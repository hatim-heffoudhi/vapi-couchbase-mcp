#!/usr/bin/env bash
set -euo pipefail

# Fill missing .env secrets, start Couchbase Enterprise + MCP, then print the
# Cloudflare HTTPS URL. Does not print secret values.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! docker info >/dev/null 2>&1; then
  echo "Start Docker Desktop, then retry."
  exit 1
fi

if [[ ! -f .env ]]; then
  cp .env.example .env
fi
if [[ ! -f .vapi-state.json ]]; then
  echo '{}' > .vapi-state.json
fi

python3 - "$ROOT/.env" << 'PY'
import secrets, sys
from pathlib import Path

path = Path(sys.argv[1])
values, order = {}, []
for line in path.read_text().splitlines():
    if not line.strip() or line.lstrip().startswith("#") or "=" not in line:
        order.append(("raw", line))
        continue
    key, val = line.split("=", 1)
    values[key] = val
    order.append(("kv", key))

def empty(key):
    return not str(values.get(key, "")).strip()

if empty("CB_USERNAME"):
    values["CB_USERNAME"] = "Administrator"
if empty("CB_PASSWORD"):
    values["CB_PASSWORD"] = "Cb-" + secrets.token_hex(12)
if empty("MCP_SHARED_TOKEN"):
    values["MCP_SHARED_TOKEN"] = secrets.token_hex(32)
if empty("AGENT_NAME"):
    values["AGENT_NAME"] = "OrderBot"

out, seen = [], set()
for kind, item in order:
    if kind == "raw":
        out.append(item)
        continue
    out.append(f"{item}={values[item]}")
    seen.add(item)
for key, val in values.items():
    if key not in seen:
        out.append(f"{key}={val}")
path.write_text("\n".join(out) + "\n")
PY

echo "Starting Couchbase Enterprise, seeding orders, and Couchbase MCP..."
docker compose up -d

echo "Waiting for http://127.0.0.1:8080/healthz ..."
ok=0
for _ in $(seq 1 90); do
  if curl -sf http://127.0.0.1:8080/healthz >/dev/null; then
    ok=1
    break
  fi
  sleep 4
done
if [[ "$ok" -ne 1 ]]; then
  echo "Stack did not become healthy. Logs:"
  docker compose ps
  docker compose logs --tail=80
  exit 1
fi

echo "Customer shop: http://127.0.0.1:8080/customer"
echo "Supervisor UI: http://127.0.0.1:8080/ui"
echo "How to test:   http://127.0.0.1:8080/howto"
echo "Mail inbox:    http://127.0.0.1:8025"
echo "Couchbase UI:  http://127.0.0.1:8091"
