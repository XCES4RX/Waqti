// Waqti (وقتي) — Cloudflare Worker Relay
// 24/7 Serverless Global Relay with Multi-Device Management & Telegram Webhook.

export default {
  async fetch(request, env, ctx) {
    try {
      await ensureDbInitialized(env);
      const url = new URL(request.url);
      const botToken = env.BOT_TOKEN || "9002447766:AAEUHZg-JMxwUn3S_OCW1DwbrccUbXkjblo";
      const botUsername = env.BOT_USERNAME || "Waqti_bot";

    // 1. Telegram Webhook Handler
    if (request.method === "POST" && (url.pathname === "/webhook" || url.pathname === "/")) {
      try {
        const update = await request.json();
        await handleTelegramUpdate(update, env, botToken, botUsername);
      } catch (err) {
        console.error("Webhook error:", err);
      }
      return new Response("OK", { status: 200 });
    }

    // 2. Windows PC Device Registration (POST /api/device/register)
    if (request.method === "POST" && url.pathname === "/api/device/register") {
      const data = await request.json();
      const deviceId = data.deviceId || ("PC-" + crypto.randomUUID().slice(0, 8).toUpperCase());
      const deviceName = data.deviceName || "PC";
      const pairingCode = data.pairingCode || Math.floor(1000000000 + Math.random() * 9000000000).toString();

      let device = await getKV(env, `dev:${deviceId}`) || {
        deviceId,
        deviceName,
        pairingCode,
        ownerChatId: null,
        lastSeen: new Date().toISOString(),
        pendingCommands: [],
        pairedUsers: {},
        users: []
      };

      device.deviceName = deviceName;
      device.pairingCode = pairingCode;
      device.lastSeen = new Date().toISOString();
      device.pairedUsers = device.pairedUsers || {};

      if (data.users && Array.isArray(data.users)) {
        device.users = data.users;
        for (const u of data.users) {
          if (u.pairingCode) {
            await putKV(env, `pin:${u.pairingCode}`, { deviceId, userSid: u.sid, username: u.username });
          }
        }
      }

      await putKV(env, `dev:${deviceId}`, device);
      await putKV(env, `pin:${device.pairingCode}`, { deviceId });

      return jsonResponse({
        success: true,
        deviceId: device.deviceId,
        pairingCode: device.pairingCode,
        isPaired: !!device.ownerChatId,
        botUsername,
        botPairLink: `https://t.me/${botUsername}?start=${device.pairingCode}`
      });
    }

    // 3. Heartbeat & Command Pull (POST /api/device/heartbeat)
    if (request.method === "POST" && url.pathname === "/api/device/heartbeat") {
      const data = await request.json();
      const deviceId = data.deviceId;
      let device = await getKV(env, `dev:${deviceId}`);
      if (!device) {
        device = {
          deviceId,
          deviceName: data.deviceName || "PC",
          pairingCode: data.pairingCode || Math.floor(1000000000 + Math.random() * 9000000000).toString(),
          ownerChatId: null,
          lastSeen: new Date().toISOString(),
          pendingCommands: [],
          pairedUsers: {},
          users: []
        };
      }

      device.pairedUsers = device.pairedUsers || {};

      if (data.users && Array.isArray(data.users)) {
        device.users = data.users;
        for (const u of data.users) {
          if (u.pairingCode) {
            await putKV(env, `pin:${u.pairingCode}`, { deviceId, userSid: u.sid, username: u.username });
          }
        }
      }

      const commands = device.pendingCommands || [];
      const hasCommandsToClear = commands.length > 0;

      const now = Date.now();
      device.lastSeen = new Date(now).toISOString();
      if (data.status) device.status = data.status;
      if (hasCommandsToClear) device.pendingCommands = [];

      const lastWrite = device._lastWrite || 0;
      const statusChanged = data.status && JSON.stringify(data.status) !== JSON.stringify(device.status);
      const timeForPeriodicWrite = (now - lastWrite) > 45000;

      if (hasCommandsToClear || statusChanged || timeForPeriodicWrite) {
        device._lastWrite = now;
        await putKV(env, `dev:${deviceId}`, device);
      } else {
        memoryStore.set(`dev:${deviceId}`, device);
      }

      const pairedUserSids = [];
      if (device.users) {
        for (const u of device.users) {
          if (device.pairedUsers[u.sid]) {
            pairedUserSids.push(u.sid);
          }
        }
      }

      return jsonResponse({
        success: true,
        isPaired: !!device.ownerChatId || pairedUserSids.length > 0,
        pairedUserSids,
        commands
      });
    }

    // 4. Command ACK (POST /api/device/ack)
    if (request.method === "POST" && url.pathname === "/api/device/ack") {
      const data = await request.json();
      const device = await getKV(env, `dev:${data.deviceId}`);
      if (device && device.ownerChatId) {
        const act = data.action || "";
        // Don't send redundant ACK messages for actions that post their own rich output
        if (act !== "take_screenshot" && act !== "get_top" && act !== "التقاط صورة شاشة" && act !== "تقرير النشاط والمواقع") {
          await sendTelegram(botToken, device.ownerChatId, `✅ <b>تم تنفيذ الأمر بنجاح!</b>\n💻 الجهاز: <code>${device.deviceName || 'PC'}</code>\n⚙️ الإجراء: <b>${act || 'الأمر'}</b>`);
        }
      }
      return jsonResponse({ success: true });
    }

    // 5. Events Forwarding (POST /api/device/event)
    if (request.method === "POST" && url.pathname === "/api/device/event") {
      const data = await request.json();
      const device = await getKV(env, `dev:${data.deviceId}`);
      if (device && device.ownerChatId && data.text) {
        await sendTelegram(botToken, device.ownerChatId, data.text, data.keyboard);
      }
      return jsonResponse({ success: true });
    }

    // 6. Screenshot Upload (POST /api/device/upload-screenshot)
    if (request.method === "POST" && url.pathname === "/api/device/upload-screenshot") {
      const deviceId = url.searchParams.get("deviceId");
      const device = await getKV(env, `dev:${deviceId}`);
      if (device && device.ownerChatId) {
        let buffer = null;
        const contentType = request.headers.get("content-type") || "";
        if (contentType.includes("octet-stream") || contentType.includes("image/")) {
          buffer = new Uint8Array(await request.arrayBuffer());
        } else {
          const bodyText = await request.text();
          try {
            const binary = atob(bodyText.trim());
            buffer = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) buffer[i] = binary.charCodeAt(i);
          } catch (e) {
            console.error("Base64 decode failed:", e);
          }
        }

        if (buffer && buffer.length > 0) {
          const timeStr = new Date().toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          const caption = `📸 <b>لقطة شاشة حيّة</b>\n🖥 الجهاز: <b>${device.deviceName || 'PC'}</b>\n⏰ الوقت: <code>${timeStr}</code>`;
          await sendTelegramPhoto(botToken, device.ownerChatId, buffer, caption);
        }
      }
      return jsonResponse({ success: true });
    }

    // Health check
    return jsonResponse({
      status: "ok",
      service: "Waqti Cloudflare Relay (Multi-Device)",
      botUsername
    });
    } catch (err) {
      console.error("Worker root error:", err);
      return jsonResponse({ success: false, error: String(err?.message || err) }, 500);
    }
  }
};

