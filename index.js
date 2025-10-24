// index.js
import 'dotenv/config';
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadContentFromMessage
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import fs from 'node:fs/promises';
import path from 'node:path';
import ffmpeg from 'fluent-ffmpeg';

let ffmpegPath = null;
try {
  const mod = await import('ffmpeg-static');
  ffmpegPath = mod?.default || null;
} catch {}
if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);

// ───────────────────────── Config ─────────────────────────
const CMD_PREFIX = process.env.CMD_PREFIX || '!';
const AUTH_DIR = process.env.AUTH_DIR || './auth';
const BOT_NAME = process.env.BOT_NAME || 'YuraBot';

// Invisible separator agar mention notify tanpa tampil @tag
const INV = '\u2063'; // U+2063

// ─────────────────────── Util: Parse Text ───────────────────────
function getTextFromMessage(msg) {
  const m = msg.message || {};
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage?.caption) return m.imageMessage.caption;
  if (m.videoMessage?.caption) return m.videoMessage.caption;
  if (m.documentMessage?.caption) return m.documentMessage.caption;
  return '';
}

// ─────────────── Util: Ambil media (quoted/inline) → Buffer ───────────────
async function messageToBuffer(sock, msg) {
  const m = msg.message || {};
  const quoted = m?.extendedTextMessage?.contextInfo?.quotedMessage;
  let mediaNode = null;

  if (quoted?.imageMessage) mediaNode = { type: 'imageMessage', node: quoted.imageMessage };
  else if (quoted?.videoMessage) mediaNode = { type: 'videoMessage', node: quoted.videoMessage };
  else if (quoted?.documentMessage && /image|video/.test(quoted.documentMessage.mimetype))
    mediaNode = { type: 'documentMessage', node: quoted.documentMessage };

  if (!mediaNode) {
    if (m.imageMessage) mediaNode = { type: 'imageMessage', node: m.imageMessage };
    else if (m.videoMessage) mediaNode = { type: 'videoMessage', node: m.videoMessage };
    else if (m.documentMessage && /image|video/.test(m.documentMessage.mimetype))
      mediaNode = { type: 'documentMessage', node: m.documentMessage };
  }

  if (!mediaNode) return { buffer: null, isVideo: false };

  const stream = await downloadContentFromMessage(mediaNode.node, mediaNode.type.replace('Message', ''));
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  const buffer = Buffer.concat(chunks);
  const isVideo = mediaNode.type === 'videoMessage' || /video/.test(mediaNode?.node?.mimetype || '');
  return { buffer, isVideo };
}

