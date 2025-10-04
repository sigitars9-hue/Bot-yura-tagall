// index.js
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    executablePath: '/usr/bin/chromium-browser', // atau '/usr/bin/chromium'
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
async function isBotAdmin(chat, client) {
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
   STIKER (gambar only)
   ========================= */
function parseStickerMeta(args) {
  const joined = args.join(' ').trim();
  if (!joined) return { author: 'Bot', pack: 'Sticker' };
  const [author, pack] = joined.split('|').map(s => (s || '').trim());
  return { author: author || 'Bot', pack: pack || 'Sticker' };
}
async function createStickerFromImage(mediaBase64, meta) {
  const media = new MessageMedia('image/jpeg', mediaBase64);
  return { media, options: { sendMediaAsSticker: true, stickerAuthor: meta.author, stickerName: meta.pack } };
}

/* =========================
   EVENT
   ========================= */
client.on('qr', (qr) => {
  console.log('Scan QR berikut di WhatsApp (Linked Devices):');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  ensureLogReady();
  console.log('✅ Bot siap!');
  console.log('Perintah:');
  console.log('• !tagall [pesan opsional]');
  console.log('• !aktif [jumlah]  -> top member aktif di grup ini (default 10, max 50)');
  console.log('• !admindebug');
  console.log('• !stiker [author|pack]  (reply ke gambar saja)');
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

    /* ===== !tagall ===== */
    if (cmd === '!tagall') {
      if (!chat.isGroup) return msg.reply('Perintah ini hanya untuk grup.');
      const rawText = msg.body.slice('!tagall'.length).trim();
      const headerText = rawText.length ? msg.body.slice(8).trim() : 'Ping semua member 👋';

      const participants = chat.participants || [];
      const contacts = await Promise.all(
        participants.map((p) => client.getContactById(p.id._serialized))
      );

      await chat.sendMessage(headerText || '👋', { mentions: contacts });
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

    /* ===== !stiker (gambar only) ===== */
    if (cmd === '!stiker' || cmd === '!sticker') {
      let targetMsg = msg;
      if (msg.hasQuotedMsg) {
        try { targetMsg = await msg.getQuotedMessage(); } catch {}
      }

      if (!targetMsg.hasMedia) {
        return msg.reply('Balas (reply) ke gambar, lalu kirim `!stiker [author|pack]`.');
      }

      const meta = parseStickerMeta(args);
      const media = await targetMsg.downloadMedia();
      if (!media || !media.mimetype || !media.data) {
        return msg.reply('Gagal mengunduh media. Coba lagi.');
      }

      if (media.mimetype.startsWith('image/')) {
        const payload = await createStickerFromImage(media.data, meta);
        await msg.reply('Membuat stiker…');
        await chat.sendMessage(payload.media, payload.options);
        return;
      }

      return msg.reply('⚠️ Saat ini hanya gambar yang bisa dijadikan stiker.');
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
