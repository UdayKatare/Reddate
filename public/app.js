/* WatchTogether client.
 *
 * End-to-end encryption: each room has an AES-GCM key that lives only in the
 * URL fragment (#room=<id>&k=<key>). The fragment is never sent to the server,
 * so the server only ever relays ciphertext. Every participant shares the same
 * link, so they all hold the same key and can decrypt each other's messages.
 */

// ---------------- Crypto helpers ----------------
const enc = new TextEncoder();
const dec = new TextDecoder();

function bytesToB64url(bytes) {
    let bin = '';
    bytes.forEach(b => bin += String.fromCharCode(b));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToBytes(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    const bin = atob(str);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

async function generateRoomKey() {
    return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}
async function exportKey(key) {
    const raw = await crypto.subtle.exportKey('raw', key);
    return bytesToB64url(new Uint8Array(raw));
}
async function importKey(b64) {
    return crypto.subtle.importKey('raw', b64urlToBytes(b64), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
async function encryptText(key, text) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text));
    return { iv: bytesToB64url(iv), ciphertext: bytesToB64url(new Uint8Array(ct)) };
}
async function decryptText(key, payload) {
    const iv = b64urlToBytes(payload.iv);
    const data = b64urlToBytes(payload.ciphertext);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
    return dec.decode(plain);
}

function randomRoomId() {
    return bytesToB64url(crypto.getRandomValues(new Uint8Array(9)));
}

// ---------------- Fragment parsing ----------------
function parseFragment() {
    const params = new URLSearchParams(location.hash.replace(/^#/, ''));
    return { roomId: params.get('room'), keyB64: params.get('k') };
}

// ---------------- App state ----------------
let socket = null;
let roomKey = null;      // CryptoKey
let roomId = null;
let currentUser = 'Guest';

let vp = null;              // unified player adapter (YouTube or HTML5 <video>)
let currentSrc = '';        // videoId (yt) or url (direct) currently loaded
let isPlayerReady = false;
let isVideoPlaying = false;
let ignoreNextStateChange = false;
let typingTimer = null;

// Generic trigger words -> reaction emoji. Detected client-side on decrypted
// text, so no plaintext ever leaves the browser.
const rainTriggers = {
    love: '❤️', heart: '❤️', lol: '😂', haha: '😂', omg: '😲',
    wow: '🤩', sad: '😢', fire: '🔥', party: '🎉', gg: '🎮'
};

const genericPolls = [
    { question: 'What should we watch next? 🎬', options: ['Comedy 😂', 'Action 💥', 'Something chill 😌', 'Surprise me! 🎲'] },
    { question: 'How\'s the vibe right now? ✨', options: ['Loving it 😍', 'Pretty good 😊', 'Let\'s switch it up 🔄', 'Need a break ☕'] },
    { question: 'Snack of choice for this watch party? 🍿', options: ['Popcorn 🍿', 'Chips 🥔', 'Sweets 🍫', 'Just vibes 😎'] }
];

let currentPoll = null;
let pollVotes = new Map();
let hasVotedInCurrentPoll = false;
let userCount = 0;
let tenorConfig = null; // { provider, key } fetched lazily

// ---------------- Lobby ----------------
const lobbyEl = document.getElementById('lobby');
const appEl = document.getElementById('app');
const usernameInput = document.getElementById('usernameInput');
const lobbyBtn = document.getElementById('lobbyBtn');
const lobbyTagline = document.getElementById('lobbyTagline');

const existing = parseFragment();
const isJoining = !!(existing.roomId && existing.keyB64);

if (isJoining) {
    lobbyBtn.textContent = 'Join room';
    lobbyTagline.textContent = 'You\'ve been invited to a room. Pick a name and jump in.';
}

usernameInput.focus();
usernameInput.addEventListener('keydown', e => { if (e.key === 'Enter') lobbyBtn.click(); });

lobbyBtn.addEventListener('click', async () => {
    const name = usernameInput.value.trim();
    if (!name) { usernameInput.focus(); return; }
    currentUser = name;
    lobbyBtn.disabled = true;

    if (isJoining) {
        roomId = existing.roomId;
        roomKey = await importKey(existing.keyB64);
    } else {
        roomId = randomRoomId();
        const key = await generateRoomKey();
        roomKey = key;
        const keyB64 = await exportKey(key);
        location.hash = `room=${encodeURIComponent(roomId)}&k=${keyB64}`;
    }

    startApp();
});

function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), 2200);
}

