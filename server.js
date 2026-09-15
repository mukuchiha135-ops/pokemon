const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname + '/public'));

let activeUsers = 0;
const rooms = {}; // 対戦・交換ルーム情報

// モンスターデータの構造・数値検証関数
function isValidMonster(mon) {
    return mon && 
           typeof mon.name === 'string' &&
           typeof mon.level === 'number' && mon.level >= 1 && mon.level <= 150 &&
           typeof mon.hp === 'number' && mon.hp >= 0 &&
           typeof mon.maxHp === 'number' && mon.maxHp > 0 &&
           typeof mon.atk === 'number' && mon.atk > 0;
}

io.on('connection', (socket) => {
    activeUsers++;
    io.emit('onlineCount', activeUsers);

    // 1. ルーム作成・参加
    socket.on('joinRoom', ({ roomId, mode, playerParty }) => {
        // パーティデータ検証
        if (!Array.isArray(playerParty) || playerParty.length === 0 || !isValidMonster(playerParty[0])) {
            socket.emit('errorMsg', '不正なパーティデータです。');
            return;
        }

        socket.join(roomId);
        if (!rooms[roomId]) {
            rooms[roomId] = {
                id: roomId,
                mode: mode, // 'battle' または 'trade'
                players: []
            };
        }

        const room = rooms[roomId];
        if (room.players.length >= 2) {
            socket.emit('errorMsg', '部屋が満員です。');
            socket.leave(roomId);
            return;
        }

        room.players.push({
            id: socket.id,
            party: playerParty,
            currentMonIndex: 0,
            acceptedTrade: false
        });

        // 2人が揃った場合にゲーム開始イベントを発行
        if (room.players.length === 2) {
            io.to(roomId).emit('roomReady', {
                roomId: roomId,
                mode: room.mode,
                players: room.players.map(p => ({
                    id: p.id,
                    activeMon: p.party[0]
                }))
            });
        }
    });

    // 2. 対戦処理：サーバー側攻撃計算＆データ検証
    socket.on('battleAttack', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || room.mode !== 'battle' || room.players.length < 2) return;

        const attacker = room.players.find(p => p.id === socket.id);
        const defender = room.players.find(p => p.id !== socket.id);

        if (!attacker || !defender) return;

        const p1Mon = attacker.party[attacker.currentMonIndex];
        const p2Mon = defender.party[defender.currentMonIndex];

        // ダメージ計算のサーバー側検証（チート防止）
        const calcDamage = Math.max(1, p1Mon.atk - Math.floor(p2Mon.level * 0.3));
        p2Mon.hp = Math.max(0, p2Mon.hp - calcDamage);

        // 結果を両者に送信
        io.to(roomId).emit('battleTurnResult', {
            attackerId: socket.id,
            damage: calcDamage,
            defenderHp: p2Mon.hp,
            isDefenderFainted: p2Mon.hp <= 0
        });
    });

    // 3. 交換処理：サーバー検証付き相互交換
    socket.on('proposeTrade', ({ roomId, offerMon }) => {
        const room = rooms[roomId];
        if (!room || room.mode !== 'trade') return;

        if (!isValidMonster(offerMon)) {
            socket.emit('errorMsg', '不正なモンスターデータです。');
            return;
        }

        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            player.offeredMon = offerMon;
            player.acceptedTrade = true;
        }

        // 両者が提示を完了している場合、安全に交換を実行
        if (room.players.length === 2 && room.players.every(p => p.acceptedTrade)) {
            const p1 = room.players[0];
            const p2 = room.players[1];

            // サーバーを介してモンスターデータを入れ替えて返却
            io.to(p1.id).emit('tradeComplete', { receivedMon: p2.offeredMon });
            io.to(p2.id).emit('tradeComplete', { receivedMon: p1.offeredMon });

            delete rooms[roomId];
        }
    });

    // 切断処理
    socket.on('disconnect', () => {
        activeUsers = Math.max(0, activeUsers - 1);
        io.emit('onlineCount', activeUsers);

        // 参加中だったルームの削除・通信切断通知
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const pIndex = room.players.findIndex(p => p.id === socket.id);
            if (pIndex !== -1) {
                room.players.splice(pIndex, 1);
                io.to(roomId).emit('partnerDisconnected');
                delete rooms[roomId];
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`[Server] Running on port ${PORT}`);
});