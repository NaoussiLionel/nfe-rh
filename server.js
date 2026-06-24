const { makeWASocket, useMultiFileAuthState, Browsers, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;
const dataDir = process.env.DATA_DIR || '.';
app.use(express.json());
app.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
app.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
    const v = Date.now();
    res.redirect('/index.html?_=' + v);
});
app.use(express.static('public', { setHeaders: (res, p) => { if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, private'); } }));

const fs = require('fs');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const db = new sqlite3.Database(path.join(dataDir, 'rh.db'));
let shiftStart = '09:00';
let shiftEnd = '18:00';
let shiftStartMinutes = 540;

function loadConfig() {
    db.get(`SELECT valeur FROM config WHERE cle = 'shiftStart'`, (err, row) => {
        if (row) { shiftStart = row.valeur; shiftStartMinutes = parseInt(row.valeur.split(':')[0]) * 60 + parseInt(row.valeur.split(':')[1] || 0); }
    });
    db.get(`SELECT valeur FROM config WHERE cle = 'shiftEnd'`, (err, row) => {
        if (row) shiftEnd = row.valeur;
    });
}

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS pointages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employe TEXT,
        date TEXT,
        heure_entree TEXT,
        heure_sortie TEXT,
        heures_travaillees REAL DEFAULT 0,
        heures_supp REAL DEFAULT 0
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS mappings (
        whatsapp_name TEXT PRIMARY KEY,
        employee_name TEXT NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS config (
        cle TEXT PRIMARY KEY,
        valeur TEXT NOT NULL
    )`);
    db.run(`INSERT OR IGNORE INTO config (cle, valeur) VALUES ('shiftStart', '09:00')`);
    db.run(`INSERT OR IGNORE INTO config (cle, valeur) VALUES ('shiftEnd', '18:00')`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_employe_date ON pointages(employe, date)`);
    loadConfig();
});

function getMappedName(whatsappName) {
    return new Promise((resolve) => {
        db.get(`SELECT employee_name FROM mappings WHERE whatsapp_name = ?`, [whatsappName], (err, row) => {
            if (err || !row) resolve(whatsappName);
            else resolve(row.employee_name);
        });
    });
}

function enregistrerPointage(nom, action) {
    const aujourdhui = new Date().toISOString().split('T')[0];
    const heure = new Date().toTimeString().slice(0,5);
    db.get(`SELECT employee_name FROM mappings WHERE whatsapp_name = ?`, [nom], (err, row) => {
        const employe = (row && row.employee_name) ? row.employee_name : nom;
        if (action === 'IN') {
            db.run(`INSERT INTO pointages (employe, date, heure_entree) VALUES (?, ?, ?)`, [employe, aujourdhui, heure]);
            console.log(employe + ' IN ' + heure);
        } else if (action === 'OUT') {
            db.run(`UPDATE pointages SET heure_sortie = ?, heures_travaillees = ROUND((JULIANDAY(?) - JULIANDAY(heure_entree)) * 24, 2), heures_supp = ROUND(MAX(0, (JULIANDAY(?) - JULIANDAY('${shiftEnd}')) * 24), 2) WHERE employe = ? AND date = ? AND heure_sortie IS NULL`, [heure, heure, heure, employe, aujourdhui], function(err) {
                if (this.changes === 0) {
                    db.run(`INSERT INTO pointages (employe, date, heure_sortie) VALUES (?, ?, ?)`, [employe, aujourdhui, heure]);
                }
            });
            console.log(employe + ' OUT ' + heure);
        }
    });
}

cron.schedule('59 23 * * *', () => {
    db.run(`UPDATE pointages SET heure_sortie = '${shiftEnd}', heures_travaillees = ROUND((JULIANDAY('${shiftEnd}') - JULIANDAY(heure_entree)) * 24, 2), heures_supp = 0 WHERE date = DATE('now') AND heure_sortie IS NULL AND heure_entree IS NOT NULL`);
    console.log('Auto-close OUT done');
});

const logger = pino({ level: 'warn' });
let whatsAppSocket = null;
let whatsAppJid = null;
let whatsAppConnected = false;
let currentQR = null;

async function connecterWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(path.join(dataDir, 'auth_info'));
        const sock = makeWASocket({
            auth: state,
            browser: Browsers.ubuntu('Chrome'),
            syncFullHistory: false,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            logger,
        });
        let pairingTried = false;
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr && !pairingTried) {
                currentQR = qr;
                console.log('Scan QR code with WhatsApp');
                try {
                    const QRCode = require('qrcode-terminal');
                    QRCode.generate(qr, { small: true });
                } catch (e) {}
            }
            if (connection === 'open') {
                whatsAppConnected = true;
                whatsAppSocket = sock;
                whatsAppJid = sock.user?.id?.split(':')[0];
                console.log('WhatsApp connected');
                if (!state.creds.registered && !pairingTried) {
                    pairingTried = true;
                    const numero = process.env.WHATSAPP_NUMBER;
                    if (numero) {
                        try {
                            let code = await sock.requestPairingCode(numero.replace(/[^0-9]/g, ''));
                            code = code.match(/.{1,4}/g)?.join('-') || code;
                            console.log('Pairing code: ' + code);
                        } catch (err) {
                            console.error('Pairing error:', err.message);
                        }
                    }
                }
            }
            if (connection === 'close') {
                whatsAppConnected = false;
                whatsAppSocket = null;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                if (statusCode !== DisconnectReason.loggedOut) {
                    console.log('Reconnect in 10s...');
                    setTimeout(() => connecterWhatsApp().catch(() => {}), 10000);
                }
            }
        });
        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('messages.upsert', (m) => {
            const msg = m.messages[0];
            const texte = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
            if (texte) {
                const expediteur = msg.pushName || msg.key.participant?.split('@')[0] || msg.key.remoteJid?.split('@')[0] || 'Moi';
                const t = texte.trim().toLowerCase();
                let action = null;
                if (t === 'in' || t.startsWith('in') || t.includes(':in')) action = 'IN';
                else if (t === 'out' || t.startsWith('out') || t.includes(':out')) action = 'OUT';
                if (action) {
                    enregistrerPointage(expediteur, action);
                }
            }
        });
    } catch (err) {
        console.error('WhatsApp error:', err.message);
    }
}
connecterWhatsApp();