// ---------------- Main app ----------------
function startApp() {
    lobbyEl.classList.add('hidden');
    appEl.classList.remove('hidden');

    socket = io();

    socket.on('connect', () => {
        document.getElementById('connectionStatus').classList.remove('disconnected');
        document.getElementById('connectionText').textContent = 'Connected';
        socket.emit('join-room', { roomId, username: currentUser });
    });
    socket.on('disconnect', () => {
        document.getElementById('connectionStatus').classList.add('disconnected');
        document.getElementById('connectionText').textContent = 'Disconnected';
    });

    socket.on('joined', () => addSystemMessage('🔒 Connected securely. Share the invite link to bring someone in.'));
    socket.on('user-count', c => {
        userCount = c;
        document.getElementById('userCount').textContent = `${c} online`;
    });
    socket.on('system-message', d => addSystemMessage(d.message));

    socket.on('new-message', async data => {
        try {
            const text = await decryptText(roomKey, data);
            const msg = parseEnvelope(text);
            addMessage(msg, data.username, 'other');
            if (msg.t === 'text') detectTriggers(msg.v);
        } catch (e) {
            addSystemMessage('⚠️ Received a message that could not be decrypted (key mismatch).');
        }
    });

    const currentlyTyping = new Set();
    socket.on('user-typing', data => {
        const el = document.getElementById('typingIndicator');
        if (data.isTyping) currentlyTyping.add(data.username);
        else currentlyTyping.delete(data.username);
        if (currentlyTyping.size > 0) {
            el.textContent = `${Array.from(currentlyTyping).join(', ')} is typing...`;
            el.style.display = 'block';
        } else el.style.display = 'none';
    });

    wireVideoEvents();
    wirePollEvents();
    wireControls();
    startPollTimer();

    document.getElementById('postAuthor').textContent = `Posted by u/${currentUser}`;

    // Hand the connected socket to the call module (defined in call.js).
    if (window.initCall) window.initCall(socket, () => userCount, showToast);
}

// ---------------- Chat ----------------
const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MB cap on uploads

// Messages are encrypted as a small JSON envelope so we can carry text or
// images over the same E2E channel. { t: 'text' | 'img', v: <string> }
function parseEnvelope(raw) {
    try {
        const obj = JSON.parse(raw);
        if (obj && (obj.t === 'text' || obj.t === 'img')) return obj;
    } catch { /* legacy/plain text */ }
    return { t: 'text', v: raw };
}

async function sendChat(msg) {
    if (!roomKey) return;
    addMessage(msg, currentUser, 'self');
    if (msg.t === 'text') detectTriggers(msg.v);
    const payload = await encryptText(roomKey, JSON.stringify(msg));
    socket.emit('send-message', payload);
}

async function sendMessage() {
    const input = document.getElementById('messageInput');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    socket.emit('typing-stop');
    await sendChat({ t: 'text', v: text });
}

function sendImageFromFile(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) { showToast('Please pick an image or GIF'); return; }
    if (file.size > MAX_IMAGE_BYTES) { showToast('Image too large (max 2 MB)'); return; }
    const reader = new FileReader();
    reader.onload = () => sendChat({ t: 'img', v: reader.result }); // encrypted data URL
    reader.readAsDataURL(file);
}

function sendGifByUrl() {
    const url = (prompt('Paste an image or GIF URL:') || '').trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) { showToast('Enter a valid http(s) URL'); return; }
    sendChat({ t: 'img', v: url });
}

