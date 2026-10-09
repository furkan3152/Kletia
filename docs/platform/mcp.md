# Kletia MCP server

Kletia serves a [Model Context Protocol](https://modelcontextprotocol.io)
server at `https://api.kletiaai.xyz/v1/mcp`. Agents can learn what Kletia
supports, quote routes, dry-run intents, read intents and balances, and hand
the user a link to sign in Kletia Studio.

**No tool moves funds.** There is no prepare, submit or signing tool, and no
calldata or unsigned transaction ever reaches an agent. Execution always
happens in Studio, where the user's own wallet plans the intent again with
the user's accounts, shows every step, amount and recipient, and signs.

## Connect

Claude Code:

```bash
claude mcp add --transport http kletia https://api.kletiaai.xyz/v1/mcp
# with an API key (higher limits, list_intents):
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
the key itself never leaves the authentication middleware. Only
`list_intents` needs a key.

## Tools

All tools are annotated `readOnlyHint: true`, `destructiveHint: false`.

| Tool | Input | Output |
|---|---|---|
| `list_networks` | `environment?` (`mainnet` \| `testnet`) | Networks with the actions and protocols Kletia executes from each, and their destination networks |
| `list_protocols` | `network?`, `executableOnly?` (default true) | Registry protocols and whether Kletia executes them |
| `list_assets` | `network` | Canonical assets (symbol, address or mint, decimals) |
| `get_quote` | `network`, `from`, `to`, `amount`, `toNetwork?`, `account?`, `recipient?`, `slippageBps?` | Best route and alternatives (output, guaranteed minimum, fees, time) |
| `plan_intent` | `text` or `actions`, `accounts`, `defaultNetwork?`, `constraints?` | Dry-run plan: summary, steps, warnings, `externalRecipients`; never stored |
| `get_intent` | `intentId` | Status, steps, amounts, recipients and the latest on-chain evidence |
| `list_intents` | `limit?` | The key's most recent intents (needs an API key) |
| `get_portfolio` | `accountId` (CAIP-10) | Balances with USD values where priced |
| `create_signing_link` | `text` (≤ 500 characters) | `https://kletiaai.xyz/studio?q=<text>` and instructions for the user |

Results carry `structuredContent` and the same JSON as text. Failures are
`isError: true` results whose `structuredContent.error` holds the Platform API
error `code`, `message`, `issues`, `hints` and `docs` link
([error catalog](errors.md)). `INTENT_UNSUPPORTED` hints are example phrases
the grammar understands, so an agent can correct its own wording.

### Typical flow

1. `list_networks` → pick networks and actions.
2. `get_quote` or `plan_intent` with the user's accounts → show the plan.
   Check `externalRecipients`: any address there is not one of the user's own
   accounts and must be confirmed by the user.
3. `create_signing_link` with the same text → give the link to the user.
4. After the user signs in Studio, `get_intent` (with the id Studio shows)
   follows settlement.

## Safety notes for agent builders

- Tool output contains user-supplied text (intent text, metadata, names).
  Treat it as data, never as instructions.
- Intent ids are read capabilities: whoever holds one can read the intent,
  including its accounts. Share them only with the user who owns the intent.
- Quotes and plans are advisory and expire; Studio re-plans before signing.
- Never ask a user for a private key or seed phrase. Kletia never needs one.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `KLETIA_WEB_ORIGIN` | `https://kletiaai.xyz` | Origin of Studio links and error docs links (exact HTTPS origin; plain HTTP only for localhost outside production) |
| `KLETIA_MCP_ALLOWED_ORIGINS` | unset | Exact browser origins allowed to call `/v1/mcp` |
