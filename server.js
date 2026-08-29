const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
// ここでSocket.io（高速トランシーバー）のスイッチを入れます
const io = new Server(server);

// 誰かがURLにアクセスしてきたら、「index.html（画面）」を渡してあげます
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// 視聴者が新しく画面を開いたときの処理
io.on('connection', (socket) => {
  console.log('新しいユーザーが画面を開きました！');

  // 視聴者の画面から「ギフトボタンが押された！（send_gift）」という連絡を受け取ります
  socket.on('send_gift', (giftName) => {
    console.log('サーバー側で受信: ' + giftName);
    
    // 今つながっている【全員の画面】に向けて、「エフェクトを出して！（show_gift_effect）」と一斉送信します
    io.emit('show_gift_effect', giftName);
  });
});

// サーバーを起動して待機します（ポート番号3000番という場所を使います）
server.listen(3000, () => {
  console.log('サーバーが起動しました。ブラウザで http://localhost:3000 を開いてください。');
});