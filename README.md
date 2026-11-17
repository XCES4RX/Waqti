<p align="center">
  <img src="docs/images/logo.png" alt="Waqti (وقتي)" width="200" />
</p>

<h1 align="center">Waqti | وقتي</h1>

<p align="center">
  <b>Modern Windows Screen Time Management, Device Control & 24/7 Cloud Remote Administration</b><br>
  <b>منظومة وقتي المتكاملة لإدارة وقت استخدام الشاشة وتنظيم الأجهزة والتحكم السحابي عبر تيليجرام</b>
</p>

<p align="center">
  <a href="https://github.com/XCES4RX/Waqti/releases"><img src="https://img.shields.io/github/v/release/XCES4RX/Waqti?color=blue&label=version" alt="Release"></a>
  <img src="https://img.shields.io/badge/.NET-8.0-purple.svg" alt=".NET 8">
  <img src="https://img.shields.io/badge/Platform-Windows%2010%20%7C%2011%20(x64)-0078D6.svg" alt="Platform">
  <img src="https://img.shields.io/badge/Architecture-Windows%20Service%20(LocalSystem)-success.svg" alt="Architecture">
  <img src="https://img.shields.io/badge/Telegram%20Bot-@Waqti__bot-2CA5E0.svg" alt="Telegram Bot">
  <img src="https://img.shields.io/badge/Cloud%20Relay-Cloudflare%20Serverless-F38020.svg" alt="Cloudflare">
  <img src="https://img.shields.io/badge/License-MIT-green.svg" alt="License">
  <img src="https://img.shields.io/badge/Installer%20Size-~49%20MB-orange.svg" alt="Setup Size">
  <img src="https://img.shields.io/badge/Languages-العربية%20%7C%20English%20%7C%20Français-lightgrey.svg" alt="Languages">
</p>

<p align="center">
  <a href="https://github.com/XCES4RX/Waqti/releases/latest"><b>Download WaqtiSetup-v1.0.0.exe</b></a> •
  <a href="#english"><b>English Overview</b></a> •
  <a href="#arabic"><b>الوصف بالعربية</b></a> •
  <a href="#telegram-bot-integration"><b>Telegram Bot</b></a> •
  <a href="#installation--setup"><b>Setup Guide</b></a>
</p>

---

<div dir="rtl" id="arabic">

## 🌟 نظرة عامة على برنامج وقتي (Waqti)

**وقتي (Waqti)** هو منصة حديثة واحترافية لإدارة وتنظيم وقت استخدام الشاشة وحماية الأجهزة على أنظمة Windows 10 و Windows 11. يعمل البرنامج كخدمة نظام ذاتية ومستقلة (`Windows Service`) بصلاحيات النظام العالية (`LocalSystem`)، مما يضمن تطبيق القيود والحدود اليومية بدقة بالغة حتى لو كان الكمبيوتر غير متصل بالإنترنت، مع منع أي محاولة لتجاوز النظام أو إيقافه من حسابات المستخدمين العادية.

