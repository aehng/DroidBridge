# droidbridge-relay

Cloudflare Worker that sits between ChatGPT (Streamable HTTP MCP) and a paired Android phone (outbound WebSocket).

## Architecture

```
ChatGPT  --HTTPS /mcp (OAuth 2.1 + PKCE)-->  Worker  --rpc frames-->  phone WebSocket
Browser  --HTTPS /pair (Clerk)------------>  Worker  issues 8-char code
App      --POST /device/pair-------------->  Worker  returns dbt_ token (SHA-256 stored)
App      --GET  /device/ws  Bearer token-->  DeviceRelay Durable Object (one per Clerk user id)
```

- Resource and issuer URLs are taken from the request origin, so `https://droid.synqra.info` and the `*.workers.dev` fallback both work.
- CORS allows `https://chatgpt.com` and `https://chat.openai.com`.
- Unauthenticated `/mcp` returns `401` with `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"`.
- Phone frames: `rpc` / `rpc_result` / `ping`+`pong` / `revoked`. Max 4 MiB. RPC wait is 30s (`-32001` / HTTP 504). No socket: `-32002` / HTTP 503. JSON-RPC notifications (no `id`) return HTTP 202.
- One active device per account. A new pairing revokes the previous token and sends `{type:"revoked"}` then close `4001`.
- `tools/list` results from the phone are passed through unchanged.

Bindings: KV `TOKENS` (OAuth codes, pairing codes), D1 `DB` (accounts, devices, OAuth clients/tokens), Durable Object `DeviceRelay`.

## Protocol (pairing)

1. Open `https://<relay>/pair`, sign in with Clerk, copy the 8-character code (A–Z2–9, 10 minutes, single use).
2. App `POST /device/pair` with `{"code":"...","deviceName":"..."}` → `{"deviceToken":"dbt_...","accountId":"...","mcpUrl":"https://<relay>/mcp"}`.
3. App connects `GET wss://<relay>/device/ws` with `Authorization: Bearer <deviceToken>` (or `?token=`).

## DEPLOY

Do not run these until IDs in `wrangler.toml` are filled in. Commands from the `relay/` directory:

```bash
npm install
npx wrangler kv namespace create TOKENS
npx wrangler d1 create droidbridge-relay
```

Paste the returned KV `id` and D1 `database_id` over the `REPLACE_WITH_*` placeholders in `wrangler.toml`. Then:

```bash
npx wrangler d1 migrations apply droidbridge-relay --remote
npx wrangler secret put CLERK_SECRET_KEY
npx wrangler deploy
```

Optional: uncomment the `droid.synqra.info` custom_domain route in `wrangler.toml` after DNS is attached.

### Secrets and vars

| Name | Where | Purpose |
| --- | --- | --- |
| `CLERK_PUBLISHABLE_KEY` | `[vars]` | Clerk browser sign-in (`pk_test_Y3JlYXRpdmUtYXJhY2huaWQtOTQ4My5jbGVyay5hY2NvdW50cy5kZXYk`) |
| `CLERK_ALLOWED_ORIGINS` | `[vars]` | Comma-separated origins allowed as JWT `azp` |
| `CLERK_SECRET_KEY` | secret | Clerk Backend API (optional; not required for pairing/OAuth as implemented) |
| `TOKENS` | KV binding | Pairing codes and OAuth authorization codes |
| `DB` | D1 | Accounts, hashed device tokens, OAuth clients and tokens |
| `DEVICES` | Durable Object | `DeviceRelay` per Clerk user id |

### Clerk dashboard

Same Clerk instance as Synqra (`creative-arachnid-9483.clerk.accounts.dev`). Add:

- Allowed origins: `https://droid.synqra.info`, `https://droidbridge-relay.<account>.workers.dev`
- Redirect URLs / after-sign-in: `https://droid.synqra.info/pair`, `https://droid.synqra.info/authorize`, and the matching `workers.dev` URLs
- Hash routing is used (`routing: "hash"`) so Google OAuth returns to `/pair` and `/authorize` rather than a path callback.

## Tests

```bash
npm test
```
