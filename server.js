const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(express.static(__dirname));

let currentBroadcaster = null;
let isBroadcasting = false;
const SECRET_HOST_KEY = 'secret123';

io.on('connection', (socket) => {
    console.log('ユーザー接続:', socket.id);

    // 接続時に現在の配信状態を通知
    socket.emit('broadcaster-status', { hasBroadcaster: !!currentBroadcaster, isBroadcasting });

    // 配信者認証
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
            console.log('配信ステータス変更:', isBroadcasting ? '配信中' : '停止中');
        }
    });

    // WebRTC シグナリング
    socket.on('request-offer', () => {
        if (currentBroadcaster && isBroadcasting) {
            io.to(currentBroadcaster).emit('request-offer-from', socket.id);
        }
    });

    socket.on('offer', (data) => {
        if (data.target) {
            io.to(data.target).emit('offer', {
                broadcasterId: socket.id,
                offer: data.offer
            });
        }
    });

    socket.on('answer', (data) => {
        if (data.target) {
            io.to(data.target).emit('answer', {
                viewerId: socket.id,
                answer: data.answer
            });
        }
    });

    socket.on('candidate', (data) => {
        if (data.target) {
            io.to(data.target).emit('candidate', {
                senderId: socket.id,
                candidate: data.candidate
            });
        }
    });

    // チャット・ギフト
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