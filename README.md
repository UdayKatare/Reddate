# Reddate

Create a private room, drop in a video, and watch it in perfect sync while you
chat — with **end-to-end encrypted** messages and an optional **1:1 video/audio
call**. No accounts, no database, nothing stored. Rooms disappear the moment
everyone leaves.

Originally built as a two-person virtual-date page, now reworked so **anyone,
anywhere** can spin up a room and share the link. Styled after Reddit
(light theme: white + orange).

## Features

- 🎬 **Synced video playback** — YouTube links *and* direct video URLs (`.mp4`,
  `.webm`, `.ogg`, …). Play, pause, seek and load together; late joiners and
  drifters auto-catch-up. Playback commands that arrive before a viewer's player
  is ready are buffered and applied on load, so nobody has to "press play first".
- 🔒 **End-to-end encrypted chat** — messages are encrypted in the browser with
  AES-GCM 256. The room key lives only in the invite link (after the `#`) and
  never touches the server, which relays opaque ciphertext only.
- 📹 **1:1 video/audio call** — peer-to-peer over WebRTC, end-to-end encrypted by
  DTLS-SRTP. Signaling is relayed through the room; media never touches the
  server. Includes incoming-call banner, mic/camera toggles, and hang-up.
- 🖼️ **Image & GIF sharing** — upload an image (sent E2E as a data URL, 2 MB cap)
  or paste a GIF/image URL into the chat.
- ⌨️ **Live typing indicators** and reaction "rain" on trigger words (`love`,
  `lol`, `fire`, …), detected locally on decrypted text.
- 💬 **Lightweight polls** to keep the room fun.
- ⬆️⬇️ **Reddit-style UI** — subreddit-style header, OP tag, cosmetic upvote/downvote,
  and a "Comment" send button.
- 🔗 **Shareable invite links** — create a room, copy the link, send it to anyone.
- 👥 **Multi-participant rooms** — share the link with as many people as you like
  (the call is 1:1; chat and video sync are group-wide).

## How the privacy model works

Reddate uses a shared-key end-to-end encryption scheme:

1. When you create a room, the browser generates a random room ID and a 256-bit
   AES-GCM key.
2. Both are placed in the URL **fragment**: `.../#room=<id>&k=<key>`. Browsers
   never send the fragment to the server, so the key stays client-side.
3. Everyone who opens the invite link gets the same key and can decrypt each
   other's messages. The server only ever relays opaque ciphertext.
4. Trigger-word reactions are detected locally on decrypted text, so no
   plaintext ever leaves your browser.

> **Note:** anyone with the invite link can read the room, so treat the link
> like a password. This protects against a curious/compromised server, not
> against someone you shared the link with. Chat history is never persisted.

### What is and isn't private

| Data | Private? |
|------|----------|
| Chat text & uploaded images | ✅ End-to-end encrypted (AES-GCM); server sees ciphertext only |
| Video/audio call media | ✅ End-to-end encrypted by WebRTC (DTLS-SRTP); peer-to-peer |
| Reaction detection | ✅ Runs locally on decrypted text |
| Which video is loaded / playback position | ⚠️ Relayed in the clear (server coordinates sync) |
| GIF-by-URL and direct video links | ⚠️ Fetched from the external host, revealing your IP to it — not E2E |

## Getting started

Requires Node.js 14+.

```bash
npm install
npm start          # or: npm run dev  (auto-reload with nodemon)
```

Then open http://localhost:3000, enter a display name, and click
**Create a room**. Copy the invite link and share it. Paste a YouTube or direct
video URL to start watching, and hit **📹 Start Call** for a 1:1 video chat.

Set a custom port with `PORT=8080 npm start`.

Optional environment variables:

- `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` — a TURN relay for calls behind
  strict NATs. STUN-only (default) works on most networks.

## Project structure

```
server.js          # Socket.IO relay server: rooms, video-state sync, ciphertext relay, WebRTC signaling
public/index.html  # Markup + styles (lobby + app shell)
public/app.js      # Client logic: E2E crypto, chat, video sync (YouTube + direct links), polls
public/call.js     # 1:1 WebRTC video/audio call (E2E via DTLS-SRTP)
```

The server keeps all room state in memory (`rooms` Map) and never inspects
message contents.

## Deploying

This is a **single long-lived Node process**: Socket.IO needs a persistent
connection and rooms live in memory, so it must run on a platform that keeps a
process alive — not on serverless/static hosts. **Vercel and Netlify won't work
without a rewrite** (they'd need an external WebSocket service + Redis for shared
state). Good fits: **Render**, **Railway**, **Fly.io**, or any VPS.

Run behind **HTTPS** — invite links stay protected in transit, and browsers only
grant camera/mic (for calls) on secure origins.

### Render (one-click Blueprint)

A [`render.yaml`](render.yaml) blueprint is included. On [render.com](https://render.com):

1. **New +** → **Blueprint**, connect this GitHub repo.
2. Render reads `render.yaml` and provisions a free web service (`npm install`
   → `npm start`). `PORT` is injected automatically.
3. (Optional) Set `TURN_URL` / `TURN_USERNAME` / `TURN_CREDENTIAL` in the
   dashboard for reliable calls behind strict NATs. STUN-only works otherwise.

Then open the service URL, pick a name, and create a room.


## Roadmap

- Shared video queue and presence
- Group calls (currently 1:1)
- More video sources
- QR-code room invites

## License

MIT
