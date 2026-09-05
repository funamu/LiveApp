const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

io.on('connection', (socket) => {
    console.log('ユーザーが接続しました:', socket.id);

    // 視聴者から「配信者の映像がほしい」という合図を受け取ったら、全員（配信者）に伝える
    socket.on('request-offer', () => {
        console.log('視聴者からのリクエストを中継します');
        socket.broadcast.emit('request-offer');
    });

    // WebRTCのシグナリング中継
    socket.on('offer', (data) => {
        socket.broadcast.emit('offer', data);
    });

    socket.on('answer', (data) => {
        socket.broadcast.emit('answer', data);
    });

    socket.on('candidate', (data) => {
        socket.broadcast.emit('candidate', data);
    });

    // ギフト機能の共有
    socket.on('send-gift', (data) => {
        io.emit('receive-gift', data);
    });

    socket.on('disconnect', () => {
        console.log('ユーザーが切断しました:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});