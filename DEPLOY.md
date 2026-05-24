# راهنمای کامل راه‌اندازی روی Ubuntu 22.04 (Hetzner)

این فایل، گام‌به‌گام و مرتب، نحوه‌ی نصب ربات `tg-bot-auto-sender` روی یک سرور تازه‌ی Ubuntu 22.04 را توضیح می‌دهد.

---

## ۱) آماده‌سازی اولیه‌ی سرور

```bash
ssh root@YOUR_SERVER_IP

# ایجاد یک کاربر معمولی (توصیه می‌شود به‌جای root)
adduser deploy
usermod -aG sudo deploy
su - deploy

sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git ufw build-essential python3 ca-certificates
```

## ۲) نصب Node.js 20 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # باید v20.x باشد
npm -v
```

## ۳) نصب PM2

```bash
sudo npm install -g pm2
pm2 -v
```

## ۴) فایروال (UFW)

ربات هیچ پورت ورودی نمی‌خواهد (long-polling خروجی است)، فقط SSH:

```bash
sudo ufw allow OpenSSH
sudo ufw --force enable
sudo ufw status
```

## ۵) گرفتن کد پروژه

```bash
cd /opt
sudo git clone <YOUR_REPO_URL> tg-bot-auto-sender
sudo chown -R $USER:$USER tg-bot-auto-sender
cd tg-bot-auto-sender
```

## ۶) تنظیم متغیرهای محیطی

```bash
cp .env.example .env
nano .env
```

حداقل این سه مقدار را پر کنید:

```
BOT_TOKEN=توکن_از_BotFather
ADMIN_USER_ID=آی‌دی_عددی_ادمین
PUBLISH_CHANNEL=@webdw
```

> 🔒 این ربات **هیچ پاسخی به کاربران عادی نمی‌دهد**. فقط `ADMIN_USER_ID` که در `.env` تنظیم می‌کنید قادر به فرستادن دستور است.

## ۷) Build پروژه

```bash
npm ci
npm run build
```

## ۸) اضافه‌کردن ربات به کانال

قبل از start:
1. ربات را به کانالی که در `PUBLISH_CHANNEL` تنظیم کردید **ادمین** کنید.
2. دسترسی **Post Messages** را برای ربات فعال کنید.

## ۹) اجرا با PM2 + auto-start بعد از reboot

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd -u $USER --hp $HOME
# آخرین خط خروجی pm2 startup را با sudo اجرا کنید
```

## ۱۰) تست عملکرد

داخل پنل خصوصی ربات (کاربر ادمین):

```
/start          → منوی ادمین
/status         → وضعیت فعلی (auto-send روشن/خاموش)
/on             → فعال‌کردن انتشار خودکار
/addsub https://example.com/sub.txt
/forcescrape    → یک چرخه‌ی فوری اسکرپ
```

اگر همه‌چیز درست باشد، حداکثر طی یک دقیقه اولین کانفیگ در کانال منتشر می‌شود با نام:
```
🇩🇪 - #1 @webdw
```

## ۱۰.۵) نصب دستور `tgpanel`

یک کنترل‌پنل تعاملی برای آپدیت / restart / حذف / ویرایش env و backup:

```bash
sudo bash /opt/tg-bot-auto-sender/scripts/install-tgpanel.sh
```

از این به بعد در هر مسیر فقط کافیست بنویسی:

```bash
tgpanel
```

منوی tgpanel شامل:

| گزینه | کار |
|---|---|
| 1 | وضعیت ربات و آخرین commit |
| 2 | لاگ زنده |
| 3 / 4 / 5 | Restart / Start / Stop |
| 6 | آپدیت از GitHub (pull + build + restart) |
| 7 | ویرایش `.env` |
| 8 | Backup دیتابیس |
| 9 | `pm2 save` |
| 10 | Shell در پوشه پروژه |
| 11 | نصب از صفر (clone) |
| 12 | حذف کامل از سرور |

## ۱۱) مانیتورینگ

```bash
pm2 status
pm2 logs tg-bot-auto-sender --lines 100
pm2 monit

tail -f logs/combined.log
tail -f logs/error.log
```

## ۱۲) آپدیت پروژه

```bash
cd /opt/tg-bot-auto-sender
git pull
npm ci
npm run build
pm2 restart tg-bot-auto-sender
```

## ۱۳) Backup دیتابیس

دیتابیس در `data/bot.sqlite` ذخیره می‌شود. این فایل را به‌طور مرتب backup بگیرید تا تاریخچه‌ی کانفیگ‌ها و شمارنده‌ی نام‌ها از بین نرود.

```bash
cp data/bot.sqlite ~/backups/bot-$(date +%F).sqlite
```

## ۱۴) اجرای جایگزین با Docker

```bash
cp .env.example .env && nano .env
docker compose up -d --build
docker compose logs -f bot
```

---

## عیب‌یابی سریع

| مشکل | راه‌حل |
|---|---|
| `Missing required environment variable` | فایل `.env` ناقص است |
| پیام در کانال ارسال نمی‌شود | ربات ادمین کانال نیست یا `Post Messages` ندارد |
| ربات به دستورات جواب نمی‌دهد | `ADMIN_USER_ID` در `.env` با آی‌دی شما یکی نیست. آی‌دی را از `@userinfobot` بگیرید |
| همه‌ی کانفیگ‌ها dead می‌شوند | فایروال outbound سرور بسته است یا IP سرور بلاک است |
| `better-sqlite3` build error | `sudo apt install -y build-essential python3` و دوباره `npm ci` |
| `pm2 startup` کار نکرد | دستوری که خروجی می‌دهد را با `sudo` اجرا کنید |
