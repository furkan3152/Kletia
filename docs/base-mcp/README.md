# Kletia Base MCP integration runbook

This directory documents Kletia's limited Base MCP integration. It is an
onboarding and orchestration layer, not an MCP server replacement and not a
custodial agent.

## Implemented surface

| Endpoint | Class | Purpose |
| --- | --- | --- |
| `GET /api/base-mcp/context` | deterministic/read-only | Bind an explicit Base MCP-detected wallet to Base Mainnet policy context |
| `POST /api/base-mcp/x402/discover` | read-only | Search Coinbase CDP Bazaar without putting free-text discovery terms in the URL |
| `GET /api/base-mcp/x402/prepare` | prepare-only | Build a capped, public-HTTPS, GET/POST plan for Base MCP's native x402 tools |

All three endpoints require:

- an explicit `wallet` EVM address;
- `network=base`;
- `chainId=8453`.

Discovery accepts these values with `wallet`, `query`, `maxPayment`, and
boolean `curatedOnly` in a JSON body. Context and prepare retain their
documented query parameters.

The prepare endpoint also requires an explicit `method=GET` or `method=POST`;
it never guesses an HTTP method for a paid resource.

The network middleware rejects Arc and every mismatched chain context before a
route handler runs. Responses use `Cache-Control: no-store`. No endpoint stores
a wallet credential, signs data, returns calldata, submits a transaction, or
calls Base MCP on the user's behalf.

## Execution boundary

```text
Base MCP OAuth + get_wallets
          |
          v
Kletia context/discover/prepare boundary
          |
          v
official initiate_x402_request
          |
          v
user reviews and approves in Base Account
          |
          v
official complete_x402_request
```

Kletia cannot verify the user's Base MCP OAuth session or prove ownership of
the query-string wallet. The plugin therefore requires `get_wallets` first and
checks that every response echoes the selected address. This is a workflow
checkpoint, not cryptographic authentication.

The deployed Kletia API host is not assumed to be on Base MCP's hosted
`web_request` allowlist. Before calling the integration production-ready:

1. Deploy the backend behind a public HTTPS origin.
2. Configure the plugin's `KLETIA_API_ORIGIN`.
3. Connect `https://mcp.base.org` with OAuth.
4. Call `get_wallets`.
5. Test the context endpoint through Base MCP `web_request`.
6. If the host is rejected, keep hosted automation disabled until Base
   allowlisting is confirmed. A coding harness may make a user-authorized
   direct HTTPS request; consumer-app users can paste the response manually.
7. Never describe the integration as fully automatic until both OAuth and host
   access are verified in the target client.

## Privacy and logging

Discovery uses POST JSON so the user's free-text search does not enter browser,
proxy, or hosting URL logs. The prepare endpoint still URL-encodes an optional
paid-request `body` query field for current plugin compatibility. Do not place
secrets or private user data in any discovery term or paid-request body.
Production infrastructure should still redact query strings from access logs.

## Validation

Run with Node 20.19 or newer. This workspace was validated with Node 22:

```bash
node node_modules/typescript/bin/tsc -p tsconfig.api.json
node node_modules/vitest/vitest.mjs run src/tests/base-mcp-routes.test.ts
```

The route tests cover:

- explicit-wallet and strict Base Mainnet isolation;
- Arc rejection;
- non-custodial context output;
- deterministic prepare IDs;
- the official two-tool x402 plan;
- private-host, malformed-body, and payment-cap rejection;
- revalidation of Coinbase CDP Bazaar Base Mainnet USDC results.

They do not prove hosted Base MCP allowlisting, OAuth, a browser approval, a
wallet signature, payment settlement, or a paid endpoint response.

## Source contract

The implementation follows current official Base documentation:

- [Get Started with Base MCP](https://docs.base.org/agents/quickstart)
- [Custom Plugins](https://docs.base.org/agents/plugins/custom-plugins)
- [Make x402 Payments](https://docs.base.org/agents/guides/x402-payments)

Agent instructions live in
[`kletia-base-plugin.md`](./kletia-base-plugin.md).
