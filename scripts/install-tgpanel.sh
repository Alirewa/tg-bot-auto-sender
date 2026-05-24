#!/usr/bin/env bash
# Quick installer for the `tgpanel` shell command.
# Usage (from inside the project dir):
#   sudo bash scripts/install-tgpanel.sh
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
chmod +x "$SCRIPT_DIR/tgpanel.sh"
ln -sf "$SCRIPT_DIR/tgpanel.sh" /usr/local/bin/tgpanel
echo "✓ tgpanel installed. Type 'tgpanel' anywhere to open the control panel."
