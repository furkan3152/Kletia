# Admin panel

`https://kletiaai.xyz/admin` is the wallet-gated operator panel: list every Kletia deployment on every network, deploy
new ones from the browser with the admin wallet, verify them on chain, manage owner functions (directly or through Safe
proposals), view fee revenue and claim accrued balances, check Render and the environment, and export verified
deployments for the next release. The API behind it lives under `/api/admin` on the Kletia API.

The server never holds a private key and never signs or sends a transaction. Every deploy, owner action, Safe signature
and Safe execution is signed by a wallet in the browser; the API only reads chains (and calls Render).

## Who can sign in

| Variable | Meaning |
|---|---|
| `KLETIA_ADMIN_ADDRESSES` | EVM wallets, comma separated. Committed value: `0xff3a3cfc42d27e85dba9ea85f0bfec34bd632f9a`. |
| `KLETIA_ADMIN_SOLANA_ADDRESSES` | Solana wallets (base58), comma separated. Committed value: `D2Ts7yCiVjedo6uwqpkM44QA8J45NdVU1J3k5m6iWtvm`. |

- Either list alone enables the panel. Both unset or empty disables it: every `/api/admin` route answers
  `503 ADMIN_DISABLED`.
- Any invalid entry in either list disables the panel entirely (fail closed). Mixed-case EVM entries must carry a
  valid EIP-55 checksum; Solana entries must decode to 32 bytes.
- No address is hard-coded in the code: a self-hosted deployment never grants admin to the Kletia owner by default.
- In production the panel also needs `KLETIA_DATABASE_URL` (sessions and the audit log must survive restarts).
- The allowlists are read from the environment only. Changing them takes a Render env change and a redeploy; a session
  whose wallet left the list stops working on its next request.

### EVM sign-in (EIP-4361)

The API builds a Sign-In with Ethereum message (domain = the page origin's host, statement, `URI: <origin>/admin`,
chain id of one of the seven EVM networks, a single-use nonce, 5-minute expiry, `Request ID: adm_login`). The wallet
signs exactly that text (`personal_sign`). EOAs are checked by recovery; smart accounts (Safe, ERC-1271/ERC-6492) are
checked on chain. A failed chain read is `502 ADMIN_RPC_UNAVAILABLE`, never a pass.

### Solana sign-in

The API builds the Sign In With Solana text with the same fields:

```
kletiaai.xyz wants you to sign in with your Solana account:
D2Ts7yCiVjedo6uwqpkM44QA8J45NdVU1J3k5m6iWtvm

Sign in to the Kletia admin panel. This signature does not move funds or approve a transaction.

URI: https://kletiaai.xyz/admin
Version: 1
Chain ID: mainnet
Nonce: <nonce>
Issued At: <iso time>
Expiration Time: <iso time>
Request ID: adm_login
```

The wallet signs the UTF-8 bytes of that exact text with `signMessage` (base58 or base64 signature); the API verifies
the ed25519 signature against the address. A Solana session opens the same panel. On-chain EVM actions (deploys,
owner actions, Safe signatures and executions) still need an EVM admin wallet from `KLETIA_ADMIN_ADDRESSES` connected
in the browser to sign; the panel says so when only the Solana wallet is connected, and the API accepts transactions
sent by any allowlisted EVM wallet for a Solana session.

## Session and request security

- Session cookie: `__Host-kletia_admin`, host-only on `api.kletiaai.xyz`, `HttpOnly; Secure; SameSite=Strict`,
  8 hours absolute, 30 minutes idle. Stored only as a SHA-256 hash. Sign out and "sign out everywhere" exist.
- Admin origins: `https://kletiaai.xyz` and `https://www.kletiaai.xyz` (override with `KLETIA_ADMIN_ORIGINS`; entries
  must be same-site with the API). `kletia-frontend.onrender.com` and `kletia.com` are refused: a SameSite cookie
  cannot work there.
- Every request needs the exact Origin, the header `X-Kletia-Admin: 1` and a JSON body.
- Step-up on every write: every state-changing route except sign-in and logout needs a fresh confirmation signed by
  the wallet that holds the session (an EVM session signs with its EVM wallet, a Solana session with its Solana
  wallet). A stolen session cookie alone can only read. The flow: `POST /api/admin/auth/nonce` with
  `purpose: "confirm"`, the action, the network (when the body names one) and `payloadSha256`; the API returns a
  plain-text "Kletia admin confirmation" message with a single-use nonce valid for 5 minutes; the wallet signs it and
  the write sends `confirmation: { message, signature }` in its JSON body.

  | Route | Action | Payload hashed (SHA-256 of canonical JSON) |
  |---|---|---|
  | `PUT /network-profiles/:network` | `network-profile.update` | the body without `confirmation` |
  | `PATCH /deployments/:id` | `deployment.status` | `{ id, status, notes? }` |
  | `POST /deployments` (deploy or import) | `deployment.record` | route payload |
  | `POST /deployments/:id/reverify` | `deployment.reverify` | route payload |
  | `POST /actions/verify` | `action.verify` | route payload |
  | `POST /safe-proposals`, `…/:id/signatures`, `…/:id/executed`, `…/:id/cancel` | `safe.propose`, `safe.sign`, `safe.executed`, `safe.cancel` | route payload |
  | `POST /fees/rescan` | `fees.rescan` | route payload |
  | `POST /services/:service/deploy` (Render redeploy) | `render.deploy` | route payload |

  The route payload is `{ route: "<METHOD> <path under /api/admin as sent>", body: <body without confirmation> }`
  (`adminRoutePayload` in `@kletia/core`). A missing, forged, replayed, expired, other-wallet or mismatched
  confirmation is `403 ADMIN_CONFIRMATION_REQUIRED` and an audit row with outcome `denied` and
  `reason: confirmation`; nothing changes, and no Render call or redeploy-budget use happens. `POST /auth/logout` and
  `POST /auth/logout-all` stay cookie-only (they only end sessions); all `GET` routes stay cookie-only. A test walks the
  router and fails if a new state-changing route lacks the step-up. The panel shows one line before each write: "Your
  wallet will first ask you to sign a confirmation for this change (a message, not a transaction: no gas)."