app.get('/api/stats', (req, res) => {
    const mois = new Date().toISOString().slice(0, 7);
    db.get(`SELECT ROUND(AVG(CASE WHEN heure_sortie IS NOT NULL THEN 1 ELSE 0 END) * 100, 1) as taux_presence, ROUND(AVG(heures_travaillees), 1) as avg_heures, ROUND(SUM(heures_supp), 1) as total_ot, (SELECT COUNT(*) FROM pointages WHERE date LIKE '${mois}%' AND heure_entree > '${shiftStart}') as total_retards FROM pointages WHERE date LIKE '${mois}%'`, (err, row) => {
        if (err) { console.error('stats err:', err); res.json({ taux_presence:0, avg_heures:0, total_ot:0, total_retards:0 }); return; }
        res.json(row || { taux_presence:0, avg_heures:0, total_ot:0, total_retards:0 });
    });
});

app.get('/api/ranking', (req, res) => {
    db.all(`SELECT employe, COUNT(*) as jours_presents, ROUND(AVG(heures_travaillees), 1) as avg_heures, ROUND(SUM(heures_supp), 1) as total_ot, ROUND((COUNT(*) * 1.0 / 180) * 40 + (1 - (AVG(heure_entree) - '${shiftStart}') / 60) * 30 + (SUM(heures_supp) / 100) * 20 + (COUNT(CASE WHEN heure_entree < '${shiftStart}' THEN 1 END) * 1.0 / COUNT(*)) * 10, 1) as score FROM pointages WHERE date >= '2026-01-01' AND heure_entree IS NOT NULL GROUP BY employe ORDER BY score DESC`, (err, rows) => {
        if (err) { console.error('ranking err:', err); res.json([]); return; }
        const result = rows.map((r, i) => {
            let badge = '4';
            if (i === 0) badge = '1';
            else if (i === 1) badge = '2';
            else if (i === 2) badge = '3';
            return { employe: r.employe, jours_presents: r.jours_presents, avg_heures: r.avg_heures, total_ot: r.total_ot, score: r.score, badge: badge };
        });
        res.json(result);
    });
});

app.get('/api/trends', (req, res) => {
    db.all(`SELECT strftime('%Y-%m', date) as mois, ROUND(AVG(CASE WHEN heure_sortie IS NOT NULL THEN 1 ELSE 0 END) * 100, 1) as presence FROM pointages WHERE date >= '2025-07-01' GROUP BY mois ORDER BY mois ASC`, (err, rows) => {
        if (err) { console.error('trends err:', err); res.json([]); return; }
        res.json(rows);
    });
});

app.get('/api/employee/:name', (req, res) => {
    const name = req.params.name;
    db.get(`SELECT employe, COUNT(*) as total_jours, ROUND(AVG(heures_travaillees), 1) as avg_heures, ROUND(SUM(heures_supp), 1) as total_ot, COUNT(CASE WHEN heure_entree > '${shiftStart}' THEN 1 END) as retards, COUNT(CASE WHEN heure_entree < '${shiftStart}' THEN 1 END) as arrives_tot FROM pointages WHERE employe = ?`, [name], (err, row) => {
        if (err) { console.error('employee err:', err); res.json({}); return; }
        res.json(row || {});
    });
});

