// Waqti (وقتي) — Cloudflare Worker Relay
// 24/7 Serverless Global Relay with Multi-Device Management & Telegram Webhook.

export default {
  async fetch(request, env, ctx) {
    try {
      await ensureDbInitialized(env);
      const url = new URL(request.url);
      const botToken = env.BOT_TOKEN;
      const botUsername = env.BOT_USERNAME || "Waqti_bot";

    // 1. Telegram Webhook Handler
    if (request.method === "POST" && (url.pathname === "/webhook" || url.pathname === "/" || url.pathname === "/api/telegram/webhook")) {
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

// -------------------------------------------------------------
// Localization & Translations
// -------------------------------------------------------------
const I18N = {
  ar: {
    btn_status: "📊 حالة الجهاز",
    btn_screenshot: "📸 لقطة شاشة",
    btn_limits: "⏳ تعديل الوقت",
    btn_schedule: "⏰ مواعيد التشغيل والانطفاء",
    btn_dns: "🛡️ حماية DNS",
    btn_pause: "⏸️ وقت مستقطع",
    btn_msg: "💬 إرسال رسالة",
    btn_top: "📈 الأكثر استخداماً",
    btn_devices: (n) => `📱 إدارة الأجهزة (${n})`,
    btn_language: "🌐 تغيير اللغة (Language)",
    btn_update: "🔄 فحص التحديثات",
    btn_home: "🏠 القائمة الرئيسية",
    btn_lock: "🔒 قفل فوري",
    online: "🟢 متصل وشغّال الآن",
    offline: "🔴 غير متصل حالياً (مطفأ أو مفصول)",
    win_uptime: "⏱️ مدة تشغيل الويندوز:",
    service_uptime: "🛡️ خدمة وقتي (Waqti):",
    last_seen: "⏱️ آخر اتصال مسجل:",
    no_sessions: "💤 لا توجد جلسات مستخدمين نشطة حالياً.",
    user_sessions: "👤 جلسات المستخدمين:",
    used_today: "المستهلك اليوم:",
    remaining_today: "رصيد اليوم المتبقي:",
    curfew_format: (end, rem) => `   🌙 <b>المتبقي للجلسة حتى موعد الإغلاق (${end}):</b> <b>${rem} د</b>\n`,
    offline_notice: "💡 <i>الجهاز غير متصل حالياً، لكن يمكنك إرسال أي أوامر وسيقوم برنامج وقتي بتنفيذها فور تشغيل الجهاز.</i>",
    welcome_unpaired: "👋 <b>مرحباً بك في بوت وقتي (Waqti)!</b>\n\nلم يتم ربط أي جهاز بحسابك بعد.\n\n🔗 <b>لربط جهاز الكمبيوتر:</b>\n1. افتح تطبيق <b>وقتي (Waqti)</b> على الكمبيوتر.\n2. اذهب إلى تفاصيل حساب الطفل أو الإعدادات.\n3. أرسل كود الاقتران المكون من 10 أرقام هنا.",
    pair_success_user: (name, dev, code) => `✅ <b>تم ربط حساب الطفل بنجاح!</b>\n👤 المستخدم: <b>${name}</b>\n💻 الجهاز: <b>${dev}</b>\n🔢 كود الاقتران: <code>${code}</code>\n\nيمكنك الآن التحكم بوقته ومواعيد تشغيله وتلقي طلباته مباشرة!`,
    pair_success_dev: (dev, count) => `✅ <b>تم ربط الجهاز بنجاح!</b>\n💻 الجهاز: <b>${dev}</b>\n📱 إجمالي أجهزتك المسجلة: ${count}`,
    pair_invalid: "❌ كود الاقتران غير صحيح أو منتهي الصلاحية.",
    main_title: (dev) => `🛡️ <b>لوحة تحكم وقتي (Waqti) — ${dev}</b>`,
    taking_shot: (dev) => `📸 <b>جاري التقاط ونقل لقطة الشاشة من جهاز (${dev})...</b>`,
    shot_offline: "⚠️ الجهاز غير متصل حالياً لالتقاط الشاشة.",
    msg_sent: (text) => `✅ تم إرسال الرسالة إلى شاشة الطفل:\n<i>"${text}"</i>`,
    msg_prompt: "✍️ <b>أرسل الآن نص الرسالة التي تريد أن تظهر على شاشة الطفل:</b>",
    pause_active: "⚡ تم إيقاف الجلسة مؤقتاً (استراحة 30 دقيقة).",
    pause_queued: "⏳ تم حفظ الأمر: سيتم إيقاف الجلسة فور تشغيل الجهاز.",
    resume_done: "▶️ تم استئناف الجلسة بنجاح.",
    top_prompt: (dev) => `📊 <b>جاري جلب تقرير البرامج والمواقع الأكثر استخداماً من جهاز (${dev})...</b>`,
    dns_toggled: "🛡️ تم إرسال أمر تبديل حماية Family DNS المانع للمواقع الإباحية والضارة.",
    time_adjusted: (u, d) => `⚡ تم تعديل الوقت لـ ${u} (${d > 0 ? '+' : ''}${d} دقيقة).`,
    time_queued: (u) => `⏳ تم حفظ الأمر: سيتم تعديل وقت ${u} فور تشغيل الجهاز.`,
    lock_sent: "⚡ تم قفل الشاشة.",
    lock_queued: "⏳ سيتم قفل الشاشة فور تشغيل الجهاز.",
    sched_title: (dev) => `⏰ <b>مواعيد التشغيل والانطفاء (جدول الحظر اليومي) — ${dev}</b>\n\nاختر من الجداول الجاهزة أدناه، أو اضغط تحديد يدوي لإدخال مواعيد مخصصة:`,
    sched_saved: (name, start, end) => `✅ <b>تم ضبط مواعيد التشغيل والانطفاء بنجاح!</b>\n👤 المستخدم: <b>${name}</b>\n🌅 يبدأ السماح بالتشغيل: <b>${start}</b>\n🌙 موعد الانطفاء والقفل: <b>${end}</b>`,
    sched_manual_prompt: "⏰ <b>أرسل وقت البداية ووقت الانطفاء بصيغة 24 ساعة (HH:mm HH:mm):</b>\nمثال: <code>08:00 21:30</code> (من الثامنة صباحاً حتى التاسعة والنصف ليلاً)",
    sched_manual_invalid: "❌ صيغة الوقت غير صحيحة. يرجى إرسال وقت البداية والنهاية مثل: <code>08:00 22:00</code>",
    lang_select_title: "🌐 <b>اختر لغة البوت المفضلة / Select Bot Language:</b>",
    lang_switched: "✅ تم ضبط لغة البوت إلى <b>العربية 🇸🇦</b> بنجاح!",
    update_sent: "🔄 <b>تم إرسال أمر فحص وتطبيق التحديثات الصامتة للكمبيوتر!</b>"
  },
  en: {
    btn_status: "📊 Device Status",
    btn_screenshot: "📸 Screenshot",
    btn_limits: "⏳ Adjust Screen Time",
    btn_schedule: "⏰ Schedule & Curfew",
    btn_dns: "🛡️ Family DNS",
    btn_pause: "⏸️ Pause Session",
    btn_msg: "💬 Send Screen Message",
    btn_top: "📈 Top Activity",
    btn_devices: (n) => `📱 Devices (${n})`,
    btn_language: "🌐 Language (اللغة)",
    btn_update: "🔄 Check Updates",
    btn_home: "🏠 Main Menu",
    btn_lock: "🔒 Lock Now",
    online: "🟢 Online & Active",
    offline: "🔴 Offline (Powered off or disconnected)",
    win_uptime: "⏱️ Windows Uptime:",
    service_uptime: "🛡️ Waqti Service:",
    last_seen: "⏱️ Last Seen:",
    no_sessions: "💤 No active user sessions right now.",
    user_sessions: "👤 User Sessions:",
    used_today: "Used Today:",
    remaining_today: "Daily Quota Left:",
    curfew_format: (end, rem) => `   🌙 <b>Remaining until curfew (${end}):</b> <b>${rem} min</b>\n`,
    offline_notice: "💡 <i>Device is currently offline. Commands will execute as soon as it reconnects.</i>",
    welcome_unpaired: "👋 <b>Welcome to Waqti Bot!</b>\n\nNo device is paired with your account yet.\n\n🔗 <b>To pair your Windows PC:</b>\n1. Open <b>Waqti</b> app on PC.\n2. Go to child user details or Settings.\n3. Send the 10-digit pairing code here.",
    pair_success_user: (name, dev, code) => `✅ <b>Child account paired successfully!</b>\n👤 User: <b>${name}</b>\n💻 Device: <b>${dev}</b>\n🔢 Code: <code>${code}</code>\n\nYou can now manage time limits, curfew schedule, and receive requests directly!`,
    pair_success_dev: (dev, count) => `✅ <b>Device paired successfully!</b>\n💻 Device: <b>${dev}</b>\n📱 Total paired devices: ${count}`,
    pair_invalid: "❌ Pairing code is invalid or expired.",
    main_title: (dev) => `🛡️ <b>Waqti Control Panel — ${dev}</b>`,
    taking_shot: (dev) => `📸 <b>Capturing live screenshot from (${dev})...</b>`,
    shot_offline: "⚠️ Device is currently offline.",
    msg_sent: (text) => `✅ Message delivered to child's screen:\n<i>"${text}"</i>`,
    msg_prompt: "✍️ <b>Type the message to display on the child's screen:</b>",
    pause_active: "⚡ Session paused (30-minute break active).",
    pause_queued: "⏳ Command queued: session will pause when PC turns on.",
    resume_done: "▶️ Session resumed successfully.",
    top_prompt: (dev) => `📊 <b>Fetching activity report from (${dev})...</b>`,
    dns_toggled: "🛡️ Family DNS protection toggle command sent.",
    time_adjusted: (u, d) => `⚡ Screen time adjusted for ${u} (${d > 0 ? '+' : ''}${d} min).`,
    time_queued: (u) => `⏳ Command queued: will update ${u} when PC turns on.`,
    lock_sent: "⚡ Screen locked.",
    lock_queued: "⏳ Screen will lock as soon as PC turns on.",
    sched_title: (dev) => `⏰ <b>Allowed Schedule & Bedtime Curfew — ${dev}</b>\n\nChoose a preset below, or tap Custom to set specific start and shutdown times:`,
    sched_saved: (name, start, end) => `✅ <b>Schedule updated successfully!</b>\n👤 User: <b>${name}</b>\n🌅 Allowed Start: <b>${start}</b>\n🌙 Bedtime Curfew: <b>${end}</b>`,
    sched_manual_prompt: "⏰ <b>Send start and shutdown curfew in 24h format (HH:mm HH:mm):</b>\nExample: <code>08:00 21:30</code>",
    sched_manual_invalid: "❌ Invalid format. Please send times like: <code>08:00 22:00</code>",
    lang_select_title: "🌐 <b>Select Bot Language:</b>",
    lang_switched: "✅ Bot language changed to <b>English 🇬🇧</b>!",
    update_sent: "🔄 <b>Silent auto-update check dispatched to PC!</b>"
  },
  fr: {
    btn_status: "📊 État de l'appareil",
    btn_screenshot: "📸 Capture d'écran",
    btn_limits: "⏳ Ajuster le temps",
    btn_schedule: "⏰ Horaires & Extinction",
    btn_dns: "🛡️ Filtre DNS",
    btn_pause: "⏸️ Mettre en pause",
    btn_msg: "💬 Envoyer un message",
    btn_top: "📈 Activité",
    btn_devices: (n) => `📱 Appareils (${n})`,
    btn_language: "🌐 Langue (Language)",
    btn_update: "🔄 Mises à jour",
    btn_home: "🏠 Menu principal",
    btn_lock: "🔒 Verrouiller",
    online: "🟢 En ligne & Actif",
    offline: "🔴 Hors ligne (Éteint ou déconnecté)",
    win_uptime: "⏱️ Uptime Windows :",
    service_uptime: "🛡️ Service Waqti :",
    last_seen: "⏱️ Dernière connexion :",
    no_sessions: "💤 Aucune session active actuellement.",
    user_sessions: "👤 Sessions utilisateurs :",
    used_today: "Utilisé aujourd'hui :",
    remaining_today: "Temps restant :",
    curfew_format: (end, rem) => `   🌙 <b>Temps restant avant extinction (${end}) :</b> <b>${rem} min</b>\n`,
    offline_notice: "💡 <i>L'appareil est hors ligne. Les commandes s'exécuteront dès sa reconnexion.</i>",
    welcome_unpaired: "👋 <b>Bienvenue sur le bot Waqti !</b>\n\nAucun appareil associé.\n\n🔗 <b>Pour associer votre PC :</b>\n1. Ouvrez l'application <b>Waqti</b> sur le PC.\n2. Allez dans les détails du compte enfant ou les Paramètres.\n3. Envoyez le code d'association à 10 chiffres ici.",
    pair_success_user: (name, dev, code) => `✅ <b>Compte enfant associé avec succès !</b>\n👤 Utilisateur : <b>${name}</b>\n💻 Appareil : <b>${dev}</b>\n🔢 Code : <code>${code}</code>\n\nVous pouvez désormais gérer le temps d'écran et les horaires d'extinction !`,
    pair_success_dev: (dev, count) => `✅ <b>Appareil associé avec succès !</b>\n💻 Appareil : <b>${dev}</b>\n📱 Total : ${count}`,
    pair_invalid: "❌ Code d'association invalide ou expiré.",
    main_title: (dev) => `🛡️ <b>Panneau de contrôle Waqti — ${dev}</b>`,
    taking_shot: (dev) => `📸 <b>Capture d'écran en direct (${dev})...</b>`,
    shot_offline: "⚠️ L'appareil est actuellement hors ligne.",
    msg_sent: (text) => `✅ Message envoyé sur l'écran :\n<i>"${text}"</i>`,
    msg_prompt: "✍️ <b>Tapez le message à afficher sur l'écran :</b>",
    pause_active: "⚡ Session mise en pause (30 min).",
    pause_queued: "⏳ Commande en attente de reconnexion.",
    resume_done: "▶️ Session reprise.",
    top_prompt: (dev) => `📊 <b>Récupération du rapport (${dev})...</b>`,
    dns_toggled: "🛡️ Commande filtre DNS Famille envoyée.",
    time_adjusted: (u, d) => `⚡ Temps ajusté pour ${u} (${d > 0 ? '+' : ''}${d} min).`,
    time_queued: (u) => `⏳ Commande en attente pour ${u}.`,
    lock_sent: "⚡ Écran verrouillé.",
    lock_queued: "⏳ Verrouillage en attente.",
    sched_title: (dev) => `⏰ <b>Horaires autorisés & Couvre-feu — ${dev}</b>\n\nChoisissez une plage horaire ou définissez des heures personnalisées :`,
    sched_saved: (name, start, end) => `✅ <b>Horaires enregistrés avec succès !</b>\n👤 Utilisateur : <b>${name}</b>\n🌅 Début : <b>${start}</b>\n🌙 Extinction : <b>${end}</b>`,
    sched_manual_prompt: "⏰ <b>Envoyez l'heure de début et d'extinction (HH:mm HH:mm) :</b>\nExemple : <code>08:00 21:30</code>",
    sched_manual_invalid: "❌ Format invalide. Exemple : <code>08:00 22:00</code>",
    lang_select_title: "🌐 <b>Choisissez la langue du bot :</b>",
    lang_switched: "✅ Langue du bot changée en <b>Français 🇫🇷</b> !",
    update_sent: "🔄 <b>Vérification silencieuse des mises à jour envoyée au PC !</b>"
  }
};

function getT(lang) {
  return I18N[lang] || I18N.ar;
}

function formatMinutes(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function isOnline(dev) {
  if (!dev || !dev.lastSeen) return false;
  const diffSec = (Date.now() - new Date(dev.lastSeen).getTime()) / 1000;
  return diffSec <= 300;
}

function buildMainKeyboard(user, dev) {
  const lang = user.lang || "ar";
  const t = getT(lang);
  const count = user.pairedDeviceIds ? user.pairedDeviceIds.length : 1;
  return {
    inline_keyboard: [
      [
        { text: t.btn_status, callback_data: "cmd:status" },
        { text: t.btn_screenshot, callback_data: "cmd:screenshot" }
      ],
      [
        { text: t.btn_limits, callback_data: "cmd:limits" },
        { text: t.btn_schedule, callback_data: "cmd:schedule" }
      ],
      [
        { text: t.btn_pause, callback_data: "cmd:pause" },
        { text: t.btn_msg, callback_data: "cmd:msg" }
      ],
      [
        { text: t.btn_top, callback_data: "cmd:top" },
        { text: t.btn_dns, callback_data: "cmd:dns" }
      ],
      [
        { text: t.btn_devices(count), callback_data: "cmd:devices" },
        { text: t.btn_language, callback_data: "cmd:language" }
      ],
      [
        { text: t.btn_update, callback_data: "cmd:update" },
        { text: "🔄", callback_data: "cmd:status" }
      ]
    ]
  };
}

function buildCancelScheduleKeyboard(user) {
  const lang = user.lang || "ar";
  const t = getT(lang);
  return {
    inline_keyboard: [
      [
        { text: t.btn_home || "🏠 القائمة الرئيسية", callback_data: "cmd:cancel_input" }
      ]
    ]
  };
}

function buildLanguageKeyboard(user) {
  const t = getT(user.lang || "ar");
  return {
    inline_keyboard: [
      [
        { text: "🇸🇦 العربية (Arabic)", callback_data: "lang:set:ar" },
        { text: "🇬🇧 English", callback_data: "lang:set:en" }
      ],
      [
        { text: "🇫🇷 Français", callback_data: "lang:set:fr" }
      ],
      [
        { text: t.btn_home, callback_data: "cmd:menu" }
      ]
    ]
  };
}

function buildStatusMessage(dev, lang = "ar") {
  const t = getT(lang);
  const online = isOnline(dev);
  const statusStr = online ? t.online : t.offline;
  const lastSeenStr = dev.lastSeen ? new Date(dev.lastSeen).toLocaleTimeString() : "N/A";

  let msg = `🖥️ <b>${dev.deviceName || 'PC'}</b> — <b>${statusStr}</b>\n`;
  if (online) {
    msg += `${t.win_uptime} <code>${dev.status?.windowsUptime || 'N/A'}</code>\n`;
    msg += `${t.service_uptime} <code>${dev.status?.serviceUptime || 'N/A'}</code>\n\n`;
  } else {
    msg += `${t.last_seen} <code>${lastSeenStr}</code>\n\n`;
  }

  const users = (dev.status && dev.status.users) || [];
  if (users.length === 0) {
    msg += `${t.no_sessions}\n`;
  } else {
    msg += `${t.user_sessions}\n`;
    for (const u of users) {
      msg += `\n• <b>${u.username}</b> ${u.isRestricted ? '🔒' : '🔓'}\n`;
      msg += `   📊 ${t.used_today} <b>${u.usedToday}/${u.dailyLimit || '∞'} min</b>\n`;
      if (u.isRestricted && u.dailyLimit) {
        const dailyRemaining = Math.max(0, u.dailyLimit - u.usedToday);
        msg += `   ⏳ ${t.remaining_today} <b>${dailyRemaining} min</b> (${formatMinutes(dailyRemaining)})\n`;
        if (u.scheduleEnd) {
          const schedRem = u.remainingSchedule !== undefined ? u.remainingSchedule : dailyRemaining;
          msg += t.curfew_format(u.scheduleEnd, schedRem);
        }
      }
    }
  }

  if (!online) {
    msg += `\n${t.offline_notice}`;
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

    const t = getT(user.lang || "ar");

    // Pending text inputs
    if (user.pendingInput) {
      const p = user.pendingInput;
      user.pendingInput = null;
      await putKV(env, `usr:${chatId}`, user);

      if (p.type === "msg_to_screen" && user.activeDeviceId) {
        await enqueueCommand(env, user.activeDeviceId, "send_msg", { message: text });
        await sendTelegram(botToken, chatId, t.msg_sent(text));
        return;
      }

      if (p.type === "set_schedule_manual" && user.activeDeviceId) {
        if (text.startsWith("/") || text === "🏠" || text.includes("إلغاء") || text.toLowerCase() === "cancel") {
          user.pendingInput = null;
          await putKV(env, `usr:${chatId}`, user);
          if (text === "🏠" || text.includes("إلغاء") || text.toLowerCase() === "cancel") {
            const dev = await getKV(env, `dev:${user.activeDeviceId}`);
            await sendTelegram(botToken, chatId, t.main_title(dev?.deviceName || "PC"), buildMainKeyboard(user, dev));
            return;
          }
        } else {
          // Normalize Arabic-Indic digits to Latin
          const normalized = text.replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d));
          const matches = normalized.match(/([01]?[0-9]|2[0-3])(?::([0-5][0-9]))?/g);
          if (matches && matches.length >= 2) {
            let start = matches[0];
            let end = matches[1];
            if (!start.includes(":")) start = start.padStart(2, "0") + ":00";
            else {
              const [h, m] = start.split(":");
              start = h.padStart(2, "0") + ":" + (m || "00").padStart(2, "0");
            }
            if (!end.includes(":")) end = end.padStart(2, "0") + ":00";
            else {
              const [h, m] = end.split(":");
              end = h.padStart(2, "0") + ":" + (m || "00").padStart(2, "0");
            }
            const targetChild = p.username || (user.activeChild?.username || "all");
            await enqueueCommand(env, user.activeDeviceId, "set_schedule", {
              username: targetChild,
              scheduleStart: start,
              scheduleEnd: end
            });
            user.pendingInput = null;
            await putKV(env, `usr:${chatId}`, user);
            const dev = await getKV(env, `dev:${user.activeDeviceId}`);
            await sendTelegram(botToken, chatId, t.sched_saved(targetChild, start, end), buildMainKeyboard(user, dev));
            return;
          } else {
            await sendTelegram(botToken, chatId, t.sched_manual_invalid, buildCancelScheduleKeyboard(user));
            return;
          }
        }
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

                await sendTelegram(botToken, chatId, t.pair_success_user(pinTarget.username, dev.deviceName, code), buildMainKeyboard(user, dev));
                return;
              } else {
                await putKV(env, `dev:${dId}`, dev);
                await putKV(env, `usr:${chatId}`, user);
                await sendTelegram(botToken, chatId, t.pair_success_dev(dev.deviceName, user.pairedDeviceIds.length), buildMainKeyboard(user, dev));
                return;
              }
            }
          }
        }
        await sendTelegram(botToken, chatId, t.pair_invalid);
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

            await sendTelegram(botToken, chatId, t.pair_success_user(pinTarget.username, dev.deviceName, pairCode), buildMainKeyboard(user, dev));
            return;
          } else {
            await putKV(env, `dev:${dId}`, dev);
            await putKV(env, `usr:${chatId}`, user);

            await sendTelegram(botToken, chatId, t.pair_success_dev(dev.deviceName, user.pairedDeviceIds.length), buildMainKeyboard(user, dev));
            return;
          }
        }
      }
    }

    // Unpaired user
    if (!user.activeDeviceId) {
      await sendTelegram(botToken, chatId, t.welcome_unpaired);
      return;
    }

    const currentDev = await getKV(env, `dev:${user.activeDeviceId}`);
    if (!currentDev) return;

    // Commands
    if (text === "/lang" || text === "/language" || text.includes("اللغة") || text.includes("Language")) {
      await sendTelegram(botToken, chatId, t.lang_select_title, buildLanguageKeyboard(user));
      return;
    }

    if (text.startsWith("/schedule") || text.startsWith("/curfew") || text.includes("مواعيد") || text.includes("انطفاء") || text.includes("تشغيل")) {
      const parts = text.split(/\s+/).slice(1);
      if (parts.length >= 2) {
        const start = parts[0].trim();
        const end = parts[1].trim();
        const targetChild = user.activeChild?.username || "all";
        await enqueueCommand(env, currentDev.deviceId, "set_schedule", {
          username: targetChild,
          scheduleStart: start,
          scheduleEnd: end
        });
        await sendTelegram(botToken, chatId, t.sched_saved(targetChild, start, end), buildMainKeyboard(user, currentDev));
        return;
      } else {
        const targetChild = user.activeChild?.username || "all";
        user.pendingInput = { type: "set_schedule_manual", username: targetChild };
        await putKV(env, `usr:${chatId}`, user);
        await sendTelegram(botToken, chatId, t.sched_manual_prompt, buildCancelScheduleKeyboard(user));
        return;
      }
    }

    if (text === "/stats" || text === "/admin" || text.includes("إحصائيات") || text.includes("المستخدمين")) {
      let statsMsg = "📊 <b>إحصائيات تطبيق وقتي (Waqti Analytics)</b>\n\n";

      // 1. D1 Database Stats
      try {
        if (env.DB) {
          const devRow = await env.DB.prepare("SELECT count(*) as count FROM kv_store WHERE key LIKE 'dev:%'").first();
          const onlineRow = await env.DB.prepare("SELECT count(*) as count FROM kv_store WHERE key LIKE 'dev:%' AND datetime(substr(json_extract(value, '$.lastSeen'), 1, 19)) > datetime('now', '-10 minutes')").first();
          const usrRow = await env.DB.prepare("SELECT count(*) as count FROM kv_store WHERE key LIKE 'usr:%'").first();

          statsMsg += `💻 <b>الأجهزة والاتصال:</b>\n`;
          statsMsg += `• إجمالي أجهزة الكمبيوتر: <b>${devRow?.count || 0}</b> جهاز\n`;
          statsMsg += `• المتصلة والنشطة الآن 🟢: <b>${onlineRow?.count || 0}</b> جهاز\n`;
          statsMsg += `• أولياء الأمور المشتركون بالبوت 👥: <b>${usrRow?.count || 0}</b> مستخدم\n\n`;
        }
      } catch (err) {
        statsMsg += `⚠️ خطأ في قراءة الأجهزة: ${err.message}\n\n`;
      }

      // 2. GitHub Releases Downloads
      try {
        const ghRes = await fetch("https://api.github.com/repos/XCES4RX/Waqti/releases", {
          headers: { "User-Agent": "Waqti-Relay" }
        });
        if (ghRes.ok) {
          const releases = await ghRes.json();
          let totalDownloads = 0;
          let breakdown = "";
          for (const r of releases) {
            const count = (r.assets || []).reduce((sum, a) => sum + (a.download_count || 0), 0);
            totalDownloads += count;
            breakdown += `  ▫️ ${r.tag_name}: <b>${count}</b> تحميل\n`;
          }
          statsMsg += `📥 <b>تحميلات البرنامج من GitHub:</b>\n`;
          statsMsg += `• إجمالي التحميلات: <b>${totalDownloads}</b> مرة\n`;
          statsMsg += breakdown + `\n`;
        }
      } catch (err) {
        statsMsg += `⚠️ تعذر جلب إحصائيات GitHub: ${err.message}\n\n`;
      }

      statsMsg += `🕒 <i>تحديث فوري — وقتي (Waqti)</i>`;
      await sendTelegram(botToken, chatId, statsMsg);
      return;
    }

    if (text === "/update" || text.includes("تحديث")) {
      await enqueueCommand(env, currentDev.deviceId, "check_update");
      await sendTelegram(botToken, chatId, t.update_sent);
      return;
    }

    if (text === "/devices" || text.includes("إدارة الأجهزة")) {
      await showDevicesMenu(env, botToken, chatId, user);
      return;
    }

    if (text === "/status" || text.includes("حالة")) {
      await sendTelegram(botToken, chatId, buildStatusMessage(currentDev, user.lang), buildMainKeyboard(user, currentDev));
      return;
    }

    if (text === "/screenshot" || text.includes("لقطة") || text.includes("شاشة")) {
      if (!isOnline(currentDev)) {
        await sendTelegram(botToken, chatId, t.shot_offline);
        return;
      }
      await enqueueCommand(env, currentDev.deviceId, "take_screenshot", { chatId });
      await sendTelegram(botToken, chatId, t.taking_shot(currentDev.deviceName || 'PC'));
      return;
    }

    if (text.startsWith("/msg ")) {
      const msgText = text.substring(5).trim();
      await enqueueCommand(env, currentDev.deviceId, "send_msg", { message: msgText });
      await sendTelegram(botToken, chatId, t.msg_sent(msgText));
      return;
    }

    if (text.startsWith("/pause")) {
      await enqueueCommand(env, currentDev.deviceId, "pause", { minutes: 30 });
      await sendTelegram(botToken, chatId, isOnline(currentDev) ? t.pause_active : t.pause_queued);
      return;
    }

    if (text.startsWith("/resume")) {
      await enqueueCommand(env, currentDev.deviceId, "resume");
      await sendTelegram(botToken, chatId, t.resume_done);
      return;
    }

    if (text.startsWith("/top") || text.includes("الأكثر استخداما")) {
      await enqueueCommand(env, currentDev.deviceId, "get_top");
      await sendTelegram(botToken, chatId, t.top_prompt(currentDev.deviceName || 'PC'));
      return;
    }

    if (text === "/dns") {
      await enqueueCommand(env, currentDev.deviceId, "toggle_dns");
      await sendTelegram(botToken, chatId, t.dns_toggled);
      return;
    }

    // Default: Main Menu
    await sendTelegram(botToken, chatId, t.main_title(currentDev.deviceName), buildMainKeyboard(user, currentDev));
  } else if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message.chat.id;
    const data = cb.data;

    let user = await getKV(env, `usr:${chatId}`);
    if (!user || !user.activeDeviceId) {
      await answerCallback(botToken, cb.id, "Device not paired");
      return;
    }

    const t = getT(user.lang || "ar");
    const dev = await getKV(env, `dev:${user.activeDeviceId}`);
    if (!dev) return;

    if (data.startsWith("approve_time:")) {
      const parts = data.split(":");
      const uid = parseInt(parts[1]);
      const mins = parseInt(parts[2]) || 15;
      await enqueueCommand(env, dev.deviceId, "add_time", { userId: uid, minutes: mins });
      await answerCallback(botToken, cb.id, `+${mins} min OK`);
      await sendTelegram(botToken, chatId, `✅ <b>+${mins} min approved!</b>`);
      return;
    }

    if (data.startsWith("deny_time:")) {
      await answerCallback(botToken, cb.id, "Denied");
      await sendTelegram(botToken, chatId, "❌ Time request denied.");
      await enqueueCommand(env, dev.deviceId, "send_msg", { message: "عذراً، لم تتم الموافقة على طلب وقت إضافي حالياً." });
      return;
    }

    if (data === "cmd:status") {
      await answerCallback(botToken, cb.id);
      await sendTelegram(botToken, chatId, buildStatusMessage(dev, user.lang), buildMainKeyboard(user, dev));
      return;
    }

    if (data === "cmd:devices") {
      await answerCallback(botToken, cb.id);
      await showDevicesMenu(env, botToken, chatId, user);
      return;
    }

    if (data === "cmd:language") {
      await answerCallback(botToken, cb.id);
      await sendTelegram(botToken, chatId, t.lang_select_title, buildLanguageKeyboard(user));
      return;
    }

    if (data.startsWith("lang:set:")) {
      const chosenLang = data.split(":")[2];
      user.lang = chosenLang;
      await putKV(env, `usr:${chatId}`, user);
      const newT = getT(chosenLang);
      await answerCallback(botToken, cb.id, chosenLang.toUpperCase());
      await sendTelegram(botToken, chatId, newT.lang_switched, buildMainKeyboard(user, dev));
      return;
    }

    if (data === "cmd:schedule" || data.startsWith("sched:manual:")) {
      const users = (dev.status && dev.status.users) || [];
      const targetUser = data.startsWith("sched:manual:") ? data.split(":")[2] : (user.activeChild?.username || (users.length > 0 ? users[0].username : "child"));
      user.pendingInput = { type: "set_schedule_manual", username: targetUser };
      await putKV(env, `usr:${chatId}`, user);
      await answerCallback(botToken, cb.id);
      await sendTelegram(botToken, chatId, t.sched_manual_prompt, buildCancelScheduleKeyboard(user));
      return;
    }

    if (data === "cmd:cancel_input") {
      user.pendingInput = null;
      await putKV(env, `usr:${chatId}`, user);
      await answerCallback(botToken, cb.id);
      await sendTelegram(botToken, chatId, t.main_title(dev.deviceName), buildMainKeyboard(user, dev));
      return;
    }

    if (data === "cmd:update") {
      await enqueueCommand(env, dev.deviceId, "check_update");
      await answerCallback(botToken, cb.id, "Checking updates...");
      await sendTelegram(botToken, chatId, t.update_sent);
      return;
    }

    if (data.startsWith("device:switch:")) {
      const targetId = data.substring(14);
      if (user.pairedDeviceIds.includes(targetId)) {
        user.activeDeviceId = targetId;
        await putKV(env, `usr:${chatId}`, user);
        const tDev = await getKV(env, `dev:${targetId}`);
        await answerCallback(botToken, cb.id, `${tDev?.deviceName || targetId}`);
        await sendTelegram(botToken, chatId, `✅ <b>Active device:</b> 💻 <b>${tDev?.deviceName || targetId}</b>`, buildMainKeyboard(user, tDev));
      }
      return;
    }

    if (data === "device:add") {
      user.pendingInput = { type: "pair_new_device" };
      await putKV(env, `usr:${chatId}`, user);
      await answerCallback(botToken, cb.id);
      await sendTelegram(botToken, chatId, `➕ <b>Pair Device:</b>\nSend the 10-digit pairing code here:`);
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

      await answerCallback(botToken, cb.id, "Unpaired");
      if (user.activeDeviceId) {
        const nextDev = await getKV(env, `dev:${user.activeDeviceId}`);
        await sendTelegram(botToken, chatId, `🗑️ Device unpaired. Switched to: 💻 <b>${nextDev?.deviceName}</b>`, buildMainKeyboard(user, nextDev));
      } else {
        await sendTelegram(botToken, chatId, `🗑️ Device unpaired. No devices left.`);
      }
      return;
    }

    if (data === "cmd:screenshot") {
      if (!isOnline(dev)) {
        await answerCallback(botToken, cb.id, t.shot_offline, true);
        return;
      }
      await answerCallback(botToken, cb.id, "Capturing screenshot...");
      await enqueueCommand(env, dev.deviceId, "take_screenshot", { chatId });
      await sendTelegram(botToken, chatId, t.taking_shot(dev.deviceName || 'PC'));
      return;
    }

    if (data === "cmd:pause") {
      await enqueueCommand(env, dev.deviceId, "pause", { minutes: 30 });
      await answerCallback(botToken, cb.id, "Pause requested");
      await sendTelegram(botToken, chatId, isOnline(dev) ? t.pause_active : t.pause_queued);
      return;
    }

    if (data === "cmd:dns") {
      await enqueueCommand(env, dev.deviceId, "toggle_dns");
      await answerCallback(botToken, cb.id, "DNS toggled");
      await sendTelegram(botToken, chatId, t.dns_toggled);
      return;
    }

    if (data === "cmd:msg") {
      user.pendingInput = { type: "msg_to_screen" };
      await putKV(env, `usr:${chatId}`, user);
      await answerCallback(botToken, cb.id);
      await sendTelegram(botToken, chatId, t.msg_prompt);
      return;
    }

    if (data === "cmd:top") {
      await enqueueCommand(env, dev.deviceId, "get_top");
      await answerCallback(botToken, cb.id, "Fetching activity report...");
      await sendTelegram(botToken, chatId, t.top_prompt(dev.deviceName || 'PC'));
      return;
    }

    if (data === "cmd:limits") {
      await answerCallback(botToken, cb.id);
      const users = (dev.status && dev.status.users) || [];
      let text = `⏳ <b>${t.btn_limits} — ${dev.deviceName}</b>\n\n`;
      const rows = [];
      for (const u of users) {
        text += `👤 <b>${u.username}</b>: <code>${u.usedToday}/${u.dailyLimit || '∞'}</code> min\n`;
        rows.push([
          { text: `➕ 15m (${u.username})`, callback_data: `time:add:${u.username}:15` },
          { text: `➕ 30m (${u.username})`, callback_data: `time:add:${u.username}:30` },
          { text: `➕ 60m (${u.username})`, callback_data: `time:add:${u.username}:60` }
        ]);
        rows.push([
          { text: `➖ 15m (${u.username})`, callback_data: `time:sub:${u.username}:15` },
          { text: `➖ 30m (${u.username})`, callback_data: `time:sub:${u.username}:30` },
          { text: t.btn_lock, callback_data: `action:lock:${u.sessionId || 1}` }
        ]);
      }
      rows.push([{ text: t.btn_home, callback_data: "cmd:menu" }]);
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
      await answerCallback(botToken, cb.id, `${isAdd ? "+" : "-"}${minutes} min`);
      await sendTelegram(botToken, chatId, isOnline(dev) ? t.time_adjusted(username, delta) : t.time_queued(username));
      return;
    }

    if (data.startsWith("action:lock:")) {
      const sessionId = parseInt(data.split(":")[2], 10);
      await enqueueCommand(env, dev.deviceId, "lock_screen", { sessionId });
      await answerCallback(botToken, cb.id, "Lock sent");
      await sendTelegram(botToken, chatId, isOnline(dev) ? t.lock_sent : t.lock_queued);
      return;
    }

    if (data === "cmd:menu") {
      await answerCallback(botToken, cb.id);
      await sendTelegram(botToken, chatId, t.main_title(dev.deviceName), buildMainKeyboard(user, dev));
      return;
    }

    await answerCallback(botToken, cb.id);
  }
}

async function showDevicesMenu(env, botToken, chatId, user) {
  const t = getT(user.lang || "ar");
  let devMsg = `📱 <b>${t.btn_devices(user.pairedDeviceIds.length)}:</b>\n\n`;
  const buttons = [];
  for (const dId of user.pairedDeviceIds) {
    const d = await getKV(env, `dev:${dId}`);
    if (d) {
      const isAct = dId === user.activeDeviceId;
      devMsg += `• <b>${d.deviceName}</b> ${isAct ? '⭐' : ''}\n`;
      devMsg += `   Status: ${isOnline(d) ? t.online : t.offline}\n\n`;
      buttons.push([{ text: (isAct ? '⭐ ' : '💻 ') + d.deviceName, callback_data: `device:switch:${dId}` }]);
    }
  }
  buttons.push([
    { text: "➕ Pair Device", callback_data: "device:add" },
    { text: "🗑️ Unpair Device", callback_data: "device:unpair_active" }
  ]);
  buttons.push([{ text: t.btn_home, callback_data: "cmd:menu" }]);
  await sendTelegram(botToken, chatId, devMsg, { inline_keyboard: buttons });
}
