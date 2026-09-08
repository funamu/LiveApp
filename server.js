const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

let currentBroadcaster = null;
let isBroadcasting = false; // 配信開始フラグ
const SECRET_HOST_KEY = 'secret123';

io.on('connection', (socket) => {
    console.log('ユーザー接続:', socket.id);

    // 視聴者接続時に現在の配信状態を伝える
    socket.emit('broadcaster-status', { hasBroadcaster: !!currentBroadcaster, isBroadcasting });

    // 配信者リクエスト
    socket.on('register-broadcaster', (key) => {
        if (key === SECRET_HOST_KEY) {
            if (!currentBroadcaster || currentBroadcaster === socket.id) {
                currentBroadcaster = socket.id;
                isBroadcasting = false;
                socket.emit('broadcaster-approved', { success: true });
                io.emit('broadcaster-status', { hasBroadcaster: true, isBroadcasting: false });
                console.log('配信者を認証:', socket.id);
            } else {
                socket.emit('broadcaster-approved', { success: false, reason: 'すでに他の配信者が接続中です。' });
            }
        } else {
            socket.emit('broadcaster-approved', { success: false, reason: '認証キーが無効です。' });
        }
    });

    // 配信開始・停止のトグル切替
    socket.on('toggle-stream', (status) => {
        if (socket.id === currentBroadcaster) {
            isBroadcasting = status;
            io.emit('broadcaster-status', { hasBroadcaster: true, isBroadcasting });
            console.log('配信ステータス変更:', isBroadcasting ? '配信中' : '準備中');
        }
    });

    // WebRTCシグナリング
    socket.on('request-offer', () => {
        if (currentBroadcaster) {
            io.to(currentBroadcaster).emit('request-offer-from', socket.id);
        }
    });

    socket.on('offer', (data) => {
        socket.broadcast.emit('offer', data);
    });

    socket.on('answer', (data) => {
        socket.broadcast.emit('answer', data);
    });

    socket.on('candidate', (data) => {
        socket.broadcast.emit('candidate', data);
    });

    // チャット＆ギフト
    socket.on('send-chat', (data) => io.emit('receive-chat', data));
    socket.on('send-gift', (data) => io.emit('receive-gift', data));

    socket.on('disconnect', () => {
        if (socket.id === currentBroadcaster) {
            currentBroadcaster = null;
            isBroadcasting = false;
            io.emit('broadcaster-status', { hasBroadcaster: false, isBroadcasting: false });
            console.log('配信者が切断しました');
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});