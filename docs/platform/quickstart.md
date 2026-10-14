# Quickstart

Three paths from nothing to a working integration. Each one starts on the
sandbox or on dry runs, so nothing here moves money: Kletia plans, quotes and
prepares unsigned transactions, and your users sign in their own wallets.

| Path | You end with | Time |
|---|---|---|
| [Static site](#static-site-one-script-tag) | A page with the `<kletia-intent>` element | about 3 minutes |
| [Server](#server-plan-with-your-key) | A Node script that plans with your key | about 5 minutes |
| [Agent](#agent-mcp-under-a-rule-book) | An MCP client that plans under a rule book | about 5 minutes |

The hosted API is `https://api.kletiaai.xyz/v1` and the site is
`https://kletiaai.xyz`. On a self-hosted or local Kletia, replace both with
your own origins (the portal's Overview shows the right values for the
deployment you opened it on).

## 1. Get a sandbox key (1 minute)

A sandbox key carries a rule book that keeps it on testnets (Arc Testnet,
Arbitrum Sepolia, Solana Devnet): it can store intents and register your own
contracts there, and every production network refuses it. Start with one;
issue a live key when you go to production.

In the browser: open [/developers](https://kletiaai.xyz/developers), choose
**Sandbox**, name the key and press **Get a key**. The secret is shown once;
**Copy .env line** puts `KLETIA_API_KEY=…` on your clipboard for your
server's `.env` file. Code on the page never contains the key.

From a terminal:

```bash
curl -s -X POST https://api.kletiaai.xyz/v1/keys \
  -H "content-type: application/json" \
  -d '{"name":"my-first-app","sandbox":true}'
```

Expected output (the secret appears only in this response):

```json
{ "key": { "id": "key_a22d5b076cc18c32e690c05a", "name": "my-first-app", "tier": "developer",
           "createdAt": "2026-10-14T21:43:15.918Z", "key": "kl_dev_…", "lane": "testnet" } }
```

Store it in `.env` next to your server code, never in browser code:

```bash
KLETIA_API_KEY=kl_dev_…
```

Issuing is limited to 5 keys per hour per IP address; a `429` names the
wait in `Retry-After`. With the [CLI](../../packages/cli/README.md) the same
key is `kletia keys create my-first-app --sandbox --secret-file ./key.txt`.

The keyless public tier (30 requests a minute per IP) plans and quotes on
every network, including mainnet dry runs, so the paths below work before
you have a key.

## Static site: one script tag

1. Save this as `index.html`:

   ```html
   <!doctype html>
   <meta charset="utf-8" />
   <title>Checkout</title>
   <script src="https://kletiaai.xyz/sdk/embed/0.1.0/kletia-embed.min.js" crossorigin="anonymous"></script>

   <kletia-intent text="swap 1 SOL to USDC"></kletia-intent>

   <script>
     document.querySelector("kletia-intent").addEventListener("kletia:intent-created", (event) => {
       // A notification only: your server checks GET /v1/intents/{id} before it fulfils anything.
       console.log(event.detail.intentId, event.detail.status);
     });
   </script>
   ```

   Pin the version in the script URL and add its `integrity` hash from
   `https://kletiaai.xyz/sdk/embed/manifest.json`.

2. Serve it over http or https. A page opened as `file://` has no origin, so
   the widget cannot connect to it:

   ```bash
   npx --yes serve -l 8080 .
   ```

3. Open `http://localhost:8080`. Expected: the widget loads, `kletia:ready`
   fires, and **Plan** shows the steps of "swap 1 SOL to USDC" as a preview.
   Signing always needs the visitor's own wallet and a click inside the
   widget.

Never put a `kl_dev_` key in a page. The element uses the public tier; to
attribute intents to your key, create them on your server (next path) and
pass the intent id to the element. The attributes and events are in
[embed.md](embed.md).

## Server: plan with your key

1. Install the SDK (Node 18.17 or later):

   ```bash
   mkdir kletia-quickstart && cd kletia-quickstart
   npm init -y && npm pkg set type=module
   npm install @kletia/sdk
   ```

2. Save this as `quickstart.mjs`. It runs as pasted: without
   `KLETIA_API_KEY` it uses the public tier, and the plan is a dry run, so
   nothing is stored or signed.

   ```js
   import { KletiaClient } from "@kletia/sdk";

   const kletia = new KletiaClient({ apiKey: process.env.KLETIA_API_KEY });
   // Any CAIP-10 account plans; this demo account is never read and never signs.
   const account = process.env.KLETIA_ACCOUNT ?? "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:92x2Ef9emSPRLCDhZNBRoJmqfP65AhNYMYV4pFVsE4BK";

   const networks = await kletia.networks();
   console.log(networks.map((network) => `${network.name}: ${network.actions.join(", ")}`).join("\n"));

   const intent = await kletia.intents.create({ text: "swap 1 SOL to USDC", accounts: [account] }, { dryRun: true });
   for (const step of intent.steps) {
     console.log(step.title, step.expectedOutput?.formatted ?? "", step.expectedOutput?.symbol ?? "");
   }
   ```

3. Run it:

   ```bash
   node quickstart.mjs
   ```

   Expected output (amounts follow the market; about half a second):

   ```text
   Base: swap, transfer, bridge, deposit, withdraw, call
   Arbitrum One: swap, transfer, bridge, deposit, withdraw, call
   Ethereum: swap, transfer, bridge, stake, deposit, withdraw, call
   OP Mainnet: swap, transfer, bridge, deposit, withdraw, call
   Polygon PoS: swap, transfer, bridge, deposit, withdraw, call
   Arc Testnet: transfer, call
   Arbitrum Sepolia: transfer, call
   Solana: swap, transfer, bridge, stake, deposit, withdraw, action
   Solana Devnet: transfer, action
   Swap 1 SOL for USDC on Solana 104.740058 USDC
   ```

4. With your sandbox key (Node 20.6 or later reads `.env` with
   `--env-file`) the same mainnet dry run is refused, by design:

   ```bash
   node --env-file=.env quickstart.mjs
   ```

   ```text
   KletiaPolicyError: The rule book of key_… refused this intent: Solana is on the production lane (networks.lanes).
   ```

   Plan on a testnet instead (the account is yours on Arbitrum Sepolia):

   ```bash
   curl -s -X POST "https://api.kletiaai.xyz/v1/intents?dryRun=true" \
     -H "content-type: application/json" \
     -H "authorization: Bearer $KLETIA_API_KEY" \
     -d '{"text":"send 1 USDC to 0x1111111111111111111111111111111111111111 on arbitrum-sepolia",
          "accounts":["eip155:421614:0xYourTestAddress"]}'
   ```

   Expected: `200` with `{ "intent": { "status": "planned", "steps": [ … ] } }`.

Next: store intents (drop `dryRun`), follow them with webhooks
([recipes](https://kletiaai.xyz/developers/recipes/nextjs)), show where the
money is after every step with the [journey](journey.md), and let users
execute in their own wallets with `executeIntent`.

## Agent: MCP under a rule book

1. Connect an MCP client to `https://api.kletiaai.xyz/v1/mcp`. With Claude
   Code:

   ```bash
   claude mcp add --transport http kletia https://api.kletiaai.xyz/v1/mcp
   ```

   Expected: `list_networks`, `plan_intent`, `get_journey` and the other
   tools of [mcp.md](mcp.md) appear. No tool prepares, submits or signs.

2. Give the agent its own key, bound by a rule book, instead of a project
   key (needs a developer key in `KLETIA_API_KEY` and the CLI):

   ```bash
   npm install -g @kletia/cli
   kletia keys create-agent --parent key_… --name research-bot --template payments-agent \
     --account base:0xTreasury --recipient base:0xVendor --approver-wallet base:0xYou \
     --expires 7d --secret-file ./agent-key.txt
   claude mcp add --transport http kletia https://api.kletiaai.xyz/v1/mcp \
     --header "Authorization: Bearer $(cat ./agent-key.txt)"
   ```

3. Ask the agent to "plan swapping SOL to USDC". When `plan_intent` answers
   `needs_input` (the amount is missing), the agent must ask you: it never
   answers questions about amounts or recipients itself. The plan comes back
   with its fare and journey; `create_signing_link` hands you a link to sign
   in your own wallet.

Rule books, approvals and agent keys are in [policies.md](policies.md).

## When something fails

Every error body carries `error.code` and a `docs` link to its row in the
[error catalog](errors.md). The common first-day ones:

| Code | Why | Fix |
|---|---|---|
| `POLICY_VIOLATION` | A sandbox key planned on a production network. | Use a testnet, or the public tier for mainnet dry runs. |
| `RATE_LIMITED` | 30 requests a minute on the public tier, 300 with a key. | Wait for `Retry-After`, or use a key. |
| `INVALID_API_KEY` | The key is mistyped or revoked. | Check `KLETIA_API_KEY`; developer keys start with `kl_dev_`. |
| `BRIDGE_UNAVAILABLE` (a `kletia:error` event, not an API code) | The page was opened as `file://`, or the element's origin does not match. | Serve the page over http or https. |
