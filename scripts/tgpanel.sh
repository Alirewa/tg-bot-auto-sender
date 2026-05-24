#!/usr/bin/env bash
# tgpanel — control panel for tg-bot-auto-sender
# Install:
#   sudo ln -sf /opt/tg-bot-auto-sender/scripts/tgpanel.sh /usr/local/bin/tgpanel
#   sudo chmod +x /opt/tg-bot-auto-sender/scripts/tgpanel.sh
# Then just run:  tgpanel

set -u

# ---------- resolve project dir ----------
# Default: /opt/tg-bot-auto-sender. Override with TGBOT_DIR env.
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
die()  { echo "${C_RED}✗ $*${C_RESET}" >&2; exit 1; }
note() { echo "${C_CYAN}» $*${C_RESET}"; }
ok()   { echo "${C_GREEN}✓ $*${C_RESET}"; }
warn() { echo "${C_YEL}! $*${C_RESET}"; }

pause() { echo; read -rp "$(printf '%sEnter to continue...%s' "$C_DIM" "$C_RESET")" _; }

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

pm2_running() {
  command -v pm2 >/dev/null 2>&1 && pm2 jlist 2>/dev/null | grep -q "\"name\":\"$APP_NAME\""
}

# ---------- actions ----------
action_status() {
  note "وضعیت PM2:"
  if command -v pm2 >/dev/null 2>&1; then
    pm2 status || true
  else
    warn "pm2 نصب نیست."
  fi
  echo
  if [ -d "$PROJECT_DIR" ]; then
    note "آخرین commit:"
    run_in_project git --no-pager log -1 --pretty=format:'%h  %ad  %s%n' --date=short 2>/dev/null || warn "git history در دسترس نیست"
  fi
  pause
}

action_logs() {
  if ! command -v pm2 >/dev/null 2>&1; then warn "pm2 نصب نیست."; pause; return; fi
  note "لاگ زنده (Ctrl+C برای خروج)..."
  pm2 logs "$APP_NAME" --lines 50 || true
}

action_restart() {
  need_dir
  if pm2_running; then
    pm2 restart "$APP_NAME"
    ok "ربات restart شد."
  else
    warn "ربات در PM2 پیدا نشد. در حال start..."
    run_in_project pm2 start ecosystem.config.js
    pm2 save || true
  fi
  pause
}

action_stop() {
  if pm2_running; then
    pm2 stop "$APP_NAME"
    ok "ربات stop شد."
  else
    warn "ربات اجرا نیست."
  fi
  pause
}

action_start() {
  need_dir
  if pm2_running; then
    pm2 restart "$APP_NAME"
  else
    run_in_project pm2 start ecosystem.config.js
    pm2 save || true
  fi
  ok "ربات start شد."
  pause
}

action_update() {
  need_dir
  note "git pull..."
  run_in_project git pull --rebase || die "git pull failed"
  note "npm ci..."
  run_in_project npm ci --no-audit --no-fund || die "npm ci failed"
  note "npm run build..."
  run_in_project npm run build || die "build failed"
  if pm2_running; then
    pm2 restart "$APP_NAME"
    ok "آپدیت کامل و ربات restart شد."
  else
    warn "ربات اجرا نبود؛ با pm2 start شروع می‌کنم..."
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
      ok ".env از روی .env.example ساخته شد."
    else
      die ".env و .env.example هیچ‌کدام وجود ندارند."
    fi
  fi
  ${EDITOR:-nano} "$env"
  if confirm "ربات restart شود تا تغییرات اعمال شود؟"; then
    if pm2_running; then pm2 restart "$APP_NAME"; ok "restart شد."; fi
  fi
  pause
}

action_backup_db() {
  need_dir
  local src="$PROJECT_DIR/data/bot.sqlite"
  [ -f "$src" ] || { warn "دیتابیس هنوز ساخته نشده: $src"; pause; return; }
  local dir="${HOME}/tgbot-backups"
  mkdir -p "$dir"
  local dst="$dir/bot-$(date +%F-%H%M%S).sqlite"
  cp "$src" "$dst"
  ok "Backup گرفته شد: $dst"
  pause
}

