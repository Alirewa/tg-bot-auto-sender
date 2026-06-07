<div align="center">

# 🤖 tg-bot-auto-sender

> A production-ready Telegram bot that collects, tests, and auto-publishes VPN configs to a Telegram channel — every minute, on autopilot.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Node.js](https://img.shields.io/badge/Node.js-20.x-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![Telegraf](https://img.shields.io/badge/Telegraf-4.x-2CA5E0?style=for-the-badge)](https://telegraf.js.org)
[![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)](LICENSE)

**Protocols:** VLESS · VMess · Trojan · Shadowsocks · WireGuard

**[Demo Channel →](https://t.me/webdwCF)**

</div>

---

## 📋 Table of Contents

- [Overview](#-overview)
- [How It Works](#-how-it-works)
- [Features](#-features)
- [Tech Stack](#-tech-stack)
- [Installation](#-installation)
- [Configuration](#-configuration)
- [Bot Menu](#-bot-menu)
- [Subscription Files](#-subscription-files)
- [Service Management](#-service-management)
- [License](#-license)

---

## 📖 Overview

**tg-bot-auto-sender** is a self-hosted Telegram bot that automates the full VPN config pipeline: scraping → testing → publishing. It scrapes subscription sources, validates each config with a real **xray-core** probe (not just TCP ping), queues the healthy ones, and posts them to your Telegram channel — one per minute, hands-free.

---

## ⚙️ How It Works

1. **Every hour** — downloads and parses all subscription sources
2. **Per config** — runs a TCP probe, then a real **xray-core** handshake test
   - Configs with invalid UUIDs or expired accounts are discarded
3. **Verified configs** enter a queue — one is published to the channel every minute
4. **Subscription files** are generated per protocol after each scrape cycle
5. **Optional** — subscription files can be auto-pushed to a GitHub repo

---

## ✨ Features

- ✅ Real xray-core validation — not just a ping
- ✅ Supports VLESS, VMess, Trojan, Shadowsocks, WireGuard
- ✅ Per-protocol subscription file generation
- ✅ Fully managed via Telegram inline keyboard — no SSH needed after setup
- ✅ Auto-push subscription files to GitHub
- ✅ Health checks on all sources
- ✅ Live analytics: best protocol, country breakdown, healthy ratio
- ✅ One-line install script for Ubuntu 20.04+

---

## 🛠️ Tech Stack

| Technology | Role |
|---|---|
| TypeScript + Node.js 20 | Core bot logic |
| Telegraf | Telegram Bot API framework |
| SQLite | Config queue & stats storage |
| xray-core | Real VPN config validation |
| systemd | Process management on Linux |

---

## 🚀 Installation

One-line install on **Ubuntu 20.04+**:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Alirewa/tg-bot-auto-sender/main/install.sh)
```

The installer automatically sets up: **Node.js 20 · xray-core · git · build tools**

> **You only need to provide during install:**
> - Bot token (from `@BotFather`)
> - Your numeric admin ID (from `@userinfobot`)
>
> Everything else is configured from inside the bot itself.

---

## ⚙️ Configuration

Edit the `.env` file if needed:

```bash
sudo nano /opt/tg-bot-auto-sender/.env
sudo systemctl restart tg-bot-auto-sender
```

### Core Variables

| Variable | Description |
|---|---|
| `BOT_TOKEN` | Telegram bot token |
| `ADMIN_USER_ID` | Your numeric Telegram user ID |
| `PUBLISH_CHANNEL` | Channel username (optional — set via `/setchannel`) |

### Optional Variables

| Variable | Default | Description |
|---|---|---|
| `PUBLISH_CRON` | `* * * * *` | Publish one config per minute |
| `SCRAPE_CRON` | `0 * * * *` | Scrape all sources every hour |
| `MAX_CONFIGS_PER_CYCLE` | `500` | Max configs to test per cycle |
| `LOG_LEVEL` | `info` | Logging verbosity |

### GitHub Auto-Push (Optional)

| Variable | Description |
|---|---|
| `GITHUB_TOKEN` | Personal Access Token (`repo` scope) |
| `GITHUB_REPO` | e.g. `username/v2ray-subs` |
| `GITHUB_BRANCH` | Default: `main` |
| `SUB_DIR` | Subdirectory in repo — default: `subs` |

---

## 🎛️ Bot Menu

All management is done via the `/start` inline keyboard:

| Section | Capabilities |
|---|---|
| **🔍 Scan** | Scrape all or single source · xray test · Clear queue |
| **🔗 Sources** | Add / remove / enable sources · Health check |
| **📊 Stats** | Overall send & validation stats |
| **📈 Analytics** | 24-hour breakdown: best protocol, country, healthy ratio |
| **📡 Sub links** | Subscription file URLs or local paths |
| **🧩 Template** | Config name template (flag · number · channel) |

---

## 📦 Subscription Files

Generated in the `subs/` directory after each scrape:

| File | Content |
|---|---|
| `main.txt` | All configs — base64 encoded (standard format) |
| `healthy.txt` | Verified configs only — plain text |
| `vless.txt` / `vmess.txt` / `trojan.txt` | Per-protocol |
| `ss.txt` / `wireguard.txt` | Per-protocol |

---

## 🛠️ Service Management

```bash
sudo systemctl status tg-bot-auto-sender     # Check status
journalctl -u tg-bot-auto-sender -f          # Live logs
sudo systemctl restart tg-bot-auto-sender    # Restart

# Update
cd /opt/tg-bot-auto-sender && git pull && npm run build && sudo systemctl restart tg-bot-auto-sender
```

---

## 📄 License

Distributed under the **MIT License** — free to use, modify, and distribute.

---

<div align="center">

Made with ❤️ by [Alirewa](https://github.com/Alirewa)

</div>