// ---------------- Tenor GIF picker ----------------
async function loadTenorConfig() {
    if (tenorConfig) return tenorConfig;
    try {
        tenorConfig = await (await fetch('/gif-config')).json();
    } catch { tenorConfig = { provider: 'tenor', key: '' }; }
    return tenorConfig;
}

async function openGifPicker() {
    const cfg = await loadTenorConfig();
    if (!cfg.key) {
        // No Tenor key configured — fall back to pasting a URL.
        showToast('No Tenor key set — paste a URL instead');
        sendGifByUrl();
        return;
    }
    document.getElementById('gifModal').classList.add('show');
    const search = document.getElementById('gifSearch');
    search.value = '';
    search.focus();
    tenorSearch(''); // featured/trending on open
}

let tenorTimer = null;
function scheduleTenorSearch(q) {
    clearTimeout(tenorTimer);
    tenorTimer = setTimeout(() => tenorSearch(q), 300);
}

async function tenorSearch(query) {
    const cfg = await loadTenorConfig();
    if (!cfg.key) return;
    const base = query.trim()
        ? `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(query)}`
        : 'https://tenor.googleapis.com/v2/featured';
    const url = `${base}${base.includes('?') ? '&' : '?'}key=${cfg.key}&client_key=watchtogether&limit=24&media_filter=tinygif,gif`;
    const grid = document.getElementById('gifGrid');
    try {
        const data = await (await fetch(url)).json();
        grid.innerHTML = '';
        (data.results || []).forEach(r => {
            const media = r.media_formats || {};
            const thumb = (media.tinygif || media.gif || {}).url;
            const full = (media.gif || media.tinygif || {}).url;
            if (!thumb || !full) return;
            const img = document.createElement('img');
            img.src = thumb;
            img.loading = 'lazy';
            img.onclick = () => {
                sendChat({ t: 'img', v: full });
                document.getElementById('gifModal').classList.remove('show');
            };
            grid.appendChild(img);
        });
    } catch {
        grid.innerHTML = '<p style="color:#818384;font-size:12px">Couldn\'t reach Tenor.</p>';
    }
}

function addMessage(msg, username, kind) {
    const chat = document.getElementById('chatMessages');
    const div = document.createElement('div');
    div.className = `message ${kind}`;
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    div.innerHTML = `
        <div class="message-header">
            <span class="username ${kind === 'self' ? 'self' : ''}"></span>
            <span class="timestamp">${time}</span>
        </div>
        <div class="message-content"></div>`;
    div.querySelector('.username').textContent = username;
    const body = div.querySelector('.message-content');
    if (msg.t === 'img') {
        const img = document.createElement('img');
        img.alt = 'shared image';
        img.loading = 'lazy';
        img.src = msg.v;           // data URL (uploaded) or external URL (GIF link)
        body.appendChild(img);
    } else {
        body.textContent = msg.v;  // textContent — never innerHTML, avoids injection
    }
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
}

function addSystemMessage(text) {
    const chat = document.getElementById('chatMessages');
    const div = document.createElement('div');
    div.className = 'message system-message';
    div.innerHTML = '<div class="message-content"></div>';
    div.querySelector('.message-content').textContent = text;
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
    setTimeout(() => {
        div.style.transition = 'opacity 0.3s, transform 0.3s';
        div.style.opacity = '0';
        div.style.transform = 'translateY(-20px)';
        setTimeout(() => div.remove(), 300);
    }, 4000);
}

function detectTriggers(text) {
    const lower = text.toLowerCase();
    Object.keys(rainTriggers).forEach(word => {
        if (lower.includes(word)) triggerRain(rainTriggers[word]);
    });
}

function triggerRain(emoji) {
    const container = document.getElementById('rainContainer');
    for (let i = 0; i < 12; i++) {
        setTimeout(() => {
            const drop = document.createElement('div');
            drop.className = 'rain-emoji';
            drop.textContent = emoji;
            drop.style.left = Math.random() * 100 + 'vw';
            drop.style.animationDuration = (Math.random() * 2 + 2) + 's';
            container.appendChild(drop);
            setTimeout(() => drop.remove(), 4000);
        }, i * 120);
    }
}