// -------------------------------------------------------------
// Database (Cloudflare D1 + Memory Cache)
// -------------------------------------------------------------
const memoryStore = new Map();
let isTableInitialized = false;

async function ensureDbInitialized(env) {
  if (!isTableInitialized && env.DB) {
    try {
      await env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)"
      ).run();
      isTableInitialized = true;
    } catch (e) {
      console.error("D1 init error:", e);
    }
  }
}

async function getKV(env, key) {
  if (env.DB) {
    try {
      const row = await env.DB.prepare("SELECT value FROM kv_store WHERE key = ?").bind(key).first();
      if (row && row.value) {
        const parsed = JSON.parse(row.value);
        memoryStore.set(key, parsed);
        return parsed;
      }
    } catch (e) {
      console.error("D1 get error:", e);
    }
  }
  return memoryStore.get(key) || null;
}

async function putKV(env, key, val) {
  memoryStore.set(key, val);
  if (env.DB) {
    try {
      await env.DB.prepare(
        "INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      ).bind(key, JSON.stringify(val), Date.now()).run();
    } catch (e) {
      console.error("D1 put error:", e);
    }
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

// -------------------------------------------------------------
// Telegram API Helpers
// -------------------------------------------------------------
async function sendTelegram(token, chatId, text, replyMarkup = null) {
  try {
    const payload = { chat_id: chatId, text, parse_mode: "HTML" };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    let res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      // If HTML entity parsing fails, retry without parse_mode
      delete payload.parse_mode;
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    }
  } catch (err) {
    console.error("sendTelegram error:", err);
  }
}

async function answerCallback(token, callbackQueryId, text = null, showAlert = false) {
  try {
    const payload = { callback_query_id: callbackQueryId };
    if (text) {
      payload.text = text;
      payload.show_alert = showAlert;
    }
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (err) {}
}

async function sendTelegramPhoto(token, chatId, photoBytes, caption = "") {
  try {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    if (caption) {
      form.append("caption", caption);
      form.append("parse_mode", "HTML");
    }
    form.append("photo", new Blob([photoBytes], { type: "image/jpeg" }), "screenshot.jpg");

    let res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: "POST",
      body: form
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("sendTelegramPhoto error:", res.status, err);
      if (caption) {
        // Fallback without parse_mode
        const fallbackForm = new FormData();
        fallbackForm.append("chat_id", String(chatId));
        fallbackForm.append("caption", caption.replace(/<[^>]+>/g, ""));
        fallbackForm.append("photo", new Blob([photoBytes], { type: "image/jpeg" }), "screenshot.jpg");
        await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
          method: "POST",
          body: fallbackForm
        });
      }
    }
  } catch (err) {
    console.error("sendTelegramPhoto exception:", err);
  }
}

