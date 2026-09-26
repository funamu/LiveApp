const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

// ログ保存用ディレクトリエリア
const LOGS_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR);
}

const SECRET_HOST_KEY = 'secret123'; // 配信者認証用キー

// メモリ上のルームデータ構造
// rooms[roomId] = {
//   password: "",
//   broadcasterSocketId: null,
//   isBroadcasting: false,
//   isPaused: false,
//   chatHistory: [],
//   logFilePath: null
// }
const rooms = {};

function getOrCreateRoom(roomId) {
    if (!rooms[roomId]) {
        rooms[roomId] = {
            password: "",
            broadcasterSocketId: null,
            isBroadcasting: false,
            isPaused: false,
            chatHistory: [],
            logFilePath: null
        };
    }
    return rooms[roomId];
}

// ログ追記用関数（配信中のみ保存）
function saveLogToFile(room, logData) {
    room.chatHistory.push(logData);
    if (room.chatHistory.length > 100) {
        room.chatHistory.shift();
    }

    if (room.logFilePath) {
        const logLine = JSON.stringify(logData) + '\n';
        fs.appendFile(room.logFilePath, logLine, (err) => {
            if (err) console.error('ログ書き込みエラー:', err);
        });
    }
}

io.on('connection', (socket) => {
    let currentRoomId = null;
    let isAuthenticated = false;

    // 1. ルームへの参加リクエスト
    socket.on('join-room', (data) => {
        const { roomId, password, isHost, hostKey } = data;
        currentRoomId = roomId || 'default';
        const room = getOrCreateRoom(currentRoomId);

        // --- 配信者の認証・参加 ---
        if (isHost) {
            if (hostKey !== SECRET_HOST_KEY) {
                return socket.emit('join-result', { success: false, reason: '配信者認証キーが無効です。' });
            }
            if (room.broadcasterSocketId && room.broadcasterSocketId !== socket.id) {
                return socket.emit('join-result', { success: false, reason: 'このルームには既に別の配信者が存在します。' });
            }

            room.broadcasterSocketId = socket.id;
            if (password) room.password = password; // 配信者が指定したパスワードをセット

            socket.join(currentRoomId);
            isAuthenticated = true;

            socket.emit('join-result', { success: true, isHost: true });
            socket.emit('chat-history', room.chatHistory);
            
            io.to(currentRoomId).emit('room-status', {
                hasBroadcaster: true,
                isBroadcasting: room.isBroadcasting,
                isPaused: room.isPaused
            });
            console.log(`[${currentRoomId}] 配信者が入室しました: ${socket.id}`);
            return;
        }

        // --- 視聴者のパスワード認証 ---
        if (room.password && room.password !== password) {
            return socket.emit('join-result', { success: false, reason: 'パスワードが違います。' });
        }

        socket.join(currentRoomId);
        isAuthenticated = true;

        socket.emit('join-result', { success: true, isHost: false });
        socket.emit('chat-history', room.chatHistory);

        socket.emit('room-status', {
            hasBroadcaster: !!room.broadcasterSocketId,
            isBroadcasting: room.isBroadcasting,
            isPaused: room.isPaused
        });
        console.log(`[${currentRoomId}] 視聴者が入室しました: ${socket.id}`);
    });

    // 2. 配信開始（新規セッション & ログファイル生成）
    socket.on('start-stream', (data) => {
        if (!currentRoomId) return;
        const room = rooms[currentRoomId];
        if (!room || room.broadcasterSocketId !== socket.id) return;

        if (data.password) {
            room.password = data.password;
        }

        room.isBroadcasting = true;
        room.isPaused = false;
        room.chatHistory = []; // 配信開始時に前回のチャット履歴を初期化

        // 新規ログファイル生成
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        room.logFilePath = path.join(LOGS_DIR, `chat_${currentRoomId}_${timestamp}.jsonl`);

        io.to(currentRoomId).emit('chat-history', []); // 視聴者のチャット表示もリセット
        io.to(currentRoomId).emit('room-status', {
            hasBroadcaster: true,
            isBroadcasting: true,
            isPaused: false
        });
        console.log(`[${currentRoomId}] 配信が開始されました。ログファイル: ${room.logFilePath}`);
    });

    // 3. 配信の一時中断 / 配信再開（チャット維持）
    socket.on('toggle-pause', (isPaused) => {
        if (!currentRoomId) return;
        const room = rooms[currentRoomId];
        if (!room || room.broadcasterSocketId !== socket.id) return;

        room.isPaused = isPaused;
        io.to(currentRoomId).emit('room-status', {
            hasBroadcaster: true,
            isBroadcasting: room.isBroadcasting,
            isPaused: room.isPaused
        });
        console.log(`[${currentRoomId}] 配信ポーズ状態変更: ${isPaused}`);
    });

    // 4. 配信完全終了（ログ保存完了）
    socket.on('stop-stream', () => {
        if (!currentRoomId) return;
        const room = rooms[currentRoomId];
        if (!room || room.broadcasterSocketId !== socket.id) return;

        room.isBroadcasting = false;
        room.isPaused = false;
        room.logFilePath = null; // ログファイルをクローズ

        io.to(currentRoomId).emit('room-status', {
            hasBroadcaster: true,
            isBroadcasting: false,
            isPaused: false
        });
        console.log(`[${currentRoomId}] 配信が完全に終了しました。`);
    });

    // --- WebRTC シグナリング処理（同一ルーム内のみに送信） ---
    socket.on('request-offer', () => {
        if (!currentRoomId) return;
        const room = rooms[currentRoomId];
        if (room && room.broadcasterSocketId && room.isBroadcasting && !room.isPaused) {
            io.to(room.broadcasterSocketId).emit('request-offer-from', socket.id);
        }
    });

    socket.on('offer', (data) => {
        if (data.target) io.to(data.target).emit('offer', { broadcasterId: socket.id, offer: data.offer });
    });

    socket.on('answer', (data) => {
        if (data.target) io.to(data.target).emit('answer', { viewerId: socket.id, answer: data.answer });
    });

    socket.on('candidate', (data) => {
        if (data.target) io.to(data.target).emit('candidate', { senderId: socket.id, candidate: data.candidate });
    });

    // --- チャット & ギフト（パスワード認証済みユーザーのみ） ---
    socket.on('send-chat', (data) => {
        if (!currentRoomId || !isAuthenticated) return;
        const room = rooms[currentRoomId];
        const logData = { type: 'chat', timestamp: new Date().toISOString(), ...data };
        saveLogToFile(room, logData);
        io.to(currentRoomId).emit('receive-chat', data);
    });

    socket.on('send-gift', (data) => {
        if (!currentRoomId || !isAuthenticated) return;
        const room = rooms[currentRoomId];
        const logData = { type: 'gift', timestamp: new Date().toISOString(), ...data };
        saveLogToFile(room, logData);
        io.to(currentRoomId).emit('receive-gift', data);
    });

    // 切断処理
    socket.on('disconnect', () => {
        if (currentRoomId && rooms[currentRoomId]) {
            const room = rooms[currentRoomId];
            if (room.broadcasterSocketId === socket.id) {
                room.broadcasterSocketId = null;
                room.isBroadcasting = false;
                room.isPaused = false;
                room.logFilePath = null;

                io.to(currentRoomId).emit('room-status', {
                    hasBroadcaster: false,
                    isBroadcasting: false,
                    isPaused: false
                });
                console.log(`[${currentRoomId}] 配信者が離脱しました。`);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`サーバー起動: http://localhost:${PORT}`);
});