// ---------------- Video sync ----------------
// A room can play a YouTube video OR a direct video-file URL (.mp4/.webm/…).
// Both are wrapped in a small adapter (`vp`) with a common play/pause/seek API
// so the sync logic below doesn't care which kind is loaded.
let ytApiReady = false;
function onYouTubeIframeAPIReady() { ytApiReady = true; }
window.onYouTubeIframeAPIReady = onYouTubeIframeAPIReady;

function stageEl() { return document.getElementById('videoPlayer'); }
function consumeIgnore() { const i = ignoreNextStateChange; ignoreNextStateChange = false; return i; }

function destroyPlayer() {
    if (vp && vp.destroy) { try { vp.destroy(); } catch (_) {} }
    vp = null;
    isPlayerReady = false;
    stageEl().innerHTML = '';
}

function onLocalPlayPause(playing) {
    isVideoPlaying = playing;
    updatePlayPauseButton();
    socket.emit('video-playpause', { isPlaying: playing, currentTime: vp ? vp.getCurrentTime() : 0 });
}

function createYouTubePlayer(videoId) {
    if (!window.YT || !YT.Player) { setTimeout(() => createYouTubePlayer(videoId), 300); return; }
    destroyPlayer();
    currentSrc = videoId;
    const mount = document.createElement('div');
    stageEl().appendChild(mount);
    const yt = new YT.Player(mount, {
        height: '400', width: '100%', videoId,
        playerVars: { autoplay: 0, controls: 1, rel: 0, modestbranding: 1 },
        events: {
            onReady: () => { isPlayerReady = true; updatePlayPauseButton(); },
            onStateChange: (e) => {
                if (consumeIgnore()) return;
                const playing = e.data === YT.PlayerState.PLAYING;
                const paused = e.data === YT.PlayerState.PAUSED;
                if (playing || paused) onLocalPlayPause(playing);
            }
        }
    });
    vp = {
        getCurrentTime: () => yt.getCurrentTime() || 0,
        seekTo: (t) => yt.seekTo(t, true),
        play: () => yt.playVideo(),
        pause: () => yt.pauseVideo(),
        destroy: () => yt.destroy()
    };
}

function createDirectPlayer(src) {
    destroyPlayer();
    currentSrc = src;
    const v = document.createElement('video');
    v.src = src;
    v.controls = true;
    v.playsInline = true;
    v.style.cssText = 'width:100%;height:400px;background:#000;border-radius:4px;';
    stageEl().appendChild(v);
    v.addEventListener('loadeddata', () => { isPlayerReady = true; updatePlayPauseButton(); });
    v.addEventListener('play', () => { if (!consumeIgnore()) onLocalPlayPause(true); });
    v.addEventListener('pause', () => { if (!consumeIgnore()) onLocalPlayPause(false); });
    v.addEventListener('seeked', () => socket.emit('video-seek', { currentTime: v.currentTime }));
    v.addEventListener('error', () => showToast('Could not load that video link (bad format or blocked by CORS)'));
    vp = {
        getCurrentTime: () => v.currentTime || 0,
        seekTo: (t) => { v.currentTime = t; },
        play: () => v.play(),
        pause: () => v.pause(),
        destroy: () => { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); }
    };
}

function ensurePlayer(state) {
    const kind = state.kind || 'yt';
    const key = kind === 'direct' ? state.src : state.videoId;
    if (!key) return false;
    if (!vp || currentSrc !== key) {
        kind === 'direct' ? createDirectPlayer(state.src) : createYouTubePlayer(state.videoId);
    }
    return true;
}


