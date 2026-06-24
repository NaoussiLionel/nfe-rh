# NFE RH - Instructions pour l'agent

## Dépôt GitHub
https://github.com/NaoussiLionel/nfe-rh (branche `main`)

## Project Overview
HR dashboard SPA with WhatsApp-based time tracking (In/Out), SQLite persistence, configurable shift hours, weekly/monthly/yearly analysis. Built with Node.js/Express/SQLite/Baileys v7/Chart.js.

## Current State
- Dashboard + 6 tabs (Performance, Discipline, Charge, Analyse, Employés)
- WhatsApp bot reads "In"/"Out" messages silently, records time entries
- SQLite with 3 tables: `pointages` (time entries), `mappings` (WhatsApp name → employee name), `config` (shiftStart, shiftEnd)
- 480 rows sample data (4 employees, Jul 2025 - Jun 2026)
- Automatic weekly reports (Friday 15:00) and monthly reports (26th 15:00) sent to user's WhatsApp
- QR code displayed in browser for WhatsApp authentication (admin > Connexion WhatsApp)
- All brand colors extracted from logo: primary `#1a1a8a`, accent `#00C8FF`
- Reports include late warnings (≥3/week, ≥5/month), punctuality congratulations, OT master + burnout risk

## Key Files
- `server.js` — Express backend (592 lines): all API routes, WhatsApp connection, report generators, cron jobs
- `public/index.html` — SPA frontend (~1070 lines): all UI, Chart.js graphs, admin modal with WhatsApp QR
- `Dockerfile` — Node 18 Alpine, exposes 3000, uses `DATA_DIR` env var
- `koyeb.yaml` — Koyeb deployment config with volume at `/data` (optional, not used)

## Environment Variables
- `DATA_DIR` — path for persistent storage (DB + WhatsApp auth), defaults to `.`
- `PORT` — server port, defaults to 3000

## Deployment on Old Android Phone (recommended)

### Prerequisites
- Old Android phone (Android 7+)
- WiFi or mobile data (constant connection)
- Power supply (keep plugged in)

### Step 1: Install Termux
1. Install **F-Droid** from https://f-droid.org/
2. Search and install **Termux** from F-Droid (NOT from Google Play Store — Play Store version is outdated)
3. Open Termux

### Step 2: Install Dependencies in Termux
Run these commands in Termux:

```bash
# Update packages
pkg update && pkg upgrade -y

# Install Node.js and git
pkg install nodejs git -y

# Verify
node --version
npm --version
```

### Step 3: Clone and Setup the App
```bash
# Clone the repository
git clone https://github.com/NaoussiLionel/nfe-rh.git
cd nfe-rh

# Install dependencies
npm install

# Start the server
npm start
```

### Step 4: Access the Dashboard
- On the phone itself: open Chrome → `http://localhost:3000`
- To access from your PC/other devices, continue to Step 5

### Step 5: Expose via Cloudflare Tunnel (optional, for external access)
```bash
# Install cloudflared in Termux
pkg install cloudflared -y

# Run tunnel (in a new Termux session or background)
cloudflared tunnel --url http://localhost:3000
```
This gives you a public URL like `https://something.trycloudflare.com`
Access this URL from your PC or any device to see the dashboard.

### Step 6: Connect WhatsApp
1. Open the dashboard URL
2. Click ⚙️ > Connexion WhatsApp
3. Scan the QR code with WhatsApp (WhatsApp > Menu > Appareils liés > Lier un appareil)
4. Once connected, status shows ✅

### Step 7: Keep the App Running 24/7
To prevent Termux from being killed by Android:
- Enable **"Keep screen on"** while charging (Developer Options)
- Or use **Termux:Boot** (install from F-Droid) to auto-start on boot
- Or use **Termux:Widget** for easy start/stop
- Disable battery optimization for Termux (Settings > Apps > Termux > Battery > Unrestricted)

### Step 8: Keep Termux Running in Background
```bash
# Use tmux to keep process alive even if terminal closes
pkg install tmux -y
tmux new -s nfe
npm start
# Detach with Ctrl+B then D
# Reattach with: tmux attach -t nfe
```

## Usage
- Send **"In"** / **"Out"** on WhatsApp to clock in/out
- Dashboard refreshes every 5 seconds
- Weekly report: Friday 15:00 (auto)
- Monthly report: 26th 15:00 (auto)
- Manual report: ⚙️ > Simulation > Rapport semaine/mois

## Technical Details
- WhatsApp auth stored in `{DATA_DIR}/auth_info/`
- SQLite DB stored at `{DATA_DIR}/rh.db`
- Server auto-creates `DATA_DIR` if it doesn't exist
- Cron auto-closes open OUT at 23:59 using configured shift end time
- Browser caching defeated via `Cache-Control: no-store` + timestamp query param
- QR code captured from Baileys `connection.update` event and served via `/api/whatsapp/status`
- Frontend polls `/api/whatsapp/status` every 3s when showing QR page
- Uses `qrcode.js` CDN library to render QR in browser

## Local Development (PC)
```bash
npm install
npm start
# Server on http://localhost:3000
```
