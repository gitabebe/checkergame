const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

let rooms = {};

io.on('connection', (socket) => {
    socket.on('joinGame', (roomId) => {
        socket.join(roomId);
        const room = io.sockets.adapter.rooms.get(roomId);
        const clientCount = room ? room.size : 0;

        if (clientCount === 1) {
            rooms[roomId] = { turn: 1 };
            socket.emit('init', { color: 1 });
        } else {
            socket.emit('init', { color: 2 });
            io.to(roomId).emit('startGame', { turn: 1 });
        }
    });

    socket.on('makeMove', (data) => {
        const { roomId, moveData } = data;
        if (rooms[roomId]) {
            rooms[roomId].turn = moveData.nextTurn;
            // Broadcast to everyone in the room (including sender)
            io.to(roomId).emit('syncMove', {
                moveData: moveData,
                nextTurn: moveData.nextTurn
            });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