function wireVideoEvents() {
    socket.on('video-loaded', data => {
        ensurePlayer(data);
        addSystemMessage(`🎬 ${data.user} loaded a video`);
    });
    socket.on('video-playpause-sync', data => {
        if (!vp || !isPlayerReady) return;
        isVideoPlaying = data.isPlaying;
        updatePlayPauseButton();
        ignoreNextStateChange = true;
        data.isPlaying ? vp.play() : vp.pause();
    });
    socket.on('video-progress-sync', data => {
        if (!vp || !isPlayerReady) return;
        if (Math.abs(vp.getCurrentTime() - data.currentTime) > 2) vp.seekTo(data.currentTime);
    });
    socket.on('video-seek', data => {
        if (vp && isPlayerReady) vp.seekTo(data.currentTime);
    });
    socket.on('video-sync', state => {
        if (!ensurePlayer(state)) return;
        const apply = () => {
            ignoreNextStateChange = true;
            state.isPlaying ? vp.play() : vp.pause();
            if (state.currentTime) vp.seekTo(state.currentTime);
        };
        isPlayerReady ? apply() : setTimeout(apply, 1200);
    });

    // Periodically share our position so late joiners / drifters stay in sync.
    setInterval(() => {
        if (vp && isPlayerReady && isVideoPlaying) {
            socket.emit('video-progress', { currentTime: vp.getCurrentTime() });
        }
    }, 4000);
}

function loadVideo() {
    const url = document.getElementById('videoUrl').value.trim();
    if (!url) return;
    let videoId = null;
    if (url.includes('youtu.be/')) videoId = url.split('youtu.be/')[1].split(/[?&]/)[0];
    else if (url.includes('v=')) videoId = url.split('v=')[1].split('&')[0];
    if (videoId) { socket.emit('load-video', { kind: 'yt', videoId, url }); return; }
    if (/^https?:\/\/\S+\.(mp4|webm|ogg|ogv|m4v|mov)(\?\S*)?$/i.test(url)) {
        socket.emit('load-video', { kind: 'direct', src: url });
        return;
    }
    showToast('Enter a YouTube link or a direct video URL (.mp4, .webm, .ogg)');
}

function togglePlayPause() {
    if (!vp || !isPlayerReady) { showToast('Load a video first'); return; }
    const shouldPlay = !isVideoPlaying;
    isVideoPlaying = shouldPlay;
    updatePlayPauseButton();
    ignoreNextStateChange = true;
    socket.emit('video-playpause', { isPlaying: shouldPlay, currentTime: vp.getCurrentTime() });
    shouldPlay ? vp.play() : vp.pause();
}

function updatePlayPauseButton() {
    document.getElementById('playPauseBtn').textContent = isVideoPlaying ? '⏸️ Pause' : '▶️ Play';
}

function syncVideo() {
    if (!vp || !isPlayerReady) { showToast('Load a video first'); return; }
    socket.emit('sync-request', { currentTime: vp.getCurrentTime(), isPlaying: isVideoPlaying });
    addSystemMessage('🔄 Syncing everyone...');
}

