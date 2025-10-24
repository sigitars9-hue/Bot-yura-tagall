// index.js (Final)
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
const AUTH_DIR   = process.env.AUTH_DIR   || './auth';
const BOT_NAME   = process.env.BOT_NAME   || 'YuraBot';

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

// ─────────────── Util: Ambil media (quoted/inline) → Buffer & info ───────────────
async function messageToBuffer(sock, msg) {
  const m = msg.message || {};
  const quoted = m?.extendedTextMessage?.contextInfo?.quotedMessage;
  let mediaNode = null;

  if (quoted?.imageMessage) mediaNode = { type: 'imageMessage', node: quoted.imageMessage };
  else if (quoted?.videoMessage) mediaNode = { type: 'videoMessage', node: quoted.videoMessage };
  else if (quoted?.documentMessage && /image|video|gif/i.test(quoted.documentMessage.mimetype || ''))
    mediaNode = { type: 'documentMessage', node: quoted.documentMessage };

  if (!mediaNode) {
    if (m.imageMessage) mediaNode = { type: 'imageMessage', node: m.imageMessage };
    else if (m.videoMessage) mediaNode = { type: 'videoMessage', node: m.videoMessage };
    else if (m.documentMessage && /image|video|gif/i.test(m.documentMessage.mimetype || ''))
      mediaNode = { type: 'documentMessage', node: m.documentMessage };
  }

  if (!mediaNode) return { buffer: null, isVideo: false };

  const stream = await downloadContentFromMessage(
    mediaNode.node,
    mediaNode.type.replace('Message', '')
  );
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  const buffer = Buffer.concat(chunks);

  const mime = mediaNode?.node?.mimetype || '';
  // GIF sering datang sebagai video/gif di mime
  const isVideo = mediaNode.type === 'videoMessage' || /video|gif/i.test(mime);
  return { buffer, isVideo };
}

// ─────────────── Filter builder (stabil) ───────────────
function buildStableWebpFilters(fps = null) {
  // 1) Scale sisi terpanjang ke 512 (AR tetap)
  // 2) Normalkan SAR = 1
  // 3) Paksa dimensi genap (hindari error filter)
  // 4) RGBA
  // 5) Pad ke 512x512 transparan (center)
  const base =
    "scale='if(gt(iw,ih),512,-2)':'if(gt(ih,iw),512,-2)':flags=lanczos:force_original_aspect_ratio=decrease," +
    "setsar=1," +
    "scale=trunc(iw/2)*2:trunc(ih/2)*2," +
    "format=rgba," +
    "pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000";
  return fps ? `${base},fps=${fps}` : base;
}

