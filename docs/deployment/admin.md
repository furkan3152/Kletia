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
- Writes that change future defaults (network role profiles, deployment status) need a second signature of a
  confirmation message bound to the action, the network and the SHA-256 of the canonical JSON payload.
- Rate limits: sign-in 10 per minute per IP; reads 240 and writes 30 per minute per session; Render redeploy 3 per 10
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
   constants and dependencies), runtime code against the committed artifact with immutables masked, owner, role reads
   and owner kind.
3. Deploys made outside the panel (Hardhat) can be imported by transaction hash.
4. Export the verified records (`GET /api/admin/deployments/export`) and hand the JSON to the lead, who pins it in a
   release. A deployment on a new network is prepared only until then: the planner does not use it.

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

- A compromised admin wallet is full admin, as it is on chain.
- Render API keys are account-wide.
- An EOA owner on a new mainnet deployment departs from the documented production policy until ownership moves to a
  Safe.
