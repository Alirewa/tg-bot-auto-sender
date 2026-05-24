# 🤖 tg-bot-auto-sender

**Telegram bot for automatic collection, validation, and publishing of VPN configs**

Supported protocols: VLESS · VMess · Trojan · Shadowsocks · WireGuard

---

📖 [مستندات فارسی ←](./README.md)

---

## What does the bot do?

1. Every 10 minutes it fetches and parses subscription sources
2. Each config is tested with a real TCP probe (dead configs are discarded)
3. Healthy configs are categorised and subscription files are generated
4. Every minute one config is published to your Telegram channel
5. If configured, subscription files are automatically pushed to GitHub

---

## 🚀 One-line install on Ubuntu 20.04+

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Alirewa/tg-bot-auto-sender/main/install.sh)
```

> **The installer only asks for two things:**
> - Your bot token (from `@BotFather`)
> - Your numeric admin user ID (from `@userinfobot`)
>
> Everything else is configured **inside the bot after installation**.

---

## ✅ Post-install setup (4 steps)

### Step 1 — Create your bot

1. Open `@BotFather` on Telegram
2. Send `/newbot`
3. Choose a name and username for your bot
4. Copy the token you receive — the installer will ask for it

### Step 2 — Get your user ID

1. Open `@userinfobot` and send `/start`
2. Copy the number shown next to **Id**
3. Enter this number as **Admin User ID** during installation

### Step 3 — Set the publish channel

After the bot is running:

1. **Add the bot to your channel** and make it an **admin**
   - Make sure the **Post Messages** permission is enabled
2. Send the following command to your bot:

```
/setchannel @your_channel_username
```

Or tap the **📢 Set Channel** button in the main inline menu.

### Step 4 — First scrape

Trigger the first cycle immediately:

```
/forcescrape
```

The bot will start scraping, show live progress, and publish the first config to your channel within a few minutes.

---

## 🎛 Bot commands

### Main controls

| Command | Description |
|---|---|
| `/start` | Open admin menu |
| `/on` | Enable auto-publishing |
| `/off` | Disable auto-publishing |
| `/setchannel @channel` | Set or change the publish channel |
| `/stats` | Overall statistics |
| `/analytics` | 24-hour analytics (best protocol, country, healthy ratio) |
| `/ping` | Bot health check + uptime |

### Source management

| Command | Description |
|---|---|
| `/listsubs` | List current subscription sources |
| `/addsub https://...` | Add a new source |
| `/delsub <id>` | Remove a source |
| `/enablesub <id>` / `/disablesub <id>` | Toggle a source on/off |

### Immediate actions

| Command | Description |
|---|---|
| `/forcescrape` | Run a scrape cycle right now |
| `/forcecheck` | Re-validate the entire queue |
| `/sublink` | Show subscription file links |

---

## ⚙️ Advanced configuration (`.env` file)

The `.env` file is located at `/opt/tg-bot-auto-sender/.env`.  
To edit it:

```bash
sudo nano /opt/tg-bot-auto-sender/.env
sudo systemctl restart tg-bot-auto-sender
```

### Base variables (set automatically during installation)

| Variable | Description |
|---|---|
| `BOT_TOKEN` | Bot token from `@BotFather` |
| `ADMIN_USER_ID` | Numeric admin user ID |

### Optional settings

| Variable | Default | Description |
|---|---|---|
| `PUBLISH_CRON` | `* * * * *` | Publish schedule (every minute) |
| `SCRAPE_CRON` | `*/10 * * * *` | Scrape schedule (every 10 minutes) |
| `LOG_LEVEL` | `info` | Log level: `error`, `warn`, `info`, `debug` |
| `DB_PATH` | `./data/bot.sqlite` | SQLite database path |
| `SUBS_DIR` | `./subs` | Local subscription files directory |

### GitHub auto-publishing (optional)

To make subscription files publicly accessible via GitHub:

