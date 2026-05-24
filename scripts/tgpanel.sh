#!/usr/bin/env bash
# tgpanel - control panel for tg-bot-auto-sender
# Install:
#   sudo bash /opt/tg-bot-auto-sender/scripts/install-tgpanel.sh
# Then run anywhere:
#   tgpanel

set -u

# ---------- resolve project dir ----------
PROJECT_DIR="${TGBOT_DIR:-/opt/tg-bot-auto-sender}"
APP_NAME="tg-bot-auto-sender"
REPO_URL="https://github.com/Alirewa/tg-bot-auto-sender.git"

# ---------- colors ----------
if [ -t 1 ]; then
  C_RESET="$(printf '\033[0m')"
  C_BOLD="$(printf '\033[1m')"
  C_CYAN="$(printf '\033[36m')"
  C_GREEN="$(printf '\033[32m')"
  C_YEL="$(printf '\033[33m')"
  C_RED="$(printf '\033[31m')"
  C_DIM="$(printf '\033[2m')"
else
  C_RESET=""; C_BOLD=""; C_CYAN=""; C_GREEN=""; C_YEL=""; C_RED=""; C_DIM=""
fi

# ---------- helpers ----------
die()  { echo "${C_RED}[X] $*${C_RESET}" >&2; exit 1; }
note() { echo "${C_CYAN}[>] $*${C_RESET}"; }
ok()   { echo "${C_GREEN}[OK] $*${C_RESET}"; }
warn() { echo "${C_YEL}[!] $*${C_RESET}"; }

pause() { echo; read -rp "$(printf '%sPress Enter to continue...%s' "$C_DIM" "$C_RESET")" _; }