app.get('/api/employee/:name/monthly', (req, res) => {
    const name = req.params.name;
    db.all(`SELECT strftime('%Y-%m', date) as mois, COUNT(*) as jours, ROUND(AVG(heures_travaillees), 1) as avg_heures, ROUND(SUM(heures_supp), 1) as total_ot, COUNT(CASE WHEN heure_entree > '${shiftStart}' THEN 1 END) as retards, COUNT(CASE WHEN heure_entree < '${shiftStart}' THEN 1 END) as avances, ROUND(AVG(CASE WHEN heure_sortie IS NOT NULL THEN 1 ELSE 0 END) * 100, 1) as presence FROM pointages WHERE employe = ? AND date >= '2025-07-01' GROUP BY mois ORDER BY mois`, [name], (err, rows) => {
        if (err) { console.error('employee monthly err:', err); res.json([]); return; }
        res.json(rows || []);
    });
});

app.get('/api/attendance-score', (req, res) => {
    db.all(`SELECT employe, COUNT(*) as jours_presents, COUNT(CASE WHEN heure_sortie IS NOT NULL THEN 1 END) as jours_complets, ROUND(AVG(heures_travaillees), 2) as avg_heures, ROUND(SUM(heures_supp), 1) as total_ot, ROUND(AVG(CASE WHEN heure_sortie IS NOT NULL THEN 1 ELSE 0 END) * 100, 1) as taux_presence, COUNT(CASE WHEN heure_entree > '${shiftStart}' THEN 1 END) as retards, COUNT(CASE WHEN heure_entree < '${shiftStart}' THEN 1 END) as avances, ROUND((COUNT(*) * 1.0 / 180) * 40 + (1 - (AVG(heure_entree) - '${shiftStart}') / 60) * 30 + (SUM(heures_supp) / 100) * 20 + (COUNT(CASE WHEN heure_entree < '${shiftStart}' THEN 1 END) * 1.0 / COUNT(*)) * 10, 1) as score FROM pointages WHERE date >= '2025-07-01' AND heure_entree IS NOT NULL GROUP BY employe ORDER BY score DESC`, (err, rows) => {
        if (err) { console.error('attendance-score err:', err); res.json([]); return; }
        const result = rows.map((r, i) => {
            let medal, badge;
            if (r.score >= 90) { medal = 'GOLD'; badge = '1'; }
            else if (r.score >= 80) { medal = 'SILVER'; badge = '2'; }
            else if (r.score >= 70) { medal = 'BRONZE'; badge = '3'; }
            else { medal = 'NI'; badge = '4'; }
            return { ...r, rang: i + 1, medal, badge };
        });
        res.json(result);
    });
});

app.get('/api/late-ranking', (req, res) => {
    db.all(`SELECT employe, COUNT(CASE WHEN heure_entree > '${shiftStart}' THEN 1 END) as retards, COUNT(*) as total_jours, ROUND(AVG(CASE WHEN heure_entree > '${shiftStart}' THEN (CAST(substr(heure_entree, 1, 2) AS REAL) * 60 + CAST(substr(heure_entree, 4, 2) AS REAL) - ${shiftStartMinutes}) END), 1) as avg_minutes_retard, ROUND(SUM(CASE WHEN heure_entree > '${shiftStart}' THEN (CAST(substr(heure_entree, 1, 2) AS REAL) * 60 + CAST(substr(heure_entree, 4, 2) AS REAL) - ${shiftStartMinutes}) ELSE 0 END), 1) as total_minutes_retard FROM pointages WHERE heure_entree IS NOT NULL GROUP BY employe HAVING retards > 0 ORDER BY retards DESC`, (err, rows) => {
        if (err) { console.error('late-ranking err:', err); res.json([]); return; }
        const result = rows.map((r, i) => ({ rang: i + 1, ...r }));
        res.json(result);
    });
});

