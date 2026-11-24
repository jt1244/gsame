const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

// Serve static client files from the public folder
app.use(express.static(path.join(__dirname, 'public')));

const ISLAND_RADIUS = 175;
const rooms = new Map();

function generateRoomCode() {
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    let code = '';
    do {
        code = '';
        for (let i = 0; i < 4; i++) {
            code += letters[Math.floor(Math.random() * letters.length)];
        }
    } while (rooms.has(code));
    return code;
}

function createRoomWorld() {
    const trees = [];
    const rocks = [];
    const chests = [];

    for (let i = 0; i < 65; i++) {
        const angle = Math.random() * Math.PI * 2;
        const r = 18 + Math.random() * (ISLAND_RADIUS - 32);
        trees.push({
            id: `tree_${i}`,
            x: Math.cos(angle) * r,
            z: Math.sin(angle) * r,
            hp: 90
        });
    }

    for (let i = 0; i < 38; i++) {
        const angle = Math.random() * Math.PI * 2;
        const r = 15 + Math.random() * (ISLAND_RADIUS - 28);
        rocks.push({
            id: `rock_${i}`,
            x: Math.cos(angle) * r,
            z: Math.sin(angle) * r,
            scale: 1.1 + Math.random() * 0.9,
            rot: [Math.random(), Math.random(), Math.random()],
            hp: 110
        });
    }

    for (let i = 0; i < 24; i++) {
        const angle = Math.random() * Math.PI * 2;
        const r = 12 + Math.random() * (ISLAND_RADIUS - 26);
        chests.push({
            id: `chest_${i}`,
            x: Math.cos(angle) * r,
            z: Math.sin(angle) * r,
            rotY: Math.random() * Math.PI * 2,
            opened: false
        });
    }

    return {
        trees,
        rocks,
        chests,
        builds: [],
        lootDrops: [],
        storm: {
            centerX: 0,
            centerZ: 0,
            targetX: (Math.random() - 0.5) * 45,
            targetZ: (Math.random() - 0.5) * 45,
            currentRadius: 195,
            targetRadius: 115,
            phase: 1,
            timer: 25,
            shrinking: false,
            damagePerSec: 3
        }
    };
}

function getSpawnPoint() {
    const angle = Math.random() * Math.PI * 2;
    const dist = 25 + Math.random() * 65;
    return {
        x: Math.cos(angle) * dist,
        z: Math.sin(angle) * dist
    };
}

const PLAYER_COLORS = [0x0284c7, 0xef4444, 0xf97316, 0x8b5cf6, 0xec4899, 0x14b8a6, 0xeab308, 0x22c55e];

