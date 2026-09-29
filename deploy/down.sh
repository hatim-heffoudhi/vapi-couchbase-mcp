#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

pkill -f 'cloudflared tunnel' 2>/dev/null || true
docker compose down
echo "Stack stopped."
