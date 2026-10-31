# Node server example

A shop backend that keeps its Kletia key on the server. The browser plans and
executes through the server's proxy; it never holds a key.

```bash
cd examples/node-server
npm install            # before the npm release, see ../README.md for the tarball install
cp .env.example .env    # fill in KLETIA_API_KEY and KLETIA_WEBHOOK_SECRET
node --env-file=.env server.mjs        # http://localhost:3000
```

A sandbox key keeps everything on testnets: `kletia keys create shop --sandbox`.

What it shows (`server.mjs`):

- **`/api/kletia/*`: `createKletiaProxy`** (through `expressKletiaProxy` on
  `node:http`). It forwards only what a visitor's browser needs (plans and
  dry runs, intent reads and events, preview, prepare and submit, receipts,
  sessions and links) with your key added server-side, drops the browser's
  `Authorization`, `Cookie` and `Origin`, caps bodies at 64 KB and never
  follows redirects. Keys, webhooks, contracts, rule books, projects and
  usage answer `403 PROXY_ROUTE_FORBIDDEN` without reaching Kletia.
- **`POST /api/checkout`**: the server creates the order's intent with its
  key. Amount, asset, network and recipient come from the order book in
  `server.mjs`; the browser only names the order and its wallet.
- **`POST /webhooks/kletia`**: `expressWebhookHandler` verifies the
  `Kletia-Signature` against the raw body and `memoryDeduplication` handles
  each event id once (Kletia retries deliveries). Use a shared store
  (Redis, your database) with more than one process.
- **`public/index.html`**: the checkout page. It loads the SDK's browser build
  from this server (`/vendor/*`, an import map, no CDN), asks the server for
  the order's intent and runs `executeIntent` with the visitor's EIP-1193
  wallet behind the fare gate (`onPreview`).

## Local events with `kletia listen`

Webhooks need a public HTTPS URL. During development, forward your key's
events to this server instead, signed with the same secret:

```bash
export KLETIA_API_KEY=kl_dev_…  KLETIA_WEBHOOK_SECRET=whsec_…
kletia listen --forward-to http://localhost:3000/webhooks/kletia
```

Contract, link, rule book and key events arrive too, not only intent events.

## Checks

`npm run check` runs `smoke.mjs` against an in-process stub of `/v1` on
127.0.0.1 (no network, no key, nothing signed): the proxy refuses
`DELETE /v1/keys/…` and forwards `POST /v1/intents?dryRun=true` with the key,
the checkout plans the server's amount, and a webhook is verified and handled
once. `npm run check:examples` at the repository root runs it through this
example's `build` script against packed workspace packages.