confirm() {
  local prompt="${1:-Are you sure?} [y/N]: "
  read -rp "$prompt" ans
  case "$ans" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

need_dir() {
  [ -d "$PROJECT_DIR" ] || die "Project not found at $PROJECT_DIR (set TGBOT_DIR to override)"
}

run_in_project() {
  cd "$PROJECT_DIR" || die "Cannot cd $PROJECT_DIR"
  "$@"
}

# ---------- runtime detection (systemd or pm2) ----------
using_systemd() {
  systemctl list-units --type=service 2>/dev/null | grep -q "${APP_NAME}.service"
}

pm2_running() {
  command -v pm2 >/dev/null 2>&1 && pm2 jlist 2>/dev/null | grep -q "\"name\":\"$APP_NAME\""
}

# ---------- actions ----------
action_status() {
  note "Service status:"
  if using_systemd; then
    systemctl status "$APP_NAME" --no-pager 2>/dev/null || true
  elif command -v pm2 >/dev/null 2>&1; then
    pm2 status || true
  else
    warn "Neither systemd service nor pm2 found."
  fi
  echo
  if [ -d "$PROJECT_DIR" ]; then
    note "Latest commit:"
    run_in_project git --no-pager log -1 --pretty=format:'%h  %ad  %s%n' --date=short 2>/dev/null \
      || warn "git history unavailable"
  fi
  pause
}

action_logs() {
  if using_systemd; then
    note "Live logs (Ctrl+C to exit)..."
    journalctl -u "$APP_NAME" -f --no-pager 2>/dev/null || warn "journalctl unavailable"
  elif command -v pm2 >/dev/null 2>&1; then
    note "Live logs (Ctrl+C to exit)..."
    pm2 logs "$APP_NAME" --lines 50 || true
  else
    warn "No log backend found."; pause
  fi
}

action_restart() {
  need_dir
  if using_systemd; then
    sudo systemctl restart "$APP_NAME"
    ok "Bot restarted (systemd)."
  elif pm2_running; then
    pm2 restart "$APP_NAME"
    ok "Bot restarted (pm2)."
  else
    warn "Bot not found in systemd or PM2. Starting via pm2..."
    run_in_project pm2 start ecosystem.config.js
    pm2 save || true
  fi
  pause
}

action_stop() {
  if using_systemd; then
    sudo systemctl stop "$APP_NAME"
    ok "Bot stopped (systemd)."
  elif pm2_running; then
    pm2 stop "$APP_NAME"
    ok "Bot stopped (pm2)."
  else
    warn "Bot is not running."
  fi
  pause
}

action_start() {
  need_dir
  if using_systemd; then
    sudo systemctl start "$APP_NAME"
    ok "Bot started (systemd)."
  elif pm2_running; then
    pm2 restart "$APP_NAME"
    ok "Bot restarted (pm2)."
  else
    run_in_project pm2 start ecosystem.config.js
    pm2 save || true
    ok "Bot started (pm2)."
  fi
  pause
}

action_update() {
  need_dir
  note "git fetch + reset --hard origin/main..."
  run_in_project git fetch --all || die "git fetch failed"
  run_in_project git reset --hard origin/main || die "git reset failed"
  note "Clearing old build (dist/)..."
  rm -rf "$PROJECT_DIR/dist"
  note "npm ci..."
  run_in_project npm ci --no-audit --no-fund || die "npm ci failed"
  note "npm run build..."
  run_in_project npm run build || die "build failed"
  if using_systemd; then
    sudo systemctl restart "$APP_NAME"
    ok "Update complete and bot restarted (systemd)."
  elif pm2_running; then
    pm2 restart "$APP_NAME" --update-env
    ok "Update complete and bot restarted (pm2)."
  else
    warn "Bot was not running; starting via pm2..."
    run_in_project pm2 start ecosystem.config.js
    pm2 save || true
  fi
  pause
}

action_edit_env() {
  need_dir
  local env="$PROJECT_DIR/.env"
  if [ ! -f "$env" ]; then
    if [ -f "$PROJECT_DIR/.env.example" ]; then
      cp "$PROJECT_DIR/.env.example" "$env"
      ok ".env created from .env.example"
    else
      die ".env and .env.example are both missing."
    fi
  fi
  ${EDITOR:-nano} "$env"
  if confirm "Restart the bot now to apply changes?"; then
    if using_systemd; then
      sudo systemctl restart "$APP_NAME"; ok "Restarted (systemd)."
    elif pm2_running; then
      pm2 restart "$APP_NAME"; ok "Restarted (pm2)."
    fi
  fi
  pause
}

action_backup_db() {
  need_dir
  local src="$PROJECT_DIR/data/bot.sqlite"
  if [ ! -f "$src" ]; then
    warn "Database file does not exist yet: $src"; pause; return
  fi
  local dir="${HOME}/tgbot-backups"
  mkdir -p "$dir"
  local dst="$dir/bot-$(date +%F-%H%M%S).sqlite"
  cp "$src" "$dst"
  ok "Backup saved to: $dst"
  pause
}

action_show_subs() {
  need_dir
  local subs_dir="$PROJECT_DIR/subs"
  echo
  note "Subscription files in: ${subs_dir}"
  echo
  if [ ! -d "$subs_dir" ]; then
    warn "subs/ directory not found. Run a scrape cycle first (/forcescrape in bot)."
    pause; return
  fi
  for f in main.txt healthy.txt vless.txt vmess.txt trojan.txt ss.txt wireguard.txt; do
    local path="$subs_dir/$f"
    if [ -f "$path" ]; then
      local size; size=$(wc -c < "$path" 2>/dev/null || echo "?")
      local lines; lines=$(wc -l < "$path" 2>/dev/null || echo "?")
      printf "  ${C_GREEN}%-18s${C_RESET} %6d bytes  %4d lines\n" "$f" "$size" "$lines"
    else
      printf "  ${C_DIM}%-18s  (not generated yet)${C_RESET}\n" "$f"
    fi
  done
  echo
  # Show GitHub URLs if configured
  local env_file="$PROJECT_DIR/.env"
  if [ -f "$env_file" ]; then
    local gh_repo; gh_repo=$(grep '^GITHUB_REPO=' "$env_file" | cut -d= -f2- | tr -d '"' | xargs)
    local gh_branch; gh_branch=$(grep '^GITHUB_BRANCH=' "$env_file" | cut -d= -f2- | tr -d '"' | xargs)
    local sub_dir; sub_dir=$(grep '^SUB_DIR=' "$env_file" | cut -d= -f2- | tr -d '"' | xargs)
    gh_branch="${gh_branch:-main}"; sub_dir="${sub_dir:-subs}"
    if [ -n "$gh_repo" ]; then
      note "GitHub raw base URL:"
      echo "  https://raw.githubusercontent.com/${gh_repo}/${gh_branch}/${sub_dir}/"
      echo
      note "Paste as subscription link in v2rayN / Clash / Hiddify:"
      echo "  https://raw.githubusercontent.com/${gh_repo}/${gh_branch}/${sub_dir}/main.txt"
    else
      warn "GITHUB_REPO not set. Local files only."
    fi
  fi
  pause
}

action_install() {
  if [ -d "$PROJECT_DIR" ]; then
    warn "$PROJECT_DIR already exists."
    pause; return
  fi
  note "Cloning $REPO_URL -> $PROJECT_DIR"
  sudo git clone "$REPO_URL" "$PROJECT_DIR" || die "clone failed"
  sudo chown -R "$USER:$USER" "$PROJECT_DIR"
  cp "$PROJECT_DIR/.env.example" "$PROJECT_DIR/.env"
  warn "Now edit .env using option 7."
  cd "$PROJECT_DIR" && npm ci && npm run build || die "build failed"
  ok "Base install done. Use option 4 to start the bot."
  pause
}

action_uninstall() {
  warn "This will completely remove the project:"
  echo "  - Stop and delete service: $APP_NAME"
  echo "  - Remove directory: $PROJECT_DIR (including data and logs)"
  echo "  - Remove symlink: /usr/local/bin/tgpanel"
  if ! confirm "Continue?"; then
    note "Aborted."; pause; return
  fi
  if confirm "Backup the database first?"; then
    action_backup_db
  fi
  if using_systemd; then
    sudo systemctl stop "$APP_NAME" 2>/dev/null || true
    sudo systemctl disable "$APP_NAME" 2>/dev/null || true
    sudo rm -f "/etc/systemd/system/${APP_NAME}.service"
    sudo systemctl daemon-reload
    ok "systemd service removed."
  fi
  if pm2_running; then
    pm2 delete "$APP_NAME" || true
    pm2 save || true
    ok "pm2 app removed."
  fi
  if [ -d "$PROJECT_DIR" ]; then
    sudo rm -rf "$PROJECT_DIR"
    ok "Project directory removed."
  fi
  if [ -L /usr/local/bin/tgpanel ]; then
    sudo rm -f /usr/local/bin/tgpanel
    ok "tgpanel symlink removed."
  fi
  ok "Uninstall complete."
  exit 0
}

action_pm2_save() {
  if command -v pm2 >/dev/null 2>&1; then
    pm2 save
    ok "pm2 process list saved."
  else
    warn "pm2 is not installed."
  fi
  pause
}

action_open_shell() {
  need_dir
  cd "$PROJECT_DIR" || die
  note "Opening shell in $PROJECT_DIR (type 'exit' to leave)"
  "${SHELL:-/bin/bash}"
}

# ---------- main menu ----------
menu() {
  clear
  cat <<EOF
${C_BOLD}${C_CYAN}===============================================
        tgpanel - bot control panel
===============================================${C_RESET}
${C_DIM}Project dir: $PROJECT_DIR${C_RESET}

  ${C_BOLD}1)${C_RESET}  Status (systemd/pm2 + last commit)
  ${C_BOLD}2)${C_RESET}  Live logs
  ${C_BOLD}3)${C_RESET}  Restart bot
  ${C_BOLD}4)${C_RESET}  Start bot
  ${C_BOLD}5)${C_RESET}  Stop bot
  ${C_BOLD}6)${C_RESET}  Update from GitHub (pull + build + restart)
  ${C_BOLD}7)${C_RESET}  Edit .env
  ${C_BOLD}8)${C_RESET}  Backup database
  ${C_BOLD}9)${C_RESET}  Show subscription files & links
 ${C_BOLD}10)${C_RESET}  pm2 save
 ${C_BOLD}11)${C_RESET}  Open shell in project dir
 ${C_BOLD}12)${C_RESET}  Fresh install (clone + build)
 ${C_BOLD}13)${C_RESET}  ${C_RED}Uninstall (remove project)${C_RESET}
  ${C_BOLD}0)${C_RESET}  Exit

EOF
  read -rp "Choice: " choice
  case "$choice" in
    1)  action_status ;;
    2)  action_logs ;;
    3)  action_restart ;;
    4)  action_start ;;
    5)  action_stop ;;
    6)  action_update ;;
    7)  action_edit_env ;;
    8)  action_backup_db ;;
    9)  action_show_subs ;;
    10) action_pm2_save ;;
    11) action_open_shell ;;
    12) action_install ;;
    13) action_uninstall ;;
    0|q|Q) exit 0 ;;
    *) warn "Invalid choice"; sleep 1 ;;
  esac
}

while true; do
  menu
done