app.get('/api/early-ranking', (req, res) => {
    db.all(`SELECT employe, COUNT(CASE WHEN heure_entree < '${shiftStart}' THEN 1 END) as avances, COUNT(*) as total_jours, ROUND(AVG(CASE WHEN heure_entree < '${shiftStart}' THEN (CAST(substr(heure_entree, 1, 2) AS REAL) * 60 + CAST(substr(heure_entree, 4, 2) AS REAL)) END), 1) as avg_minutes_arrivee, COUNT(CASE WHEN heure_entree < '${shiftStart}' THEN 1 END) * 1.0 / COUNT(*) as consistence FROM pointages WHERE heure_entree IS NOT NULL GROUP BY employe HAVING avances > 0 ORDER BY avances DESC`, (err, rows) => {
        if (err) { console.error('early-ranking err:', err); res.json([]); return; }
        const result = rows.map((r, i) => {
            const avgMin = r.avg_minutes_arrivee;
            const h = Math.floor(avgMin / 60);
            const m = Math.round(avgMin % 60);
            const avgArrival = (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
            const score = Math.round((r.avances / r.total_jours) * 40 + (1 - avgMin / shiftStartMinutes) * 30 + r.consistence * 30);
            return { rang: i + 1, ...r, avg_arrival: avgArrival, score };
        });
        res.json(result);
    });
});

app.get('/api/compensation', (req, res) => {
    db.all(`SELECT employe, ROUND(SUM(heures_supp), 1) as total_ot, COUNT(CASE WHEN heures_supp > 0 THEN 1 END) as jours_ot, ROUND(AVG(CASE WHEN heures_supp > 0 THEN heures_supp END), 2) as avg_ot_jour, ROUND(MAX(heures_supp), 2) as max_ot, ROUND(SUM(heures_supp) * 0.5, 1) as compensation_heures, ROUND(SUM(heures_supp) * 0.5 / 8, 1) as jours_compensation FROM pointages WHERE heures_supp IS NOT NULL AND heures_supp > 0 GROUP BY employe ORDER BY total_ot DESC`, (err, rows) => {
        if (err) { console.error('compensation err:', err); res.json([]); return; }
        const result = rows.map((r, i) => ({ rang: i + 1, ...r }));
        res.json(result);
    });
});

app.get('/api/burnout', (req, res) => {
    db.all(`SELECT employe, COUNT(*) as total_jours, COUNT(CASE WHEN heures_travaillees > 10 THEN 1 END) as jours_plus_10h, COUNT(CASE WHEN heures_travaillees > 12 THEN 1 END) as jours_plus_12h, ROUND(MAX(heures_travaillees), 2) as max_heures, ROUND(AVG(heures_travaillees), 2) as avg_heures FROM pointages WHERE heure_entree IS NOT NULL GROUP BY employe ORDER BY (COUNT(CASE WHEN heures_travaillees > 10 THEN 1 END) * 5 + COUNT(CASE WHEN heures_travaillees > 12 THEN 1 END) * 10) DESC`, (err, rows) => {
        if (err) { console.error('burnout err:', err); res.json([]); return; }
        const result = rows.map((r, i) => {
            const score = r.jours_plus_10h * 5 + r.jours_plus_12h * 10;
            let risque = 'LOW';
            let emoji = 'green';
            if (score > 40) { risque = 'HIGH'; emoji = 'red'; }
            else if (score >= 20) { risque = 'MEDIUM'; emoji = 'yellow'; }
            let tendance = '→';
            if (r.jours_plus_12h > 0) tendance = '↑↑';
            else if (r.jours_plus_10h > 3) tendance = '↑';
            else if (r.jours_plus_10h === 0) tendance = '↓';
            return { rang: i + 1, ...r, burnout_score: score, risque, emoji, tendance };
        });
        res.json(result);
    });
});

app.get('/api/executive-summary', (req, res) => {
    const q = `SELECT 
        (SELECT COUNT(DISTINCT employe) FROM pointages WHERE heure_entree IS NOT NULL) as total_employes,
        ROUND((SELECT AVG(CASE WHEN heure_sortie IS NOT NULL THEN 1 ELSE 0 END) * 100 FROM pointages), 1) as avg_presence,
        ROUND((SELECT SUM(heures_supp) FROM pointages), 1) as total_ot,
        ROUND((SELECT SUM(heures_supp) * 0.5 FROM pointages), 1) as total_compensation,
        (SELECT COUNT(*) FROM (SELECT employe FROM pointages WHERE heures_travaillees > 10 GROUP BY employe HAVING COUNT(CASE WHEN heures_travaillees > 10 THEN 1 END) > 0)) as burnout_employes,
        (SELECT COUNT(*) FROM pointages WHERE heures_travaillees > 10) as burnout_incidents,
        (SELECT COUNT(*) FROM pointages WHERE heure_entree > '${shiftStart}') as total_retards,
        ROUND((SELECT AVG(heures_travaillees) FROM pointages WHERE heures_travaillees > 0), 2) as avg_heures,
        (SELECT COUNT(*) FROM (SELECT employe FROM pointages WHERE heure_entree IS NOT NULL GROUP BY employe HAVING COUNT(*) >= 150)) as gold_candidates`;
    db.get(q, (err, row) => {
        if (err) { console.error('executive err:', err); res.json({}); return; }
        res.json(row || {});
    });
});

app.get('/api/analysis/weekly', (req, res) => {
    db.all(`SELECT strftime('%Y-W%W', date) as periode, MIN(date) as date_debut, COUNT(DISTINCT employe) as employes, ROUND(AVG(CASE WHEN heure_sortie IS NOT NULL THEN 1 ELSE 0 END) * 100, 1) as presence, ROUND(AVG(heures_travaillees), 2) as avg_heures, ROUND(SUM(heures_supp), 1) as total_ot, COUNT(CASE WHEN heure_entree > '${shiftStart}' THEN 1 END) as retards, COUNT(CASE WHEN heure_entree < '${shiftStart}' THEN 1 END) as avances FROM pointages WHERE date >= '2025-07-01' GROUP BY strftime('%Y-%W', date) ORDER BY date_debut ASC`, (err, rows) => {
        if (err) { console.error('weekly err:', err); res.json([]); return; }
        res.json(rows || []);
    });
});

app.get('/api/analysis/monthly', (req, res) => {
    db.all(`SELECT strftime('%Y-%m', date) as periode, COUNT(DISTINCT employe) as employes, ROUND(AVG(CASE WHEN heure_sortie IS NOT NULL THEN 1 ELSE 0 END) * 100, 1) as presence, ROUND(AVG(heures_travaillees), 2) as avg_heures, ROUND(SUM(heures_supp), 1) as total_ot, COUNT(CASE WHEN heure_entree > '${shiftStart}' THEN 1 END) as retards, COUNT(CASE WHEN heure_entree < '${shiftStart}' THEN 1 END) as avances FROM pointages WHERE date >= '2025-07-01' GROUP BY periode ORDER BY periode ASC`, (err, rows) => {
        if (err) { console.error('monthly analysis err:', err); res.json([]); return; }
        res.json(rows || []);
    });
});

app.get('/api/analysis/yearly', (req, res) => {
    db.all(`SELECT strftime('%Y', date) as periode, COUNT(DISTINCT employe) as employes, ROUND(AVG(CASE WHEN heure_sortie IS NOT NULL THEN 1 ELSE 0 END) * 100, 1) as presence, ROUND(AVG(heures_travaillees), 2) as avg_heures, ROUND(SUM(heures_supp), 1) as total_ot, COUNT(CASE WHEN heure_entree > '${shiftStart}' THEN 1 END) as retards, COUNT(CASE WHEN heure_entree < '${shiftStart}' THEN 1 END) as avances FROM pointages GROUP BY periode ORDER BY periode ASC`, (err, rows) => {
        if (err) { console.error('yearly err:', err); res.json([]); return; }
        res.json(rows || []);
    });
});

app.get('/api/whatsapp/status', (req, res) => {
    res.json({ connected: whatsAppConnected, qr: currentQR, jid: whatsAppJid });
});

app.get('/api/config', (req, res) => {
    res.json({ shiftStart, shiftEnd });
});

app.post('/api/config', (req, res) => {
    const { shiftStart: newStart, shiftEnd: newEnd } = req.body;
    const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (newStart && timeRegex.test(newStart)) {
        shiftStart = newStart;
        shiftStartMinutes = parseInt(newStart.split(':')[0]) * 60 + parseInt(newStart.split(':')[1]);
        db.run(`INSERT OR REPLACE INTO config (cle, valeur) VALUES ('shiftStart', ?)`, [newStart]);
    }
    if (newEnd && timeRegex.test(newEnd)) {
        shiftEnd = newEnd;
        db.run(`INSERT OR REPLACE INTO config (cle, valeur) VALUES ('shiftEnd', ?)`, [newEnd]);
    }
    res.json({ success: true, shiftStart, shiftEnd });
});

app.post('/api/test/pointage', (req, res) => {
    const { nom, action } = req.body;
    if (!nom || !action || !['IN', 'OUT'].includes(action)) {
        return res.status(400).json({ error: 'nom et action (IN/OUT) requis' });
    }
    enregistrerPointage(nom, action);
    res.json({ success: true });
});

app.get('/api/mappings', (req, res) => {
    db.all(`SELECT * FROM mappings ORDER BY whatsapp_name`, (err, rows) => {
        if (err) { console.error('mappings err:', err); res.json([]); return; }
        res.json(rows || []);
    });
});

app.get('/api/mappings/whatsapp-names', (req, res) => {
    db.all(`SELECT DISTINCT employe FROM pointages ORDER BY employe`, (err, rows) => {
        if (err) { console.error('whatsapp names err:', err); res.json([]); return; }
        db.all(`SELECT whatsapp_name FROM mappings`, (err2, mapped) => {
            const mappedNames = mapped ? mapped.map(m => m.whatsapp_name) : [];
            const result = (rows || []).map(r => ({
                whatsapp_name: r.employe,
                mapped: mappedNames.includes(r.employe)
            }));
            res.json(result);
        });
    });
});

app.post('/api/mappings', (req, res) => {
    const { whatsapp_name, employee_name } = req.body;
    if (!whatsapp_name || !employee_name) {
        return res.status(400).json({ error: 'whatsapp_name et employee_name requis' });
    }
    db.run(`INSERT OR REPLACE INTO mappings (whatsapp_name, employee_name) VALUES (?, ?)`, [whatsapp_name, employee_name], (err) => {
        if (err) { console.error('save mapping err:', err); return res.json({ success: false }); }
        res.json({ success: true });
    });
});

app.delete('/api/mappings/:whatsapp_name', (req, res) => {
    db.run(`DELETE FROM mappings WHERE whatsapp_name = ?`, [req.params.whatsapp_name], (err) => {
        if (err) { console.error('delete mapping err:', err); return res.json({ success: false }); }
        res.json({ success: true });
    });
});

app.delete('/api/test/pointages', (req, res) => {
    db.run('DELETE FROM pointages', function(err) {
        if (err) { console.error('delete err:', err); res.json({ success: false }); return; }
        res.json({ success: true, supprime: this.changes });
    });
});

async function sendWhatsAppMessage(jid, text) {
    if (!whatsAppSocket || !whatsAppConnected) return false;
    try {
        await whatsAppSocket.sendMessage(jid, { text });
        return true;
    } catch (e) {
        console.error('Send WA error:', e.message);
        return false;
    }
}

function getMonday(d) {
    const date = new Date(d);
    const day = date.getDay();
    const diff = date.getDate() - day + (day === 0 ? -6 : 1);
    const m = new Date(date.setDate(diff));
    return m.toISOString().split('T')[0];
}

function getFriday(d) {
    const monday = new Date(getMonday(d));
    const friday = new Date(monday);
    friday.setDate(friday.getDate() + 4);
    return friday.toISOString().split('T')[0];
}

function formatDateFR(dateStr) {
    const d = new Date(dateStr + 'T12:00:00');
    const jours = ['Dim','Lun','Mar','Mer','Jeu','Ven','Sam'];
    return jours[d.getDay()] + ' ' + String(d.getDate()).padStart(2,'0') + '/' + String(d.getMonth()+1).padStart(2,'0');
}

function pad(s) { return String(s).padStart(2,'0'); }

async function generateWeeklyReport() {
    const now = new Date();
    const mon = getMonday(now);
    const fri = getFriday(now);
    const weekLabel = formatDateFR(mon) + ' - ' + formatDateFR(fri);
    const parts = [];
    parts.push('📊 *RAPPORT HEBDOMADAIRE*');
    parts.push('Semaine du ' + weekLabel);
    parts.push('');
    const summary = await new Promise(resolve => {
        db.get(`SELECT ROUND(AVG(CASE WHEN heure_sortie IS NOT NULL THEN 1 ELSE 0 END) * 100, 1) as presence, ROUND(AVG(heures_travaillees), 1) as avg_heures, ROUND(SUM(heures_supp), 1) as total_ot, COUNT(CASE WHEN heure_entree > '${shiftStart}' THEN 1 END) as retards FROM pointages WHERE date >= ? AND date <= ?`, [mon, fri], (err, row) => resolve(row || {}));
    });
    parts.push('👥 Presence: *' + (summary.presence || 0) + '%* | Heures moy: *' + (summary.avg_heures || 0) + 'h*');
    parts.push('⏱ OT total: *' + (summary.total_ot || 0) + 'h* | Retards: *' + (summary.retards || 0) + '*');
    parts.push('');
    const lateRanking = await new Promise(resolve => {
        db.all(`SELECT employe, COUNT(CASE WHEN heure_entree > '${shiftStart}' THEN 1 END) as retards, ROUND(SUM(CASE WHEN heure_entree > '${shiftStart}' THEN (CAST(substr(heure_entree, 1, 2) AS REAL) * 60 + CAST(substr(heure_entree, 4, 2) AS REAL) - ${shiftStartMinutes}) ELSE 0 END), 1) as total_min FROM pointages WHERE date >= ? AND date <= ? AND heure_entree IS NOT NULL GROUP BY employe HAVING retards > 0 ORDER BY retards DESC`, [mon, fri], (err, rows) => resolve(rows || []));
    });
    if (lateRanking.length > 0) {
        const pire = lateRanking[0];
        const warn = pire.retards >= 3 ? ' ⚠️ Avertissement recommande' : '';
        parts.push('🔴 *Plus en retard:* ' + pire.employe + ' (' + pire.retards + ' retards, ' + pire.total_min + ' min)' + warn);
    } else {
        parts.push('🔴 *Retards:* Aucun cette semaine ✅');
    }
    const earlyRanking = await new Promise(resolve => {
        db.all(`SELECT employe, COUNT(CASE WHEN heure_entree < '${shiftStart}' THEN 1 END) as avances FROM pointages WHERE date >= ? AND date <= ? AND heure_entree IS NOT NULL GROUP BY employe HAVING avances > 0 ORDER BY avances DESC`, [mon, fri], (err, rows) => resolve(rows || []));
    });
    if (earlyRanking.length > 0) {
        const ponctuel = earlyRanking[0];
        parts.push('🟢 *Plus ponctuel:* ' + ponctuel.employe + ' (' + ponctuel.avances + ' arrives matinales)');
        parts.push('   → Felicitations ! 🎉');
    }
    parts.push('');
    const otRanking = await new Promise(resolve => {
        db.all(`SELECT employe, ROUND(SUM(heures_supp), 1) as total_ot, COUNT(CASE WHEN heures_travaillees > 10 THEN 1 END) as jours_plus_10h, COUNT(CASE WHEN heures_travaillees > 12 THEN 1 END) as jours_plus_12h FROM pointages WHERE date >= ? AND date <= ? AND heures_supp > 0 GROUP BY employe ORDER BY total_ot DESC`, [mon, fri], (err, rows) => resolve(rows || []));
    });
    if (otRanking.length > 0) {
        const maitre = otRanking[0];
        parts.push('⚡ *Maitre OT:* ' + maitre.employe + ' (' + maitre.total_ot + 'h cette semaine)');
        if (maitre.jours_plus_10h > 0) {
            const risque = maitre.jours_plus_12h > 0 ? 'ELEVE 🔴' : 'MOYEN 🟡';
            parts.push('   → Jours >10h: ' + maitre.jours_plus_10h + ', risque burnout ' + risque);
            if (maitre.jours_plus_12h > 0) parts.push('   → Recommande: repos et suivi charge travail');
        }
        if (otRanking.length > 1) {
            for (let i = 1; i < otRanking.length; i++) {
                const e = otRanking[i];
                parts.push('   • ' + e.employe + ': ' + e.total_ot + 'h OT');
                if (e.jours_plus_10h > 0) parts.push('     ⚠️ ' + e.jours_plus_10h + ' jour(s) >10h');
            }
        }
    } else {
        parts.push('⚡ *OT:* Aucune heure supplementaire ✅');
    }
    return parts.join('\n');
}

async function generateMonthlyReport() {
    const now = new Date();
    const mois = now.toISOString().slice(0, 7);
    const nomMois = now.toLocaleString('fr-FR', { month: 'long', year: 'numeric' });
    const parts = [];
    parts.push('📊 *RAPPORT MENSUEL*');
    parts.push(nomMois.charAt(0).toUpperCase() + nomMois.slice(1));
    parts.push('');
    const summary = await new Promise(resolve => {
        db.get(`SELECT COUNT(DISTINCT employe) as employes, ROUND(AVG(CASE WHEN heure_sortie IS NOT NULL THEN 1 ELSE 0 END) * 100, 1) as presence, ROUND(AVG(heures_travaillees), 1) as avg_heures, ROUND(SUM(heures_supp), 1) as total_ot, ROUND(SUM(heures_supp) * 0.5, 1) as compensation, COUNT(*) as total_pointages FROM pointages WHERE date LIKE '${mois}%'`, (err, row) => resolve(row || {}));
    });
    const compJours = summary.compensation ? (summary.compensation / 8).toFixed(1) : 0;
    parts.push('👥 Employes: *' + (summary.employes || 0) + '* | Presence: *' + (summary.presence || 0) + '%*');
    parts.push('⏱ OT total: *' + (summary.total_ot || 0) + 'h* | Compensation: *' + (summary.compensation || 0) + 'h* (' + compJours + ' jours off)');
    parts.push('');
    const lateRanking = await new Promise(resolve => {
        db.all(`SELECT employe, COUNT(CASE WHEN heure_entree > '${shiftStart}' THEN 1 END) as retards FROM pointages WHERE date LIKE '${mois}%' AND heure_entree IS NOT NULL GROUP BY employe HAVING retards > 0 ORDER BY retards DESC`, [], (err, rows) => resolve(rows || []));
    });
    if (lateRanking.length > 0) {
        const pire = lateRanking[0];
        const warn = pire.retards >= 5 ? ' ⚠️ Avertissement necessaire' : (pire.retards >= 3 ? ' 🟡 Surveillance recommandee' : '');
        parts.push('🔴 *Plus en retard:* ' + pire.employe + ' (' + pire.retards + ' retards)' + warn);
        if (lateRanking.length > 1) {
            parts.push('   • ' + lateRanking.slice(1).map(e => e.employe + ' (' + e.retards + ')').join(', '));
        }
    } else {
        parts.push('🔴 *Retards:* Aucun ce mois ✅');
    }
    const earlyRanking = await new Promise(resolve => {
        db.all(`SELECT employe, COUNT(CASE WHEN heure_entree < '${shiftStart}' THEN 1 END) as avances FROM pointages WHERE date LIKE '${mois}%' AND heure_entree IS NOT NULL GROUP BY employe HAVING avances > 0 ORDER BY avances DESC`, [], (err, rows) => resolve(rows || []));
    });
    if (earlyRanking.length > 0) {
        const ponctuel = earlyRanking[0];
        parts.push('🟢 *Plus ponctuel:* ' + ponctuel.employe + ' (' + ponctuel.avances + ' arrives matinales) 🎉');
        parts.push('   → Excellent sens de la ponctualite !');
    }
    parts.push('');
    const otRanking = await new Promise(resolve => {
        db.all(`SELECT employe, ROUND(SUM(heures_supp), 1) as total_ot, COUNT(CASE WHEN heures_travaillees > 10 THEN 1 END) as jours_plus_10h, COUNT(CASE WHEN heures_travaillees > 12 THEN 1 END) as jours_plus_12h, ROUND(AVG(heures_travaillees), 1) as avg_heures FROM pointages WHERE date LIKE '${mois}%' AND heures_supp > 0 GROUP BY employe ORDER BY total_ot DESC`, [], (err, rows) => resolve(rows || []));
    });
    if (otRanking.length > 0) {
        const maitre = otRanking[0];
        parts.push('⚡ *Maitre OT:* ' + maitre.employe + ' (' + maitre.total_ot + 'h)');
        if (maitre.jours_plus_10h > 0) {
            const niveau = maitre.jours_plus_12h > 0 ? 'ELEVE 🔴' : (maitre.jours_plus_10h > 5 ? 'MOYEN 🟡' : 'FAIBLE 🟢');
            parts.push('   → Jours >10h: ' + maitre.jours_plus_10h + ', risque burnout: ' + niveau);
            if (maitre.jours_plus_12h > 0) parts.push('   → ACTION: Reduire charge immédiatement');
            else if (maitre.jours_plus_10h > 5) parts.push('   → Surveiller charge de travail');
        }
        parts.push('');
        parts.push('📋 *Recapitulatif OT:*');
        otRanking.forEach(e => {
            const comp = (e.total_ot * 0.5).toFixed(1);
            parts.push('   • ' + e.employe + ': ' + e.total_ot + 'h OT (compensation ' + comp + 'h)');
            if (e.jours_plus_10h > 0) parts.push('     ⏰ ' + e.jours_plus_10h + ' jours >10h');
        });
    } else {
        parts.push('⚡ *OT:* Aucune heure supplementaire ce mois ✅');
    }
    parts.push('');
    parts.push('💰 Compensation totale du mois: *' + (summary.compensation || 0) + 'h* (' + compJours + ' jours)');
    return parts.join('\n');
}

app.get('/api/report/weekly', async (req, res) => {
    const text = await generateWeeklyReport();
    let sent = false;
    if (whatsAppJid) {
        sent = await sendWhatsAppMessage(whatsAppJid + '@s.whatsapp.net', text);
    }
    res.json({ report: text, sent });
});

app.get('/api/report/monthly', async (req, res) => {
    const text = await generateMonthlyReport();
    let sent = false;
    if (whatsAppJid) {
        sent = await sendWhatsAppMessage(whatsAppJid + '@s.whatsapp.net', text);
    }
    res.json({ report: text, sent });
});

cron.schedule('0 15 * * 5', async () => {
    console.log('Cron: Weekly report');
    if (!whatsAppJid) { console.log('WA not connected, skip'); return; }
    const text = await generateWeeklyReport();
    await sendWhatsAppMessage(whatsAppJid + '@s.whatsapp.net', text);
    console.log('Weekly report sent');
});

cron.schedule('0 15 26 * *', async () => {
    console.log('Cron: Monthly report');
    if (!whatsAppJid) { console.log('WA not connected, skip'); return; }
    const text = await generateMonthlyReport();
    await sendWhatsAppMessage(whatsAppJid + '@s.whatsapp.net', text);
    console.log('Monthly report sent');
});

app.listen(port, () => {
    console.log('Server on http://localhost:' + port);
});