// ─────────────── Convert → WEBP (statis/animasi) ───────────────
async function toWebpBuffer(inputBuffer, { isVideo = false } = {}) {
  const tmpDir = path.join(process.cwd(), 'tmp');
  await fs.mkdir(tmpDir, { recursive: true });
  const inPath  = path.join(tmpDir, `in_${Date.now()}`);
  const outPath = path.join(tmpDir, `out_${Date.now()}.webp`);
  await fs.writeFile(inPath, inputBuffer);

  const vf = buildStableWebpFilters(isVideo ? 15 : null);

  const common = [
    '-filter:v', vf,
    '-an',
    '-vsync', '0',
    '-preset', 'default',
    '-threads', '1'
  ];

  const imageOpts = [
    '-vcodec', 'libwebp',
    ...common,
    '-lossless', '0',
    '-qscale', '60'
  ];

  const videoOpts = [
    '-vcodec', 'libwebp',
    ...common,
    '-loop', '0',
    '-lossless', '0',
    '-qscale', '65',
    '-t', '6' // batasi durasi animasi agar kecil & kompatibel
  ];

  await new Promise((resolve, reject) => {
    ffmpeg(inPath)
      .outputOptions(isVideo ? videoOpts : imageOpts)
      .output(outPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });

  const out = await fs.readFile(outPath).finally(async () => {
    await fs.unlink(inPath).catch(()=>{});
    await fs.unlink(outPath).catch(()=>{});
  });
  return out;
}

// ─────────────── Fallback → GIF-like MP4 (kalau WEBP gagal) ───────────────
async function toGifLikeMp4(inputBuffer, { fps = 15, maxSec = 6 } = {}) {
  const tmpDir = path.join(process.cwd(), 'tmp');
  await fs.mkdir(tmpDir, { recursive: true });
  const inPath  = path.join(tmpDir, `in_${Date.now()}`);
  const outPath = path.join(tmpDir, `out_${Date.now()}.mp4`);
  await fs.writeFile(inPath, inputBuffer);

  const vf =
    "scale='if(gt(iw,ih),512,-2)':'if(gt(ih,iw),512,-2)':flags=lanczos:force_original_aspect_ratio=decrease," +
    "setsar=1,scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=" + String(fps);

  await new Promise((resolve, reject) => {
    ffmpeg(inPath)
      .outputOptions([
        '-movflags', '+faststart',
        '-pix_fmt', 'yuv420p',
        '-filter:v', vf,
        '-an',
        '-r', String(fps),
        '-t', String(maxSec),
        '-threads', '1'
      ])
      .videoCodec('libx264')
      .output(outPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });

  const out = await fs.readFile(outPath).finally(async () => {
    await fs.unlink(inPath).catch(()=>{});
    await fs.unlink(outPath).catch(()=>{});
  });
  return out;
}

// ─────────────── Fitur: TagAll (admin-only, tanpa baris baru) ───────────────
async function cmdTagAll(sock, msg, textArg) {
  const from = msg.key.remoteJid;
  const sender = msg.key.participant || msg.key.remoteJid;

  if (!from?.endsWith('@g.us')) {
    await sock.sendMessage(from, { text: 'Perintah ini hanya bisa digunakan di grup, kak 💬' }, { quoted: msg });
    return;
  }

  const meta = await sock.groupMetadata(from);
  const adminList = meta.participants
    .filter(p => p.admin === 'admin' || p.admin === 'superadmin')
    .map(p => p.id);

  const isAdmin = adminList.includes(sender);
  if (!isAdmin) {
    await sock.sendMessage(from, { text: 'Maaf kak, cuma admin yang bisa pakai perintah ini 😅' }, { quoted: msg });
    return;
  }

  const participants = (meta.participants || []).map(p => p.id);
  if (!participants.length) {
    await sock.sendMessage(from, { text: 'Tidak ada anggota ditemukan 😕' }, { quoted: msg });
    return;
  }

  // TANPA baris baru/space
  const filler = participants.map(() => INV).join('');
  const teks = (textArg?.trim() || 'Penting nih kak!') + filler;

  await sock.sendMessage(from, { text: teks, mentions: participants }, { quoted: msg });
}

// ─────────────── Fitur: Sticker ───────────────
async function cmdSticker(sock, msg) {
  const { buffer, isVideo } = await messageToBuffer(sock, msg);
  const from = msg.key.remoteJid;

  if (!buffer) {
    await sock.sendMessage(from, { text: 'Reply/kirim gambar atau video/GIF dengan caption !sticker.' }, { quoted: msg });
    return;
  }

  const MAX = 15 * 1024 * 1024;
  if (buffer.length > MAX) {
    await sock.sendMessage(from, { text: 'File terlalu besar. Maksimal ~15MB.' }, { quoted: msg });
    return;
  }

  try {
    const webp = await toWebpBuffer(buffer, { isVideo });
    await sock.sendMessage(from, { sticker: webp }, { quoted: msg });
  } catch (e) {
    console.error('Sticker WEBP failed, fallback to gif-like mp4:', e);
    try {
      const mp4 = await toGifLikeMp4(buffer, { fps: 15, maxSec: 6 });
      await sock.sendMessage(from, { video: mp4, gifPlayback: true }, { quoted: msg });
    } catch (e2) {
      console.error('Fallback mp4 failed:', e2);
      await sock.sendMessage(from, { text: 'Gagal membuat stiker. Coba durasi lebih pendek atau resolusi lebih kecil.' }, { quoted: msg });
    }
  }
}

// ─────────────── Router Command ───────────────
function parseCommand(txt) {
  if (!txt || !txt.startsWith(CMD_PREFIX)) return null;
  const cut = txt.slice(CMD_PREFIX.length).trim();
  const [cmd] = cut.split(/\s+/);
  const argText = cut.slice(cmd.length).trim();
  return { cmd: cmd.toLowerCase(), argText };
}

// ─────────────── Bootstrap WhatsApp ───────────────
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  console.log('[Init] Using ffmpeg:', ffmpegPath || 'system ffmpeg on PATH');

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
      if (cmd === 'tagall')   return void (await cmdTagAll(sock, msg, argText));
      if (cmd === 'sticker' || cmd === 's' || cmd === 'stiker')
        return void (await cmdSticker(sock, msg));

      if (cmd === 'help' || cmd === 'menu') {
        const help = [
          `*${BOT_NAME}*`,
          `Prefix: ${CMD_PREFIX}`,
          '',
          `• ${CMD_PREFIX}tagall [pesan]  → Mention semua (admin only, tanpa baris baru)`,
          `• ${CMD_PREFIX}sticker (reply gambar/video/GIF) →`,
          `   - Gambar → stiker statis WEBP (AR terjaga + padding transparan)`,
          `   - GIF/Video → stiker animasi WEBP (≤ ~6s, fps 15) `,
          `     (fallback MP4 gifPlayback bila WEBP gagal)`,
        ].join('\n');
        await sock.sendMessage(msg.key.remoteJid, { text: help }, { quoted: msg });
      }

    } catch (err) {
      console.error('messages.upsert error:', err);
    }
  });
}

start().catch((e) => console.error('Fatal start error:', e));
