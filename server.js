// Watch-together / virtual-date platform — room-based sync server.
//
// Privacy model: chat is end-to-end encrypted in the browser. Each room has a
// symmetric key that lives only in the client URL fragment (#...), which is
// never sent to the server. This process only relays opaque ciphertext and
// never sees message plaintext. Nothing is persisted: rooms live in memory and
// are discarded once empty, and chat history is never stored.

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.static('public'));

// WebRTC ICE configuration. Media is peer-to-peer and E2E encrypted; a TURN
// relay only forwards already-encrypted packets. Configure TURN via env for
// reliable calls across strict NATs (optional — STUN alone works on most LANs).
app.get('/rtc-config', (_req, res) => {
    const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    if (process.env.TURN_URL) {
        iceServers.push({
            urls: process.env.TURN_URL,
            username: process.env.TURN_USERNAME || '',
            credential: process.env.TURN_CREDENTIAL || ''
        });
    }
    res.json({ iceServers });
});

// GIF search config. The key is required for Tenor search; without it the
// client falls back to paste-a-URL. Note: GIF search is NOT private.
app.get('/gif-config', (_req, res) => {
    res.json({ provider: 'tenor', key: process.env.TENOR_API_KEY || '' });
});

// roomId -> { videoState, users: Map<socketId, {username}>, poll, pollVotes: Map }
const rooms = new Map();

const MAX_ROOM_ID = 128;
const MAX_USERNAME = 40;

function getRoom(roomId) {
    let room = rooms.get(roomId);
    if (!room) {
        room = {
            videoState: { videoId: '', isPlaying: false, currentTime: 0, lastUpdate: Date.now() },
            users: new Map(),
            poll: null,
            pollVotes: new Map()
        };
        rooms.set(roomId, room);
    }
    return room;
}

function broadcastUserCount(roomId) {
    const room = rooms.get(roomId);
    if (room) io.to(roomId).emit('user-count', room.users.size);
}

function leaveRoom(socket) {
    const { roomId, username } = socket.data;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (room) {
        room.users.delete(socket.id);
        room.pollVotes.delete(socket.id);
        socket.to(roomId).emit('system-message', {
            message: `${username || 'Someone'} left the room 👋`,
            timestamp: Date.now()
        });
        broadcastUserCount(roomId);
        if (room.users.size === 0) rooms.delete(roomId);
    }
    socket.leave(roomId);
    socket.data.roomId = null;
}