io.on('connection', (socket) => {
    let currentRoomCode = null;

    socket.on('createRoom', ({ playerName }) => {
        const code = generateRoomCode();
        const world = createRoomWorld();
        const spawn = getSpawnPoint();

        const room = {
            code,
            world,
            players: {},
            nextLootId: 1,
            nextBuildId: 1
        };

        const playerObj = {
            id: socket.id,
            name: (playerName || 'Player').slice(0, 14),
            color: PLAYER_COLORS[0],
            x: spawn.x,
            y: 4,
            z: spawn.z,
            yaw: 0,
            hp: 100,
            shield: 50,
            alive: true,
            elims: 0
        };

        room.players[socket.id] = playerObj;
        rooms.set(code, room);
        currentRoomCode = code;
        socket.join(code);

        socket.emit('roomJoined', {
            code,
            playerId: socket.id,
            world: room.world,
            players: room.players
        });
    });

    socket.on('joinRoom', ({ code, playerName }) => {
        const cleanCode = (code || '').trim().toUpperCase();
        const room = rooms.get(cleanCode);

        if (!room) {
            socket.emit('roomError', 'Room not found! Check the 4-letter code.');
            return;
        }

        const spawn = getSpawnPoint();
        const colorIdx = Object.keys(room.players).length % PLAYER_COLORS.length;
        const playerObj = {
            id: socket.id,
            name: (playerName || 'Player').slice(0, 14),
            color: PLAYER_COLORS[colorIdx],
            x: spawn.x,
            y: 4,
            z: spawn.z,
            yaw: 0,
            hp: 100,
            shield: 50,
            alive: true,
            elims: 0
        };

        room.players[socket.id] = playerObj;
        currentRoomCode = cleanCode;
        socket.join(cleanCode);

        socket.emit('roomJoined', {
            code: cleanCode,
            playerId: socket.id,
            world: room.world,
            players: room.players
        });

        socket.to(cleanCode).emit('playerJoined', playerObj);
    });

    socket.on('playerMove', (data) => {
        if (!currentRoomCode) return;
        const room = rooms.get(currentRoomCode);
        if (!room || !room.players[socket.id]) return;

        const p = room.players[socket.id];
        p.x = data.x;
        p.y = data.y;
        p.z = data.z;
        p.yaw = data.yaw;
        p.hp = data.hp;
        p.shield = data.shield;

        socket.to(currentRoomCode).emit('playerMoved', {
            id: socket.id,
            x: p.x,
            y: p.y,
            z: p.z,
            yaw: p.yaw,
            hp: p.hp,
            shield: p.shield
        });
    });

    socket.on('shootBullet', (bulletData) => {
        if (!currentRoomCode) return;
        socket.to(currentRoomCode).emit('bulletSpawned', {
            ownerId: socket.id,
            ...bulletData
        });
    });

    socket.on('hitPlayer', ({ targetId, damage }) => {
        if (!currentRoomCode) return;
        const room = rooms.get(currentRoomCode);
        if (!room) return;

        const target = room.players[targetId];
        const attacker = room.players[socket.id];
        if (!target || !target.alive) return;

        let remaining = damage;
        if (target.shield > 0) {
            const absorbed = Math.min(target.shield, remaining);
            target.shield -= absorbed;
            remaining -= absorbed;
        }
        target.hp = Math.max(0, target.hp - remaining);

        io.to(currentRoomCode).emit('playerDamaged', {
            targetId,
            attackerId: socket.id,
            hp: target.hp,
            shield: target.shield
        });

        if (target.hp <= 0 && target.alive) {
            target.alive = false;
            if (attacker) attacker.elims++;

            io.to(currentRoomCode).emit('playerEliminated', {
                victimId: targetId,
                victimName: target.name,
                killerId: socket.id,
                killerName: attacker ? attacker.name : 'The Storm',
                killerElims: attacker ? attacker.elims : 0
            });
        }
    });

    socket.on('harvestResource', ({ resourceId, damage }) => {
        if (!currentRoomCode) return;
        const room = rooms.get(currentRoomCode);
        if (!room) return;

        let list = resourceId.startsWith('tree_') ? room.world.trees : room.world.rocks;
        const idx = list.findIndex(item => item.id === resourceId);
        if (idx !== -1) {
            list[idx].hp -= damage;
            if (list[idx].hp <= 0) {
                list.splice(idx, 1);
                io.to(currentRoomCode).emit('resourceDestroyed', { resourceId });
            }
        }
    });

    socket.on('openChest', ({ chestId }) => {
        if (!currentRoomCode) return;
        const room = rooms.get(currentRoomCode);
        if (!room) return;

        const chest = room.world.chests.find(c => c.id === chestId);
        if (chest && !chest.opened) {
            chest.opened = true;
            const pool = ['shotgun', 'sniper', 'ar', 'potion'];
            const dropWeapon = pool[Math.floor(Math.random() * pool.length)];

            const drop1 = {
                id: `loot_${room.nextLootId++}`,
                x: chest.x + 1.2,
                z: chest.z + 0.8,
                weaponKey: dropWeapon
            };
            const drop2 = {
                id: `loot_${room.nextLootId++}`,
                x: chest.x - 1.2,
                z: chest.z + 0.8,
                weaponKey: 'potion'
            };
            room.world.lootDrops.push(drop1, drop2);

            io.to(currentRoomCode).emit('chestOpened', {
                chestId,
                drops: [drop1, drop2]
            });
        }
    });

    socket.on('pickupLoot', ({ lootId }) => {
        if (!currentRoomCode) return;
        const room = rooms.get(currentRoomCode);
        if (!room) return;

        const idx = room.world.lootDrops.findIndex(l => l.id === lootId);
        if (idx !== -1) {
            const [item] = room.world.lootDrops.splice(idx, 1);
            socket.emit('lootGranted', { weaponKey: item.weaponKey });
            io.to(currentRoomCode).emit('lootRemoved', { lootId });
        }
    });

    socket.on('placeBuild', (buildData) => {
        if (!currentRoomCode) return;
        const room = rooms.get(currentRoomCode);
        if (!room) return;

        const buildObj = {
            id: `build_${room.nextBuildId++}`,
            ...buildData,
            hp: buildData.matType === 'wood' ? 120 : 220
        };
        room.world.builds.push(buildObj);
        io.to(currentRoomCode).emit('buildPlaced', buildObj);
    });

    socket.on('damageBuild', ({ buildId, damage }) => {
        if (!currentRoomCode) return;
        const room = rooms.get(currentRoomCode);
        if (!room) return;

        const idx = room.world.builds.findIndex(b => b.id === buildId);
        if (idx !== -1) {
            room.world.builds[idx].hp -= damage;
            if (room.world.builds[idx].hp <= 0) {
                room.world.builds.splice(idx, 1);
                io.to(currentRoomCode).emit('buildDestroyed', { buildId });
            }
        }
    });

    socket.on('respawnPlayer', () => {
        if (!currentRoomCode) return;
        const room = rooms.get(currentRoomCode);
        if (!room || !room.players[socket.id]) return;

        const spawn = getSpawnPoint();
        const p = room.players[socket.id];
        p.x = spawn.x;
        p.y = 4;
        p.z = spawn.z;
        p.hp = 100;
        p.shield = 50;
        p.alive = true;

        io.to(currentRoomCode).emit('playerRespawned', p);
    });

    socket.on('disconnect', () => {
        if (!currentRoomCode) return;
        const room = rooms.get(currentRoomCode);
        if (room) {
            delete room.players[socket.id];
            io.to(currentRoomCode).emit('playerLeft', { id: socket.id });
            if (Object.keys(room.players).length === 0) {
                rooms.delete(currentRoomCode);
            }
        }
    });
});

setInterval(() => {
    const dt = 0.1;
    rooms.forEach((room, code) => {
        const storm = room.world.storm;
        storm.timer -= dt;
        if (storm.timer <= 0) {
            storm.shrinking = !storm.shrinking;
            if (storm.shrinking) {
                storm.timer = 18;
            } else {
                storm.phase++;
                storm.timer = 22;
                storm.targetRadius = Math.max(20, storm.currentRadius * 0.55);
                storm.damagePerSec += 2;
            }
        }

        if (storm.shrinking && storm.currentRadius > storm.targetRadius) {
            storm.currentRadius = Math.max(storm.targetRadius, storm.currentRadius - 4.2 * dt);
            storm.centerX += (storm.targetX - storm.centerX) * 0.1 * dt;
            storm.centerZ += (storm.targetZ - storm.centerZ) * 0.1 * dt;
        }

        io.to(code).emit('stormUpdate', storm);
    });
}, 100);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`StormRoyale 3D Multiplayer Server running on http://localhost:${PORT}`);
});
