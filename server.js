const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 静ファイル（HTMLなど）を公開する設定
app.use(express.static(__dirname));

io.on('connection', (socket) => {
    console.log('ユーザーが接続しました');

    // クライアントからギフト通知を受け取ったら、全員に共有する
    socket.on('send-gift', (data) => {
        io.emit('receive-gift', data);
    });

    socket.on('disconnect', () => {
        console.log('ユーザーが切断しました');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});