io.on('connection', (socket) => {
    socket.on('join-room', ({ roomId, username } = {}) => {
        if (typeof roomId !== 'string' || !roomId || roomId.length > MAX_ROOM_ID) return;
        username = (typeof username === 'string' ? username : '').slice(0, MAX_USERNAME).trim() || 'Guest';

        if (socket.data.roomId) leaveRoom(socket); // leave any previous room first

        const room = getRoom(roomId);
        socket.data.roomId = roomId;
        socket.data.username = username;
        socket.join(roomId);
        room.users.set(socket.id, { username });

        socket.to(roomId).emit('system-message', {
            message: `${username} joined the room 💫`,
            timestamp: Date.now()
        });

        // Bring the newcomer up to speed with the current video state.
        if (room.videoState.videoId || room.videoState.src) socket.emit('video-sync', room.videoState);
        broadcastUserCount(roomId);
        socket.emit('joined', { roomId });
    });

    // ---- Encrypted chat relay (server never sees plaintext) ----
    socket.on('send-message', (payload = {}) => {
        const roomId = socket.data.roomId;
        if (!roomId || !payload.ciphertext || !payload.iv) return;
        socket.to(roomId).emit('new-message', {
            ciphertext: payload.ciphertext,
            iv: payload.iv,
            username: socket.data.username,
            timestamp: Date.now(),
            id: socket.id
        });
    });

    // ---- Typing indicators ----
    socket.on('typing-start', () => {
        const roomId = socket.data.roomId;
        if (roomId) socket.to(roomId).emit('user-typing', { username: socket.data.username, isTyping: true });
    });
    socket.on('typing-stop', () => {
        const roomId = socket.data.roomId;
        if (roomId) socket.to(roomId).emit('user-typing', { username: socket.data.username, isTyping: false });
    });

    // ---- Video sync ----
    socket.on('load-video', (videoData = {}) => {
        const roomId = socket.data.roomId;
        if (!roomId) return;
        const room = getRoom(roomId);
        room.videoState = {
            videoId: videoData.videoId || '',
            src: videoData.src || '',
            kind: videoData.kind || 'yt',
            isPlaying: false,
            currentTime: 0,
            lastUpdate: Date.now()
        };
        io.to(roomId).emit('video-loaded', { ...videoData, user: socket.data.username });
    });

    socket.on('video-playpause', (data = {}) => {
        const roomId = socket.data.roomId;
        if (!roomId) return;
        const room = getRoom(roomId);
        room.videoState.isPlaying = !!data.isPlaying;
        room.videoState.currentTime = data.currentTime || 0;
        room.videoState.lastUpdate = Date.now();
        socket.to(roomId).emit('video-playpause-sync', {
            isPlaying: data.isPlaying,
            currentTime: data.currentTime,
            user: socket.data.username
        });
        io.to(roomId).emit('system-message', {
            message: `${socket.data.username} ${data.isPlaying ? 'played ▶️' : 'paused ⏸️'} the video`,
            timestamp: Date.now()
        });
    });

    socket.on('video-progress', (data = {}) => {
        const roomId = socket.data.roomId;
        if (!roomId) return;
        const room = getRoom(roomId);
        room.videoState.currentTime = data.currentTime || 0;
        room.videoState.lastUpdate = Date.now();
        socket.to(roomId).emit('video-progress-sync', { currentTime: data.currentTime });
    });

    socket.on('video-seek', (data = {}) => {
        const roomId = socket.data.roomId;
        if (!roomId) return;
        getRoom(roomId).videoState.currentTime = data.currentTime || 0;
        socket.to(roomId).emit('video-seek', { currentTime: data.currentTime, user: socket.data.username });
    });

    socket.on('sync-request', (data = {}) => {
        const roomId = socket.data.roomId;
        if (!roomId) return;
        const room = getRoom(roomId);
        if (data) {
            room.videoState.currentTime = data.currentTime || room.videoState.currentTime;
            room.videoState.isPlaying = !!data.isPlaying;
            room.videoState.lastUpdate = Date.now();
        }
        io.to(roomId).emit('video-sync', room.videoState);
    });

    // ---- Polls (preset questions, non-private) ----
    socket.on('start-poll', (pollData = {}) => {
        const roomId = socket.data.roomId;
        if (!roomId) return;
        const room = getRoom(roomId);
        room.poll = { ...pollData, id: Date.now(), startTime: Date.now() };
        room.pollVotes.clear();
        io.to(roomId).emit('poll-started', room.poll);
    });

    socket.on('poll-vote', (voteData = {}) => {
        const roomId = socket.data.roomId;
        if (!roomId) return;
        const room = getRoom(roomId);
        if (room.poll && voteData.pollId === room.poll.id) {
            room.pollVotes.set(socket.id, { user: voteData.user, option: voteData.option });
            io.to(roomId).emit('poll-vote', { user: voteData.user, option: voteData.option });
        }
    });

    socket.on('poll-end', () => {
        const roomId = socket.data.roomId;
        if (!roomId) return;
        const room = getRoom(roomId);
        if (room.poll) {
            io.to(roomId).emit('poll-ended', { results: Array.from(room.pollVotes.values()) });
            room.poll = null;
            room.pollVotes.clear();
        }
    });

    // ---- WebRTC signaling relay (1:1 call; server never sees media) ----
    socket.on('rtc-signal', (data = {}) => {
        const roomId = socket.data.roomId;
        if (roomId) socket.to(roomId).emit('rtc-signal', { from: socket.id, signal: data.signal });
    });
    socket.on('call-hangup', () => {
        const roomId = socket.data.roomId;
        if (roomId) socket.to(roomId).emit('call-hangup', { from: socket.id });
    });

    socket.on('disconnect', () => leaveRoom(socket));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Watch-together server running on http://localhost:${PORT}`);
});
