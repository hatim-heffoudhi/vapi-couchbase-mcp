# Vapi voice agent with Couchbase MCP

Local demo: a customer shop writes orders into **Couchbase Enterprise**. **Jack** (one Vapi voice assistant) verifies the caller with an email OTP, looks up orders through **Couchbase MCP**, and can cancel or request a delivery-date change. Late cancels and date changes wait for a human on the supervisor desk. Vapi never talks to `localhost`; a Cloudflare tunnel exposes HTTPS.

```
Shop /customer  →  JSON order in order-demo._default.orders
Call Jack       →  OTP once per call  →  Couchbase MCP lookup
Cancel / date   →  processing < 6h cancels now
                →  processing > 6h needs Supervisor Accept
                →  shipped: date only   delivered: locked
Supervisor /ui  →  Accept / Reject  →  Couchbase + email  →  shop updates
```

## Prerequisites

Install these before the first run:

| Need | Why |
| --- | --- |
| [Docker Desktop](https://www.docker.com/products/docker-desktop/) | Couchbase Enterprise, MCP, Mailpit, Caddy, shop API |
| [Node.js 18+](https://nodejs.org/) (`nvm use` reads `.nvmrc`) | Creates/updates Jack on your Vapi account |
| [Python 3](https://www.python.org/) | Fills empty `.env` tokens on first start |
| [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) | Public `https://*.trycloudflare.com` URL for Vapi |
| [Vapi](https://dashboard.vapi.ai/) account | Private API key; Jack is created in that org |
| Microphone + browser popups | In-page **Call support** window |

On macOS with Homebrew:

```bash
brew install node python cloudflared
# Docker Desktop from the website, then start it
```

Get a Vapi private key from [API keys](https://dashboard.vapi.ai/org/api-keys). Do not put `localhost` in Vapi. Do not commit or paste `.env` secrets.

## What to change

```bash
cp .env.example .env
```

**Required**

- `VAPI_API_KEY` — your Vapi private key

**Usually leave as-is (first `npm start` fills blanks)**

- `MCP_SHARED_TOKEN` — Bearer token Caddy requires on `/mcp`
- `CB_USERNAME` / `CB_PASSWORD` — Couchbase UI login (defaults `Administrator` / `Administrator`)

| Variable | What it changes |
| --- | --- |
| `VAPI_PUBLIC_KEY` | In-page calling without minting a JWT from the private key |
| `CUSTOMER_NAME` | Name on seeded orders |
| `DEMO_CUSTOMER_EMAIL` | Email on seeded orders; OTP destination |
| `AGENT_NAME` | Assistant name in Vapi (max 40 characters) |
| `AGENT_MODEL` | LLM, default `gpt-4o` |
| `AGENT_VOICE_*` | Cartesia voice (default Greg `sonic-3.5`) |
| `RESEND_API_KEY` + `MAIL_FROM` | Real mailbox instead of Mailpit |
| `CB_PASSWORD` | Couchbase password if you do not want the example default |

Seeded catalog and Jack’s script live in `src/catalog.ts` and `src/templates.ts`. Shop copy is in `ui/`.

## Run locally with Docker Compose

Docker Compose starts the whole local stack: Couchbase Enterprise, the seed job, the read-only MCP server, Mailpit, the shop API, and Caddy. After the containers are up, the pages are on your machine:

```bash
cp .env.example .env   # set VAPI_API_KEY
docker compose up -d
```

- Customer shop: http://127.0.0.1:8080/customer
- Supervisor UI: http://127.0.0.1:8080/ui
- How to test:   http://127.0.0.1:8080/howto
- Mail inbox:    http://127.0.0.1:8025
- Couchbase UI:  http://127.0.0.1:8091

`docker compose up` does not create the Vapi assistant. Jack needs a public HTTPS URL, so use `npm start` when you want the call.

## How to run (shop + Jack)

```bash
nvm use          # Node 18
npm install
npm start
```

Keep that terminal open. `npm start` runs Docker Compose, waits until the shop is healthy, opens a Cloudflare tunnel, then creates or updates Jack on your Vapi account and points his tools at `https://<tunnel>/mcp`.

Ctrl+C or `npm stop` stops the tunnel and Docker.

| Page | URL |
| --- | --- |
| Customer shop | http://127.0.0.1:8080/customer |
| Supervisor desk | http://127.0.0.1:8080/ui |
| How to test | http://127.0.0.1:8080/howto |
| Mailpit (OTP + confirmations) | http://127.0.0.1:8025 |
| Couchbase UI | http://127.0.0.1:8091 |

Allow the **Call support** popup and the microphone. Codes appear on Supervisor and in Mailpit.

### Reset demo data

Restores ORD-1001 processing, ORD-1002 shipped, ORD-1003 delivered (last week), deletes extra shop orders, OTPs, supervisor requests, and Mailpit messages:

```bash
docker compose run --rm couchbase-init
```

### Recreate Jack after you change `.env`

Keep `npm start` running, or:

```bash
npm run agent -- create --mcp-url https://YOUR-TUNNEL.trycloudflare.com/mcp --replace
```

`npm run agent -- wipe` deletes every assistant and tool in that Vapi account. Use only if you mean it.

## Demo script

1. Shop: buy a product (new order is under six hours → **Can cancel immediately**).
2. **Call support**. Ask for that order. Read the OTP. Say you placed it by mistake → Jack cancels now.
3. Ask for **ORD-1001** → cancel needs Supervisor **Accept**.
4. Ask to cancel **ORD-1002** (shipped) → Jack refuses; offer a date change, then Accept on Supervisor.
5. **ORD-1003** (delivered) cannot be cancelled or rescheduled.

OTP is once per live call, including a new shop order on the same call. Hang up and call again → new OTP.

## Layout

```
deploy/          npm start / stop, Caddy, Couchbase seed
src/             shop API, mail, Vapi assistant + tools
ui/              shop, supervisor, call popup, how-to
docker-compose.yml
```

MCP protocol is Streamable HTTP (`shttp`) at `/mcp` with `Authorization: Bearer $MCP_SHARED_TOKEN`.
