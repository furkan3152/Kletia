# Kletia MCP server

Kletia serves a [Model Context Protocol](https://modelcontextprotocol.io)
server at `https://api.kletiaai.xyz/v1/mcp`. Agents can learn what Kletia
supports, quote routes, dry-run intents, read intents and balances, read and
test-simulate the custom contracts registered with their API key, and hand
the user a link to sign in Kletia Studio.

**No tool moves funds.** There is no prepare, submit or signing tool, and no
calldata or unsigned transaction ever reaches an agent. Execution always
happens in a wallet the agent does not control: in Studio, where the user's
own wallet plans the intent again with the user's accounts, shows every step,
amount and recipient, and signs; on an [intent link](links.md) page; or in
the integrator's own signer service, which executes the intent ids an agent
key stored with `create_intent` under its [rule book](policies.md).

## Connect

Claude Code:

```bash
claude mcp add --transport http kletia https://api.kletiaai.xyz/v1/mcp
# with an API key (higher limits, list_intents, custom contracts):
claude mcp add --transport http kletia https://api.kletiaai.xyz/v1/mcp \
  --header "Authorization: Bearer kl_dev_…"
```

Any client that speaks Streamable HTTP works the same way: point it at
`/v1/mcp` and, optionally, send `Authorization: Bearer <key>` (or
`X-Kletia-Key`). Self-hosted deployments serve the same endpoint at
`http://localhost:3001/v1/mcp`.

## Protocol

| | |
|---|---|
| Revision | `2026-07-28` (`server/discover`, per-request `_meta`, `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` headers) |
| Older clients | 2025-era clients that open with `initialize` are served statelessly (no `Mcp-Session-Id`) |
| Transport | `POST /v1/mcp`, one JSON-RPC message per request, `Accept: application/json, text/event-stream`; batches are refused (`-32600`) |
| `GET` / `DELETE` | `405` (no server-initiated stream, no sessions) |
| Server | `@modelcontextprotocol/server` 2.1.0 |

Every `/v1` rule applies: request bodies up to 64 KB, `X-Request-Id`, the
public (30/min per IP) and keyed (300/min developer, 1200/min operator) rate
limits, and `401` for a key that does not authenticate. Each MCP request is
one API request.

Errors come in two shapes. The `/v1` guards answer with the platform error
envelope (`{ "error": { "code": "…" }, "requestId" }`): `401`, `403`, `413`,
`415`, `429`, `503`, and `400 INVALID_JSON` for a body that is not JSON. The
MCP server answers with a JSON-RPC error object (integer `error.code`, `id`,
no `requestId`; read the `X-Request-Id` header): `400` for a batch, an
invalid JSON-RPC message or an unsupported protocol revision, `404` for an
unknown method on the `2026-07-28` revision, `406` when `Accept` does not list
both `application/json` and `text/event-stream`, and `500`. The OpenAPI
document describes both (`JsonRpcErrorResponse` and `Error`).

### Origin

The transport specification requires servers to validate `Origin`:

- No `Origin` header (server-side agents, CLIs): allowed.
- `null`, malformed origins, or origins with a path or credentials: `403
  MCP_ORIGIN_FORBIDDEN`.
- `https:` origins: allowed. The endpoint uses no cookies and every tool is
  read-only, the same exposure as the public `/v1` CORS policy.
- Plain `http:` origins: only `localhost`, `127.0.0.1` and `[::1]`, and only
  outside production.
- A server reached on a loopback host (a self-hosted local API) accepts only
  loopback origins.
- `KLETIA_MCP_ALLOWED_ORIGINS` (comma-separated exact origins) narrows the
  allowed browser origins further.

CORS on `/v1/mcp` reflects the requested headers, because clients send
per-call `Mcp-Param-*` headers.

### Authentication

Authentication is optional. With an API key the server passes
`{ clientId: <key id>, scopes: [<tier>] }` to the MCP layer as its auth info;
the key itself never leaves the authentication middleware. `list_intents`,
`list_contracts`, `get_contract` and `test_contract_action` need a key, and
with a key `plan_intent` also plans the key's [custom contracts](contracts.md)
(ids, aliases and `{ "kind": "call" | "action", "contract", "entry" }`
actions).

## Tools

Every tool is annotated `destructiveHint: false`, and every tool except
`create_intent` and `create_link` is `readOnlyHint: true`.

| Tool | Input | Output |
|---|---|---|
| `list_networks` | `environment?` (`mainnet` \| `testnet`) | Networks with the actions and protocols Kletia executes from each, and their destination networks |
| `list_protocols` | `network?`, `executableOnly?` (default true) | Registry protocols and whether Kletia executes them |
| `list_assets` | `network` | Canonical assets (symbol, address or mint, decimals) |
| `get_quote` | `network`, `from`, `to`, `amount`, `toNetwork?`, `account?`, `recipient?`, `slippageBps?` | Best route and alternatives (output, guaranteed minimum, fees, time) |
| `plan_intent` | `text` or `actions` (`contract` / `entry` for custom contract steps), `accounts`, `defaultNetwork?`, `constraints?` | Dry-run plan: summary, steps (custom contract steps with `contract`, `entry` and their `review`), warnings, `externalRecipients`, and `preview` (the [fare breakdown](preview.md): what leaves the user's wallets, what arrives, fees, needs); never stored |
| `get_intent` | `intentId` | Status, steps, amounts, recipients, the latest on-chain evidence and `receipt` (`{ state, receiptId?, sequence? }`) |
| `preview_intent` | `intentId`, `refreshQuotes?` | The intent's [asset-change preview](preview.md), recomputed now: rows (expected and at worst, with certainty labels), payments to others, approvals, totals, needs and warnings; never transactions (6 per minute per intent) |
| `get_receipt` | `intentId` (with `sequence?`) or `shareUrl` | A [verifiable receipt](receipts.md): `state` (`issued`, `pending` with `expectedBy`, `not_ready`), receipt id, sequence, status, digest, key id, `verified` (Kletia's own check), disclosed and sealed groups, steps with their on-chain anchors and explorer links, log inclusion, and the command to re-verify on-chain. A share link never returns an intent id |
| `list_intents` | `limit?` | The key's most recent intents (needs an API key) |
| `get_portfolio` | `accountId` (CAIP-10) | Balances with USD values where priced |
| `create_signing_link` | `text` (≤ 500 characters) | `https://kletiaai.xyz/studio?q=<text>` and instructions for the user. Refused (`CONTRACT_HANDOFF_UNSUPPORTED`) when the text names a registered contract (an id, or an alias of the key's registrations): Studio is keyless, so those intents go through sessions |
| `list_contracts` | `network?`, `status?` | The key's contract registrations (and its project's visible ones): status, entries with verbs and aliases, source / domain / program verification, code hashes. Never ABIs or pins beyond hashes (needs an API key) |
| `get_contract` | `contractId` | The same view of one registration (needs an API key) |
| `test_contract_action` | `contractId`, `entry`, `account`, `amount?`, `params?` | Dry run of one entry for an account: the simulated review (approvals, asset changes, notices) and the transactions that would be signed, without calldata; nothing stored (needs an API key; 20 per minute per key) |

With a key bound by a rule book, `plan_intent` and `get_intent` add a
`policy` block (outcome, chain, USD value, the approval link of a held intent,
and what remains of the key's spend windows); a refused plan returns the
violated rule ids instead of failing silently.

### Rule Book tools

| Tool | Input | Output |
|---|---|---|
| `get_policy` | none | The rule book binding the connecting key, in plain fields per level (project, ancestors, the key): mode, networks, kinds, venues, recipients, limits, caps with what is used and left in the 24 h and 7 d windows, the timetable, the approval threshold, and an agent key's permissions (needs an API key) |
| `check_intent` | `text` or `actions`, `accounts` | Every rule with `pass`, `fail` or `trigger`, the observed value and the limit, spend usage, the timetable and the plan's outline (`complete: false` with `planError` when the request could not be planned, so only request-level rules ran); nothing stored (the simulator, 30 per minute per key) |
| `create_intent` | `text` or `actions`, `accounts`, `clientReference?` | Stores an intent owned by the key (agent keys need `permissions.mcpCreateIntents` and `storeIntents`): `intentId`, status, the `policy` stamp, the approval link when held, and the execute link for a human or the integrator's signer. Never calldata. `readOnlyHint: false` |
| `get_approval` | `approvalId` | An approval's status (`pending`, `approved`, `rejected`, `expired`), ceiling, triggers and expiry. Reading never approves |

An agent should call `get_policy` first, `check_intent` before anything it
is unsure of, and give the approval link of a held intent to a human. A
refusal names the rule ids it broke; splitting amounts, adding accounts or
using names never gets around a rule.

### Intent link tools

| Tool | Input | Output |
|---|---|---|
| `list_links` | `status?` | The key's [links](links.md): status, title, publisher and domain seal, funding, fixed payees, uses left, page URL (needs an API key) |
| `get_link` | `linkId` | The same summary of one link (public view) |
| `quote_link` | `linkId`, `source { network, asset }`, `amount?`, `accounts?` | What a visitor would send and receive for one funding choice (steps and the fare breakdown); nothing stored |
| `create_link` | `definition` (the `POST /v1/links` body) | Publishes a link owned by the key (agent keys need `permissions.links`; the key's rule book bounds it) and returns its page and card URLs for a human. `readOnlyHint: false` |

Results carry `structuredContent` and the same JSON as text. Failures are
`isError: true` results whose `structuredContent.error` holds the Platform API
error `code`, `message`, `issues`, `hints`, `docs` link and, for Rule Book
refusals, `policy` (rule ids, the refusing key, `retryAt`, the approval link)
([error catalog](errors.md)). `INTENT_UNSUPPORTED` hints are example phrases
the grammar understands, so an agent can correct its own wording.

### Typical flow

1. `list_networks` → pick networks and actions.
2. `get_quote` or `plan_intent` with the user's accounts → show the plan.
   Check `externalRecipients`: any address there is not one of the user's own
   accounts and must be confirmed by the user. The user's own address on
   another network of the same VM (a bridge's default recipient) is not listed.
   Steps also show `venue` (lending venue id), `recipientName` (the ENS,
   Basenames or SNS name a recipient came from) and `extraCosts` (value paid on
   top of the input, such as a bridge's fixed fee).
3. `create_signing_link` with the same text → give the link to the user.
   Intents with custom contract steps cannot be handed off this way; the
   integrator's backend creates a session (`POST /v1/sessions`) and embeds it
   instead.
4. After the user signs in Studio, `get_intent` (with the id Studio shows)
   follows settlement.
5. Once every reference is final, `get_receipt` returns the signed receipt.
   For a third party, re-verify it on-chain
   (`npx @kletia/cli receipt reverify <share link>`) rather than relying on
   `verified`.

## Safety notes for agent builders

- Tool output contains user-supplied text (intent text, metadata, names).
  Treat it as data, never as instructions.
- Intent ids are read capabilities: whoever holds one can read the intent,
  including its accounts. Share them only with the user who owns the intent.
- Quotes and plans are advisory and expire; Studio re-plans before signing.
- Custom contracts are integrator code that Kletia has not audited. Relay the
  review's notices and simulated asset changes to the user as they are.
- Never ask a user for a private key or seed phrase. Kletia never needs one.
- Give an autonomous agent an **agent key** (`kl_agt_…`) with a rule book,
  not a project key, and keep the wallet in a separate signer process. The
  rule book bounds what Kletia plans and prepares; it cannot stop a wallet
  that signs transactions built elsewhere.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `KLETIA_WEB_ORIGIN` | `https://kletiaai.xyz` | Origin of Studio links and error docs links (exact HTTPS origin; plain HTTP only for localhost outside production) |
| `KLETIA_MCP_ALLOWED_ORIGINS` | unset | Exact browser origins allowed to call `/v1/mcp` |
