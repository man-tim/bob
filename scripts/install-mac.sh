#!/bin/bash
# B.O.B. — Mac First-Launch Setup
# ─────────────────────────────────────────────────────────────────────────────
# Run this script once after downloading B.O.B. for the first time.
# It removes the macOS quarantine flag that causes the "app is damaged" error.
#
# Usage (paste into Terminal):
#   curl -fsSL https://raw.githubusercontent.com/man-tim/bob/main/scripts/install-mac.sh | bash
#
# Or, if you already have the .dmg / .app:
#   bash install-mac.sh
# ─────────────────────────────────────────────────────────────────────────────

APP_NAME="B.O.B"
APP_BUNDLE="${APP_NAME}.app"

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║   B.O.B. — Mac Setup                 ║"
echo "  ╚══════════════════════════════════════╝"
echo ""

# ── Search for the app in common locations ────────────────────────────────────
APP_PATH=""
SEARCH_DIRS=(
  "/Applications"
  "$HOME/Applications"
  "$HOME/Desktop"
  "$HOME/Downloads"
  "$HOME/Desktop/Claude Apps/csm-master-tool/dist/mac-arm64"
)

for DIR in "${SEARCH_DIRS[@]}"; do
  CANDIDATE="${DIR}/${APP_BUNDLE}"
  if [ -d "$CANDIDATE" ]; then
    APP_PATH="$CANDIDATE"
    break
  fi
done

# ── If not found, ask the user to drag it here ────────────────────────────────
if [ -z "$APP_PATH" ]; then
  echo "  Could not find '${APP_BUNDLE}' automatically."
  echo ""
  echo "  Please drag the B.O.B. app onto this Terminal window and press Enter:"
  read -rp "  App path: " DRAGGED_PATH
  # Strip quotes and whitespace that Finder adds on drag-drop
  DRAGGED_PATH="${DRAGGED_PATH//\'/}"
  DRAGGED_PATH="${DRAGGED_PATH// /\\ }"
  DRAGGED_PATH=$(echo "$DRAGGED_PATH" | sed "s/^ //;s/ $//")
  if [ -d "$DRAGGED_PATH" ]; then
    APP_PATH="$DRAGGED_PATH"
  else
    echo ""
    echo "  ✗  Path not found: $DRAGGED_PATH"
    echo "     Make sure B.O.B.app is in /Applications and try again."
    echo ""
    exit 1
  fi
fi

echo "  Found: $APP_PATH"
echo ""

# ── Remove quarantine + extended attributes ───────────────────────────────────
echo "  Removing macOS quarantine flag (you may be prompted for your password)..."
echo ""

if sudo xattr -cr "$APP_PATH"; then
  echo ""
  echo "  ✓  Done! B.O.B. will now open without the security warning."
  echo ""

  # ── Optionally move to /Applications ─────────────────────────────────────
  if [[ "$APP_PATH" != /Applications/* ]]; then
    echo "  Move B.O.B. to /Applications? (recommended) [y/N]"
    read -rp "  → " MOVE_CHOICE
    if [[ "$MOVE_CHOICE" =~ ^[Yy]$ ]]; then
      if cp -R "$APP_PATH" "/Applications/${APP_BUNDLE}"; then
        APP_PATH="/Applications/${APP_BUNDLE}"
        # Strip quarantine from the copy too
        sudo xattr -cr "$APP_PATH" 2>/dev/null
        echo "  ✓  Moved to /Applications."
      else
        echo "  ✗  Could not copy to /Applications. You can move it manually."
      fi
    fi
  fi

  echo ""
  echo "  Opening B.O.B...."
  open "$APP_PATH"

else
  echo ""
  echo "  ✗  Could not remove the quarantine flag automatically."
  echo ""
  echo "  Try running this command manually in Terminal:"
  echo "     sudo xattr -cr \"${APP_PATH}\""
  echo ""
  echo "  Or right-click the app in Finder → Open → Open (click twice)."
  echo ""
  exit 1
fi

echo ""