| Variable | Description |
|---|---|
| `GITHUB_TOKEN` | Personal Access Token with `repo` scope |
| `GITHUB_REPO` | e.g. `username/v2ray-subs` |
| `GITHUB_BRANCH` | Default: `main` |
| `SUB_DIR` | Subdirectory in repo — default: `subs` |

To create a GitHub token: GitHub → Settings → Developer Settings → Personal Access Tokens → Tokens (classic) → enable `repo` scope.

### Performance settings (auto-detected)

The bot automatically detects server CPU and RAM and sets optimal values:

| Server | Concurrency | Max configs / cycle |
|---|---|---|
| 1 vCPU / 2 GB RAM | 100 | 400 |
| 2 vCPU / 4 GB RAM | 300 | 1,200 |
| 4 vCPU / 8 GB RAM | 600 | 2,500 |
| 8+ vCPU | 1,000 | 5,000 |

To override manually in `.env`:

```env
VALIDATION_CONCURRENCY=300
MAX_CONFIGS_PER_CYCLE=1200
TCP_TIMEOUT_MS=2500
```

---

## 📦 Generated subscription files

After each scrape cycle the following files are created:

| File | Contents |
|---|---|
| `subs/main.txt` | All configs — base64 encoded (standard V2Ray format) |
| `subs/healthy.txt` | All healthy configs — plain text |
| `subs/vless.txt` | VLESS only |
| `subs/vmess.txt` | VMess only |
| `subs/trojan.txt` | Trojan only |
| `subs/ss.txt` | Shadowsocks only |
| `subs/wireguard.txt` | WireGuard only |

---

## 🛠 Service management

```bash
# Status
sudo systemctl status tg-bot-auto-sender

# Live logs
journalctl -u tg-bot-auto-sender -f

# Restart
sudo systemctl restart tg-bot-auto-sender

# Stop
sudo systemctl stop tg-bot-auto-sender
```

### Management panel (optional)

```bash
sudo bash /opt/tg-bot-auto-sender/scripts/install-tgpanel.sh
tgpanel
```

Interactive menu for: update / restart / edit env / backup / logs / uninstall

---

## ❓ Troubleshooting

**Bot is not posting:**
- Open `/start` and check the Auto-send status — if it shows 🔴 OFF, send `/on`
- The bot automatically disables auto-send when it gets a channel error, and sends you a warning DM
- Verify the channel is set correctly with `/setchannel`
- Make sure the bot is an admin in the channel with Post Messages permission
- Queue empty? Run `/forcescrape`

**`EMFILE` error in logs:**

```bash
echo '* soft nofile 65535' | sudo tee -a /etc/security/limits.conf
echo '* hard nofile 65535' | sudo tee -a /etc/security/limits.conf
sudo reboot
```

**Check logs:**

```bash
journalctl -u tg-bot-auto-sender -n 50 --no-pager
```

---

## Local development

```bash
git clone https://github.com/Alirewa/tg-bot-auto-sender.git
cd tg-bot-auto-sender
cp .env.example .env
# Fill in your values
npm ci
npm run build
npm start
```

---

## How it works (pipeline)

```
Subscription Sources (URLs stored in DB)
        ↓
Fetch & Parse configs
        ↓
Deduplicate (SHA-256, permanent)
        ↓
TCP Health Check + GeoIP lookup
        ↓
Rename / brand each config
        ↓
┌──────────────────────────────────────┐
│   Generate Subscription Files        │
│   subs/main.txt  (base64, all)       │
│   subs/vless.txt   subs/vmess.txt    │
│   subs/trojan.txt  subs/ss.txt       │
│   subs/wireguard.txt                 │
└───────────────┬──────────────────────┘
                │
      ┌─────────┴──────────┐
      ↓                    ↓
 GitHub Repo          Telegram Channel
 (auto push)          (1 config / min)
```

---

*Built with Node.js 20 · TypeScript · Telegraf · SQLite · node-cron*
