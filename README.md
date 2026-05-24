<div dir="rtl">

# 🤖 tg-bot-auto-sender

**ربات تلگرام برای جمع‌آوری، تست و انتشار خودکار کانفیگ‌های VPN**

پروتکل‌های پشتیبانی‌شده: VLESS · VMess · Trojan · Shadowsocks · WireGuard

---

📖 [English Documentation →](./README-EN.md)

---

## ربات چه کاری انجام می‌دهد؟

۱. هر ۱۰ دقیقه یک‌بار منابع subscription را دانلود و parse می‌کند  
۲. هر کانفیگ را با یک TCP probe واقعی تست می‌کند (کانفیگ‌های مرده حذف می‌شوند)  
۳. کانفیگ‌های سالم را دسته‌بندی می‌کند و فایل‌های subscription تولید می‌کند  
۴. هر دقیقه یک کانفیگ را در کانال تلگرام شما منتشر می‌کند  
۵. در صورت تنظیم، فایل‌های subscription را به GitHub push می‌کند  

---

## 🚀 نصب یک‌خطی روی Ubuntu 20.04+

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Alirewa/tg-bot-auto-sender/main/install.sh)
```

> **تنها چیزی که هنگام نصب از شما پرسیده می‌شود:**
> - توکن ربات (از `@BotFather`)
> - آی‌دی عددی ادمین (از `@userinfobot`)
>
> بقیه تنظیمات را **بعد از نصب از داخل خود ربات** انجام می‌دهید.

---

## ✅ راه‌اندازی بعد از نصب (۴ مرحله)

### مرحله ۱ — ساخت ربات

۱. به `@BotFather` در تلگرام بروید  
۲. دستور `/newbot` را بزنید  
۳. یک اسم و username برای ربات انتخاب کنید  
۴. توکن دریافتی را کپی کنید — هنگام نصب از شما خواسته می‌شود  

### مرحله ۲ — گرفتن آی‌دی خودتان

۱. به `@userinfobot` بروید و `/start` بزنید  
۲. عدد «Id» که نشان می‌دهد را کپی کنید  
۳. این عدد را هنگام نصب به عنوان Admin User ID وارد کنید  

### مرحله ۳ — تنظیم کانال انتشار

بعد از نصب و راه‌اندازی ربات:

۱. **ربات را به کانال خود اضافه کنید** و آن را **ادمین** کنید  
   - حتماً دسترسی «ارسال پیام» (Post Messages) فعال باشد  
۲. به ربات پیام بدهید و آدرس کانال را تنظیم کنید:  

```
/setchannel @username_کانال_شما
```

یا از منوی اصلی روی دکمه **📢 Set Channel** کلیک کنید.

### مرحله ۴ — اولین اسکرپ

دستور زیر را بزنید تا ربات فوری شروع به جمع‌آوری کانفیگ کند:

```
/forcescrape
```

ربات شروع به اسکرپ و تست می‌کند و وضعیت را زنده نشان می‌دهد.  
بعد از چند دقیقه اولین کانفیگ در کانال شما منتشر می‌شود.

---

## 🎛 دستورات ربات

### کنترل اصلی

| دستور | کاربرد |
|---|---|
| `/start` | منوی اصلی ادمین |
| `/on` | روشن‌کردن ارسال خودکار |
| `/off` | خاموش‌کردن ارسال خودکار |
| `/setchannel @channel` | تنظیم یا تغییر کانال انتشار |
| `/stats` | آمار کلی |
| `/analytics` | آمار ۲۴ ساعته (بهترین پروتکل، کشور، نسبت سالم) |
| `/ping` | تست اتصال ربات |

### مدیریت منابع

| دستور | کاربرد |
|---|---|
| `/listsubs` | لیست منابع subscription فعلی |
| `/addsub https://...` | افزودن یک منبع جدید |
| `/delsub <id>` | حذف منبع |
| `/enablesub <id>` / `/disablesub <id>` | فعال/غیرفعال کردن منبع |

### اقدامات فوری

| دستور | کاربرد |
|---|---|
| `/forcescrape` | شروع فوری چرخه اسکرپ |
| `/forcecheck` | اعتبارسنجی مجدد کل صف |
| `/sublink` | لینک فایل‌های subscription |

---

## ⚙️ تنظیمات پیشرفته (فایل `.env`)

فایل `.env` در مسیر `/opt/tg-bot-auto-sender/.env` قرار دارد.  
برای ویرایش:

```bash
sudo nano /opt/tg-bot-auto-sender/.env
sudo systemctl restart tg-bot-auto-sender
```

### متغیرهای پایه (بعد از نصب به‌صورت خودکار تنظیم می‌شوند)

