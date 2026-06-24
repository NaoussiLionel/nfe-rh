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
- `koyeb.yaml` — Koyeb deployment config with volume at `/data`

## Environment Variables
- `DATA_DIR` — path for persistent storage (DB + WhatsApp auth), defaults to `.`
- `PORT` — server port, defaults to 3000

## What Needs to Be Done
### 1. Deploy on Koyeb
1. Go to https://app.koyeb.com → sign up with GitHub
2. Create App → GitHub → `NaoussiLionel/nfe-rh`
3. Builder: Dockerfile, Port: 3000
4. Add volume: name `data`, mount path `/data`, 1GB
5. Add env var: `DATA_DIR=/data`
6. Deploy

### 2. After Deployment
1. Open the Koyeb URL
2. Go to ⚙️ > Connexion WhatsApp → scan QR code with WhatsApp
3. Test by sending "In" / "Out" from WhatsApp
4. Verify the dashboard shows data

### 3. Possible Improvements (Future)
- CSV export of time entries
- WhatsApp notification when admin sends reports
- More employees via the mapping interface
- Role-based access (admin vs viewer)
- Add cloud DB option (Turso) for multi-instance deployment

## Technical Details
- WhatsApp auth stored in `{DATA_DIR}/auth_info/`
- SQLite DB stored at `{DATA_DIR}/rh.db`
- Server auto-creates `DATA_DIR` if it doesn't exist
- Cron auto-closes open OUT at 23:59 using configured shift end time
- Browser caching defeated via `Cache-Control: no-store` + timestamp query param
- QR code captured from Baileys `connection.update` event and served via `/api/whatsapp/status`
- Frontend polls `/api/whatsapp/status` every 3s when showing QR page
- Uses `qrcode.js` CDN library to render QR in browser

## Local Development
```bash
npm install
npm start
# Server on http://localhost:3000
```