- Rate limits: sign-in and confirmation nonces 10 per minute per IP; reads 240 and writes 30 per minute per session; Render redeploy 3 per 10
  minutes; fee rescans 6 per 10 minutes.
- Audit: every mutation and every sign-in attempt writes an audit row before the response; if the row cannot be
  written the request fails and nothing changes.

## Deployments

The catalog (`packages/core/src/admin.ts`) lists, per EVM network, which Kletia contracts are pinned, deployable,
quarantined, legacy or not applicable. Solana and Solana Devnet show "No Kletia programs. Nothing to deploy."

1. Choose the network and fill the owner, guardian and treasury roles (Base defaults to the Governance, Guardian and
   Treasury Safes). An EOA owner on a mainnet needs a typed acknowledgement: `DEPLOYMENT.md` asks for a Safe.
2. Deploy from the panel with the admin wallet. The API verifies the creation transaction on chain: chain id,
   success and confirmations, contract creation, deployer, init code, constructor arguments (including pinned
   constants and dependencies), runtime code against the committed artifact with immutables masked, owner, role reads,
   owner kind and admin control (below).
3. Deploys made outside the panel (Hardhat) can be imported by transaction hash.
4. Export the verified records (`GET /api/admin/deployments/export`) and hand the JSON to the lead, who pins it in a
   release. A deployment on a new network is prepared only until then: the planner does not use it.

### Verified means admin-controlled

A record (fresh deploy or import) is `verified` only when every check passes, including `admin_control`: the
contract's effective owner/admin is

- an allowlisted admin EVM wallet (`KLETIA_ADMIN_ADDRESSES`), or
- the network profile's configured owner (the saved profile, else the catalog default, e.g. the Base Governance Safe),
  or
- a Safe whose on-chain `getOwners()` includes an allowlisted admin EVM wallet.

The effective owner is `owner()` with no pending owner (contracts whose owner comes from the deployer or a constructor
role; the `owner` check already requires `owner()` to equal it and `pendingOwner()` to be zero), or for contracts
without such a role the on-chain `owner()` (with no open `pendingOwner()`) or else the creator constructor argument
(KLET token). Contracts with no owner or admin role pass `admin_control`.

When every other check passes but `admin_control` fails, the record is stored as `foreign`. A foreign record is shown
in red in the panel ("Foreign owner", with the reason), counted as a warning on the overview, never exported for
pinning, never used as a constructor dependency or to satisfy a checklist step, and not a target for owner actions or
Safe proposals. Reverify reruns the check against the current allowlist, profile and Safe owners, so a record can move
between `verified` and `foreign`. Records stored before this check existed gain it on their next reverify.

Artifacts come from `apps/api/src/admin/contract-artifacts/kletia-contracts.json`, generated by
`npm run export:contract-artifacts` after `npm run compile:base && npm run compile:arc` and checked in CI by
`npm run check:contract-artifacts`.

## Management and fees

- Owner actions run directly when the owner is an admin EVM wallet, or as Safe proposals when the owner is a Safe the
  admin co-owns (Base V2 contracts are owned by the 2-of-2 Governance Safe). The Safe transaction hash is read from
  the Safe on chain; signers are recovered by the API; execution is confirmed by the Safe's `ExecutionSuccess` log.
- `renounceOwnership` is never offered.
- Fees: Router V2 and Launch Factory V2 push fees to the treasury in each transaction (summed from events with a
  persisted scan); x402 gateways accrue USDC and are claimed with `withdraw(to)`; the legacy fee router's stray
  balances are claimed with `rescueTokens`. Testnet amounts are excluded from USD totals.

## Render and environment

- `RENDER_API_KEY` (Render → Account settings → API keys) enables service status and the Redeploy buttons. The panel
  calls only `GET /services/{id}`, `GET /services/{id}/deploys` and `POST /services/{id}/deploys`; it never edits env
  vars. Redeploy builds the latest commit on `main` even if CI has not passed yet.
- The environment view shows which variables are set, as booleans only.

## Residual risks

- A compromised admin wallet is full admin, as it is on chain. A stolen session cookie alone can only read until the
  session ends (8 hours absolute, 30 minutes idle): every write needs the wallet's confirmation signature.
- Render API keys are account-wide.
- An EOA owner on a new mainnet deployment departs from the documented production policy until ownership moves to a
  Safe.
