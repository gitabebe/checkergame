const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

let rooms = {}; // Store active games

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('joinGame', (roomId) => {
        const room = io.sockets.adapter.rooms.get(roomId);
        const clientCount = room ? room.size : 0;

        if (clientCount === 0) {
            socket.join(roomId);
            rooms[roomId] = { turn: 1 }; // 1 = White
            socket.emit('init', { color: 1 }); // Player 1 is White
        } else if (clientCount === 1) {
            socket.join(roomId);
            socket.emit('init', { color: 2 }); // Player 2 is Black
            io.to(roomId).emit('startGame', true); // Start game
        } else {
            socket.emit('full', true);
        }
    });

    socket.on('makeMove', ({ roomId, moveData }) => {
        // Broadcast move to the other player in the room
        socket.to(roomId).emit('opponentMove', moveData);
    });

    socket.on('disconnect', () => {
        console.log('User disconnected');
        // Optional: Handle cleanup if needed
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

