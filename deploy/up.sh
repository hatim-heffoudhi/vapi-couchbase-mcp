#!/usr/bin/env bash
set -euo pipefail

# One command: Docker stack + Cloudflare tunnel + Vapi OrderBot.
# Does not print .env secret values.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "Install cloudflared, then retry."
  exit 1
fi

bash "$ROOT/deploy/local-up.sh"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh"
  nvm use 18 >/dev/null
fi

LOG="$(mktemp -t vapi-tunnel.XXXXXX)"
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8080 >"$LOG" 2>&1 &
CF_PID=$!

cleanup() {
  kill "$CF_PID" 2>/dev/null || true
  wait "$CF_PID" 2>/dev/null || true
  rm -f "$LOG"
  echo "Stopping Docker containers..."
  docker compose down
}
trap cleanup EXIT INT TERM

TUNNEL=""
for _ in $(seq 1 60); do
  if ! kill -0 "$CF_PID" 2>/dev/null; then
    echo "Cloudflare tunnel exited. Last log lines:"
    tail -n 40 "$LOG"
    exit 1
  fi
  TUNNEL="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -n 1 || true)"
  if [[ -n "$TUNNEL" ]]; then
    break
  fi
  sleep 1
done

if [[ -z "$TUNNEL" ]]; then
  echo "Cloudflare tunnel URL did not appear. Last log lines:"
  tail -n 40 "$LOG"
  exit 1
fi

echo "Public URL: $TUNNEL"
npm run agent -- create --mcp-url "$TUNNEL/mcp" --replace

echo
echo "Keep this terminal open. Ctrl+C stops the tunnel and Docker containers."
echo "Customer shop: http://127.0.0.1:8080/customer"
echo "Supervisor UI: http://127.0.0.1:8080/ui"
echo "How to test:   http://127.0.0.1:8080/howto"
echo "Mail inbox:    http://127.0.0.1:8025"
wait "$CF_PID"
