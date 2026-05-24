# tg-bot-auto-sender

ربات تلگرام **ادمین‌محور** برای جمع‌آوری، اعتبارسنجی و انتشار خودکار کانفیگ‌های V2Ray / VLESS / VMess / Trojan / Shadowsocks در یک کانال تلگرام.

- ربات فقط به **یک کاربر ادمین** (تنظیم‌شده در `.env`) پاسخ می‌دهد. کاربران معمولی به‌طور خاموش نادیده گرفته می‌شوند.
- هر ۶۰ ثانیه یک کانفیگ سالم در کانال منتشر می‌شود.
- نام هر کانفیگ طبق قالب قابل تنظیم بازنویسی می‌شود — پیش‌فرض:
  ```
  🇩🇪 - #1 @webdw
  🇫🇷 - #2 @webdw
  🇺🇸 - #3 @webdw
  ```
- اعتبارسنجی واقعی TCP + GeoIP آفلاین (geoip-lite).
- لینک‌های Subscription از داخل خود ربات قابل افزودن/حذف هستند.
- ضد تکرار دائمی با SQLite.

نصب کامل: **[DEPLOY.md](./DEPLOY.md)**

---

## دستورات ادمین

### وضعیت و کنترل
| دستور | کاربرد |
|---|---|
| `/start` یا `/help` | منوی ادمین |
| `/status` | وضعیت کامل (auto-send، قالب، شمارنده، تعداد منابع، صف) |
| `/on` | روشن‌کردن ارسال خودکار |
| `/off` | خاموش‌کردن ارسال خودکار |
| `/stats` | آمار |
| `/ping` | تست سلامت + uptime |

### قالب ارسال
| دستور | کاربرد |
|---|---|
| `/template` | نمایش قالب فعلی |
| `/settemplate {flag} - #{n} {channel}` | تغییر قالب |
| `/resetcounter` | صفرکردن شمارنده‌ی n |

پلیس‌هولدرها: `{flag}` `{n}` `{channel}` `{country}`

### مدیریت لینک‌های Subscription
| دستور | کاربرد |
|---|---|
| `/listsubs` | لیست منابع همراه id |
| `/addsub https://...` | افزودن منبع |
| `/delsub <id>` | حذف کامل |
| `/enablesub <id>` / `/disablesub <id>` | فعال/غیرفعال موقت |

### اقدامات فوری
| دستور | کاربرد |
|---|---|
| `/forcescrape` | شروع چرخه‌ی اسکرپ همین الان |
| `/forcecheck` | اعتبارسنجی مجدد کل صف |

---

## متغیرهای محیطی

| متغیر | اجباری | توضیح |
|---|---|---|
| `BOT_TOKEN` | ✅ | توکن از `@BotFather` |
| `ADMIN_USER_ID` | ✅ | آی‌دی عددی تنها ادمین |
| `PUBLISH_CHANNEL` | ✅ | مثل `@webdw` (ربات باید ادمین کانال باشد) |
| `TCP_TIMEOUT_MS` | ❌ | پیش‌فرض `2500` — کمتر = اسکرپ سریع‌تر، false-negative بیشتر |
| `VALIDATION_CONCURRENCY` | ❌ | پیش‌فرض `300` (مناسب Hetzner CX22) — برای سرور قوی‌تر ۵۰۰-۸۰۰ |
| `MAX_CONFIGS_PER_CYCLE` | ❌ | پیش‌فرض `1200` — sample تصادفی برای جلوگیری از قفل شدن چرخه |

## 🖥 تنظیمات پیشنهادی بر اساس سرور

| سرور | `VALIDATION_CONCURRENCY` | `MAX_CONFIGS_PER_CYCLE` |
|---|---|---|
| Hetzner CX11 (1 vCPU / 2 GB) | 150 | 600 |
| **Hetzner CX22 (2 vCPU / 4 GB)** ← پیش‌فرض | **300** | **1200** |
| Hetzner CX32 (4 vCPU / 8 GB) | 600 | 2500 |
| CPX/AX series (8+ vCPU) | 1000+ | 5000 |

روی CX22 با concurrency=300 یک چرخه‌ی ۱۲۰۰ تایی معمولاً **۱۰-۲۰ ثانیه** طول می‌کشد.

### اگر TCP probe خطای `EMFILE` گرفت

به این معنی است که ulimit پایین است. در سرور:
```bash
echo '* soft nofile 65535' | sudo tee -a /etc/security/limits.conf
echo '* hard nofile 65535' | sudo tee -a /etc/security/limits.conf
# سپس logout و دوباره login، یا reboot
```
| `PUBLISH_CRON` | ❌ | پیش‌فرض `* * * * *` |
| `SCRAPE_CRON` | ❌ | پیش‌فرض `*/10 * * * *` |
| `DB_PATH` | ❌ | پیش‌فرض `./data/bot.sqlite` |
| `LOG_LEVEL` | ❌ | `error|warn|info|debug` |

---

## ساختار

```
src/
  bot/          # Telegraf + adminGate + commands + publisher (rename + template)
  scraper/      # axios + parser (sub URLs از DB می‌آیند)
  validator/    # TCP probe + p-limit
  geoip/        # geoip-lite + flag emoji
  scheduler/    # node-cron + auto_send toggle + صف
  database/     # better-sqlite3 + migrations + repositories
  utils/        # config / logger / retry / escape / renamer
  types/
  index.ts
```

## 🛠 ابزار `tgpanel`

روی سرور Ubuntu بعد از clone می‌توانی این دستور را نصب کنی:

```bash
sudo bash scripts/install-tgpanel.sh
```

سپس با `tgpanel` یک منوی متنی باز می‌شود که شامل:
update / restart / start / stop / edit env / backup / logs / uninstall.

## اجرای لوکال
```bash
cp .env.example .env
npm ci
npm run build
npm start       # یا: npm run dev
```

## اجرا با Docker
```bash
cp .env.example .env
docker compose up -d --build
docker compose logs -f bot
```