function formatMinutes(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}د`;
  if (m === 0) return `${h}س`;
  return `${h}س ${m}د`;
}

function isOnline(dev) {
  if (!dev || !dev.lastSeen) return false;
  const diffSec = (Date.now() - new Date(dev.lastSeen).getTime()) / 1000;
  return diffSec <= 300;
}

function buildMainKeyboard(user, dev) {
  const count = user.pairedDeviceIds ? user.pairedDeviceIds.length : 1;
  return {
    inline_keyboard: [
      [
        { text: "📊 حالة الجهاز", callback_data: "cmd:status" },
        { text: "📸 لقطة شاشة", callback_data: "cmd:screenshot" }
      ],
      [
        { text: "⏳ الوقت والحدود", callback_data: "cmd:limits" },
        { text: "🛡️ حماية DNS", callback_data: "cmd:dns" }
      ],
      [
        { text: "⏸️ وقت مستقطع", callback_data: "cmd:pause" },
        { text: "💬 إرسال رسالة", callback_data: "cmd:msg" }
      ],
      [
        { text: "📊 الأكثر استخداماً", callback_data: "cmd:top" },
        { text: `📱 إدارة الأجهزة (${count})`, callback_data: "cmd:devices" }
      ],
      [
        { text: "🔄 تحديث", callback_data: "cmd:status" }
      ]
    ]
  };
}

function buildStatusMessage(dev) {
  const online = isOnline(dev);
  const statusStr = online ? "🟢 متصل وشغّال الآن" : "🔴 غير متصل حالياً (مطفأ أو مفصول)";
  const lastSeenStr = dev.lastSeen ? new Date(dev.lastSeen).toLocaleTimeString() : "غير محدد";

  let msg = `🖥️ <b>${dev.deviceName || 'PC'}</b> — <b>${statusStr}</b>\n`;
  if (online) {
    msg += `⏱️ مدة تشغيل الويندوز: <code>${dev.status?.windowsUptime || 'N/A'}</code>\n`;
    msg += `🛡️ خدمة وقتي (Waqti): <code>${dev.status?.serviceUptime || 'N/A'}</code>\n\n`;
  } else {
    msg += `⏱️ آخر اتصال مسجل: <code>${lastSeenStr}</code>\n\n`;
  }

  const users = (dev.status && dev.status.users) || [];
  if (users.length === 0) {
    msg += `💤 <i>لا توجد جلسات مستخدمين نشطة حالياً.</i>\n`;
  } else {
    msg += `👤 <b>جلسات المستخدمين:</b>\n`;
    for (const u of users) {
      msg += `\n• <b>${u.username}</b> ${u.isRestricted ? '🔒 (مقيد)' : '🔓 (غير مقيد)'}\n`;
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
    msg += `\n💡 <i>الجهاز غير متصل حالياً، لكن يمكنك إرسال أي أوامر وسيقوم برنامج وقتي بتنفيذها فور تشغيل الجهاز وتوصيله بالإنترنت.</i>`;
  }

  return msg;
}

async function enqueueCommand(env, deviceId, action, args = {}) {
  const dev = await getKV(env, `dev:${deviceId}`);
  if (!dev) return;
  if (!dev.pendingCommands) dev.pendingCommands = [];
  dev.pendingCommands.push({
    id: "cmd_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
    action,
    args,
    createdAt: new Date().toISOString()
  });
  await putKV(env, `dev:${deviceId}`, dev);
}

// -------------------------------------------------------------
// Update Handler
// -------------------------------------------------------------
async function handleTelegramUpdate(update, env, botToken, botUsername) {
  if (update.message) {
    const msg = update.message;
    const chatId = msg.chat.id;
    const text = (msg.text || "").trim();

    let user = await getKV(env, `usr:${chatId}`) || {
      chatId,
      pairedDeviceIds: [],
      activeDeviceId: null,
      lang: "ar",
      pendingInput: null
    };

    // Pending text inputs
    if (user.pendingInput) {
      const p = user.pendingInput;
      user.pendingInput = null;
      await putKV(env, `usr:${chatId}`, user);

      if (p.type === "msg_to_screen" && user.activeDeviceId) {
        await enqueueCommand(env, user.activeDeviceId, "send_msg", { message: text });
        await sendTelegram(botToken, chatId, `✅ تم إرسال الرسالة إلى شاشة الطفل:\n<i>"${text}"</i>`);
        return;
      }

      if (p.type === "pair_new_device") {
        const code = text.replace(/[^0-9]/g, "");
        if (code.length === 6 || code.length === 10) {
          let pinTarget = await getKV(env, `pin:${code}`);
          if (pinTarget) {
            if (typeof pinTarget === "string") pinTarget = { deviceId: pinTarget };
            const dId = pinTarget.deviceId;
            const dev = await getKV(env, `dev:${dId}`);
            if (dev) {
              dev.ownerChatId = chatId;
              dev.pairedUsers = dev.pairedUsers || {};
              if (!user.pairedDeviceIds.includes(dId)) user.pairedDeviceIds.push(dId);
              user.activeDeviceId = dId;

              if (pinTarget.userSid) {
                dev.pairedUsers[pinTarget.userSid] = chatId;
                user.pairedUsers = user.pairedUsers || [];
                if (!user.pairedUsers.some(x => x.userSid === pinTarget.userSid)) {
                  user.pairedUsers.push({ deviceId: dId, userSid: pinTarget.userSid, username: pinTarget.username });
                }
                user.activeChild = { deviceId: dId, userSid: pinTarget.userSid, username: pinTarget.username };
                await putKV(env, `dev:${dId}`, dev);
                await putKV(env, `usr:${chatId}`, user);

                await sendTelegram(botToken, chatId, `✅ <b>تم ربط حساب الطفل بنجاح!</b>\n👤 المستخدم: <b>${pinTarget.username}</b>\n💻 الجهاز: <b>${dev.deviceName}</b>\n🔢 كود الاقتران: <code>${code}</code>\n\nيمكنك الآن إدارة وقته، إيقاف/استئناف الجلسة، وتلقي طلباته مباشرة!`, buildMainKeyboard(user, dev));
                return;
              } else {
                await putKV(env, `dev:${dId}`, dev);
                await putKV(env, `usr:${chatId}`, user);
                await sendTelegram(botToken, chatId, `✅ <b>تم ربط الجهاز بنجاح!</b>\n💻 الجهاز: <b>${dev.deviceName}</b>\n📱 إجمالي أجهزتك المسجلة: ${user.pairedDeviceIds.length}`, buildMainKeyboard(user, dev));
                return;
              }
            }
          }
        }
        await sendTelegram(botToken, chatId, `❌ كود الاقتران غير صحيح أو منتهي الصلاحية.`);
        return;
      }
    }

    // Direct /start with code or raw 6-digit or 10-digit code
    let pairCode = null;
    if (text.startsWith("/start") && text.split(/\s+/).length > 1) {
      pairCode = text.split(/\s+/)[1].replace(/[^0-9]/g, "");
    } else {
      const cleanNum = text.replace(/[^0-9]/g, "");
      if (cleanNum.length === 6 || cleanNum.length === 10) {
        pairCode = cleanNum;
      }
    }

    if (pairCode) {
      let pinTarget = await getKV(env, `pin:${pairCode}`);
      if (pinTarget) {
        if (typeof pinTarget === "string") pinTarget = { deviceId: pinTarget };
        const dId = pinTarget.deviceId;
        const dev = await getKV(env, `dev:${dId}`);
        if (dev) {
          dev.ownerChatId = chatId;
          dev.pairedUsers = dev.pairedUsers || {};

          if (!user.pairedDeviceIds.includes(dId)) user.pairedDeviceIds.push(dId);
          user.activeDeviceId = dId;

          if (pinTarget.userSid) {
            dev.pairedUsers[pinTarget.userSid] = chatId;
            user.pairedUsers = user.pairedUsers || [];
            if (!user.pairedUsers.some(x => x.userSid === pinTarget.userSid)) {
              user.pairedUsers.push({ deviceId: dId, userSid: pinTarget.userSid, username: pinTarget.username });
            }
            user.activeChild = { deviceId: dId, userSid: pinTarget.userSid, username: pinTarget.username };
            await putKV(env, `dev:${dId}`, dev);
            await putKV(env, `usr:${chatId}`, user);

            await sendTelegram(botToken, chatId, `✅ <b>تم ربط حساب الطفل بنجاح!</b>\n👤 المستخدم: <b>${pinTarget.username}</b>\n💻 الجهاز: <b>${dev.deviceName}</b>\n🔢 كود الاقتران: <code>${pairCode}</code>\n\nيمكنك الآن إدارة وقته، إيقاف/استئناف الجلسة، وتلقي طلباته مباشرة!`, buildMainKeyboard(user, dev));
            return;
          } else {
            await putKV(env, `dev:${dId}`, dev);
            await putKV(env, `usr:${chatId}`, user);

            await sendTelegram(botToken, chatId, `✅ <b>تم ربط الجهاز بنجاح!</b>\n💻 الجهاز: <b>${dev.deviceName}</b>\n🆔 المعرّف: <code>${dev.deviceId}</code>\n📱 إجمالي أجهزتك المسجلة: ${user.pairedDeviceIds.length}`, buildMainKeyboard(user, dev));
            return;
          }
        }
      }
    }

    // Unpaired user
    if (!user.activeDeviceId) {
      await sendTelegram(botToken, chatId, `👋 <b>مرحباً بك في بوت وقتي (Waqti)!</b>\n\nلم يتم ربط أي جهاز بحسابك بعد.\n\n🔗 <b>لربط جهاز الكمبيوتر:</b>\n1. افتح تطبيق <b>وقتي (Waqti)</b> على الكمبيوتر.\n2. اذهب إلى قسم <b>الإعدادات</b>.\n3. أرسل كود الاقتران المكون من 6 أرقام هنا.`);
      return;
    }

    const currentDev = await getKV(env, `dev:${user.activeDeviceId}`);
    if (!currentDev) return;

    if (text === "/devices" || text.includes("إدارة الأجهزة")) {
      await showDevicesMenu(env, botToken, chatId, user);
      return;
    }

    if (text === "/status" || text.includes("حالة")) {
      await sendTelegram(botToken, chatId, buildStatusMessage(currentDev), buildMainKeyboard(user, currentDev));
      return;
    }

    if (text === "/screenshot" || text.includes("لقطة") || text.includes("شاشة")) {
      if (!isOnline(currentDev)) {
        await sendTelegram(botToken, chatId, "⚠️ الجهاز غير متصل حالياً لالتقاط الشاشة.");
        return;
      }
      await enqueueCommand(env, currentDev.deviceId, "take_screenshot", { chatId });
      await sendTelegram(botToken, chatId, `📸 <b>جاري التقاط ونقل لقطة الشاشة من جهاز (${currentDev.deviceName || 'PC'})...</b>`);
      return;
    }

    if (text.startsWith("/msg ")) {
      const msgText = text.substring(5).trim();
      await enqueueCommand(env, currentDev.deviceId, "send_msg", { message: msgText });
      await sendTelegram(botToken, chatId, `✅ تم إرسال الرسالة للشاشة:\n<i>"${msgText}"</i>`);
      return;
    }

    if (text.startsWith("/pause")) {
      await enqueueCommand(env, currentDev.deviceId, "pause", { minutes: 30 });
      await sendTelegram(botToken, chatId, `⏸️ تم تفعيل وضع الاستراحة (30 دقيقة).`);
      return;
    }

    if (text.startsWith("/resume")) {
      await enqueueCommand(env, currentDev.deviceId, "resume");
      await sendTelegram(botToken, chatId, `▶️ تم استئناف الجلسة.`);
      return;
    }

    if (text.startsWith("/top") || text.includes("الأكثر استخداما")) {
      await enqueueCommand(env, currentDev.deviceId, "get_top");
      await sendTelegram(botToken, chatId, `📊 <b>جاري جلب تقرير البرامج والمواقع الأكثر استخداماً من جهاز (${currentDev.deviceName || 'PC'})...</b>`);
      return;
    }

    if (text === "/dns") {
      await enqueueCommand(env, currentDev.deviceId, "toggle_dns");
      await sendTelegram(botToken, chatId, "🛡️ تم إرسال أمر تبديل حماية Family DNS المانع للمواقع الإباحية والضارة.");
      return;
    }

    // Default: Main Menu
    await sendTelegram(botToken, chatId, `🛡️ <b>لوحة تحكم وقتي (Waqti) — ${currentDev.deviceName}</b>`, buildMainKeyboard(user, currentDev));
  } else if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message.chat.id;
    const data = cb.data;

    let user = await getKV(env, `usr:${chatId}`);
    if (!user || !user.activeDeviceId) {
      await answerCallback(botToken, cb.id, "الجهاز غير مقترن");
      return;
    }

    const dev = await getKV(env, `dev:${user.activeDeviceId}`);
    if (!dev) return;

    if (data.startsWith("approve_time:")) {
      const parts = data.split(":");
      const uid = parseInt(parts[1]);
      const mins = parseInt(parts[2]) || 15;
      await enqueueCommand(env, dev.deviceId, "add_time", { userId: uid, minutes: mins });
      await answerCallback(botToken, cb.id, `✅ تمت الموافقة على +${mins} دقيقة!`);
      await sendTelegram(botToken, chatId, `✅ <b>تمت الموافقة بنجاح!</b>\nتمت إضافة <b>+${mins} دقيقة</b> لحساب الطفل.`);
      return;
    }

    if (data.startsWith("deny_time:")) {
      await answerCallback(botToken, cb.id, "❌ تم رفض الطلب");
      await sendTelegram(botToken, chatId, "❌ تم رفض طلب الوقت الإضافي.");
      await enqueueCommand(env, dev.deviceId, "send_msg", { message: "عذراً، لم تتم الموافقة على طلب وقت إضافي حالياً." });
      return;
    }

    if (data === "cmd:status") {
      await answerCallback(botToken, cb.id);
      await sendTelegram(botToken, chatId, buildStatusMessage(dev), buildMainKeyboard(user, dev));
      return;
    }

    if (data === "cmd:devices") {
      await answerCallback(botToken, cb.id);
      await showDevicesMenu(env, botToken, chatId, user);
      return;
    }

    if (data.startsWith("device:switch:")) {
      const targetId = data.substring(14);
      if (user.pairedDeviceIds.includes(targetId)) {
        user.activeDeviceId = targetId;
        await putKV(env, `usr:${chatId}`, user);
        const tDev = await getKV(env, `dev:${targetId}`);
        await answerCallback(botToken, cb.id, `تم التبديل إلى: ${tDev?.deviceName || targetId}`);
        await sendTelegram(botToken, chatId, `✅ <b>تم التبديل بنجاح إلى:</b> 💻 <b>${tDev?.deviceName || targetId}</b>`, buildMainKeyboard(user, tDev));
      }
      return;
    }

    if (data === "device:add") {
      user.pendingInput = { type: "pair_new_device" };
      await putKV(env, `usr:${chatId}`, user);
      await answerCallback(botToken, cb.id);
      await sendTelegram(botToken, chatId, `➕ <b>ربط جهاز إضافي:</b>\nأرسل كود الاقتران المكون من 6 أرقام للكمبيوتر الآخر هنا:`);
      return;
    }

    if (data === "device:unpair_active") {
      const unpairId = user.activeDeviceId;
      const uDev = await getKV(env, `dev:${unpairId}`);
      if (uDev) {
        uDev.ownerChatId = null;
        await putKV(env, `dev:${unpairId}`, uDev);
      }
      user.pairedDeviceIds = user.pairedDeviceIds.filter(id => id !== unpairId);
      user.activeDeviceId = user.pairedDeviceIds.length > 0 ? user.pairedDeviceIds[0] : null;
      await putKV(env, `usr:${chatId}`, user);

      await answerCallback(botToken, cb.id, "تم إزالة الجهاز");
      if (user.activeDeviceId) {
        const nextDev = await getKV(env, `dev:${user.activeDeviceId}`);
        await sendTelegram(botToken, chatId, `🗑️ تم إلغاء ربط الجهاز السابق. تم التبديل تلقائياً إلى: 💻 <b>${nextDev?.deviceName}</b>`, buildMainKeyboard(user, nextDev));
      } else {
        await sendTelegram(botToken, chatId, `🗑️ تم إلغاء ربط الجهاز. لا توجد أجهزة متبقية بحسابك.`);
      }
      return;
    }

    if (data === "cmd:screenshot") {
      if (!isOnline(dev)) {
        await answerCallback(botToken, cb.id, "⚠️ الجهاز غير متصل حالياً", true);
        return;
      }
      await answerCallback(botToken, cb.id, "جاري التقاط لقطة الشاشة...");
      await enqueueCommand(env, dev.deviceId, "take_screenshot", { chatId });
      await sendTelegram(botToken, chatId, `📸 <b>جاري التقاط ونقل لقطة الشاشة من جهاز (${dev.deviceName || 'PC'})...</b>`);
      return;
    }

    if (data === "cmd:pause") {
      await enqueueCommand(env, dev.deviceId, "pause", { minutes: 30 });
      await answerCallback(botToken, cb.id, "تم تفعيل الاستراحة");
      await sendTelegram(botToken, chatId, isOnline(dev) ? "⚡ تم إيقاف الجلسة مؤقتاً (استراحة 30 دقيقة)." : "⏳ تم حفظ الأمر: سيتم إيقاف الجلسة فور تشغيل الجهاز.");
      return;
    }

    if (data === "cmd:dns") {
      await enqueueCommand(env, dev.deviceId, "toggle_dns");
      await answerCallback(botToken, cb.id, "جاري تبديل حماية DNS");
      await sendTelegram(botToken, chatId, "🛡️ تم إرسال أمر تبديل حماية Family DNS المانع للمواقع الإباحية والضارة.");
      return;
    }

    if (data === "cmd:msg") {
      user.pendingInput = { type: "msg_to_screen" };
      await putKV(env, `usr:${chatId}`, user);
      await answerCallback(botToken, cb.id);
      await sendTelegram(botToken, chatId, "✍️ <b>أرسل الآن نص الرسالة التي تريد أن تظهر على شاشة الطفل:</b>");
      return;
    }

    if (data === "cmd:top") {
      await enqueueCommand(env, dev.deviceId, "get_top");
      await answerCallback(botToken, cb.id, "جاري إعداد تقرير النشاط...");
      await sendTelegram(botToken, chatId, `📊 <b>جاري جلب تقرير البرامج والمواقع الأكثر استخداماً من جهاز (${dev.deviceName || 'PC'})...</b>`);
      return;
    }

    if (data === "cmd:limits") {
      await answerCallback(botToken, cb.id);
      const users = (dev.status && dev.status.users) || [];
      let text = `⏳ <b>إدارة الوقت والحدود — ${dev.deviceName}</b>\n\n`;
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
      rows.push([{ text: "🏠 القائمة الرئيسية", callback_data: "cmd:menu" }]);
      await sendTelegram(botToken, chatId, text, { inline_keyboard: rows });
      return;
    }

    if (data.startsWith("time:add:") || data.startsWith("time:sub:")) {
      const parts = data.split(":");
      const isAdd = parts[1] === "add";
      const username = parts[2];
      const minutes = parseInt(parts[3], 10);
      const delta = isAdd ? minutes : -minutes;
      await enqueueCommand(env, dev.deviceId, "adjust_time", { username, minutes: delta });
      await answerCallback(botToken, cb.id, `تم تعديل الوقت: ${isAdd ? "+" : "-"}${minutes} د`);
      await sendTelegram(botToken, chatId, isOnline(dev) ? `⚡ تم تعديل الوقت لـ ${username}` : `⏳ تم حفظ الأمر: سيتم تعديل وقت ${username} فور تشغيل الجهاز.`);
      return;
    }

    if (data.startsWith("action:lock:")) {
      const sessionId = parseInt(data.split(":")[2], 10);
      await enqueueCommand(env, dev.deviceId, "lock_screen", { sessionId });
      await answerCallback(botToken, cb.id, "تم إرسال أمر القفل");
      await sendTelegram(botToken, chatId, isOnline(dev) ? "⚡ تم قفل الشاشة." : "⏳ سيتم قفل الشاشة فور تشغيل الجهاز.");
      return;
    }

    if (data === "cmd:menu") {
      await answerCallback(botToken, cb.id);
      await sendTelegram(botToken, chatId, `🛡️ <b>لوحة تحكم وقتي (Waqti) — ${dev.deviceName}</b>`, buildMainKeyboard(user, dev));
      return;
    }

    await answerCallback(botToken, cb.id);
  }
}

async function showDevicesMenu(env, botToken, chatId, user) {
  let devMsg = `📱 <b>إدارة الأجهزة المرتبطة بحسابك (${user.pairedDeviceIds.length}):</b>\n\n`;
  const buttons = [];
  for (const dId of user.pairedDeviceIds) {
    const d = await getKV(env, `dev:${dId}`);
    if (d) {
      const isAct = dId === user.activeDeviceId;
      devMsg += `• <b>${d.deviceName}</b> ${isAct ? '⭐ (الجهاز النشط)' : ''}\n`;
      devMsg += `   الحالة: ${isOnline(d) ? '🟢 متصل' : '🔴 غير متصل'}\n\n`;
      buttons.push([{ text: (isAct ? '⭐ ' : '💻 ') + d.deviceName, callback_data: `device:switch:${dId}` }]);
    }
  }
  buttons.push([
    { text: "➕ ربط جهاز جديد", callback_data: "device:add" },
    { text: "🗑️ حذف الجهاز النشط", callback_data: "device:unpair_active" }
  ]);
  buttons.push([{ text: "🏠 القائمة الرئيسية", callback_data: "cmd:menu" }]);
  await sendTelegram(botToken, chatId, devMsg, { inline_keyboard: buttons });
}