// ---------------- Controls & share ----------------
function wireControls() {
    document.getElementById('loadBtn').addEventListener('click', loadVideo);
    document.getElementById('playPauseBtn').addEventListener('click', togglePlayPause);
    document.getElementById('syncBtn').addEventListener('click', syncVideo);
    document.getElementById('sendBtn').addEventListener('click', sendMessage);

    const msgInput = document.getElementById('messageInput');
    msgInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendMessage(); });
    msgInput.addEventListener('input', () => {
        socket.emit('typing-start');
        clearTimeout(typingTimer);
        typingTimer = setTimeout(() => socket.emit('typing-stop'), 1000);
    });

    document.getElementById('shareBtn').addEventListener('click', async () => {
        const link = location.href;
        try {
            await navigator.clipboard.writeText(link);
            showToast('Invite link copied 🔗');
        } catch {
            prompt('Copy this invite link:', link);
        }
    });

    // Image / GIF sharing (sent over the encrypted channel)
    const fileInput = document.getElementById('fileInput');
    document.getElementById('imgBtn').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
        sendImageFromFile(fileInput.files[0]);
        fileInput.value = '';
    });
    document.getElementById('gifBtn').addEventListener('click', openGifPicker);
    document.getElementById('gifSearch').addEventListener('input', e => scheduleTenorSearch(e.target.value));
    // Close modals when clicking the dark backdrop.
    document.querySelectorAll('.modal').forEach(m => {
        m.addEventListener('click', e => { if (e.target === m) m.classList.remove('show'); });
    });

    // Cosmetic Reddit-style vote widget
    let vote = 0; // -1, 0, 1
    const up = document.getElementById('upvoteArrow');
    const down = document.getElementById('downvoteArrow');
    const count = document.getElementById('voteCount');
    const renderVote = () => {
        count.textContent = 1 + vote;
        up.classList.toggle('upvoted', vote === 1);
        down.classList.toggle('downvoted', vote === -1);
    };
    up.addEventListener('click', () => { vote = vote === 1 ? 0 : 1; renderVote(); });
    down.addEventListener('click', () => { vote = vote === -1 ? 0 : -1; renderVote(); });
}

// ---------------- Polls ----------------
function wirePollEvents() {
    socket.on('poll-started', poll => {
        currentPoll = poll;
        pollVotes.clear();
        hasVotedInCurrentPoll = false;
        showPoll(poll);
    });
    socket.on('poll-vote', vote => { pollVotes.set(vote.user, vote.option); updatePollResults(); });
    socket.on('poll-ended', () => {
        setTimeout(() => { document.getElementById('pollModal').classList.remove('show'); currentPoll = null; }, 5000);
    });
}

function startPollTimer() {
    const delay = (10 + Math.random() * 5) * 60 * 1000; // 10-15 min
    setTimeout(() => {
        if (document.querySelectorAll('#chatMessages .message').length > 5) {
            socket.emit('start-poll', genericPolls[Math.floor(Math.random() * genericPolls.length)]);
        }
        startPollTimer();
    }, delay);
}

function showPoll(poll) {
    document.getElementById('pollQuestion').textContent = poll.question;
    const container = document.getElementById('pollOptions');
    container.style.display = 'block';
    container.innerHTML = '';
    poll.options.forEach((option, i) => {
        const div = document.createElement('div');
        div.className = 'poll-option';
        div.textContent = option;
        div.onclick = () => votePoll(i, option);
        container.appendChild(div);
    });
    document.getElementById('pollResults').style.display = 'none';
    document.getElementById('pollModal').classList.add('show');
}

function votePoll(index, optionText) {
    if (hasVotedInCurrentPoll) return;
    hasVotedInCurrentPoll = true;
    const opts = document.querySelectorAll('.poll-option');
    opts[index].classList.add('voted');
    opts.forEach(o => o.style.pointerEvents = 'none');
    socket.emit('poll-vote', { pollId: currentPoll.id, option: optionText, user: currentUser });
    setTimeout(() => {
        document.getElementById('pollOptions').style.display = 'none';
        document.getElementById('pollResults').style.display = 'block';
        updatePollResults();
    }, 800);
}

function updatePollResults() {
    if (!currentPoll) return;
    const container = document.getElementById('pollResults');
    container.innerHTML = '<h3 style="margin-bottom:15px;color:#46d160">Results so far</h3>';
    const total = pollVotes.size;
    const counts = new Map();
    pollVotes.forEach(opt => counts.set(opt, (counts.get(opt) || 0) + 1));
    currentPoll.options.forEach(option => {
        const count = counts.get(option) || 0;
        const pct = total > 0 ? Math.round((count / total) * 100) : 0;
        const div = document.createElement('div');
        div.className = 'poll-result';
        div.innerHTML = `<div><div class="label"></div><div class="poll-result-bar" style="width:${pct}%"></div></div>
            <div style="color:#ff4500;font-weight:bold">${count}</div>`;
        div.querySelector('.label').textContent = option;
        container.appendChild(div);
    });
}
