# tg-bot-auto-sender

**پلتفرم حرفه‌ای جمع‌آوری، اعتبارسنجی و انتشار خودکار کانفیگ‌های VPN**

> V2Ray / VLESS / REALITY / VMess / Trojan / Shadowsocks / WireGuard

---

## معماری Pipeline

```
Scrape Sources (Sub URLs از DB)
        ↓
Parse & Normalize
        ↓
Deduplicate (SHA-256 دائمی)
        ↓
TCP Health Check + GeoIP
        ↓
Rename / Brand configs
        ↓
┌──────────────────────────────────┐
│  Generate Internal Subscription  │
│  subs/main.txt  (base64, همه)    │
│  subs/vless.txt  subs/vmess.txt  │
│  subs/trojan.txt subs/ss.txt     │
│  subs/wireguard.txt              │
└──────────────────┬───────────────┘
                   │
         ┌─────────┴──────────┐
         ↓                    ↓
  GitHub Repo           Telegram Channel
  (auto push)           (1 config/min)
```

- ربات فقط به **یک کاربر ادمین** پاسخ می‌دهد. بقیه نادیده گرفته می‌شوند.
- سیستم **خودکار** منابع، CPU و RAM را تشخیص می‌دهد و مقادیر بهینه را تنظیم می‌کند.
- هر ۱۰ دقیقه یک چرخه‌ی کامل Scrape + Validate اجرا می‌شود.
- هر ۶۰ ثانیه یک کانفیگ سالم در کانال منتشر می‌شود.
- فایل‌های Subscription بعد از هر چرخه به‌روز می‌شوند.
- اعتبارسنجی واقعی TCP + GeoIP آفلاین (geoip-lite).
- ضد تکرار دائمی با SQLite.
- آنالیتیکس کامل با آمار ۲۴ ساعته.

نصب کامل: **[DEPLOY.md](./DEPLOY.md)**

---

## 🚀 نصب یک‌خطی (Ubuntu 20.04+)

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Alirewa/tg-bot-auto-sender/main/install.sh)
```

Wizard تعاملی همه‌چیز را می‌پرسد و سرویس systemd را راه‌اندازی می‌کند.

---

## دستورات ادمین

### وضعیت و کنترل
| دستور | کاربرد |
|---|---|
| `/start` یا `/help` | منوی اصلی ادمین |
| `/status` | وضعیت کامل (auto-send، قالب، شمارنده، منابع، صف) |
| `/on` | روشن‌کردن ارسال خودکار |
| `/off` | خاموش‌کردن ارسال خودکار |
| `/stats` | آمار کلی |
| `/ping` | تست سلامت + uptime |
| `/analytics` | آنالیتیکس ۲۴ ساعته (بهترین پروتکل، کشور، نسبت سالم) |

### لینک‌های Subscription
| دستور | کاربرد |
|---|---|
| `/sublink` | لینک‌های raw GitHub برای همه فایل‌های sub |

فرمت پیام نمونه:
```
📡 Subscription Links

All (base64):   https://raw.githubusercontent.com/user/repo/main/subs/main.txt
Healthy (plain):https://raw.githubusercontent.com/user/repo/main/subs/healthy.txt
VLESS:          https://raw.githubusercontent.com/user/repo/main/subs/vless.txt
VMess:          https://raw.githubusercontent.com/user/repo/main/subs/vmess.txt
Trojan:         https://raw.githubusercontent.com/user/repo/main/subs/trojan.txt
SS:             https://raw.githubusercontent.com/user/repo/main/subs/ss.txt
WireGuard:      https://raw.githubusercontent.com/user/repo/main/subs/wireguard.txt
```

### قالب ارسال
| دستور | کاربرد |
|---|---|
| `/template` | نمایش قالب فعلی |
| `/settemplate {flag} - #{n} {channel}` | تغییر قالب |
| `/resetcounter` | صفرکردن شمارنده‌ی n |

پلیس‌هولدرها: `{flag}` `{n}` `{channel}` `{country}`

### مدیریت منابع Subscription
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

## فرمت پست کانال

```
━━━━━━━━━━━━━━━━━━━━━━━
🇩🇪 Germany  ⚡ VLESS
📶 Ping: 82ms  🟢 Online
━━━━━━━━━━━━━━━━━━━━━━━

<config URI>

🔗 Join: @channel
#config #v2ray #vpn #vless
```

