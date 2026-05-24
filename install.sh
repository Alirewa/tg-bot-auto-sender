#!/usr/bin/env bash
# ============================================================
# tg-bot-auto-sender — One-Line Installer for Ubuntu 20.04+
# Usage:
#   bash <(curl -fsSL https://raw.githubusercontent.com/YOUR_REPO/main/install.sh)
# ============================================================
set -euo pipefail

REPO_URL="${TGBOT_REPO_URL:-https://github.com/Alirewa/tg-bot-auto-sender.git}"
INSTALL_DIR="${TGBOT_DIR:-/opt/tg-bot-auto-sender}"
APP_NAME="tg-bot-auto-sender"
SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"
MIN_NODE_VERSION=20

# ---------- colours ----------
if [ -t 1 ]; then
  RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
  CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; CYAN=''; BOLD=''; RESET=''
fi

info()  { echo -e "${CYAN}[INFO]${RESET}  $*"; }
ok()    { echo -e "${GREEN}[OK]${RESET}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
die()   { echo -e "${RED}[ERROR]${RESET} $*" >&2; exit 1; }

# Redirect all output to /dev/tty so colours appear even when piped.
exec >/dev/tty 2>&1
ask()   {
  # ask VAR_NAME "Prompt text" "default"
  # Reads from /dev/tty so it works even when script is piped from curl.
  local var="$1" prompt="$2" default="${3:-}"
  local hint; hint="${default:+ [${default}]}"
  printf '%s' "${BOLD}${prompt}${hint}: ${RESET}" >/dev/tty
  local _ans; read -r _ans </dev/tty
  printf -v "$var" '%s' "${_ans:-$default}"
}

# ---------- OS check ----------
check_os() {
  if [ ! -f /etc/os-release ]; then
    die "Cannot detect OS. This installer supports Ubuntu 20.04+."
  fi
  # shellcheck source=/dev/null
  . /etc/os-release
  if [[ "${ID:-}" != "ubuntu" ]]; then
    die "This installer requires Ubuntu. Detected: ${ID:-unknown}"
  fi
  local ver_major; ver_major=$(echo "${VERSION_ID:-0}" | cut -d. -f1)
  if [ "$ver_major" -lt 20 ]; then
    die "Ubuntu 20.04+ required. Detected: ${VERSION_ID:-unknown}"
  fi
  ok "OS: Ubuntu ${VERSION_ID}"
}

# ---------- Node.js ----------
install_node() {
  if command -v node >/dev/null 2>&1; then
    local ver; ver=$(node --version | sed 's/v//' | cut -d. -f1)
    if [ "$ver" -ge "$MIN_NODE_VERSION" ]; then
      ok "Node.js $(node --version) already installed"
      return
    fi
    warn "Node.js $(node --version) is too old. Installing Node.js ${MIN_NODE_VERSION}..."
  fi
  info "Installing Node.js ${MIN_NODE_VERSION} via NodeSource..."
  curl -fsSL "https://deb.nodesource.com/setup_${MIN_NODE_VERSION}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
  ok "Node.js $(node --version) installed"
}

# ---------- system deps ----------
install_deps() {
  info "Installing system dependencies..."
  sudo apt-get update -qq
  sudo apt-get install -y --no-install-recommends \
    git build-essential python3 curl ca-certificates
  ok "System dependencies installed"
}

# ---------- clone / update ----------
setup_project() {
  if [ -d "$INSTALL_DIR/.git" ]; then
    info "Updating existing installation at $INSTALL_DIR..."
    git -C "$INSTALL_DIR" fetch --all
    git -C "$INSTALL_DIR" reset --hard origin/main
  else
    info "Cloning repository to $INSTALL_DIR..."
    sudo git clone "$REPO_URL" "$INSTALL_DIR"
    sudo chown -R "$USER:$USER" "$INSTALL_DIR"
  fi
  ok "Source code ready at $INSTALL_DIR"
}

# ---------- interactive setup wizard ----------
setup_env() {
  local env_file="$INSTALL_DIR/.env"
  local example="$INSTALL_DIR/.env.example"

  echo
  echo -e "${BOLD}${CYAN}══════════════════════════════════════════${RESET}"
  echo -e "${BOLD}         Setup Wizard — Enter Values         ${RESET}"
  echo -e "${BOLD}${CYAN}══════════════════════════════════════════${RESET}"
  echo

  ask BOT_TOKEN      "Telegram Bot Token (from @BotFather)"   ""
  ask ADMIN_USER_ID  "Admin User ID (from @userinfobot)"      ""
  ask PUBLISH_CHANNEL "Publish Channel (e.g. @mychannel)"    "@mychannel"
  ask SCRAPE_CRON    "Scrape interval (cron)"                 "*/10 * * * *"
  ask PUBLISH_CRON   "Publish interval (cron)"                "* * * * *"
  echo
  info "GitHub auto-publishing (press Enter to skip):"
  ask GITHUB_TOKEN   "GitHub Token (leave blank to skip)"     ""
  ask GITHUB_REPO    "GitHub Repo (e.g. user/v2ray-subs)"    ""
  ask LOG_LEVEL      "Log level (error|warn|info|debug)"      "info"

  # Validate mandatory fields
  [ -z "$BOT_TOKEN" ]       && die "BOT_TOKEN is required"
  [ -z "$ADMIN_USER_ID" ]   && die "ADMIN_USER_ID is required"
  [ -z "$PUBLISH_CHANNEL" ] && die "PUBLISH_CHANNEL is required"

  # Write .env from example, substituting values
  if [ -f "$example" ]; then
    cp "$example" "$env_file"
  else
    touch "$env_file"
  fi

  # set_env KEY VALUE — adds or replaces a KEY=VALUE line in the .env file.
  # Uses a Python one-liner to avoid shell-escaping nightmares with cron strings
  # that contain *, /, spaces, etc.
  set_env() {
    local key="$1" val="$2"
    python3 - "$env_file" "$key" "$val" <<'PYEOF'
import sys, re
path, key, val = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as f: lines = f.readlines()
pattern = re.compile(r'^#?\s*' + re.escape(key) + r'\s*=')
replaced = False
out = []
for line in lines:
    if pattern.match(line):
        out.append(f'{key}={val}\n')
        replaced = True
    else:
        out.append(line)
if not replaced:
    out.append(f'{key}={val}\n')
with open(path, 'w') as f: f.writelines(out)
PYEOF
  }

  set_env BOT_TOKEN       "$BOT_TOKEN"
  set_env ADMIN_USER_ID   "$ADMIN_USER_ID"
  set_env PUBLISH_CHANNEL "$PUBLISH_CHANNEL"
  set_env SCRAPE_CRON     "$SCRAPE_CRON"
  set_env PUBLISH_CRON    "$PUBLISH_CRON"
  set_env LOG_LEVEL       "$LOG_LEVEL"
  [ -n "$GITHUB_TOKEN" ] && set_env GITHUB_TOKEN "$GITHUB_TOKEN"
  [ -n "$GITHUB_REPO" ]  && set_env GITHUB_REPO  "$GITHUB_REPO"

  chmod 600 "$env_file"
  ok ".env written to $env_file"
}

# ---------- build ----------
build_project() {
  info "Installing npm dependencies..."
  npm ci --prefix "$INSTALL_DIR" --no-audit --no-fund
  info "Building TypeScript..."
  npm run build --prefix "$INSTALL_DIR"
  ok "Build complete"
}

# ---------- systemd service ----------
install_service() {
  local svc_template="$INSTALL_DIR/scripts/tgbot.service"
  local user_name; user_name=$(whoami)

  if [ -f "$svc_template" ]; then
    sudo sed \
      -e "s|__INSTALL_DIR__|${INSTALL_DIR}|g" \
      -e "s|__USER__|${user_name}|g" \
      -e "s|__NODE_PATH__|$(command -v node)|g" \
      "$svc_template" | sudo tee "$SERVICE_FILE" > /dev/null
  else
    # Inline fallback if template is missing
    sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=tg-bot-auto-sender VPN aggregation bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${user_name}
WorkingDirectory=${INSTALL_DIR}
ExecStart=$(command -v node) dist/index.js
Restart=on-failure
RestartSec=10
EnvironmentFile=${INSTALL_DIR}/.env
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${APP_NAME}

[Install]
WantedBy=multi-user.target
EOF
  fi

  sudo systemctl daemon-reload
  sudo systemctl enable "$APP_NAME"
  sudo systemctl restart "$APP_NAME"

  ok "systemd service installed and started"
}

# ---------- finish ----------
print_summary() {
  echo
  echo -e "${BOLD}${GREEN}══════════════════════════════════════════${RESET}"
  echo -e "${BOLD}${GREEN}   ✅  Installation complete!              ${RESET}"
  echo -e "${BOLD}${GREEN}══════════════════════════════════════════${RESET}"
  echo
  echo -e "  ${BOLD}Status:${RESET}  sudo systemctl status ${APP_NAME}"
  echo -e "  ${BOLD}Logs:${RESET}    journalctl -u ${APP_NAME} -f"
  echo -e "  ${BOLD}Restart:${RESET} sudo systemctl restart ${APP_NAME}"
  echo -e "  ${BOLD}Stop:${RESET}    sudo systemctl stop ${APP_NAME}"
  echo -e "  ${BOLD}Panel:${RESET}   tgpanel   (if install-tgpanel.sh was run)"
  echo
  echo -e "  The bot will post the first config within ~1 minute."
  echo
}

# ---------- main ----------
main() {
  echo
  echo -e "${BOLD}${CYAN}tg-bot-auto-sender — Installer${RESET}"
  echo

  check_os
  install_deps
  install_node
  setup_project
  setup_env
  build_project
  install_service
  print_summary
}

main
