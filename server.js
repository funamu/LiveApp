// 必要なライブラリ（ExpressとSocket.IO）を読み込みます
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" } // どのページからでも接続を受け許可する設定
});

// index_4.html などの静的ファイルを配信するための設定
app.use(express.static(__dirname));

// 配信の状態を管理する変数
let currentBroadcaster = null; // 現在の配信者のSocket ID
let isBroadcasting = false;    // 配信中かどうか（true: 配信中, false: 停止中）
const SECRET_HOST_KEY = 'secret123'; // 配信者認証用キー（URLの ?host=secret123 で指定）

// --- チャットログファイル管理 ---
const LOG_FILE_PATH = path.join(__dirname, 'chat_logs.jsonl');
const chatHistory = [];
const MAX_HISTORY = 100; // メモリ上に保持・途中参加者に送信する最大件数

// 起動時に過去のログファイルがあれば読み込む
if (fs.existsSync(LOG_FILE_PATH)) {
    try {
        const fileData = fs.readFileSync(LOG_FILE_PATH, 'utf-8');
        const lines = fileData.trim().split('\n').filter(Boolean);
        lines.forEach(line => {
            chatHistory.push(JSON.parse(line));
        });
        // 直近の件数のみ保持
        if (chatHistory.length > MAX_HISTORY) {
            chatHistory.splice(0, chatHistory.length - MAX_HISTORY);
        }
        console.log(`過去のログファイルを ${lines.length} 件読み込みました。`);
    } catch (err) {
        console.error('ログファイルの読み込みエラー:', err);
    }
}

// ログ追記用関数
function saveLogToFile(logData) {
    chatHistory.push(logData);
    if (chatHistory.length > MAX_HISTORY) {
        chatHistory.shift();
    }
    
    // 1行1JSON形式でファイルへ追記
    const logLine = JSON.stringify(logData) + '\n';
    fs.appendFile(LOG_FILE_PATH, logLine, (err) => {
        if (err) console.error('ログの書き込みエラー:', err);
    });
}

// クライアント（ブラウザ）が接続してきたときの処理
io.on('connection', (socket) => {
    console.log('ユーザーが接続しました:', socket.id);

    // 1. 接続した人（新しく開いた視聴者など）に、現在の配信状態を教える
    socket.emit('broadcaster-status', { 
        hasBroadcaster: !!currentBroadcaster, 
        isBroadcasting: isBroadcasting 
    });

    // 途中参加したユーザーに過去のチャット・ギフト履歴を送信
    socket.emit('chat-history', chatHistory);

    // 2. 配信者としての認証要求を受け取る
    socket.on('register-broadcaster', (key) => {
        if (key === SECRET_HOST_KEY) {
            // 他に配信者がいない、または自分が再接続した場合
            if (!currentBroadcaster || currentBroadcaster === socket.id) {
                currentBroadcaster = socket.id;
                isBroadcasting = false; // 初期状態は停止中
                socket.emit('broadcaster-approved', { success: true });
                io.emit('broadcaster-status', { hasBroadcaster: true, isBroadcasting: false });
                console.log('配信者として認証されました:', socket.id);
            } else {
                socket.emit('broadcaster-approved', { success: false, reason: 'すでに他の配信者が接続中です。' });
            }
        } else {
            socket.emit('broadcaster-approved', { success: false, reason: '認証キーが無効です。' });
        }
    });

    // 3. 配信開始・停止ボタンが押されたとき
    socket.on('toggle-stream', (status) => {
        if (socket.id === currentBroadcaster) {
            isBroadcasting = status;
            // 全員に現在の配信状態を通知する
            io.emit('broadcaster-status', { hasBroadcaster: true, isBroadcasting: isBroadcasting });
            console.log('配信ステータス変更:', isBroadcasting ? '配信中' : '停止中');
        }
    });

    // --- WebRTC（映像・音声の直接通信）の手順を仲介するシグナリング処理 ---

    // 視聴者から「映像の準備をしてほしい（Offer要求）」が来たら配信者に伝える
    socket.on('request-offer', () => {
        if (currentBroadcaster && isBroadcasting) {
            io.to(currentBroadcaster).emit('request-offer-from', socket.id);
        }
    });

    // 配信者からのOffer（接続提案）を特定の視聴者に届ける
    socket.on('offer', (data) => {
        if (data.target) {
            io.to(data.target).emit('offer', {
                broadcasterId: socket.id,
                offer: data.offer
            });
        }
    });

    // 視聴者からのAnswer（応答）を配信者に届ける
    socket.on('answer', (data) => {
        if (data.target) {
            io.to(data.target).emit('answer', {
                viewerId: socket.id,
                answer: data.answer
            });
        }
    });

    // ネットワーク接続経路情報（ICE Candidate）を相手に渡す
    socket.on('candidate', (data) => {
        if (data.target) {
            io.to(data.target).emit('candidate', {
                senderId: socket.id,
                candidate: data.candidate
            });
        }
    });

    // --- チャット・ギフト機能 ---
    socket.on('send-chat', (data) => {
        const logData = { type: 'chat', timestamp: new Date().toISOString(), ...data };
        saveLogToFile(logData);
        io.emit('receive-chat', data);
    });

    socket.on('send-gift', (data) => {
        const logData = { type: 'gift', timestamp: new Date().toISOString(), ...data };
        saveLogToFile(logData);
        io.emit('receive-gift', data);
    });

    // 接続が切れたときの処理
    socket.on('disconnect', () => {
        if (socket.id === currentBroadcaster) {
            currentBroadcaster = null;
            isBroadcasting = false;
            // 配信者が切断したことを全員に通知
            io.emit('broadcaster-status', { hasBroadcaster: false, isBroadcasting: false });
            console.log('配信者が切断されました');
        }
    });
});

// サーバーの起動
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`サーバーが起動しました: http://localhost:${PORT}`);
});