#!/usr/bin/env bash
set -euo pipefail

cd /home/anttonalberdi/rejsudai-bot

# Load RECEIPTS_INBOX from .env if present
RECEIPTS_INBOX="${RECEIPTS_INBOX:-/home/anttonalberdi/macos_shared/receipts-inbox}"
if [ -f .env ]; then
  INBOX_FROM_ENV=$(grep -E '^RECEIPTS_INBOX=' .env | cut -d= -f2- | tr -d '"' | tr -d "'" || true)
  if [ -n "${INBOX_FROM_ENV:-}" ]; then
    RECEIPTS_INBOX="$INBOX_FROM_ENV"
  fi
fi

echo "Scanning inbox: $RECEIPTS_INBOX"

# Every settlement folder directly inside the inbox that holds something to file
pending=()
while IFS= read -r -d '' dir; do
  basename=$(basename "$dir")
  case "$basename" in .*) continue ;; esac
  if find "$dir" -maxdepth 1 -type f \
       \( -iname '*.pdf' -o -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.heic' \) \
       -print -quit 2>/dev/null | grep -q .; then
    pending+=("$basename")
  fi
done < <(find "$RECEIPTS_INBOX" -mindepth 1 -maxdepth 1 -type d -print0 2>/dev/null || true)

if [ ${#pending[@]} -eq 0 ]; then
  echo ""
  echo "No pending settlements found in $RECEIPTS_INBOX"
  echo ""
  echo "Press Enter to close..."
  read -r
  exit 0
fi

echo ""
echo "Found ${#pending[@]} pending settlement(s):"
for folder in "${pending[@]}"; do
  echo "  - $folder"
done
echo ""

for folder in "${pending[@]}"; do
  echo "========================================="
  echo "Processing: $folder"
  echo "========================================="
  node bot.js "$folder" || echo "WARNING: $folder exited with error $?"
  echo ""
done

echo "========================================="
echo "All done. Press Enter to close..."
read -r
