# Developer accounts

A project starts as its first key. Without an account, losing every key of a
project means losing the project: its settings, rule books, links and
webhooks stay behind with no way back in. A **developer account** gives the
project a durable owner: a wallet. Sign in with that wallet on any device and
you can list the project's keys, issue a new one, rotate or revoke the old
ones.

Accounts are optional. Keys keep working exactly as before, and the
anonymous "Issue a key" flow on the Keys page needs no wallet.

Accounts are used from the developer portal (`/developers/keys` and
`/developers/project`). The routes below exist for the portal; integrations
manage keys from their servers with `/v1/keys`.

## Sign in

1. `POST /v1/accounts/nonce` `{ "walletKind": "evm" | "solana", "address", "chainId"? }`
   returns the exact message to sign:
   - EVM wallets: an [EIP-4361](https://eips.ethereum.org/EIPS/eip-4361)
     (Sign-In with Ethereum) message naming Base, Ethereum, Arbitrum One,
     Optimism or Polygon (`chainId` 8453, 1, 42161, 10 or 137).
   - Solana wallets: the same fields in the Sign In With Solana text layout,
     signed with the wallet's `signMessage`.

   The message names the site's host (`URI` is the site's root: the portal
   and the desk's wallet tracking sign in with the same session), the
   address, a single-use nonce and an expiry 5 minutes away, with the
   statement "Sign in to Kletia with this wallet (developer projects and
   keys, and wallet tracking on the desk). This signature does not move
   funds or approve a transaction."
2. `POST /v1/accounts/session` `{ "message", "signature" }` checks it: the
   nonce is used up by the first attempt (valid or not), the message must be
   the one issued for this origin, and the signature must come from the
   named wallet. Plain wallets are checked offline; smart-contract wallets
   (ERC-1271, ERC-6492) are checked on the named network, and a failed read
   is `502 RPC_UNAVAILABLE`, never a pass.
3. The answer holds a session token (`kl_acs_…`, shown once; Kletia stores
   only its SHA-256). Send it as `Kletia-Account-Session`. A session ends 8
   hours after sign-in, after 1 hour without a request, or with
   `DELETE /v1/accounts/session`. It works only from the origin that signed
   in.

The portal keeps the token in the tab's memory only (never in storage, a
cookie or the URL), like a loaded key. Reloading signs the tab out; your
projects stay yours. It finds browser wallets through EIP-6963 (EVM) and the
Wallet Standard (Solana), so an unlocked wallet extension is needed, and it
only ever asks the wallet to sign the message above, never a transaction.

## Own a project

| Route | What it does |
|---|---|
| `GET /v1/accounts/projects` | The wallet's projects (also those with no key left). |
| `POST /v1/accounts/projects` `{ name, sandbox? }` | A new project owned by the wallet, with its first project key (shown once). |
| `POST /v1/accounts/projects/claim` | Links the project of the presented project key (`X-Kletia-Key` or `Authorization`, current secret) to the wallet. 201 when linked now, 200 when it already was. |
| `GET /v1/accounts/projects/{projectId}/keys` | Every key of the project, revoked ones included (never secrets). |
| `POST /v1/accounts/projects/{projectId}/keys` `{ name, sandbox? }` | A new project key, also when every key was lost or revoked. |
| `POST /v1/accounts/projects/{projectId}/keys/{keyId}/rotate` `{ graceSeconds? }` | New secret, same id; the old secret works during the grace window but cannot manage keys. |
| `DELETE /v1/accounts/projects/{projectId}/keys/{keyId}` | Revokes the key and its subtree; their webhooks are deleted. The project stays owned. |
| `GET /v1/accounts/activity` | The wallet's newest 50 account events. |

Rules:

- A project has **one owner wallet, for good**. Claiming a project another
  wallet owns is `409 PROJECT_ALREADY_OWNED`. Claim your existing projects
  early: until a project has an owner, anyone holding one of its project
  keys can claim it.
- Claiming needs a project key (`kl_dev_`) with its current secret. Agent and
  publishable keys cannot claim; a rotated-out secret gets
  `403 KEY_SECRET_ROTATED`.
- A wallet owns at most 20 projects (`409 PROJECT_LIMIT_REACHED`) and creates
  at most 5 an hour.
- A project the wallet does not own reads as `404 PROJECT_NOT_FOUND`.
- Key limits, events (`key.created`, `key.revoked`) and the project's decision
  log are the same as for `/v1/keys`; the actor is the owner wallet.
- An EVM address is one identity on every listed network. A smart-contract
  wallet should sign in on the network where it is deployed.

## Recover access on a new device

1. Open `/developers/keys` and choose **Sign in with a wallet**.
2. Sign the message with the wallet that owns the project.
3. Under **Your projects**, choose **Recover access** (or **Manage keys**) and
   issue a new project key. Copy it into your server's secret store; revoke
   the keys you no longer trust.

## Security

- Every account route needs a first-party `Origin` (the Kletia web app);
  anything else is `403 ACCOUNT_ORIGIN_FORBIDDEN`, also when the header is
  missing. The session travels in a header, never a cookie, so another page
  cannot use it.
- Sign-in messages: 10 a minute per address. Sign-in attempts: 10 a minute
  per address. Reads: 120 a minute per session. Changes: 20 a minute per
  session. The public per-address limit applies on top.
- Every sign-in (refused ones too), sign-out, project creation or claim and
  key change is written to the account audit log (`kletia_account_audit`)
  before the answer. If the row cannot be written the request fails with
  `503 STORE_UNAVAILABLE` and nothing changes. Refused sign-ins are never
  attributed to the wallet they claim.
- Storage: Postgres (`kletia_account_nonces`, `kletia_account_sessions`,
  `kletia_project_owners`, `kletia_account_audit`) when
  `KLETIA_DATABASE_URL` is set. Outside production, memory. In production
  without a database every account route answers `503 STORE_UNAVAILABLE`:
  ownership kept in memory would be lost on restart.
- Kletia never signs or sends a transaction for an account, and never holds
  a wallet key.

## Errors

| Code | Status | When |
|---|---|---|
| `ACCOUNT_ORIGIN_FORBIDDEN` | 403 | The request does not come from the Kletia web app. |
| `ACCOUNT_SESSION_REQUIRED` | 401 | No session, or it ended, or it belongs to another origin. |
| `ACCOUNT_NONCE_INVALID` | 401 | The sign-in message is unknown, used, expired or altered. |
| `ACCOUNT_SIGNATURE_INVALID` | 401 | The signature does not match the message and wallet. |
| `PROJECT_NOT_FOUND` | 404 | The wallet does not own this project. |
| `PROJECT_ALREADY_OWNED` | 409 | Another wallet owns the project. |
| `PROJECT_LIMIT_REACHED` | 409 | The wallet owns 20 projects. |
