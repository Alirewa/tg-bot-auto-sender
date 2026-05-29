#!/usr/bin/env bash
# Quick installer for the `tgsender` shell command.
# Usage (from inside the project dir):
#   sudo bash scripts/install-tgsender.sh
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
chmod +x "$SCRIPT_DIR/tgsender.sh"
ln -sf "$SCRIPT_DIR/tgsender.sh" /usr/local/bin/tgsender
echo "✓ tgsender installed. Type 'tgsender' anywhere to open the control panel."
