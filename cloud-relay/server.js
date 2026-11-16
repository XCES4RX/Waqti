// Waqti (وقتي) — Cloud Relay & Multi-Tenant Telegram Bot
// 24/7 central relay connecting parent Telegram accounts with Windows PCs.
// Supports multi-device management per user (switch, add, unpair).
// Zero npm dependencies — runs on standard Node.js (v18+)

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const DB_PATH = path.join(__dirname, 'relay_db.json');

let config = {
  botToken: "9002447766:AAEUHZg-JMxwUn3S_OCW1DwbrccUbXkjblo",
  botUsername: "Waqti_bot",
  port: 5055,
  heartbeatTimeoutSeconds: 75
};

if (fs.existsSync(CONFIG_PATH)) {
  try {
    config = Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
  } catch (err) {
    console.error('Failed to parse config.json:', err);
  }
}

// Database state
let db = {
  devices: {}, // deviceId -> { deviceId, deviceName, pairingCode, ownerChatId, lastSeen, isOnline, status, pendingCommands: [] }
  users: {}    // chatId -> { chatId, pairedDeviceIds: [], activeDeviceId, lang: 'ar', pendingInput: null }
};

function loadDb() {
  if (fs.existsSync(DB_PATH)) {
    try {
      db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
      if (!db.devices) db.devices = {};
      if (!db.users) db.users = {};
      for (const [cid, u] of Object.entries(db.users)) {
        if (!u.pairedDeviceIds) {
          u.pairedDeviceIds = u.activeDeviceId ? [u.activeDeviceId] : [];
        }
      }
    } catch (e) {
      console.error('Failed to read relay_db.json:', e);
    }
  }
}

function saveDb() {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save relay_db.json:', e);
  }
}

loadDb();

// -------------------------------------------------------------
// Telegram API Helper (HTTPS)
// -------------------------------------------------------------
function telegramApi(method, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload || {});
    const req = https.request({
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${config.botToken}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      },
      timeout: 35000
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve(json);
        } catch (e) {
          resolve({ ok: false, error: body });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Telegram API request timed out'));
    });

    req.write(data);
    req.end();
  });
}

async function sendTelegramMessage(chatId, text, replyMarkup = null) {
  try {
    const payload = {
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML'
    };
    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }
    return await telegramApi('sendMessage', payload);
  } catch (err) {
    console.error(`Error sending message to ${chatId}:`, err.message);
  }
}