| متغیر | توضیح |
|---|---|
| `BOT_TOKEN` | توکن ربات از `@BotFather` |
| `ADMIN_USER_ID` | آی‌دی عددی ادمین |

### تنظیمات اختیاری

| متغیر | پیش‌فرض | توضیح |
|---|---|---|
| `PUBLISH_CRON` | `* * * * *` | زمان‌بندی انتشار (هر دقیقه) |
| `SCRAPE_CRON` | `*/10 * * * *` | زمان‌بندی اسکرپ (هر ۱۰ دقیقه) |
| `LOG_LEVEL` | `info` | سطح لاگ: `error`, `warn`, `info`, `debug` |
| `DB_PATH` | `./data/bot.sqlite` | مسیر دیتابیس |
| `SUBS_DIR` | `./subs` | پوشه فایل‌های subscription |

### انتشار خودکار به GitHub (اختیاری)

اگر بخواهید فایل‌های subscription به‌صورت عمومی در GitHub در دسترس باشند:

| متغیر | توضیح |
|---|---|
| `GITHUB_TOKEN` | Personal Access Token با دسترسی `repo` |
| `GITHUB_REPO` | مثل `username/v2ray-subs` |
| `GITHUB_BRANCH` | پیش‌فرض `main` |
| `SUB_DIR` | زیرشاخه در repo — پیش‌فرض `subs` |

برای ساخت GitHub Token: GitHub → Settings → Developer Settings → Personal Access Tokens → Tokens (classic) → دسترسی `repo` را فعال کنید.

### تنظیمات کارایی (خودکار تنظیم می‌شود)

ربات به‌صورت خودکار CPU و RAM سرور را تشخیص می‌دهد و مقادیر بهینه را تنظیم می‌کند:

| سرور | موازی‌سازی | حداکثر کانفیگ در هر چرخه |
|---|---|---|
| ۱ vCPU / ۲ GB RAM | ۱۰۰ | ۴۰۰ |
| ۲ vCPU / ۴ GB RAM | ۳۰۰ | ۱۲۰۰ |
| ۴ vCPU / ۸ GB RAM | ۶۰۰ | ۲۵۰۰ |
| ۸+ vCPU | ۱۰۰۰ | ۵۰۰۰ |

برای override دستی در `.env`:

```env
VALIDATION_CONCURRENCY=300
MAX_CONFIGS_PER_CYCLE=1200
TCP_TIMEOUT_MS=2500
```

---

## 📦 فایل‌های Subscription تولیدشده

بعد از هر چرخه اسکرپ، فایل‌های زیر تولید می‌شوند:

| فایل | محتوا |
|---|---|
| `subs/main.txt` | همه کانفیگ‌ها — base64 (فرمت استاندارد V2Ray) |
| `subs/healthy.txt` | همه کانفیگ‌های سالم — متن ساده |
| `subs/vless.txt` | فقط VLESS |
| `subs/vmess.txt` | فقط VMess |
| `subs/trojan.txt` | فقط Trojan |
| `subs/ss.txt` | فقط Shadowsocks |
| `subs/wireguard.txt` | فقط WireGuard |

---

## 🛠 مدیریت سرویس

```bash
# وضعیت
sudo systemctl status tg-bot-auto-sender

# لاگ‌های زنده
journalctl -u tg-bot-auto-sender -f

# ری‌استارت
sudo systemctl restart tg-bot-auto-sender

# توقف
sudo systemctl stop tg-bot-auto-sender
```

### پنل مدیریتی (اختیاری)

```bash
sudo bash /opt/tg-bot-auto-sender/scripts/install-tgpanel.sh
tgpanel
```

پنل تعاملی برای: update / restart / ویرایش env / بکاپ / لاگ / حذف

---

## ❓ رفع مشکل

**ربات پست نمی‌زند:**
- از `/stats` بپرسید — اگر queue خالی است `/forcescrape` بزنید
- از `/setchannel` مطمئن شوید کانال درست تنظیم شده
- مطمئن شوید ربات ادمین کانال است و دسترسی Post Messages دارد

**خطای `EMFILE` در لاگ‌ها:**

```bash
echo '* soft nofile 65535' | sudo tee -a /etc/security/limits.conf
echo '* hard nofile 65535' | sudo tee -a /etc/security/limits.conf
sudo reboot
```

**بررسی لاگ‌ها:**

```bash
journalctl -u tg-bot-auto-sender -n 50 --no-pager
```

---

## اجرای محلی (برای توسعه)

```bash
git clone https://github.com/Alirewa/tg-bot-auto-sender.git
cd tg-bot-auto-sender
cp .env.example .env
# مقادیر .env را پر کنید
npm ci
npm run build
npm start
```

---

*ساخته‌شده با Node.js 20 · TypeScript · Telegraf · SQLite · node-cron*

</div>
