const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// THE SERVER'S MEMORY
let rooms = {};

// Helper to send open rooms to the lobby
function broadcastLobbyUpdate() {
    const openRooms = Object.keys(rooms).filter(id => rooms[id].status === 'waiting').map(id => ({
        id,
        hostName: rooms[id].players[1] ? rooms[id].players[1].name : rooms[id].players[2].name,
        hostColor: rooms[id].players[1] ? 'White' : 'Black'
    }));
    io.to('lobby').emit('lobbyUpdate', openRooms);
}

// 1-Second Global Timer Loop
setInterval(() => {
    for (const roomId in rooms) {
        let room = rooms[roomId];
        if (room.status === 'playing') {
            const p1Connected = room.players[1] && room.players[1].connected;
            const p2Connected = room.players[2] && room.players[2].connected;

            if (!p1Connected || !p2Connected) {
                // Someone is disconnected: Run the 3-minute Disconnect Timer
                room.timers.disconnectTimeLeft--;
                if (room.timers.disconnectTimeLeft <= 0) {
                    const winner = p1Connected ? 1 : 2;
                    endGame(roomId, winner, "Opponent Abandoned");
                }
            } else {
                // Both are connected: Run the 2-minute Turn Timer
                room.timers.turnTimeLeft--;
                if (room.timers.turnTimeLeft <= 0) {
                    const winner = room.turn === 1 ? 2 : 1; // The person whose turn it ISN'T wins
                    endGame(roomId, winner, "Time Out");
                }
            }
            // Broadcast timer updates to the room
            io.to(roomId).emit('timerTick', room.timers);
        }
    }
}, 1000);

function endGame(roomId, winningColor, reason) {
    let room = rooms[roomId];
    if (!room) return;

    room.status = 'ended';
    room.totalGamesPlayed++;
    
    if (winningColor === 1) room.score.white++;
    if (winningColor === 2) room.score.black++;

    io.to(roomId).emit('gameOver', { 
        winner: winningColor, 
        reason: reason,
        score: room.score,
        totalGamesPlayed: room.totalGamesPlayed
    });
}

io.on('connection', (socket) => {
    // Put new users in the lobby room
    socket.join('lobby');
    broadcastLobbyUpdate();

    socket.on('joinGame', (data) => {
        const { roomId, playerName, color } = data; // color is 1 (White) or 2 (Black)
        
        if (!rooms[roomId]) {
            // CREATE NEW ROOM
            rooms[roomId] = {
                status: 'waiting',
                turn: 1,
                board: null, // Client will send initial board
                score: { white: 0, black: 0 },
                totalGamesPlayed: 0,
                players: { 1: null, 2: null },
                timers: { turnTimeLeft: 120, disconnectTimeLeft: 180 }
            };
            rooms[roomId].players[color] = { name: playerName, connected: true, socketId: socket.id };
            
            socket.leave('lobby');
            socket.join(roomId);
            socket.roomId = roomId;
            socket.color = color;

            socket.emit('initGame', { status: 'waiting', color: color });
            broadcastLobbyUpdate();

        } else {
            let room = rooms[roomId];
            
            // CHECK 3-CREDENTIAL RECONNECT OR JOIN
            if (room.players[color] !== null) {
                // Color is taken. Is it a reconnect?
                if (room.players[color].name === playerName) {
                    // Successful Reconnect
                    room.players[color].connected = true;
                    room.players[color].socketId = socket.id;
                    room.timers.disconnectTimeLeft = 180; // Reset disconnect timer
                    
                    socket.leave('lobby');
                    socket.join(roomId);
                    socket.roomId = roomId;
                    socket.color = color;

                    socket.emit('initGame', { 
                        status: room.status, 
                        color: color, 
                        board: room.board, 
                        turn: room.turn 
                    });
                    
                    if (room.status === 'playing') {
                        io.to(roomId).emit('systemMessage', `${playerName} reconnected.`);
                    }
                } else {
                    // Wrong name for this color
                    socket.emit('joinError', 'That color is already taken by another player.');
                }
            } else if (room.status === 'waiting') {
                // Color is free, room is waiting. Successful Join.
                room.players[color] = { name: playerName, connected: true, socketId: socket.id };
                room.status = 'playing';
                
                socket.leave('lobby');
                socket.join(roomId);
                socket.roomId = roomId;
                socket.color = color;

                socket.emit('initGame', { status: 'playing', color: color });
                io.to(roomId).emit('startGame', { turn: 1 });
                broadcastLobbyUpdate(); // Hides the room from lobby
            } else {
                socket.emit('joinError', 'Room is currently in progress or full.');
            }
        }
    });

    socket.on('makeMove', (data) => {
        const { roomId, moveData, newBoard } = data;
        let room = rooms[roomId];
        if (room && room.status === 'playing') {
            room.turn = moveData.nextTurn;
            room.board = newBoard; // Cache the board on the server for reconnects
            
            // Reset Turn Timer if the turn actually changed to the other player
            if (moveData.nextTurn !== socket.color) {
                room.timers.turnTimeLeft = 120;
            }

            io.to(roomId).emit('syncMove', {
                moveData: moveData,
                nextTurn: moveData.nextTurn,
                newBoard: newBoard
            });
        }
    });

    socket.on('initialBoardSync', (data) => {
        if (rooms[data.roomId]) {
            rooms[data.roomId].board = data.board;
        }
    });

    socket.on('manualEndGame', () => {
        if (socket.roomId && rooms[socket.roomId]) {
            const winner = socket.color === 1 ? 2 : 1; // The person who clicked it loses
            endGame(socket.roomId, winner, "Opponent Ended Game");
        }
    });

    socket.on('disconnect', () => {
        if (socket.roomId && rooms[socket.roomId]) {
            let room = rooms[socket.roomId];
            if (room.players[socket.color]) {
                room.players[socket.color].connected = false;
            }

            if (room.status === 'waiting') {
                // If they leave while waiting, destroy the room
                delete rooms[socket.roomId];
                broadcastLobbyUpdate();
            } else if (room.status === 'playing') {
                // Start disconnect logic
                io.to(socket.roomId).emit('systemMessage', `Opponent disconnected. Waiting 3 minutes...`);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
