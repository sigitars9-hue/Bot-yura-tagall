// index.js
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── ffmpeg
const ffmpeg = require('fluent-ffmpeg');
let ffmpegPath;
try {
  ffmpegPath = require('ffmpeg-static');
  if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
} catch {}
// fallback biarkan ffmpeg dari sistem jika ada

/* =========================
   CLIENT
   ========================= */
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    executablePath: '/usr/bin/chromium-browser', // sesuaikan dengan servermu
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']
  },
});

/* =========================
   LOGGING -> CSV
   ========================= */
const LOG_DIR = path.join(__dirname, 'data');
const LOG_PATH = path.join(LOG_DIR, 'activity_log.csv');

function ensureLogReady() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  if (!fs.existsSync(LOG_PATH)) {
    fs.writeFileSync(
      LOG_PATH,
      [
        'timestamp_iso',
        'group_id',
        'group_name',
        'contact_id',
        'contact_name',
        'phone_last4',
        'message',
      ].join(',') + '\n',
      'utf8'
    );
  }
}
function appendCsvRow(obj) {
  const esc = (v) => {
    const s = (v ?? '').toString().replace(/\r?\n|\r/g, ' ').trim();
    if (/[",]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const row = [
    esc(obj.timestamp_iso),
    esc(obj.group_id),
    esc(obj.group_name),
    esc(obj.contact_id),
    esc(obj.contact_name),
    esc(obj.phone_last4),
    esc(obj.message),
  ].join(',') + '\n';
  fs.appendFileSync(LOG_PATH, row, 'utf8');
}

/* =========================
   HELPER: ADMIN & UTIL
   ========================= */
function getParticipant(chat, widSerialized) {
  return chat.participants?.find((p) => p.id._serialized === widSerialized);
}
function isParticipantAdmin(part) {
  return !!(part && (part.isAdmin || part.isSuperAdmin));
}
async function isSenderAdmin(chat, msg) {
  try { if (typeof chat.fetchParticipants === 'function') await chat.fetchParticipants(); } catch {}
  const senderContact = await msg.getContact();
  const senderWid = senderContact?.id?._serialized;
  const part = getParticipant(chat, senderWid);
  return isParticipantAdmin(part);
}
async function isBotAdmin(chat) {
  try { if (typeof chat.fetchParticipants === 'function') await chat.fetchParticipants(); } catch {}
  const botWid = client.info?.wid?._serialized;
  const part = getParticipant(chat, botWid);
  return isParticipantAdmin(part);
}
function phoneLast4FromContact(contact) {
  const user = contact?.id?.user || '';
  return user.slice(-4);
}
function tokenizeCommand(s) { return s.trim().split(/\s+/); }

/* =========================
   CSV PARSER SEDERHANA
   ========================= */
function parseCsvLine(line) {
  const out = []; let cur = ''; let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else { cur += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { out.push(cur); cur = ''; }
      else { cur += ch; }
    }
  }
  out.push(cur);
  return out;
}

/* =========================
   STICKER UTILS (IMG, GIF/VIDEO)
   ========================= */
const INV = '\u2063'; // filler invisible untuk tagall tanpa baris baru
const TMP_DIR = path.join(__dirname, 'tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

function writeTmp(buf, ext) {
  const p = path.join(TMP_DIR, `${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);
  fs.writeFileSync(p, buf);
  return p;
}
function readB64(p) {
  const b = fs.readFileSync(p);
  return b.toString('base64');
}
function mimeExt(mimetype) {
  if (!mimetype) return 'bin';
  if (mimetype.includes('png')) return 'png';
  if (mimetype.includes('jpeg') || mimetype.includes('jpg')) return 'jpg';
  if (mimetype.includes('webp')) return 'webp';
  if (mimetype.includes('gif')) return 'gif';
  if (mimetype.includes('mp4')) return 'mp4';
  if (mimetype.includes('quicktime')) return 'mov';
  if (mimetype.includes('webm')) return 'webm';
  if (mimetype.includes('video')) return 'mp4';
  if (mimetype.includes('image')) return 'jpg';
  return 'bin';
}

// agar stabil: dimensi genap + padding transparan ke 512×512 (AR terjaga)
function buildPadFilter(fps = null) {
  const base = [
    "scale='if(gt(iw,ih),512,-2)':'if(gt(ih,iw),512,-2)':flags=lanczos:force_original_aspect_ratio=decrease",
    "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    "format=rgba",
    "pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000"
  ].join(',');
  return fps ? `${base},fps=${fps}` : base;
}

async function toStaticWebpBuffer(inputPath) {
  const outPath = path.join(TMP_DIR, `out_${Date.now()}.webp`);
  const vf = buildPadFilter();
  await new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        '-vcodec', 'libwebp',
        '-filter:v', vf,
        '-lossless', '0',
        '-qscale', '60',
        '-an',
        '-vsync', '0',
        '-threads', '1'
      ])
      .output(outPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
  const b64 = readB64(outPath);
  try { fs.unlinkSync(outPath); } catch {}
  return b64;
}

async function toAnimatedWebpBuffer(inputPath, { fps = 15, maxSec = 6 } = {}) {
  const outPath = path.join(TMP_DIR, `out_${Date.now()}.webp`);
  const vf = buildPadFilter(fps);
  await new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        '-vcodec', 'libwebp',
        '-filter:v', vf,
        '-loop', '0',
        '-lossless', '0',
        '-qscale', '65',
        '-an',
        '-vsync', '0',
        '-t', String(maxSec),
        '-threads', '1'
      ])
      .output(outPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
  const b64 = readB64(outPath);
  try { fs.unlinkSync(outPath); } catch {}
  return b64;
}

/* =========================
   STICKER METADATA
   ========================= */
function parseStickerMeta(args) {
  const joined = args.join(' ').trim();
  if (!joined) return { author: 'Bot', pack: 'Sticker' };
  const [author, pack] = joined.split('|').map(s => (s || '').trim());
  return { author: author || 'Bot', pack: pack || 'Sticker' };
}

/* =========================
   EVENTS
   ========================= */
client.on('qr', (qr) => {
  console.log('Scan QR berikut di WhatsApp (Linked Devices):');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  ensureLogReady();
  console.log('✅ Bot siap!');
  console.log('Perintah:');
  console.log('• !tagall [pesan opsional]  (admin only, tanpa baris baru)');
  console.log('• !aktif [jumlah]           (default 10, max 50)');
  console.log('• !admindebug');
  console.log('• !stiker [author|pack]     (reply ke gambar/GIF/video)');
  console.log('📁 Log: ' + LOG_PATH);
});

client.on('message', async (msg) => {
  try {
    const chat = await msg.getChat();

    // === LOG aktivitas (grup, bukan pesan bot) ===
    if (!msg.fromMe && chat.isGroup) {
      const senderContact = await msg.getContact();
      const ts = msg.timestamp ? new Date(msg.timestamp * 1000) : new Date();

      ensureLogReady();
      appendCsvRow({
        timestamp_iso: ts.toISOString(),
        group_id: chat.id?._serialized || msg.from,
        group_name: chat.name || '',
        contact_id: senderContact?.id?._serialized || (msg.author || msg.from),
        contact_name:
          senderContact?.pushname ||
          senderContact?.name ||
          senderContact?.shortName ||
          senderContact?.id?.user ||
          '',
        phone_last4: phoneLast4FromContact(senderContact),
        message: (msg.body || '').toString(),
      });
    }

    if (!msg.body?.startsWith('!')) return;
    const [cmdRaw, ...argsRaw] = tokenizeCommand(msg.body);
    const cmd = cmdRaw.toLowerCase();
    const args = argsRaw;

    /* ===== !tagall (ADMIN ONLY, TANPA BARIS BARU) ===== */
    if (cmd === '!tagall') {
      if (!chat.isGroup) return msg.reply('Perintah ini hanya untuk grup.');
      const allowed = await isSenderAdmin(chat, msg);
      if (!allowed) return msg.reply('Maaf, perintah ini hanya untuk admin.');

      const rawText = msg.body.slice('!tagall'.length).trim();
      const headerText = rawText.length ? rawText : 'Ping semua member 👋';

      // Ambil mentions
      try { if (typeof chat.fetchParticipants === 'function') await chat.fetchParticipants(); } catch {}
      const participants = chat.participants || [];
      if (!participants.length) return msg.reply('Tidak ada anggota ditemukan.');

      const contacts = await Promise.all(
        participants.map((p) => client.getContactById(p.id._serialized))
      );

      // Filler invisible TANPA \n agar tidak bikin baris baru
      const filler = INV.repeat(Math.max(1, contacts.length));
      await chat.sendMessage(headerText + filler, { mentions: contacts });
      return;
    }

    /* ===== !aktif [N] ===== */
    if (cmd === '!aktif') {
      if (!chat.isGroup) return msg.reply('Perintah ini hanya untuk grup.');

      ensureLogReady();
      const content = fs.readFileSync(LOG_PATH, 'utf8');
      const lines = content.trim().split('\n').slice(1);
      const groupId = chat.id?._serialized;

      const counts = new Map();
      for (const line of lines) {
        const cols = parseCsvLine(line);
        if (!cols.length) continue;
        const gId = cols[1];
        if (gId !== groupId) continue;

        const cId = cols[3];
        const cName = cols[4];
        const l4 = cols[5];

        const prev = counts.get(cId) || { count: 0, name: cName, last4: l4 };
        prev.count += 1;
        if (!prev.name && cName) prev.name = cName;
        if (!prev.last4 && l4) prev.last4 = l4;
        counts.set(cId, prev);
      }

      const limit = Math.max(1, Math.min(50, parseInt(args[0], 10) || 10));
      const ranking = [...counts.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, limit);

      if (!ranking.length) {
        return msg.reply('Belum ada data aktivitas untuk grup ini.');
      }

      const linesMsg = ranking.map(([cid, d], i) => {
        const label = (d.name ? d.name : cid.replace('@c.us', '')) + (d.last4 ? ` (#${d.last4})` : '');
        return `${i + 1}. ${label} — ${d.count} pesan`;
      });

      await msg.reply(`📊 Top ${limit} member paling aktif di *${chat.name}*:\n` + linesMsg.join('\n'));
      return;
    }

    /* ===== !admindebug ===== */
    if (cmd === '!admindebug') {
      if (!chat.isGroup) return msg.reply('Hanya untuk grup.');
      try { if (typeof chat.fetchParticipants === 'function') await chat.fetchParticipants(); } catch {}

      const senderContact = await msg.getContact();
      const senderWid = senderContact?.id?._serialized;
      const botWid = client.info?.wid?._serialized;

      const senderPart = chat.participants.find((p) => p.id._serialized === senderWid);
      const botPart = chat.participants.find((p) => p.id._serialized === botWid);

      const fmt = (label, part) =>
        `${label}: ${part?.id?._serialized || '-'} | admin=${!!(part?.isAdmin || part?.isSuperAdmin)} | owner=${!!part?.isSuperAdmin}`;

      return msg.reply(
        '🔧 Admin Debug\n' + fmt('Sender', senderPart) + '\n' + fmt('Bot   ', botPart)
      );
    }

    /* ===== !stiker (gambar / GIF / video) ===== */
    if (cmd === '!stiker' || cmd === '!sticker') {
      let targetMsg = msg;
      if (msg.hasQuotedMsg) {
        try { targetMsg = await msg.getQuotedMessage(); } catch {}
      }

      if (!targetMsg.hasMedia) {
        return msg.reply('Balas (reply) ke gambar / GIF / video, lalu kirim `!stiker [author|pack]`.');
      }

      const meta = parseStickerMeta(args);
      const media = await targetMsg.downloadMedia();
      if (!media || !media.mimetype || !media.data) {
        return msg.reply('Gagal mengunduh media. Coba lagi.');
      }

      // batasan ukuran & durasi agar aman
      const MAX_BYTES = 15 * 1024 * 1024;
      const buf = Buffer.from(media.data, 'base64');
      if (buf.length > MAX_BYTES) {
        return msg.reply('File terlalu besar. Maksimal ~15MB.');
      }

      try {
        const ext = mimeExt(media.mimetype);
        const inPath = writeTmp(buf, ext);

        let outB64;
        if (media.mimetype.startsWith('image/')) {
          // gambar → webp statis
          outB64 = await toStaticWebpBuffer(inPath);
        } else if (media.mimetype.startsWith('video/') || ext === 'gif') {
          // GIF / video → webp animasi
          outB64 = await toAnimatedWebpBuffer(inPath, { fps: 15, maxSec: 6 });
        } else {
          try { fs.unlinkSync(inPath); } catch {}
          return msg.reply('Format tidak didukung untuk stiker.');
        }

        try { fs.unlinkSync(inPath); } catch {}

        const stickerMedia = new MessageMedia('image/webp', outB64);
        await chat.sendMessage(stickerMedia, {
          sendMediaAsSticker: true,
          stickerAuthor: meta.author,
          stickerName: meta.pack,
        });
      } catch (e) {
        console.error('Sticker convert error:', e);
        return msg.reply('Gagal membuat stiker. Coba media lain atau lebih pendek.');
      }

      return;
    }

  } catch (err) {
    console.error('Error:', err);
    try { await msg.reply('Terjadi error saat memproses perintah.'); } catch {}
  }
});

/* =========================
   START
   ========================= */
client.initialize();
