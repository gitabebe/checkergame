const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

// THE SERVER'S MEMORY
let rooms = {};

function broadcastLobbyUpdate() {
  const openRooms = Object.keys(rooms)
    .filter((id) => rooms[id].status === "waiting")
    .map((id) => ({
      id,
      hostName: rooms[id].players[1]
        ? rooms[id].players[1].name
        : rooms[id].players[2].name,
      hostColor: rooms[id].players[1] ? "White" : "Black",
    }));
  io.to("lobby").emit("lobbyUpdate", openRooms);
}

// 1-Second Global Timer Loop
setInterval(() => {
  for (const roomId in rooms) {
    let room = rooms[roomId];
    if (room.status === "playing") {
      const p1Connected = room.players[1] && room.players[1].connected;
      const p2Connected = room.players[2] && room.players[2].connected;

      if (!p1Connected || !p2Connected) {
        room.timers.disconnectTimeLeft--;
        if (room.timers.disconnectTimeLeft <= 0) {
          const winner = p1Connected ? 1 : 2;
          endGame(roomId, winner, "Opponent Abandoned");
        }
      } else {
        room.timers.turnTimeLeft--;
        if (room.timers.turnTimeLeft <= 0) {
          const winner = room.turn === 1 ? 2 : 1;
          endGame(roomId, winner, "Time Out");
        }
      }
      io.to(roomId).emit("timerTick", room.timers);
    }
  }
}, 1000);

function endGame(roomId, winningColor, reason) {
  let room = rooms[roomId];
  if (!room) return;

  room.status = "ended";
  room.totalGamesPlayed++;

  if (winningColor === 1) room.score.white++;
  if (winningColor === 2) room.score.black++;

  io.to(roomId).emit("gameOver", {
    winner: winningColor,
    reason: reason,
    score: room.score,
    totalGamesPlayed: room.totalGamesPlayed,
  });
}

io.on("connection", (socket) => {
  socket.join("lobby");
  broadcastLobbyUpdate();

  socket.on("joinGame", (data) => {
    const { roomId, playerName, color } = data;

    if (!rooms[roomId]) {
      rooms[roomId] = {
        status: "waiting",
        turn: 1,
        board: null,
        lastMove: null,
        score: { white: 0, black: 0 },
        totalGamesPlayed: 0,
        players: { 1: null, 2: null },
        timers: { turnTimeLeft: 120, disconnectTimeLeft: 180 },
      };
      rooms[roomId].players[color] = {
        name: playerName,
        connected: true,
        socketId: socket.id,
      };

      socket.leave("lobby");
      socket.join(roomId);
      socket.roomId = roomId;
      socket.color = color;

      socket.emit("initGame", { status: "waiting", color: color });
      broadcastLobbyUpdate();
    } else {
      let room = rooms[roomId];

      if (room.players[color] !== null) {
        if (room.players[color].name === playerName) {
          // Successful Reconnect
          room.players[color].connected = true;
          room.players[color].socketId = socket.id;
          room.timers.disconnectTimeLeft = 180;

          socket.leave("lobby");
          socket.join(roomId);
          socket.roomId = roomId;
          socket.color = color;

          socket.emit("initGame", {
            status: room.status,
            color: color,
            board: room.board,
            turn: room.turn,
            lastMove: room.lastMove,
          });

          if (room.status === "playing") {
            io.to(roomId).emit("systemMessage", `${playerName} reconnected.`);
          }
        } else {
          socket.emit(
            "joinError",
            "That color is already taken by another player.",
          );
        }
      } else if (room.status === "waiting") {
        const opponentColor = color === 1 ? 2 : 1;
        if (
          room.players[opponentColor] &&
          room.players[opponentColor].name === playerName
        ) {
          socket.emit(
            "joinError",
            "Name already used by the opponent. Choose a different name.",
          );
          return;
        }

        room.players[color] = {
          name: playerName,
          connected: true,
          socketId: socket.id,
        };
        room.status = "playing";

        socket.leave("lobby");
        socket.join(roomId);
        socket.roomId = roomId;
        socket.color = color;

        socket.emit("initGame", {
          status: "playing",
          color: color,
          lastMove: room.lastMove,
        });
        io.to(roomId).emit("startGame", { turn: 1 });
        broadcastLobbyUpdate();
      } else {
        socket.emit("joinError", "Room is currently in progress or full.");
      }
    }
  });

  socket.on("makeMove", (data) => {
    const { roomId, moveData, newBoard } = data;
    let room = rooms[roomId];
    if (room && room.status === "playing") {
      room.turn = moveData.nextTurn;
      room.board = newBoard;
      room.lastMove = {
        r1: moveData.r1,
        c1: moveData.c1,
        r2: moveData.r2,
        c2: moveData.c2,
      };

      if (moveData.nextTurn !== socket.color) {
        room.timers.turnTimeLeft = 120;
      }

      io.to(roomId).emit("syncMove", {
        moveData: moveData,
        nextTurn: moveData.nextTurn,
        newBoard: newBoard,
        lastMove: room.lastMove,
      });
    }
  });

  socket.on("initialBoardSync", (data) => {
    if (rooms[data.roomId]) {
      rooms[data.roomId].board = data.board;
    }
  });

  // --- END GAME & REPLAY LOGIC ---
  socket.on("manualEndGame", () => {
    if (socket.roomId && rooms[socket.roomId]) {
      const winner = socket.color === 1 ? 2 : 1;
      endGame(socket.roomId, winner, "Opponent Surrendered");
    }
  });

  socket.on("gameLost", () => {
    if (socket.roomId && rooms[socket.roomId]) {
      const winner = socket.color === 1 ? 2 : 1;
      endGame(socket.roomId, winner, "No valid moves left");
    }
  });

  socket.on("playAgain", () => {
    let room = rooms[socket.roomId];
    if (room && room.status === "ended") {
      room.status = "playing";
      room.turn = 1;
      room.timers.turnTimeLeft = 120;
      room.timers.disconnectTimeLeft = 180;
      room.lastMove = null;
      io.to(socket.roomId).emit("resetBoard");
    }
  });

  socket.on("disconnect", () => {
    if (socket.roomId && rooms[socket.roomId]) {
      let room = rooms[socket.roomId];
      if (room.players[socket.color]) {
        room.players[socket.color].connected = false;
      }

      if (room.status === "waiting") {
        delete rooms[socket.roomId];
        broadcastLobbyUpdate();
      } else if (room.status === "playing") {
        io.to(socket.roomId).emit(
          "systemMessage",
          `Opponent disconnected. Waiting 3 minutes...`,
        );
      } else if (room.status === "ended") {
        // MEMORY FIX: If both players leave the scoreboard, delete the room
        const p1Connected = room.players[1] && room.players[1].connected;
        const p2Connected = room.players[2] && room.players[2].connected;
        if (!p1Connected && !p2Connected) {
          delete rooms[socket.roomId];
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