// ─────────────── Util: Convert buffer → WebP (stiker) ───────────────
async function toWebpBuffer(inputBuffer, { isVideo = false } = {}) {
  const tmpDir = path.join(process.cwd(), 'tmp');
  await fs.mkdir(tmpDir, { recursive: true });
  const inPath = path.join(tmpDir, `in_${Date.now()}`);
  const outPath = path.join(tmpDir, `out_${Date.now()}.webp`);
  await fs.writeFile(inPath, inputBuffer);

  const optsImage = [
    '-vcodec', 'libwebp',
    '-vf', 'scale=512:512:force_original_aspect_ratio=decrease',
    '-preset', 'default',
    '-an',
    '-vsync', '0',
    '-s', '512:512'
  ];
  const optsVideo = [
    '-vcodec', 'libwebp',
    '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,fps=20',
    '-preset', 'default',
    '-an',
    '-vsync', '0',
    '-s', '512:512',
    '-loop', '0',
    '-lossless', '1'
  ];

  await new Promise((resolve, reject) => {
    ffmpeg(inPath)
      .outputOptions(isVideo ? optsVideo : optsImage)
      .output(outPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });

  const out = await fs.readFile(outPath).finally(async () => {
    await fs.unlink(inPath).catch(() => {});
    await fs.unlink(outPath).catch(() => {});
  });
  return out;
}

// ─────────────── Fitur: TagAll hanya untuk Admin ───────────────
async function cmdTagAll(sock, msg, textArg) {
  const from = msg.key.remoteJid;
  const sender = msg.key.participant || msg.key.remoteJid; // pengirim

  if (!from?.endsWith('@g.us')) {
    await sock.sendMessage(from, { text: 'Perintah ini hanya bisa digunakan di grup, kak 💬' }, { quoted: msg });
    return;
  }

  // Ambil metadata grup & cek apakah pengirim adalah admin
  const meta = await sock.groupMetadata(from);
  const adminList = meta.participants.filter(p => p.admin === 'admin' || p.admin === 'superadmin').map(p => p.id);

  const isAdmin = adminList.includes(sender);
  if (!isAdmin) {
    await sock.sendMessage(from, { text: 'Maaf kak, cuma admin yang bisa pakai perintah ini 😅' }, { quoted: msg });
    return;
  }

  // Ambil semua member
  const participants = (meta.participants || []).map(p => p.id);
  if (!participants.length) {
    await sock.sendMessage(from, { text: 'Tidak ada anggota ditemukan 😕' }, { quoted: msg });
    return;
  }

  const filler = participants.map(() => INV).join(' ');
  const teks = (textArg && textArg.trim().length ? textArg.trim() : 'Penting nih kak!') + '\n' + filler;

  await sock.sendMessage(from, {
    text: teks,
    mentions: participants
  }, { quoted: msg });
}

// ─────────────── Fitur: Sticker ───────────────
async function cmdSticker(sock, msg) {
  const { buffer, isVideo } = await messageToBuffer(sock, msg);
  const from = msg.key.remoteJid;

  if (!buffer) {
    await sock.sendMessage(from, { text: 'Reply/kirim gambar atau video dengan caption !sticker.' }, { quoted: msg });
    return;
  }

  const MAX = 15 * 1024 * 1024;
  if (buffer.length > MAX) {
    await sock.sendMessage(from, { text: 'File terlalu besar. Maksimal ~15MB.' }, { quoted: msg });
    return;
  }

  const webp = await toWebpBuffer(buffer, { isVideo });
  await sock.sendMessage(from, { sticker: webp }, { quoted: msg });
}

// ─────────────── Router Command ───────────────
function parseCommand(txt) {
  if (!txt || !txt.startsWith(CMD_PREFIX)) return null;
  const cut = txt.slice(CMD_PREFIX.length).trim();
  const [cmd, ...rest] = cut.split(/\s+/);
  const argText = cut.slice(cmd.length).trim();
  return { cmd: cmd.toLowerCase(), argText };
}

// ─────────────── Bootstrap WhatsApp ───────────────
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    printQRInTerminal: false,
    auth: state,
    browser: [BOT_NAME, 'Chrome', '1.0'],
    syncFullHistory: false
  });

  sock.ev.on('connection.update', (u) => {
    const { qr, connection, lastDisconnect } = u;
    if (qr) {
      console.clear();
      console.log(`[${BOT_NAME}] Scan QR berikut untuk login:`);
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Koneksi terputus:', lastDisconnect?.error, 'reconnect:', shouldReconnect);
      if (shouldReconnect) start();
    } else if (connection === 'open') {
      console.log(`[${BOT_NAME}] Tersambung ✅`);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async (up) => {
    try {
      const msg = up.messages?.[0];
      if (!msg || msg.key.fromMe) return;

      const txt = getTextFromMessage(msg);
      const parsed = parseCommand(txt);
      if (!parsed) return;

      const { cmd, argText } = parsed;
      if (cmd === 'tagall') {
        await cmdTagAll(sock, msg, argText);
        return;
      }
      if (cmd === 'sticker' || cmd === 's' || cmd === 'stiker') {
        await cmdSticker(sock, msg);
        return;
      }

      if (cmd === 'help' || cmd === 'menu') {
        const help = [
          `*${BOT_NAME}*`,
          `Prefix: ${CMD_PREFIX}`,
          '',
          `• ${CMD_PREFIX}tagall [pesan]  → Mention semua (admin only)`,
          `• ${CMD_PREFIX}sticker (reply gambar/video) → Jadikan stiker`,
        ].join('\n');
        await sock.sendMessage(msg.key.remoteJid, { text: help }, { quoted: msg });
      }

    } catch (err) {
      console.error('messages.upsert error:', err);
    }
  });
}

start().catch((e) => console.error('Fatal start error:', e));
