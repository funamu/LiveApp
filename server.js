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

// 部屋情報管理ファイル
const ROOMS_FILE = path.join(__dirname, 'rooms.json');

// 初期設定ファイルの作成（存在しない場合）
if (!fs.existsSync(ROOMS_FILE)) {
    const initialRoomsData = {
        "default": {
            "password": "",
            "title": "デフォルトルーム"
        }
    };
    fs.writeFileSync(ROOMS_FILE, JSON.stringify(initialRoomsData, null, 2), 'utf8');
}

// rooms.json から最新の部屋設定を読み込む関数
function loadRoomsConfig() {
    try {
        const data = fs.readFileSync(ROOMS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error('rooms.json の読み込みエラー:', err);
        return {};
    }
}

const SECRET_HOST_KEY = 'secret123'; // 配信者認証用共通キー

// メモリ上の実行時ルーム状態データ
const roomsState = {};

function getOrCreateRoomState(roomId) {
    if (!roomsState[roomId]) {
        roomsState[roomId] = {
            broadcasterSocketId: null,
            isBroadcasting: false,
            isPaused: false,
            chatHistory: [],
            logFilePath: null
        };
    }
    return roomsState[roomId];
}

// ログ追記用関数（配信中のみ保存）
function saveLogToFile(roomState, logData) {
    roomState.chatHistory.push(logData);
    if (roomState.chatHistory.length > 100) {
        roomState.chatHistory.shift();
    }

    if (roomState.logFilePath) {
        const logLine = JSON.stringify(logData) + '\n';
        fs.appendFile(roomState.logFilePath, logLine, (err) => {
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
        
        // rooms.json から最新の部屋情報を取得
        const roomsConfig = loadRoomsConfig();
        const roomConfig = roomsConfig[currentRoomId];

        // 部屋が存在しない場合
        if (!roomConfig && !isHost) {
            return socket.emit('join-result', { success: false, reason: '指定された配信ルームが存在しません。' });
        }

        const roomState = getOrCreateRoomState(currentRoomId);

        // --- 配信者の認証・参加 ---
        if (isHost) {
            if (hostKey !== SECRET_HOST_KEY) {
                return socket.emit('join-result', { success: false, reason: '配信者認証キーが無効です。' });
            }
            if (roomState.broadcasterSocketId && roomState.broadcasterSocketId !== socket.id) {
                return socket.emit('join-result', { success: false, reason: 'このルームには既に別の配信者が存在します。' });
            }

            roomState.broadcasterSocketId = socket.id;

            socket.join(currentRoomId);
            isAuthenticated = true;

            socket.emit('join-result', { success: true, isHost: true });
            socket.emit('chat-history', roomState.chatHistory);
            
            io.to(currentRoomId).emit('room-status', {
                hasBroadcaster: true,
                isBroadcasting: roomState.isBroadcasting,
                isPaused: roomState.isPaused
            });
            console.log(`[${currentRoomId}] 配信者が入室しました: ${socket.id}`);
            return;
        }

        // --- 視聴者のパスワード認証 ---
        const targetPassword = roomConfig ? roomConfig.password : "";
        if (targetPassword && targetPassword !== password) {
            return socket.emit('join-result', { success: false, reason: 'パスワードが違います。' });
        }

        socket.join(currentRoomId);
        isAuthenticated = true;

        socket.emit('join-result', { success: true, isHost: false });
        socket.emit('chat-history', roomState.chatHistory);

        socket.emit('room-status', {
            hasBroadcaster: !!roomState.broadcasterSocketId,
            isBroadcasting: roomState.isBroadcasting,
            isPaused: roomState.isPaused
        });
        console.log(`[${currentRoomId}] 視聴者が認証成功して入室しました: ${socket.id}`);
    });

    // 2. 配信開始（新規セッション & ログファイル生成）
    socket.on('start-stream', () => {
        if (!currentRoomId) return;
        const roomState = roomsState[currentRoomId];
        if (!roomState || roomState.broadcasterSocketId !== socket.id) return;

        roomState.isBroadcasting = true;
        roomState.isPaused = false;
        roomState.chatHistory = []; // 配信開始時に前回のチャット履歴を初期化

        // 新規ログファイル生成
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        roomState.logFilePath = path.join(LOGS_DIR, `chat_${currentRoomId}_${timestamp}.jsonl`);

        io.to(currentRoomId).emit('chat-history', []); // 視聴者のチャット表示もリセット
        io.to(currentRoomId).emit('room-status', {
            hasBroadcaster: true,
            isBroadcasting: true,
            isPaused: false
        });
        console.log(`[${currentRoomId}] 配信が開始されました。ログファイル: ${roomState.logFilePath}`);
    });

    // 3. 配信の一時中断 / 配信再開（チャット維持）
    socket.on('toggle-pause', (isPaused) => {
        if (!currentRoomId) return;
        const roomState = roomsState[currentRoomId];
        if (!roomState || roomState.broadcasterSocketId !== socket.id) return;

        roomState.isPaused = isPaused;
        io.to(currentRoomId).emit('room-status', {
            hasBroadcaster: true,
            isBroadcasting: roomState.isBroadcasting,
            isPaused: roomState.isPaused
        });
        console.log(`[${currentRoomId}] 配信ポーズ状態変更: ${isPaused}`);
    });

    // 4. 配信完全終了（ログ保存完了）
    socket.on('stop-stream', () => {
        if (!currentRoomId) return;
        const roomState = roomsState[currentRoomId];
        if (!roomState || roomState.broadcasterSocketId !== socket.id) return;

        roomState.isBroadcasting = false;
        roomState.isPaused = false;
        roomState.logFilePath = null; // ログファイルをクローズ

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
        const roomState = roomsState[currentRoomId];
        if (roomState && roomState.broadcasterSocketId && roomState.isBroadcasting && !roomState.isPaused) {
            io.to(roomState.broadcasterSocketId).emit('request-offer-from', socket.id);
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
        const roomState = roomsState[currentRoomId];
        const logData = { type: 'chat', timestamp: new Date().toISOString(), ...data };
        saveLogToFile(roomState, logData);
        io.to(currentRoomId).emit('receive-chat', data);
    });

    socket.on('send-gift', (data) => {
        if (!currentRoomId || !isAuthenticated) return;
        const roomState = roomsState[currentRoomId];
        const logData = { type: 'gift', timestamp: new Date().toISOString(), ...data };
        saveLogToFile(roomState, logData);
        io.to(currentRoomId).emit('receive-gift', data);
    });

    // 切断処理
    socket.on('disconnect', () => {
        if (currentRoomId && roomsState[currentRoomId]) {
            const roomState = roomsState[currentRoomId];
            if (roomState.broadcasterSocketId === socket.id) {
                roomState.broadcasterSocketId = null;
                roomState.isBroadcasting = false;
                roomState.isPaused = false;
                roomState.logFilePath = null;

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