---

## متغیرهای محیطی

### اجباری
| متغیر | توضیح |
|---|---|
| `BOT_TOKEN` | توکن از `@BotFather` |
| `ADMIN_USER_ID` | آی‌دی عددی تنها ادمین |
| `PUBLISH_CHANNEL` | مثل `@webdw` (ربات باید ادمین کانال باشد) |

### اختیاری — زمان‌بندی
| متغیر | پیش‌فرض | توضیح |
|---|---|---|
| `PUBLISH_CRON` | `* * * * *` | هر دقیقه یک کانفیگ |
| `SCRAPE_CRON` | `*/10 * * * *` | هر ۱۰ دقیقه یک چرخه‌ی scrape |

### اختیاری — کارایی (خودکار تشخیص داده می‌شود)
| متغیر | پیش‌فرض خودکار | توضیح |
|---|---|---|
| `VALIDATION_CONCURRENCY` | بر اساس CPU/RAM | تعداد probe های موازی |
| `MAX_CONFIGS_PER_CYCLE` | بر اساس CPU/RAM | حداکثر کانفیگ در هر چرخه |
| `TCP_TIMEOUT_MS` | `2500` یا `3000` | timeout هر TCP probe |

**تشخیص خودکار:**
| سرور | `CONCURRENCY` | `MAX_CONFIGS` |
|---|---|---|
| ۱ vCPU / ۲ GB | 100 | 400 |
| **۲ vCPU / ۴ GB** | **300** | **1200** |
| ۴ vCPU / ۸ GB | 600 | 2500 |
| ۸+ vCPU | 1000 | 5000 |

اگر می‌خواهید مقادیر را override کنید، در `.env` تنظیم کنید.

### اختیاری — ذخیره‌سازی
| متغیر | پیش‌فرض | توضیح |
|---|---|---|
| `DB_PATH` | `./data/bot.sqlite` | مسیر دیتابیس SQLite |
| `SUBS_DIR` | `./subs` | مسیر فایل‌های subscription محلی |
| `LOG_LEVEL` | `info` | `error|warn|info|debug` |

### اختیاری — GitHub Auto-Publisher
| متغیر | توضیح |
|---|---|
| `GITHUB_TOKEN` | Personal Access Token با دسترسی `repo write` — خالی = غیرفعال |
| `GITHUB_REPO` | مثل `myuser/v2ray-subs` |
| `GITHUB_BRANCH` | پیش‌فرض `main` |
| `SUB_DIR` | زیرشاخه داخل repo، پیش‌فرض `subs` |
| `GITHUB_PUSH_INTERVAL_MS` | پیش‌فرض `300000` (5 دقیقه) |

---

## ساختار پروژه

```
src/
  bot/           # Telegraf + admin gate + commands + publisher
  scraper/       # axios + parser (vmess/vless/trojan/ss/wireguard)
  validator/     # TCP probe + p-limit concurrency
  geoip/         # geoip-lite + flag emoji
  scheduler/     # node-cron + publish queue + analytics recording
  subscriptions/ # subscription file generator (per-protocol .txt files)
  github/        # GitHub Contents API auto-publisher
  database/      # better-sqlite3 + migrations + repositories + AnalyticsRepo
  utils/         # config / logger / retry / escape / renamer / system (auto-tune)
  types/
  index.ts
subs/            # generated subscription files (gitignored locally)
data/            # SQLite DB (gitignored)
logs/            # winston logs (gitignored)
scripts/
  tgpanel.sh          # interactive control panel
  install-tgpanel.sh  # installer for tgpanel command
  tgbot.service       # systemd service template
install.sh            # one-line Ubuntu installer
```

---

## اگر TCP probe خطای `EMFILE` گرفت

```bash
echo '* soft nofile 65535' | sudo tee -a /etc/security/limits.conf
echo '* hard nofile 65535' | sudo tee -a /etc/security/limits.conf
# سپس logout و دوباره login، یا reboot
```

---

## 🛠 ابزار `tgpanel`

```bash
sudo bash scripts/install-tgpanel.sh
tgpanel
```

منوی تعاملی: update / restart / start / stop / edit env / backup / sub links / logs / uninstall

---

## اجرای لوکال
```bash
cp .env.example .env
# مقادیر .env را پر کنید
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
