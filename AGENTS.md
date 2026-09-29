# Agent instructions

Local Couchbase Enterprise + MCP + one Vapi OrderBot, exposed with Cloudflare Tunnel. Full setup is in `README.md`.

```bash
npm start
```

Ctrl+C or `npm stop` also stops Docker.

There is only one assistant. Customers buy on `/customer` (orders in Couchbase). The agent verifies OTP, looks up orders, and raises delivery-date changes or late cancels for `/ui`. Never use localhost for Vapi. Never print `.env` secrets.