action_install() {
  if [ -d "$PROJECT_DIR" ]; then
    warn "$PROJECT_DIR از قبل وجود دارد."
    pause; return
  fi
  note "Cloning $REPO_URL → $PROJECT_DIR"
  sudo git clone "$REPO_URL" "$PROJECT_DIR" || die "clone failed"
  sudo chown -R "$USER:$USER" "$PROJECT_DIR"
  cp "$PROJECT_DIR/.env.example" "$PROJECT_DIR/.env"
  warn "حالا .env را با گزینه ۵ ویرایش کنید."
  cd "$PROJECT_DIR" && npm ci && npm run build || die "build failed"
  ok "نصب پایه انجام شد. با گزینه ۴ start کنید."
  pause
}

action_uninstall() {
  warn "این عملیات کاملاً پروژه را حذف می‌کند:"
  echo "  - متوقف و حذف pm2 app: $APP_NAME"
  echo "  - حذف پوشه: $PROJECT_DIR (شامل data و logs)"
  echo "  - حذف symlink: /usr/local/bin/tgpanel"
  if ! confirm "ادامه می‌دهید؟"; then
    note "لغو شد."; pause; return
  fi
  if confirm "آیا قبل از حذف از دیتابیس backup گرفته شود؟"; then
    action_backup_db
  fi
  if pm2_running; then
    pm2 delete "$APP_NAME" || true
    pm2 save || true
  fi
  if [ -d "$PROJECT_DIR" ]; then
    sudo rm -rf "$PROJECT_DIR"
    ok "پوشه پروژه حذف شد."
  fi
  if [ -L /usr/local/bin/tgpanel ]; then
    sudo rm -f /usr/local/bin/tgpanel
    ok "symlink tgpanel حذف شد."
  fi
  ok "حذف کامل انجام شد."
  exit 0
}

action_pm2_save() {
  if command -v pm2 >/dev/null 2>&1; then
    pm2 save
    ok "pm2 process list ذخیره شد."
  else
    warn "pm2 نصب نیست."
  fi
  pause
}

action_open_shell() {
  need_dir
  cd "$PROJECT_DIR" || die
  note "ورود به shell در $PROJECT_DIR (با exit خارج شو)"
  "${SHELL:-/bin/bash}"
}

# ---------- main menu ----------
menu() {
  clear
  cat <<EOF
${C_BOLD}${C_CYAN}╔══════════════════════════════════════════╗
║          tgpanel — کنترل پنل ربات         ║
╚══════════════════════════════════════════╝${C_RESET}
${C_DIM}مسیر پروژه: $PROJECT_DIR${C_RESET}

  ${C_BOLD}1)${C_RESET} 📊 وضعیت ربات و آخرین commit
  ${C_BOLD}2)${C_RESET} 📜 نمایش لاگ زنده
  ${C_BOLD}3)${C_RESET} ♻️  Restart ربات
  ${C_BOLD}4)${C_RESET} ▶️  Start ربات
  ${C_BOLD}5)${C_RESET} ⏸  Stop ربات
  ${C_BOLD}6)${C_RESET} ⬆️  آپدیت از GitHub (pull + build + restart)
  ${C_BOLD}7)${C_RESET} ✏️  ویرایش فایل .env
  ${C_BOLD}8)${C_RESET} 💾 Backup دیتابیس
  ${C_BOLD}9)${C_RESET} 💿 ذخیره لیست pm2 (pm2 save)
 ${C_BOLD}10)${C_RESET} 🖥  باز کردن shell در پوشه‌ی پروژه
 ${C_BOLD}11)${C_RESET} 📥 نصب پروژه از صفر (clone + build)
 ${C_BOLD}12)${C_RESET} ${C_RED}🗑  حذف کامل پروژه از سرور${C_RESET}
  ${C_BOLD}0)${C_RESET} ❌ خروج

EOF
  read -rp "انتخاب: " choice
  case "$choice" in
    1) action_status ;;
    2) action_logs ;;
    3) action_restart ;;
    4) action_start ;;
    5) action_stop ;;
    6) action_update ;;
    7) action_edit_env ;;
    8) action_backup_db ;;
    9) action_pm2_save ;;
    10) action_open_shell ;;
    11) action_install ;;
    12) action_uninstall ;;
    0|q|Q) exit 0 ;;
    *) warn "گزینه نامعتبر"; sleep 1 ;;
  esac
}

while true; do
  menu
done
