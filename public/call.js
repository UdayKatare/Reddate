/* 1:1 video/audio call over WebRTC.
 *
 * Signaling (SDP + ICE) is relayed through the Socket.IO room; the actual audio
 * and video travel peer-to-peer and are end-to-end encrypted by WebRTC itself
 * (DTLS-SRTP). A TURN relay, if configured, only forwards encrypted packets and
 * cannot read the media. initCall() is called from app.js once the socket
 * connects.
 */
window.initCall = function (socket, getUserCount, toast) {
    const cfgPromise = fetch('/rtc-config').then(r => r.json())
        .catch(() => ({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }));

    let pc = null;
    let localStream = null;
    let pendingCandidates = [];
    let pendingOffer = null;
    let inCall = false;
    let micOn = true;
    let camOn = true;

    const panel = document.getElementById('callPanel');
    const incoming = document.getElementById('incomingCall');
    const remoteVideo = document.getElementById('remoteVideo');
    const localVideo = document.getElementById('localVideo');
    const statusEl = document.getElementById('callStatus');
    const setStatus = s => { statusEl.textContent = s; };

    async function getMedia() {
        if (localStream) return localStream;
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        localVideo.srcObject = localStream;
        return localStream;
    }

    async function createPC() {
        const cfg = await cfgPromise;
        pc = new RTCPeerConnection({ iceServers: cfg.iceServers });
        localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
        pc.onicecandidate = e => {
            if (e.candidate) socket.emit('rtc-signal', { signal: { candidate: e.candidate } });
        };
        pc.ontrack = e => { remoteVideo.srcObject = e.streams[0]; setStatus('Connected 🔒'); };
        pc.onconnectionstatechange = () => {
            if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) endCall(false);
        };
        return pc;
    }

    async function flushCandidates() {
        for (const c of pendingCandidates) { try { await pc.addIceCandidate(c); } catch (_) {} }
        pendingCandidates = [];
    }

    async function startCall() {
        if (inCall) return;
        if (getUserCount() !== 2) { toast('Calls are 1:1 — you need exactly 2 people in the room'); return; }
        try { await getMedia(); } catch (_) { toast('Camera/mic permission needed'); return; }
        inCall = true;
        panel.classList.add('show');
        setStatus('Calling…');
        await createPC();
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('rtc-signal', { signal: { sdp: pc.localDescription } });
    }

    async function acceptCall() {
        incoming.classList.remove('show');
        try { await getMedia(); } catch (_) { toast('Camera/mic permission needed'); declineCall(); return; }
        inCall = true;
        panel.classList.add('show');
        setStatus('Connecting…');
        await createPC();
        await pc.setRemoteDescription(pendingOffer);
        await flushCandidates();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('rtc-signal', { signal: { sdp: pc.localDescription } });
        pendingOffer = null;
    }

    function declineCall() {
        incoming.classList.remove('show');
        pendingOffer = null;
        pendingCandidates = [];
        socket.emit('call-hangup');
    }

    function endCall(notify = true) {
        if (notify) socket.emit('call-hangup');
        if (pc) { pc.close(); pc = null; }
        if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
        remoteVideo.srcObject = null;
        localVideo.srcObject = null;
        panel.classList.remove('show');
        incoming.classList.remove('show');
        inCall = false;
        pendingOffer = null;
        pendingCandidates = [];
        setStatus('Connecting…');
    }

    socket.on('rtc-signal', async ({ signal }) => {
        if (!signal) return;
        if (signal.sdp) {
            const desc = signal.sdp;
            if (desc.type === 'offer') {
                if (inCall) return; // busy / glare — ignore
                pendingOffer = new RTCSessionDescription(desc);
                document.getElementById('incomingText').textContent = 'Incoming video call… 📹';
                incoming.classList.add('show');
            } else if (desc.type === 'answer' && pc) {
                await pc.setRemoteDescription(new RTCSessionDescription(desc));
                await flushCandidates();
            }
        } else if (signal.candidate) {
            const cand = new RTCIceCandidate(signal.candidate);
            if (pc && pc.remoteDescription) { try { await pc.addIceCandidate(cand); } catch (_) {} }
            else pendingCandidates.push(cand);
        }
    });

    socket.on('call-hangup', () => {
        if (inCall || pendingOffer) { toast('Call ended'); endCall(false); }
    });

    document.getElementById('callBtn').addEventListener('click', startCall);
    document.getElementById('hangupBtn').addEventListener('click', () => endCall(true));
    document.getElementById('acceptCallBtn').addEventListener('click', acceptCall);
    document.getElementById('declineCallBtn').addEventListener('click', declineCall);
    document.getElementById('micBtn').addEventListener('click', () => {
        micOn = !micOn;
        if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = micOn);
        document.getElementById('micBtn').classList.toggle('off', !micOn);
    });
    document.getElementById('camBtn').addEventListener('click', () => {
        camOn = !camOn;
        if (localStream) localStream.getVideoTracks().forEach(t => t.enabled = camOn);
        document.getElementById('camBtn').classList.toggle('off', !camOn);
    });
};
