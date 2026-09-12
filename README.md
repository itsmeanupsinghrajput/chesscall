# ♟ ChessCall

> Omegle-style random video calls where strangers can optionally play chess together.

---

## ✨ Features

- 🎥 **Random Video Calls** — Peer-to-peer via WebRTC (no server sees your video)
- ♟ **Optional Chess** — Either player can invite the other to play chess mid-call
- ⏭ **Skip / Next** — Instantly move to a new stranger
- 💬 **Text Chat** — Chat alongside the video call
- 🎤 **Mic/Camera Toggle** — Mute yourself anytime
- 🏆 **Full Chess Rules** — Checkmate, stalemate, draw offers, resignation
- 📱 **Responsive** — Works on desktop & mobile

---

## 🚀 Run Locally (5 minutes)

### Requirements
- Node.js 18+ (https://nodejs.org)

### Steps

```bash
# 1. Install dependencies
npm install

# 2. Start the server
npm start

# 3. Open in browser
# Go to: http://localhost:3000
```

For live reload during development:
```bash
npm run dev
```

> ⚠️ WebRTC requires HTTPS in production. Localhost works without HTTPS.

---

## 🌐 Deploy Free (Production)

### Option A: Render.com (Recommended — Free)

1. Push code to GitHub
2. Go to https://render.com → New → Web Service
3. Connect your GitHub repo
4. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Environment:** Node
5. Click Deploy!

> ℹ️ Free tier sleeps after 15 min inactivity. Use https://uptimerobot.com (free) to ping it every 10 min.

### Option B: Railway.app

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

### Option C: Fly.io

```bash
npm install -g flyctl
fly launch
fly deploy
```

---

## 📁 Project Structure

```
chesscall/
├── server.js          ← Node.js + Socket.io backend
├── package.json
└── public/
    ├── index.html     ← Main UI
    ├── style.css      ← Dark theme styling
    └── client.js      ← WebRTC + Chess + Socket client
```

---

## ⚙️ How It Works

### Matchmaking
```
User clicks "Start Talking"
  → Camera/mic permission requested
  → Socket connects to server
  → Server puts user in waiting queue
  → When 2 users are in queue → matched into a private room
  → WebRTC peer connection established (video/audio direct P2P)
```

### Skip
```
User clicks "Next"
  → Server notified
  → Current partner sees "Stranger disconnected"
  → Both users put back in waiting queue
  → Re-matched with new strangers
```

### Chess Invite Flow
```
User A clicks "Play Chess"
  → User B sees modal: "Accept / Decline"
  → If accepted: server assigns colors randomly
  → Chess board slides up below the video
  → Moves synced via Socket.io events
```

---

## 🔒 Privacy Notes

- Video/audio is **peer-to-peer** (WebRTC) — never passes through the server
- No accounts, no login, no data stored
- Chat messages are relayed through server but not saved
- Chess moves relayed through server but not saved

---

## 🛠️ Tech Stack

| Layer | Tech |
|-------|------|
| Backend | Node.js + Express + Socket.io |
| Frontend | Vanilla JS + HTML + CSS |
| Video | WebRTC (PeerConnection) |
| Chess logic | chess.js |
| Chess board UI | chessboard.js |
| Hosting | Render / Railway / Fly.io |

---

## 💡 Future Ideas

- [ ] Multiple game options (Connect 4, Tic-tac-toe)
- [ ] Country flags / optional usernames
- [ ] Report / moderation system
- [ ] Spectator mode
- [ ] ELO rating for chess

---

## 📄 License

MIT — do whatever you want with it!
