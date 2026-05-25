<div dir="rtl">

# 🤖 tg-bot-auto-sender

**ربات تلگرام برای جمع‌آوری، تست واقعی و انتشار خودکار کانفیگ‌های VPN**

پروتکل‌های پشتیبانی‌شده: VLESS · VMess · Trojan · Shadowsocks · WireGuard

---

## ربات چه کاری انجام می‌دهد؟

۱. هر ۱ ساعت یک‌بار منابع subscription را دانلود و parse می‌کند  
۲. هر کانفیگ را ابتدا با TCP probe و سپس با **xray واقعی** تست می‌کند  
   — کانفیگ‌هایی که UUID اشتباه دارند یا اکانتشان expire شده حذف می‌شوند  
۳. کانفیگ‌های تأییدشده وارد صف می‌شوند و هر دقیقه یکی در کانال منتشر می‌شود  
۴. فایل‌های subscription به تفکیک پروتکل تولید می‌شوند  
۵. در صورت تنظیم، فایل‌های subscription به GitHub push می‌شوند  

---

## 🚀 نصب یک‌خطی روی Ubuntu 20.04+

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Alirewa/tg-bot-auto-sender/main/install.sh)
```

اسکریپت نصب به‌صورت خودکار نصب می‌کند: Node.js 20 · xray-core · git · build tools

> **تنها چیزی که هنگام نصب از شما پرسیده می‌شود:**
> - توکن ربات (از `@BotFather`)
> - آی‌دی عددی ادمین (از `@userinfobot`)
>
> بقیه تنظیمات را **بعد از نصب از داخل خود ربات** انجام می‌دهید.

---

## ✅ راه‌اندازی بعد از نصب

### مرحله ۱ — ساخت ربات
۱. به `@BotFather` بروید و `/newbot` بزنید  
۲. توکن دریافتی را هنگام نصب وارد کنید  

### مرحله ۲ — گرفتن آی‌دی خودتان
۱. به `@userinfobot` بروید و `/start` بزنید  
۲. عدد «Id» را کپی کنید و هنگام نصب وارد کنید  

### مرحله ۳ — تنظیم کانال انتشار
۱. ربات را به کانال اضافه کنید و **ادمین** کنید (دسترسی Post Messages)  
۲. در چت با ربات بزنید:

```
/setchannel @نام_کانال_شما
```

### مرحله ۴ — اضافه کردن منابع و اولین اسکرپ
از منوی `/start` → **🔗 Sources** → **➕ Add source** منابع subscription را اضافه کنید.  
سپس روی **🔍 Scan** → **⏳ Scrape now** بزنید.

---

## 🎛 منوی مدیریت ربات

همه چیز از طریق دکمه‌های inline در `/start` مدیریت می‌شود:

| بخش | قابلیت‌ها |
|---|---|
| **🔍 Scan** | اسکرپ از همه منابع یا یک منبع خاص · تست xray · پاک‌کردن صف |
| **🔗 Sources** | افزودن/حذف/فعال‌سازی منابع · بررسی سلامت خودکار (🩺 Health check) |
| **📊 Stats** | آمار کلی ارسال‌ها و اعتبارسنجی |
| **📈 Analytics** | آمار ۲۴ ساعته: بهترین پروتکل، کشور، نسبت سالم |
| **📡 Sub links** | لینک یا مسیر فایل‌های subscription |
| **🧩 Template** | قالب نام کانفیگ (flag · شماره · کانال) |

---

## ⚙️ تنظیمات فایل `.env`

```bash
sudo nano /opt/tg-bot-auto-sender/.env
sudo systemctl restart tg-bot-auto-sender
```

### متغیرهای اصلی

| متغیر | توضیح |
|---|---|
| `BOT_TOKEN` | توکن ربات |
| `ADMIN_USER_ID` | آی‌دی عددی ادمین |
| `PUBLISH_CHANNEL` | آدرس کانال (اختیاری — از `/setchannel` هم می‌شود) |

### تنظیمات اختیاری

| متغیر | پیش‌فرض | توضیح |
|---|---|---|
| `PUBLISH_CRON` | `* * * * *` | هر دقیقه یک کانفیگ منتشر می‌شود |
| `SCRAPE_CRON` | `0 * * * *` | هر ساعت اسکرپ می‌کند |
| `MAX_CONFIGS_PER_CYCLE` | `500` | حداکثر کانفیگ برای تست در هر چرخه |
| `LOG_LEVEL` | `info` | سطح لاگ |

### انتشار خودکار به GitHub (اختیاری)

| متغیر | توضیح |
|---|---|
| `GITHUB_TOKEN` | Personal Access Token (دسترسی `repo`) |
| `GITHUB_REPO` | مثل `username/v2ray-subs` |
| `GITHUB_BRANCH` | پیش‌فرض `main` |
| `SUB_DIR` | زیرشاخه در repo — پیش‌فرض `subs` |

---

## 📦 فایل‌های Subscription

بعد از هر چرخه اسکرپ در پوشه `subs/` تولید می‌شوند:

| فایل | محتوا |
|---|---|
| `main.txt` | همه کانفیگ‌ها — base64 (فرمت استاندارد) |
| `healthy.txt` | کانفیگ‌های تأییدشده — متن ساده |
| `vless.txt` / `vmess.txt` / `trojan.txt` | به تفکیک پروتکل |
| `ss.txt` / `wireguard.txt` | به تفکیک پروتکل |

---

## 🛠 مدیریت سرویس

```bash
sudo systemctl status tg-bot-auto-sender   # وضعیت
journalctl -u tg-bot-auto-sender -f        # لاگ زنده
sudo systemctl restart tg-bot-auto-sender  # ری‌استارت
```

### اپدیت

```bash
cd /opt/tg-bot-auto-sender && git pull && npm run build && systemctl restart tg-bot-auto-sender
```

---

## ❓ رفع مشکل

**ربات پست نمی‌زند:**
- از `/start` وضعیت Auto-send را چک کنید — اگر 🔴 است `/on` بزنید
- ربات هنگام خطای کانال auto-send را خاموش می‌کند و پیام هشدار می‌فرستد
- مطمئن شوید ربات ادمین کانال با دسترسی Post Messages است
- صف خالی؟ از Scan → Scrape now استفاده کنید

**خطای `EMFILE` در لاگ:**
```bash
echo '* soft nofile 65535' | sudo tee -a /etc/security/limits.conf
echo '* hard nofile 65535' | sudo tee -a /etc/security/limits.conf
sudo reboot
```

---

*Node.js 20 · TypeScript · Telegraf · SQLite · xray-core*

</div>