async function sendTelegramPhoto(chatId, photoBuffer, caption = '') {
  return new Promise((resolve, reject) => {
    const boundary = '----WebKitFormBoundary' + crypto.randomBytes(8).toString('hex');
    const req = https.request({
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${config.botToken}/sendPhoto`,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { resolve({ ok: false }); }
      });
    });

    req.on('error', reject);

    req.write(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`);
    if (caption) {
      req.write(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`);
    }
    req.write(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="screenshot.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`);
    req.write(photoBuffer);
    req.write(`\r\n--${boundary}--\r\n`);
    req.end();
  });
}

async function answerCallbackQuery(callbackQueryId, text = null, showAlert = false) {
  try {
    const payload = { callback_query_id: callbackQueryId };
    if (text) {
      payload.text = text;
      payload.show_alert = showAlert;
    }
    await telegramApi('answerCallbackQuery', payload);
  } catch (e) {}
}

// -------------------------------------------------------------
// Pairing & Device Helpers
// -------------------------------------------------------------
function generatePairingCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function findDeviceByPairingCode(code) {
  const clean = String(code).trim().replace(/[^0-9]/g, '');
  if (clean.length !== 6) return null;
  for (const [id, dev] of Object.entries(db.devices)) {
    if (dev.pairingCode === clean) {
      return dev;
    }
  }
  return null;
}

function isDeviceOnline(device) {
  if (!device || !device.lastSeen) return false;
  const lastSeenMs = new Date(device.lastSeen).getTime();
  const diffSec = (Date.now() - lastSeenMs) / 1000;
  return diffSec <= config.heartbeatTimeoutSeconds;
}

function formatMinutes(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

// -------------------------------------------------------------
// Multilingual Texts & Templates
// -------------------------------------------------------------
const TEXTS = {
  ar: {
    welcome_unpaired: "👋 <b>مرحباً بك في بوت الرقابة الأبوية!</b>\n\nلم يتم ربط أي جهاز بحسابك بعد.\n\n🔗 <b>لربط جهاز الكمبيوتر:</b>\n1. افتح برنامج الرقابة الأبوية على كمبيوتر طفلك.\n2. اضغط على <b>إعدادات</b> ثم <b>ربط التلغرام</b>.\n3. أرسل كود الاقتران المكون من 6 أرقام هنا (مثال: <code>{code}</code>).\n\nأو اضغط مباشرة على رابط الربط الظاهر في شاشة البرنامج.",
    pairing_success: "✅ <b>تم ربط الجهاز بنجاح!</b>\n\n💻 <b>اسم الجهاز:</b> <code>{name}</code>\n🆔 <b>المعرّف:</b> <code>{id}</code>\n📱 <b>إجمالي أجهزتك المسجلة:</b> {count}\n\nأنت الآن تتحكم بهذا الجهاز ويمكنك التبديل بين أجهزتك في أي وقت من زر <b>إدارة الأجهزة</b>.",
    pairing_invalid: "❌ كود الاقتران غير صحيح أو منتهي الصلاحية.\nيرجى فتح شاشة إعدادات البرنامج على الكمبيوتر والتحقق من كود الـ 6 أرقام.",
    main_menu_title: "🛡️ <b>لوحة تحكم الرقابة الأبوية — {device}</b>",
    btn_status: "📊 حالة الجهاز",
    btn_screenshot: "📸 لقطة شاشة",
    btn_time_menu: "⏳ الوقت والحدود",
    btn_dns: "🛡️ حماية DNS",
    btn_pause: "⏸️ وقت مستقطع (العشاء)",
    btn_resume: "▶️ استئناف الجلسة",
    btn_msg: "💬 إرسال رسالة للشاشة",
    btn_top: "📊 الأكثر استخداماً",
    btn_devices: "💻 إدارة الأجهزة ({count})",
    btn_refresh: "🔄 تحديث",
    btn_main: "🏠 القائمة الرئيسية",
    status_online: "🟢 شغال ومتصل الآن",
    status_offline: "🔴 غير متصل حالياً (مطفأ أو مفصول)",
    lock_btn: "🔒 قفل (Session #{id})",
    logout_btn: "🚪 خروج (Session #{id})",
    cmd_queued: "⏳ <b>تم وضع الأمر في قائمة الانتظار:</b>\nسيتم تطبيق {action} فور تشغيل الجهاز والاتصال بالإنترنت.",
    cmd_sent: "⚡ <b>تم إرسال الأمر للجهاز:</b>\nجاري تطبيق {action} الآن...",
    cmd_ack: "✅ <b>تم تنفيذ الأمر المجدول بنجاح!</b>\n💻 الجهاز: <code>{device}</code>\n⚙️ الإجراء: <b>{action}</b>"
  },
  en: {
    welcome_unpaired: "👋 <b>Welcome to Waqti Parental Control Bot!</b>\n\nNo device is linked to your Telegram account yet.\n\n🔗 <b>To pair your computer:</b>\n1. Open Waqti on your child's PC.\n2. Click <b>Settings & Telegram</b>.\n3. Send the 6-digit pairing PIN here (e.g. <code>{code}</code>).\n\nOr click the direct link shown on the computer screen.",
    pairing_success: "✅ <b>Device Paired Successfully!</b>\n\n💻 <b>Computer:</b> <code>{name}</code>\n🆔 <b>Device ID:</b> <code>{id}</code>\n📱 <b>Total Registered Devices:</b> {count}\n\nYou can manage this device or switch between workstations via <b>Device Management</b>.",
    pairing_invalid: "❌ Invalid or expired pairing code.\nPlease verify the 6-digit PIN on the computer settings screen.",
    main_menu_title: "🛡️ <b>Waqti Dashboard — {device}</b>",
    btn_status: "📊 Device Status",
    btn_screenshot: "📸 Screenshot",
    btn_time_menu: "⏳ Time & Limits",
    btn_dns: "🛡️ Family Safe DNS",
    btn_pause: "⏸️ Dinner Pause Mode",
    btn_resume: "▶️ Resume Session",
    btn_msg: "💬 Message Screen",
    btn_top: "📊 Top Activity",
    btn_devices: "💻 Manage Devices ({count})",
    btn_refresh: "🔄 Refresh",
    btn_main: "🏠 Main Menu",
    status_online: "🟢 Online & Connected",
    status_offline: "🔴 Offline (Shutdown or No Internet)",
    lock_btn: "🔒 Lock (Session #{id})",
    logout_btn: "🚪 Log off (Session #{id})",
    cmd_queued: "⏳ <b>Command Queued:</b>\n{action} will execute as soon as the PC turns on and connects.",
    cmd_sent: "⚡ <b>Command Sent:</b>\nExecuting {action} now...",
    cmd_ack: "✅ <b>Queued command executed successfully!</b>\n💻 Device: <code>{device}</code>\n⚙️ Action: <b>{action}</b>"
  }
};

function getLang(chatId) {
  return (db.users[chatId] && db.users[chatId].lang) || 'ar';
}

function t(chatId, key, params = {}) {
  const lang = getLang(chatId);
  let str = (TEXTS[lang] && TEXTS[lang][key]) || TEXTS['ar'][key] || key;
  for (const [k, v] of Object.entries(params)) {
    str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
  }
  return str;
}

function getUserDeviceCount(chatId) {
  const user = db.users[chatId];
  if (!user || !user.pairedDeviceIds) return 0;
  return user.pairedDeviceIds.length;
}

function buildMainKeyboard(chatId, device) {
  const count = getUserDeviceCount(chatId);
  return {
    inline_keyboard: [
      [
        { text: t(chatId, 'btn_status'), callback_data: 'cmd:status' },
        { text: t(chatId, 'btn_screenshot'), callback_data: 'cmd:screenshot' }
      ],
      [
        { text: t(chatId, 'btn_time_menu'), callback_data: 'cmd:limits' },
        { text: t(chatId, 'btn_dns'), callback_data: 'cmd:dns' }
      ],
      [
        { text: t(chatId, 'btn_pause'), callback_data: 'cmd:pause' },
        { text: t(chatId, 'btn_msg'), callback_data: 'cmd:msg' }
      ],
      [
        { text: t(chatId, 'btn_top'), callback_data: 'cmd:top' },
        { text: t(chatId, 'btn_devices', { count }), callback_data: 'cmd:devices' }
      ],
      [
        { text: t(chatId, 'btn_refresh'), callback_data: 'cmd:status' }
      ]
    ]
  };
}

// -------------------------------------------------------------
// Multi-Device Management View & Keyboard
// -------------------------------------------------------------
function buildDevicesMessage(chatId) {
  const user = db.users[chatId];
  const list = (user && user.pairedDeviceIds) || [];

  let msg = `💻 <b>إدارة الأجهزة المرتبطة بحسابك (${list.length}):</b>\n\n`;

  if (list.length === 0) {
    msg += `<i>لا توجد أجهزة مرتبطة بحسابك حالياً.</i>\n\nاضغط على الزر أدناه لربط جهاز جديد.`;
    return msg;
  }

  for (let i = 0; i < list.length; i++) {
    const devId = list[i];
    const dev = db.devices[devId];
    if (!dev) continue;

    const isActive = devId === user.activeDeviceId;
    const online = isDeviceOnline(dev);
    const star = isActive ? '⭐ (الجهاز النشط حالياً)' : '';

    msg += `<b>${i + 1}. ${dev.deviceName || 'PC'}</b> ${star}\n`;
    msg += `   🆔 المعرّف: <code>${dev.deviceId}</code>\n`;
    msg += `   📶 الحالة: ${online ? '🟢 متصل وشغال' : '🔴 غير متصل'}\n`;

    const users = (dev.status && dev.status.users) || [];
    if (users.length > 0) {
      const uStr = users.map(u => `${u.username} (${u.remainingDaily || 0}د متبقية)`).join(', ');
      msg += `   👤 المستخدمون: ${uStr}\n`;
    }
    msg += `\n`;
  }

  msg += `<i>اضغط على اسم أي جهاز أدناه للتبديل إليه والتحكم به:</i>`;
  return msg;
}

function buildDevicesKeyboard(chatId) {
  const user = db.users[chatId];
  const list = (user && user.pairedDeviceIds) || [];
  const rows = [];

  for (const devId of list) {
    const dev = db.devices[devId];
    if (!dev) continue;
    const isActive = devId === user.activeDeviceId;
    const label = (isActive ? '⭐ ' : '💻 ') + (dev.deviceName || devId);
    rows.push([{ text: label, callback_data: `device:switch:${devId}` }]);
  }

  rows.push([
    { text: "➕ ربط جهاز جديد", callback_data: "device:add" },
    { text: "🗑️ حذف الجهاز النشط", callback_data: "device:unpair_active" }
  ]);

  rows.push([{ text: t(chatId, 'btn_main'), callback_data: 'cmd:menu' }]);

  return { inline_keyboard: rows };
}

// -------------------------------------------------------------
// Message Rendering (Device Status with Corrected Timing)
// -------------------------------------------------------------
function buildStatusMessage(chatId, device) {
  const online = isDeviceOnline(device);
  const statusStr = online ? t(chatId, 'status_online') : t(chatId, 'status_offline');
  const dName = device.deviceName || 'PC';
  const lastSeenStr = device.lastSeen ? new Date(device.lastSeen).toLocaleTimeString() : 'N/A';

  let msg = `🖥️ <b>${dName}</b> — <b>${statusStr}</b>\n`;
  if (online) {
    msg += `⏱️ مدة التشغيل: <code>${device.status?.windowsUptime || 'N/A'}</code>\n`;
    msg += `🛡️ خدمة الرقابة: <code>${device.status?.serviceUptime || 'N/A'}</code>\n\n`;
  } else {
    msg += `⏱️ آخر اتصال مسجل: <code>${lastSeenStr}</code>\n\n`;
  }

  const users = (device.status && device.status.users) || [];
  if (users.length === 0) {
    msg += `💤 <i>لا توجد جلسات مستخدمين نشطة حالياً.</i>\n`;
  } else {
    msg += `👤 <b>المستخدمون:</b>\n`;
    for (const u of users) {
      msg += `\n• <b>${u.username}</b> ${u.isRestricted ? '🔒 (مقيد)' : '🔓'}\n`;
      msg += `   📊 المستهلك اليوم: <b>${u.usedToday}/${u.dailyLimit || '∞'} د</b>\n`;
      if (u.isRestricted && u.dailyLimit) {
        const dailyRemaining = Math.max(0, u.dailyLimit - u.usedToday);
        msg += `   ⏳ <b>رصيد اليوم المتبقي:</b> <b>${dailyRemaining} د</b> (${formatMinutes(dailyRemaining)})\n`;
        if (u.scheduleEnd) {
          const schedRem = u.remainingSchedule !== undefined ? u.remainingSchedule : dailyRemaining;
          msg += `   🌙 <b>المتبقي للجلسة حتى موعد الإغلاق (${u.scheduleEnd}):</b> <b>${schedRem} د</b> (${formatMinutes(schedRem)})\n`;
        }
      }
    }
  }

  if (!online) {
    msg += `\n💡 <i>الجهاز غير متصل حالياً، لكن يمكنك إرسال أي أوامر وسيقوم البرنامج بتطبيقها فور تشغيل الجهاز.</i>`;
  }

  return msg;
}

// -------------------------------------------------------------
// Telegram Bot Long Polling Worker
// -------------------------------------------------------------
let updateOffset = 0;

async function pollTelegram() {
  while (true) {
    try {
      const res = await telegramApi('getUpdates', {
        offset: updateOffset,
        timeout: 25,
        allowed_updates: ['message', 'callback_query']
      });

      if (res && res.ok && Array.isArray(res.result)) {
        for (const update of res.result) {
          updateOffset = update.update_id + 1;
          await handleTelegramUpdate(update);
        }
      }
    } catch (err) {
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

async function handleTelegramUpdate(update) {
  if (update.message) {
    const msg = update.message;
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();

    if (!db.users[chatId]) {
      db.users[chatId] = { chatId, pairedDeviceIds: [], activeDeviceId: null, lang: 'ar', pendingInput: null };
      saveDb();
    }

    const user = db.users[chatId];
    if (!user.pairedDeviceIds) {
      user.pairedDeviceIds = user.activeDeviceId ? [user.activeDeviceId] : [];
    }

    // 1. Check pending input states
    if (user.pendingInput) {
      const pending = user.pendingInput;

      if (pending.type === 'msg_to_screen' && user.activeDeviceId && db.devices[user.activeDeviceId]) {
        user.pendingInput = null;
        saveDb();
        enqueueCommand(user.activeDeviceId, 'send_msg', { message: text, user: pending.username || 'All' });
        await sendTelegramMessage(chatId, `✅ تم إرسال الرسالة إلى شاشة الطفل:\n<i>"${text}"</i>`);
        return;
      }

      if (pending.type === 'pair_new_device') {
        user.pendingInput = null;
        saveDb();
        const digits = text.replace(/[^0-9]/g, '');
        if (digits.length === 6 && tryPairUser(chatId, digits)) {
          return;
        } else {
          await sendTelegramMessage(chatId, t(chatId, 'pairing_invalid'));
          return;
        }
      }
    }

    // 2. Handle /start [code]
    if (text.startsWith('/start')) {
      const parts = text.split(/\s+/);
      if (parts.length > 1) {
        const potentialCode = parts[1].replace(/[^0-9]/g, '');
        if (tryPairUser(chatId, potentialCode)) {
          return;
        }
      }
    }

    // 3. Check if user typed a 6-digit code
    const digitsOnly = text.replace(/[^0-9]/g, '');
    if (digitsOnly.length === 6) {
      if (tryPairUser(chatId, digitsOnly)) {
        return;
      }
    }

    // 4. If user has no paired devices
    if (!user.activeDeviceId || !db.devices[user.activeDeviceId]) {
      const exampleCode = "123456";
      await sendTelegramMessage(chatId, t(chatId, 'welcome_unpaired', { code: exampleCode }));
      return;
    }

    const device = db.devices[user.activeDeviceId];

    // 5. Handle standard commands
    if (text === '/devices' || text.includes('إدارة الأجهزة')) {
      await sendTelegramMessage(chatId, buildDevicesMessage(chatId), buildDevicesKeyboard(chatId));
      return;
    }

    if (text === '/menu' || text === '/start' || text.includes('القائمة')) {
      const menuText = t(chatId, 'main_menu_title', { device: device.deviceName || 'PC' });
      await sendTelegramMessage(chatId, menuText, buildMainKeyboard(chatId, device));
      return;
    }

    if (text === '/status' || text.includes('حالة')) {
      const statusText = buildStatusMessage(chatId, device);
      await sendTelegramMessage(chatId, statusText, buildMainKeyboard(chatId, device));
      return;
    }

    if (text.startsWith('/msg ')) {
      const msgText = text.substring(5).trim();
      enqueueCommand(device.deviceId, 'send_msg', { message: msgText, user: 'All' });
      await sendTelegramMessage(chatId, `✅ تم إرسال الرسالة للشاشة:\n<i>"${msgText}"</i>`);
      return;
    }

    if (text.startsWith('/pause')) {
      enqueueCommand(device.deviceId, 'pause', { minutes: 30, user: 'All' });
      await sendTelegramMessage(chatId, `⏸️ تم تفعيل وضع الاستراحة (30 دقيقة).`);
      return;
    }

    if (text.startsWith('/resume')) {
      enqueueCommand(device.deviceId, 'resume', { user: 'All' });
      await sendTelegramMessage(chatId, `▶️ تم استئناف الجلسة.`);
      return;
    }

    if (text.startsWith('/top')) {
      enqueueCommand(device.deviceId, 'get_top', {});
      await sendTelegramMessage(chatId, `📊 جاري جلب تقرير البرامج والمواقع الأكثر استخداماً...`);
      return;
    }

    // Default: show menu
    const menuText = t(chatId, 'main_menu_title', { device: device.deviceName || 'PC' });
    await sendTelegramMessage(chatId, menuText, buildMainKeyboard(chatId, device));
  } else if (update.callback_query) {
    await handleCallbackQuery(update.callback_query);
  }
}

function tryPairUser(chatId, code) {
  const dev = findDeviceByPairingCode(code);
  if (!dev) return false;

  dev.ownerChatId = chatId;

  if (!db.users[chatId]) {
    db.users[chatId] = {
      chatId,
      pairedDeviceIds: [dev.deviceId],
      activeDeviceId: dev.deviceId,
      lang: 'ar',
      pendingInput: null
    };
  } else {
    const user = db.users[chatId];
    if (!user.pairedDeviceIds) user.pairedDeviceIds = [];
    if (!user.pairedDeviceIds.includes(dev.deviceId)) {
      user.pairedDeviceIds.push(dev.deviceId);
    }
    user.activeDeviceId = dev.deviceId;
  }

  saveDb();

  const totalCount = db.users[chatId].pairedDeviceIds.length;
  sendTelegramMessage(
    chatId,
    t(chatId, 'pairing_success', { name: dev.deviceName || 'PC', id: dev.deviceId, count: totalCount }),
    buildMainKeyboard(chatId, dev)
  );
  return true;
}

async function handleCallbackQuery(cb) {
  const chatId = cb.message.chat.id;
  const data = cb.data;
  const user = db.users[chatId];

  if (!user || !user.activeDeviceId || !db.devices[user.activeDeviceId]) {
    await answerCallbackQuery(cb.id, "الجهاز غير مقترن");
    return;
  }

  const device = db.devices[user.activeDeviceId];
  const isOnline = isDeviceOnline(device);

  // --- Multi-Device Actions ---
  if (data === 'cmd:devices') {
    await answerCallbackQuery(cb.id);
    await sendTelegramMessage(chatId, buildDevicesMessage(chatId), buildDevicesKeyboard(chatId));
    return;
  }

  if (data.startsWith('device:switch:')) {
    const targetId = data.substring(14);
    if (db.devices[targetId] && user.pairedDeviceIds.includes(targetId)) {
      user.activeDeviceId = targetId;
      saveDb();
      const targetDev = db.devices[targetId];
      await answerCallbackQuery(cb.id, `تم التبديل إلى: ${targetDev.deviceName || targetId}`);
      await sendTelegramMessage(
        chatId,
        `✅ <b>تم التبديل بنجاح إلى:</b> 💻 <b>${targetDev.deviceName || targetId}</b>`,
        buildMainKeyboard(chatId, targetDev)
      );
    } else {
      await answerCallbackQuery(cb.id, "الجهاز غير متاح", true);
    }
    return;
  }

  if (data === 'device:add') {
    user.pendingInput = { type: 'pair_new_device' };
    saveDb();
    await answerCallbackQuery(cb.id);
    await sendTelegramMessage(
      chatId,
      `➕ <b>ربط جهاز كمبيوتر جديد:</b>\n\n1. افتح برنامج الرقابة الأبوية على الكمبيوتر الثاني.\n2. اذهب إلى <b>إعدادات</b>.\n3. أرسل كود الاقتران المكون من 6 أرقام هنا الآن:`
    );
    return;
  }

  if (data === 'device:unpair_active') {
    const unpairingDevId = user.activeDeviceId;
    const dev = db.devices[unpairingDevId];
    if (dev) dev.ownerChatId = null;

    user.pairedDeviceIds = (user.pairedDeviceIds || []).filter(id => id !== unpairingDevId);
    user.activeDeviceId = user.pairedDeviceIds.length > 0 ? user.pairedDeviceIds[0] : null;
    saveDb();

    await answerCallbackQuery(cb.id, "تم حذف الجهاز");

    if (user.activeDeviceId && db.devices[user.activeDeviceId]) {
      const nextDev = db.devices[user.activeDeviceId];
      await sendTelegramMessage(
        chatId,
        `🗑️ تم إلغاء ربط الجهاز.\n\n🔄 <b>تم التبديل تلقائياً إلى جهازك الآخر:</b> 💻 <b>${nextDev.deviceName || nextDev.deviceId}</b>`,
        buildMainKeyboard(chatId, nextDev)
      );
    } else {
      await sendTelegramMessage(
        chatId,
        `🗑️ تم إلغاء ربط الجهاز بنجاح. لا توجد أجهزة متبقية بحسابك.\nيمكنك ربط جهاز جديد في أي وقت بإرسال كود الاقتران.`
      );
    }
    return;
  }

  // --- Device Controls ---
  if (data === 'cmd:status') {
    await answerCallbackQuery(cb.id);
    const statusText = buildStatusMessage(chatId, device);
    await sendTelegramMessage(chatId, statusText, buildMainKeyboard(chatId, device));
    return;
  }

  if (data === 'cmd:screenshot') {
    if (!isOnline) {
      await answerCallbackQuery(cb.id, "⚠️ الجهاز غير متصل حالياً لالتقاط لقطة شاشة", true);
      return;
    }
    await answerCallbackQuery(cb.id, "جاري التقاط لقطة الشاشة...");
    enqueueCommand(device.deviceId, 'take_screenshot', { chatId });
    return;
  }

  if (data === 'cmd:limits') {
    await answerCallbackQuery(cb.id);
    const users = (device.status && device.status.users) || [];
    let text = `⏳ <b>إدارة الوقت والحدود — ${device.deviceName}</b>\n\n`;
    const rows = [];

    for (const u of users) {
      text += `👤 <b>${u.username}</b>: مستهلك <code>${u.usedToday}/${u.dailyLimit || '∞'}</code> دقيقة\n`;
      rows.push([
        { text: `➕ 15د (${u.username})`, callback_data: `time:add:${u.username}:15` },
        { text: `➕ 30د (${u.username})`, callback_data: `time:add:${u.username}:30` },
        { text: `➕ 60د (${u.username})`, callback_data: `time:add:${u.username}:60` }
      ]);
      rows.push([
        { text: `➖ 15د (${u.username})`, callback_data: `time:sub:${u.username}:15` },
        { text: `➖ 30د (${u.username})`, callback_data: `time:sub:${u.username}:30` },
        { text: `🔒 قفل فوري`, callback_data: `action:lock:${u.sessionId || 1}` }
      ]);
    }

    rows.push([{ text: t(chatId, 'btn_main'), callback_data: 'cmd:menu' }]);

    await sendTelegramMessage(chatId, text, { inline_keyboard: rows });
    return;
  }

  if (data.startsWith('time:add:') || data.startsWith('time:sub:')) {
    const parts = data.split(':');
    const isAdd = parts[1] === 'add';
    const username = parts[2];
    const minutes = parseInt(parts[3], 10);
    const actionDelta = isAdd ? minutes : -minutes;

    enqueueCommand(device.deviceId, 'adjust_time', { username, minutes: actionDelta });
    await answerCallbackQuery(cb.id, `تم تسجيل تعديل الوقت: ${isAdd ? '+' : '-'}${minutes} دقيقة`);
    await sendTelegramMessage(chatId, isOnline
      ? t(chatId, 'cmd_sent', { action: `${isAdd ? 'زيادة' : 'إنقاص'} ${minutes} دقيقة لـ ${username}` })
      : t(chatId, 'cmd_queued', { action: `${isAdd ? 'زيادة' : 'إنقاص'} ${minutes} دقيقة لـ ${username}` }));
    return;
  }

  if (data.startsWith('action:lock:')) {
    const sessionId = data.split(':')[2];
    enqueueCommand(device.deviceId, 'lock_screen', { sessionId: parseInt(sessionId, 10) });
    await answerCallbackQuery(cb.id, "تم إرسال أمر القفل");
    await sendTelegramMessage(chatId, isOnline
      ? t(chatId, 'cmd_sent', { action: 'قفل الشاشة' })
      : t(chatId, 'cmd_queued', { action: 'قفل الشاشة' }));
    return;
  }

  if (data === 'cmd:pause') {
    enqueueCommand(device.deviceId, 'pause', { minutes: 30, user: 'All' });
    await answerCallbackQuery(cb.id, "تم تفعيل وقت مستقطع 30 دقيقة");
    await sendTelegramMessage(chatId, isOnline
      ? t(chatId, 'cmd_sent', { action: 'إيقاف مؤقت للجلسة (وضع العشاء)' })
      : t(chatId, 'cmd_queued', { action: 'إيقاف مؤقت للجلسة (وضع العشاء)' }));
    return;
  }

  if (data === 'cmd:dns') {
    enqueueCommand(device.deviceId, 'toggle_dns', {});
    await answerCallbackQuery(cb.id, "جاري تبديل وضع حماية Family DNS");
    await sendTelegramMessage(chatId, `🛡️ تم إرسال أمر تبديل حماية المحتوى والـ DNS.`);
    return;
  }

  if (data === 'cmd:msg') {
    user.pendingInput = { type: 'msg_to_screen', username: 'All' };
    saveDb();
    await answerCallbackQuery(cb.id);
    await sendTelegramMessage(chatId, `✍️ <b>أرسل الآن نص الرسالة التي تريد أن تظهر على شاشة الطفل:</b>`);
    return;
  }

  if (data === 'cmd:top') {
    enqueueCommand(device.deviceId, 'get_top', {});
    await answerCallbackQuery(cb.id, "جاري إعداد تقرير النشاط...");
    return;
  }

  if (data === 'cmd:menu') {
    await answerCallbackQuery(cb.id);
    const menuText = t(chatId, 'main_menu_title', { device: device.deviceName || 'PC' });
    await sendTelegramMessage(chatId, menuText, buildMainKeyboard(chatId, device));
    return;
  }

  await answerCallbackQuery(cb.id);
}

function enqueueCommand(deviceId, action, args = {}) {
  const dev = db.devices[deviceId];
  if (!dev) return null;
  if (!dev.pendingCommands) dev.pendingCommands = [];
  const cmd = {
    id: 'cmd_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
    action,
    args,
    createdAt: new Date().toISOString()
  };
  dev.pendingCommands.push(cmd);
  saveDb();
  return cmd;
}

// -------------------------------------------------------------
// REST API Server for Windows Client PC
// -------------------------------------------------------------
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      let data = {};
      if (body) {
        try { data = JSON.parse(body); } catch (e) {}
      }

      // 1. Device Registration / Pairing Code Refresh
      if (req.method === 'POST' && pathname === '/api/device/register') {
        const deviceId = data.deviceId || ('PC-' + crypto.randomBytes(4).toString('hex').toUpperCase());
        const deviceName = data.deviceName || 'PC';

        if (!db.devices[deviceId]) {
          db.devices[deviceId] = {
            deviceId,
            deviceName,
            pairingCode: generatePairingCode(),
            ownerChatId: null,
            lastSeen: new Date().toISOString(),
            status: {},
            pendingCommands: []
          };
        } else {
          db.devices[deviceId].deviceName = deviceName;
          if (!db.devices[deviceId].pairingCode) {
            db.devices[deviceId].pairingCode = generatePairingCode();
          }
        }

        saveDb();

        const dev = db.devices[deviceId];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          deviceId: dev.deviceId,
          pairingCode: dev.pairingCode,
          isPaired: !!dev.ownerChatId,
          botUsername: config.botUsername,
          botPairLink: `https://t.me/${config.botUsername}?start=${dev.pairingCode}`
        }));
        return;
      }

      // 2. Heartbeat & Command Pull
      if (req.method === 'POST' && pathname === '/api/device/heartbeat') {
        const deviceId = data.deviceId;
        if (!deviceId || !db.devices[deviceId]) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Device not registered' }));
          return;
        }

        const dev = db.devices[deviceId];
        dev.lastSeen = new Date().toISOString();
        if (data.status) {
          dev.status = data.status;
        }

        const commandsToExecute = dev.pendingCommands || [];
        dev.pendingCommands = [];
        saveDb();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          isPaired: !!dev.ownerChatId,
          commands: commandsToExecute
        }));
        return;
      }

      // 3. Command ACK from Windows Service
      if (req.method === 'POST' && pathname === '/api/device/ack') {
        const { deviceId, commandId, action, result } = data;
        const dev = db.devices[deviceId];
        if (dev && dev.ownerChatId) {
          const text = t(dev.ownerChatId, 'cmd_ack', {
            device: dev.deviceName || 'PC',
            action: action || 'الأمر'
          });
          sendTelegramMessage(dev.ownerChatId, text);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
      }

      // 4. Events forwarding
      if (req.method === 'POST' && pathname === '/api/device/event') {
        const { deviceId, eventType, text, keyboard } = data;
        const dev = db.devices[deviceId];
        if (dev && dev.ownerChatId && text) {
          sendTelegramMessage(dev.ownerChatId, text, keyboard);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
      }

      // 5. Screenshot Upload
      if (req.method === 'POST' && pathname === '/api/device/upload-screenshot') {
        const deviceId = url.searchParams.get('deviceId');
        const dev = db.devices[deviceId];
        if (dev && dev.ownerChatId) {
          const buffer = Buffer.from(body, 'base64');
          await sendTelegramPhoto(dev.ownerChatId, buffer, `📸 لقطة شاشة حيّة — ${dev.deviceName} (${new Date().toLocaleTimeString()})`);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
      }

      // Health check
      if (pathname === '/health' || pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          service: 'Waqti Cloud Relay',
          botUsername: config.botUsername,
          registeredDevices: Object.keys(db.devices).length,
          pairedUsers: Object.keys(db.users).length
        }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Endpoint not found' }));
    } catch (err) {
      console.error('Server error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
});

server.listen(config.port, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(`🛡️  Waqti (وقتي) — Cloud Relay`);
  console.log(`🤖  Bot: @${config.botUsername}`);
  console.log(`🌐  Local REST API: http://localhost:${config.port}`);
  console.log(`=======================================================`);

  // Start polling Telegram
  pollTelegram();
});