يتميز البرنامج بربط سحابي متطور يعمل على مدار الساعة (24/7) عبر بوت تيليجرام الرسمي **[@Waqti_bot](https://t.me/Waqti_bot)**، مما يمكّن الوالدين من متابعة وإدارة أجهزة أطفالهم من أي مكان في العالم: استلام لقطات شاشة مباشرة، تعديل الأوقات بنقرة زر، إرسال رسائل فورية للشاشة، تفعيل وقت الاستراحة، وإدارة عدة أجهزة من حساب تلغرام واحد.

---

### ✨ أبرز الميزات الرئيسية (Core Features)

1. **⏱️ إدارة دقيقة لرصيد الوقت اليومي ومواعيد الإغلاق:**
   - تحديد رصيد يومي محدد بالدقائق لكل مستخدم على الكمبيوتر.
   - تحديد جدول زمني يومي يبدأ وينتهي في ساعات محددة (مثل موعد النوم).
   - احتساب دقيق للمستهلك، الرصيد المتبقي لليوم، والمتبقي حتى موعد الإغلاق دون أي التباس.

2. **☁️ تحكم سحابي دائم 24/7 عبر تيليجرام (@Waqti_bot):**
   - ربط آمن عبر كود اقتران (PIN) مكون من 6 أرقام.
   - البوت يعمل دائماً عبر خادم سحابي عالمي (Cloudflare Serverless Worker).
   - إذا كان جهاز الكمبيوتر مغلقاً أو غير متصل، تُحفظ الأوامر وتُنفّذ تلقائياً بمجرد تشغيله.

3. **📱 إدارة أجهزة متعددة بحساب واحد (Multi-Device Support):**
   - إمكانية ربط أكثر من كمبيوتر بنفس حساب تيليجرام.
   - التبديل الفوري بين الأجهزة عبر زر **إدارة الأجهزة** في تيليجرام.
   - الاطلاع على حالة كل جهاز ومتابعة جلساته بشكل مستقل.

4. **📸 لقطات شاشة حيّة وتحكم فوري (Live Screenshots & Instant Actions):**
   - طلب لقطة شاشة حيّة فورية لسطح مكتب الطفل في أي لحظة.
   - قفل فوري للشاشة أو تسجيل الخروج بنقرة زر.
   - وضع الاستراحة ("وقت العشاء") لإيقاف الجلسة مؤقتاً لمدة 30 دقيقة.
   - إضافة أو خصم وقت (+15د، +30د، +60د) بلمسة واحدة.

5. **💬 إرسال رسائل توجيهية مباشرة لشاشة الطفل:**
   - إرسال تنبيهات وتوجيهات نصية تظهر كإشعار مميز على شاشة الكمبيوتر.

6. **🛡️ حماية وتصفية المحتوى عبر DNS العائلي (Family Safe DNS):**
   - تفعيل/تعطيل حجب المواقع الضارة والإباحية وحماية التصفح العائلي فورياً من البوت.

7. **🚫 حظر التطبيقات والألعاب:**
   - قائمة سوداء قابلة للتخصيص لمنع تشغيل ألعاب أو برامج محددة.

8. **🎨 لوحة متابعة مخصصة للطفل (Child Companion Dashboard):**
   - نافذة شفافة وتفاعلية توضح للطفل الوقت المتبقي له وموعد الإغلاق القادم لتشجيع تنظيم الوقت ذاتياً.

9. **📴 عمل كامل ومستقل دون إنترنت (Offline-First Resilient Architecture):**
   - تخزين محلي كامل في قاعدة بيانات SQLite سريعة وآمنة.
   - استمرار قيود الوقت وحظر البرامج بدقة تامة حتى في حال انقطاع الشبكة.

</div>

---

<div id="english">

## 🌟 English Overview

**Waqti (وقتي)** is an enterprise-grade screen time management and device wellbeing platform built natively for 64-bit Windows 10 and 11 environments. Operating as an autonomous background Windows Service under the high-privilege `LocalSystem` security context, Waqti enforces strict daily screen time quotas, curfew windows, application blacklists, and DNS protection policies—guaranteeing tamper resistance and offline-first reliability.

Parents can manage their family workstations 24/7 from anywhere in the world using the official Telegram bot **[@Waqti_bot](https://t.me/Waqti_bot)**: request live desktop screenshots, adjust remaining quotas on the fly, dispatch remote messages to child monitors, toggle bedtime curfews, and switch seamlessly between multiple managed workstations within a single Telegram interface.

---

### ✨ Key Features

- **⏱️ Dual-Metric Time Management:** Clearly distinguishes between *Daily Quota Remaining* (e.g. 405 min left) and *Session Curfew Remaining* (time until scheduled bedtime lock).
- **☁️ 24/7 Cloud Architecture:** Powered by a high-availability Cloudflare serverless relay (`https://waqti-relay.cpcontrol.workers.dev`). Offline commands are safely queued and executed the moment the workstation reconnects.
- **📱 Multi-Device Fleet Management:** Pair unlimited Windows computers to a single parent account. Switch active devices, view connection heartbeats, and audit each child's PC from one menu.
- **📸 Live Remote Desktop Capture:** Capture high-resolution desktop screenshots instantly from Telegram to monitor active tasks and safety.
- **🛡️ Family Safe DNS Filtering:** One-click remote toggle for Cloudflare / CleanBrowsing family-grade DNS to block adult content, phishing, and malware across all browsers without client extensions.
- **⏸️ Dinner Pause & Instant Lock:** Temporarily pause screen time during family dinners or study hours, or lock the workstation instantly.
- **💬 Direct-to-Screen Messaging:** Dispatch instant notifications and reminders that display prominently on the child's screen.
- **🚫 Process & App Hardening:** Real-time monitoring and termination of blacklisted executables and games.
- **🎨 Child Companion Interface:** A non-intrusive, interactive dashboard displaying remaining session time and bedtime countdowns to nurture digital responsibility.
- **📴 Offline-First Reliability:** Uses a secure, local SQLite engine ensuring that daily limits and schedules are enforced even when Internet access is severed.
- **🌐 Trilingual Support:** Native user interface and Telegram interactions in **Arabic (RTL)**, **English**, and **French**.

</div>

---

## 🏗️ Architecture & Technology Stack

```
                          ┌─────────────────────────┐
                          │    Parent Smartphone    │
                          │   (Telegram Messenger)  │
                          └────────────┬────────────┘
                                       │ HTTPS Webhook
                                       ▼
                          ┌─────────────────────────┐
                          │   Waqti Cloud Relay     │
                          │  (Cloudflare Workers &   │
                          │   Global KV Datastore)  │
                          └────────────┬────────────┘
                                       │ Encrypted Long-Poll / REST
                  ┌────────────────────┴────────────────────┐
                  ▼                                         ▼
     ┌────────────────────────┐                ┌────────────────────────┐
     │   Child Workstation 1   │                │   Child Workstation 2   │
     │ ┌────────────────────┐ │                │ ┌────────────────────┐ │
     │ │ Windows Service    │ │                │ │ Windows Service    │ │
     │ │ (LocalSystem)      │ │                │ │ (LocalSystem)      │ │
     │ └──────────┬─────────┘ │                │ └──────────┬─────────┘ │
     │   ┌────────┴────────┐  │                │   ┌────────┴────────┐  │
     │   ▼                 ▼  │                │   ▼                 ▼  │
     │ Waqti Admin     Waqti  │                │ Waqti Admin     Waqti  │
     │   Dashboard   Companion│                │   Dashboard   Companion│
     └────────────────────────┘                └────────────────────────┘
```

- **Runtime:** .NET 8.0 (Windows x64)
- **Service Layer:** Native Windows Service (`LocalSystem`, SCM integration)
- **GUI Engine:** WPF (Windows Presentation Foundation) with Material Design & full RTL support
- **Persistence:** Local SQLite Engine (`Microsoft.Data.Sqlite`) with zero external service dependencies
- **Cloud Backend:** Cloudflare Serverless Workers + KV distributed key-value storage
- **Remote Protocol:** Telegram Bot API (Encrypted HTTPS Webhooks & command dispatch)
- **Packaging:** Inno Setup 6 with ultra-high LZMA2 solid compression (~49 MB installer)

---

## 🚀 Installation & Setup Guide

### 1. Download & Install
1. Download the latest installer **[WaqtiSetup-v1.0.0.exe](https://github.com/XCES4RX/Waqti/releases/latest)**.
2. Run `WaqtiSetup-v1.0.0.exe` as **Administrator**.
3. The installer registers the autonomous Windows Service and creates desktop shortcuts for **Waqti Admin** and **Waqti Child Companion**.

### 2. Configure Limits & Pairing
1. Launch **Waqti Admin** from the desktop shortcut or Start menu.
2. Set daily screen time limits and allowed active hours for your child's Windows account.
3. Open **Settings & Telegram** (الإعدادات وتليجرام).
4. Note your unique 6-digit **Pairing PIN** (or click the direct pairing link).

### 3. Connect Telegram Bot
1. Open Telegram and search for **[@Waqti_bot](https://t.me/Waqti_bot)**.
2. Press **Start** and send your 6-digit PIN.
3. Your device is now securely paired! You can now monitor status, adjust time, capture screenshots, and manage settings remotely 24/7.

---

## 🛠️ Building from Source

### Prerequisites
- [Windows 10 / 11 (64-bit)](https://www.microsoft.com/windows)
- [.NET 8.0 SDK](https://dotnet.microsoft.com/download/dotnet/8.0)
- [Inno Setup 6.2+](https://jrsoftware.org/isdownload.php) (for building the installer)

### Build Commands
```powershell
# Clone the repository
git clone https://github.com/XCES4RX/Waqti.git
cd Waqti

# Compile and package everything
.\build.ps1
```
The compiled, compressed installer will be generated at `installer\Output\WaqtiSetup-v1.0.0.exe`.

---

## 📄 License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for full details.
