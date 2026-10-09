# Rule Book: policies and agent keys (`kletia.policy/v1`)

The **Rule Book** bounds what Kletia plans and prepares for an API key. You
write a rule book for the project and for any key: which networks, assets,
protocols, contracts and recipients it may touch, how much it may spend per
step, per intent, per day and per week, when it may act, and which intents
need a human approval. You give an AI agent (or any automation) its own
**agent key** (`kl_agt_…`) under one of your keys, with its own rule book,
and every request it makes is checked against the whole chain: the project,
every ancestor key and the agent key itself.

Kletia never holds keys and never signs. The Rule Book decides whether
Kletia plans an intent and hands out unsigned transactions for it; the wallet
still signs every transaction. It fails closed: when a rule cannot be
checked (an amount without a fresh price under a USD rule, a store that
cannot be read) the request is refused, never allowed.

- Reference types and validation: `validatePolicy`, `comparePolicies`,
  `policyHash`, `POLICY_TEMPLATES` and `verifyDecisionChain` in
  `@kletia/core`.
- Endpoints: [api-v1.md](api-v1.md#rule-book), OpenAPI tag `Rule Book`.
- Agents: the [MCP tools](mcp.md#rule-book-tools) `get_policy`,
  `check_intent`, `create_intent` and `get_approval`.

## Concepts

| Term | Meaning |
|---|---|
| Project key | A `kl_dev_…` key issued with `POST /v1/keys`. It manages keys and writes rule books. |
| Agent key | A `kl_agt_…` key issued under another key with `POST /v1/keys/{id}/children`. It always expires, never manages project keys, never writes rule books and never approves. |
| Lineage | The ancestors of an agent key, project key first. A key authenticates only while every ancestor is active and unexpired. |
| Rule book | A `kletia.policy/v1` document attached to the project (`prj_…`) or to one key. Versioned; every version has a canonical hash (`sha256:…`). |
| Chain | The rule books a request is checked against: the project's, each ancestor's, then the key's own. A request passes only if every level allows it. |
| Decision | One evaluation (plan, prepare, submit, simulator, approval, amendment, key event), appended to a hash-chained log per project. |
| Exposure | The USD value of a prepared payload, counted against spend caps from the moment the payload is handed out. |
| Approval | A hold on an intent that a rule book wants a human to confirm (`apr_…`). |

## Agent keys

```http
POST /v1/keys/{parentId}/children
Authorization: Bearer kl_dev_…
Idempotency-Key: 4c1e…

{ "name": "payouts-bot", "expiresInSeconds": 604800, "template": "payments-agent",
  "fill": { "accounts": ["eip155:8453:0x4f18…"], "recipients": ["eip155:8453:0x1111…"] } }
```

- The response carries the raw key once (`key.key`, `kl_agt_` + 32 base62
  characters) and the rule book's version 1. Without `policy` or `template`
  the agent is an **observer**: it can plan, quote and dry-run, nothing is
  stored or prepared.
- Agent keys sit at most **2 levels** below a project key
  (`409 KEY_DEPTH_EXCEEDED`); a project holds at most **100** active agent
  keys (`409 AGENT_KEY_LIMIT_REACHED`).
- `expiresInSeconds` is 3,600 to 31,536,000 (default 30 days) and never later
  than the parent's expiry. `PATCH /v1/keys/{id}` with `{ "expiresAt" }`
  shortens at once; extending is a loosening and is refused while the key's
  rule book has an amendment delay. Project keys may clear their expiry with
  `null`; agent keys always expire.
- `DELETE /v1/keys/{id}` revokes the key **and its whole subtree**
  (`key.revoked` lists the cascade). An agent key may revoke keys of its own
  subtree, never itself or anything above it.
- Every request of an agent key checks its lineage: a revoked or expired
  ancestor stops it immediately on the answering instance and within 15
  seconds everywhere. Intents it created stop being prepared
  (`403 POLICY_OWNER_REVOKED`); steps already submitted keep settling.
- `GET /v1/keys` shows `kind`, `parentId`, `depth`, `expiresAt`,
  `policyVersion` and `descendants` for every key. Agent keys see themselves
  and their subtree.

### What an agent key may do

| Endpoint | Project key | Agent key |
|---|---|---|
| `POST /v1/keys` (a project key) | yes | never (`403 AGENT_KEY_FORBIDDEN`) |
| `POST /v1/keys/{id}/children` | yes | `permissions.createChildKeys`, under itself |
| `PUT` / `DELETE …/policy` | yes | never, its own rule book included |
| Webhooks (create, delete, test) | yes | `permissions.webhooks` |
| Custom contract writes | yes | `permissions.registerContracts` |
| `POST /v1/sessions` | yes | `permissions.sessions` |
| Stored intents (`POST /v1/intents`) | yes | `permissions.storeIntents` and the chain |
| MCP `create_intent` | yes | `permissions.mcpCreateIntents` |
| `POST /v1/links` (publish a link) | yes | `permissions.links` and the chain |
| Approve or reject | yes, outside the requester's subtree | never |
| Reads (`GET /v1/policy/*`, decisions, spend) | the whole project | itself and its subtree |

## The document

```json
{
  "schema": "kletia.policy/v1",
  "label": "Payouts bot",
  "networks": { "allow": ["base", "arbitrum", "solana"], "lanes": ["production"] },
  "kinds": { "allow": ["transfer", "swap", "bridge"] },
  "assets": { "allow": ["group:USDC"], "unlisted": "deny" },
  "accounts": { "allow": ["eip155:*:0x4f183e308f24c81c05303821AD025812fBFd807D"] },
  "recipients": { "mode": "allowlist", "allow": ["eip155:8453:0x1111111111111111111111111111111111111111"], "names": "resolve" },
  "limits": { "maxSteps": 3, "maxSlippageBps": 50, "maxFeeUsd": "5" },
  "caps": { "perIntentUsd": "500", "dailyUsd": "2000", "weeklyUsd": "8000" },
  "schedule": { "timezone": "Europe/Paris", "windows": [{ "days": ["mon", "tue", "wed", "thu", "fri"], "from": "08:00", "to": "20:00" }] },
  "confirm": { "aboveUsd": "250", "when": ["cross-network"], "approvers": { "wallets": ["eip155:1:0x9a…"] }, "ttlSeconds": 3600 },
  "permissions": { "storeIntents": true, "mcpCreateIntents": true },
  "execution": { "pinNonce": true },
  "amendments": { "delaySeconds": 86400 }
}
```

| Field | Rule ids | Effect |
|---|---|---|
| `mode` | `mode.paused`, `mode.dryRun` | `paused`: nothing new is planned or prepared; `dry-run`: plans and dry runs only. |
| `networks.allow`, `networks.lanes` | `networks.allow`, `networks.lanes` | Every step's network (and a bridge's destination) must be listed; lanes are `production` and `testnet`. |
| `kinds.allow` | `kinds.allow` | Action kinds (`transfer`, `swap`, `bridge`, `stake`, `deposit`, `withdraw`, `call`, `action`, …). |
| `protocols.allow` / `deny` | `protocols.allow`, `protocols.deny` | Venues; deny always wins. |
| `contracts.allow` | `contracts.allow` | Custom contract registrations (and entries) the key may call. Agent default: none. |
| `assets.allow`, `categories`, `unlisted` | `assets.*` | `SYMBOL`, `SYMBOL@network`, `group:USDC`, CAIP-19 ids; categories such as `stablecoin`; `unlisted: "deny"` refuses assets outside the registry (position tokens of the registry's lending venues, such as aTokens and vault shares, count as listed). |
| `accounts.allow` | `accounts.allow` | CAIP-10 accounts (or `eip155:*:<address>`) the intent may spend from. |
| `recipients` | `recipients.mode`, `recipients.deny`, `recipients.names` | `own` (only the intent's own accounts; agent default), `allowlist` or `any`; names (ENS, Basenames, SNS) `deny`, `resolve` (checked after resolution) or `trusted`. |
| `limits` | `limits.*` | Steps, slippage, value paid on top of the input, network fees, settlement time. Tightens the intent's own constraints before planning. |
| `caps` | `caps.perStepUsd`, `caps.perIntentUsd`, `caps.dailyUsd`, `caps.weeklyUsd` | USD caps; daily and weekly are rolling 24 h and 7 d windows of exposures. |
| `schedule` | `schedule.window` | Payloads are prepared only inside the windows (IANA time zone). Plans outside a window carry a warning. |
| `confirm` | `confirm.aboveUsd`, `confirm.externalRecipient`, `confirm.contractCall`, `confirm.crossNetwork` | Holds the intent for an approval (see below). |
| `permissions` | `permissions.*` | API rights of an agent key (ignored on project keys). |
| `execution.pinNonce` | `execution.pinNonce` | EVM payloads pin the account nonce, so re-preparing a step replaces its exposure instead of adding one. Agent default: on. |
| `amendments.delaySeconds` | | How long a loosening waits before it applies (0 to 7 days). |

On a project key an absent field restricts nothing. On an **agent key**
absent fields take safe defaults (recipients `own`, no contracts, unlisted
assets denied, nonce pinning on, permissions off except `storeIntents`), so
forgetting a section never widens an agent. `GET /v1/keys/{id}/policy`
returns the stored document and the `effective` chain with defaults filled
in.

Validate locally with `validatePolicy` or with `POST /v1/policy/validate`
(public): it returns `issues`, `warnings` (such as `NO_CAPS` or
`ACCOUNTS_NOT_PINNED`), the canonical `hash`, and with `against` what a
change tightens and loosens.

Templates (`template` on child creation, `POLICY_TEMPLATES` in core):
`observer`, `payments-agent`, `treasury-rebalancer`, `contract-operator`.

## Versions: tighten now, loosen later

```http
PUT /v1/keys/{id}/policy          (or /v1/projects/current/policy)
Authorization: Bearer kl_dev_…
If-Match: "sha256:9c1f…"
Idempotency-Key: 0b6f…
```

- Only **project keys** with their current secret write rule books (agent
  keys get `403 AGENT_KEY_FORBIDDEN`; a rotated-out secret
  `403 KEY_SECRET_ROTATED`).
- A write that only **tightens** (or the first version) applies at once
  (`applied: "now"`, `policy.amended`). A write that **loosens** anything is
  stored as `pending` until `activatesAt = now + amendments.delaySeconds`
  (`applied: "pending"`, `policy.amendment_pending` with the loosened paths).
  The delay in force is the current version's, so a delay cannot be removed
  and used in the same write. A later write supersedes a pending one.
- `DELETE …/policy` removes the rule book; removal is a loosening and waits
  like one (`409 POLICY_AMENDMENT_PENDING` while another amendment is
  pending). `DELETE …/policy/pending` cancels a pending amendment
  (`404 POLICY_NOT_FOUND` when none).
- `If-Match` takes the current hash (`ETag` of the last write) or `none`;
  a mismatch is `409 POLICY_CONFLICT`. Without it the write is unconditional.
- `GET /v1/keys/{id}/policy/versions` lists every version with its status
  (`active`, `pending`, `superseded`, `cancelled`, `removed`), what it
  tightened and loosened, and who wrote it. Due amendments are promoted
  lazily on read and by a background promoter every 30 seconds.
- Rule book writes take the same per-project lock as spend reservations, so
  a pause that committed is seen by every later prepare.

## Enforcement

| Point | What is checked |
|---|---|
| Plan (`POST /v1/intents`, dry runs, MCP `plan_intent`) | Every rule of the chain on the planned graph. The request's constraints are narrowed first (slippage, fees, time, avoided protocols) so the planner picks routes that fit. Stored intents get a stamp (`intent.policy`: decision id, outcome, chain hashes, USD value). Plans already over a window cap are refused early. |
| Prepare | The chain is read again (a rule book may have changed since the plan), prices are fresh, the schedule is checked, and the payload's USD value is **reserved atomically** against every capped scope. The payload carries `policy: { decisionId, exposureId, notionalUsd, chainHashes }`. |
| Submit | Pinned EVM nonces are compared with the landed transaction; a mismatch is recorded as an observed violation. |

Refusals are errors with `error.policy`:

```json
{ "error": { "code": "POLICY_SPEND_LIMIT", "message": "…",
    "policy": { "decisionId": "pdc_…", "stage": "prepare", "outcome": "deny", "keyId": "key_…",
                "violations": [{ "rule": "caps.dailyUsd", "scope": "key", "keyId": "key_…", "observed": "2140.00", "limit": "2000.00", "message": "…" }],
                "retryAt": "2026-10-10T08:12:00Z" } },
  "requestId": "…" }
```

| Code | Status | Retry |
|---|---|---|
| `POLICY_VIOLATION` | 403 | No: change the request. Lists every violated rule. |
| `POLICY_SPEND_LIMIT` | 403 | After `Retry-After` / `retryAt`, when enough of the window has rolled off. |
| `POLICY_SCHEDULE_CLOSED` | 403 | After `Retry-After`, when the next window opens. |
| `POLICY_PRICE_UNAVAILABLE` | 503 | Shortly: a USD rule needs a price no fresh source covers. |
| `POLICY_OWNER_REVOKED` | 403 | No: the owner key or an ancestor is revoked or expired. |
| `POLICY_APPROVAL_REQUIRED` | 403 | After an approver approves (`error.policy.approval.url`). |
| `POLICY_APPROVAL_REJECTED`, `POLICY_APPROVAL_EXPIRED`, `POLICY_APPROVAL_STALE` | 403, 410, 409 | No: plan a new intent. |
| `AGENT_KEY_FORBIDDEN` | 403 | No: the agent lacks the permission. |

Retryable policy errors are never stored by `Idempotency-Key`, so a retry is
evaluated again. Set `KLETIA_POLICIES_ENABLED=false` to stop enforcing
(rule books stay stored; `GET /v1/health` reports `policies.enabled`).

### Prices

USD rules use a conservative oracle: Chainlink feeds (read on-chain, fresh
within the feed's heartbeat) and Jupiter prices (liquid and recent), and the
**highest** fresh source wins, so a wrong high price can only tighten; USD
stablecoins never count below $1. Testnet assets count as $0. An amount no
fresh source prices fails closed under a USD rule
(`POLICY_PRICE_UNAVAILABLE`); without USD rules nothing is priced.

## Spend caps and the exposure ledger

A payload counts against `dailyUsd` and `weeklyUsd` from the moment it is
handed out, not when it lands, because Kletia cannot know whether a signed
transaction will be broadcast. Each exposure is written once per scope (the
key, each ancestor and the project), and the reservation reads usage, checks
every cap and inserts under one PostgreSQL advisory lock per project, so
concurrent prepares on many instances cannot overspend: 60 concurrent $30
prepares under a $1,000 project cap accept exactly 33 (this repository's
test suite runs that against PostgreSQL).

- With nonce pinning (agent default), re-preparing a step on the same nonce
  replaces its exposure (the larger amount counts once).
- Solana payloads whose blockhash expired unsubmitted stop counting (the
  reaper checks every minute); a payload that was never returned (the intent
  commit failed) is marked dead at once.
- `GET /v1/policy/spend?keyId=` shows usage and what remains at every level.
- `policy.spend_threshold` fires when a window crosses 80 % and 95 % of a cap.

Without a database the ledger lives in memory: correct for one instance only.

## Approvals

When `confirm` triggers on a stored intent, the intent is planned and held:
`intent.policy.outcome` is `confirm` and `intent.policy.approval` gives the
approval id, its URL (`https://kletiaai.xyz/approve#apr_…`), the expiry
(`confirm.ttlSeconds`, default 1 hour) and the **ceiling**
(`ceil(value at hold time × 1.02)`). Prepare answers
`403 POLICY_APPROVAL_REQUIRED` with `Retry-After` until it is decided.

- The URL is safe to hand to the agent: reading an approval
  (`GET /v1/policy/approvals/{id}`) is not approving it. It shows the steps,
  recipients, value, ceiling, triggers and what to sign; wallets are masked.
- **Deciders.** `POST /v1/policy/approvals/{id}/approve` (or `/reject`) with
  an empty body and a project key outside the requester's subtree (only the
  keys in `confirm.approvers.keys` when that list is set; never with
  `requireWallet`); or with `{ account, signature, expiresAt }` from a wallet
  in `confirm.approvers.wallets`:
  - EVM: EIP-712 typed data `approvalTypedData(...)` (domain
    `Kletia Approvals`, version 1): EOAs, ERC-1271 smart accounts and ERC-6492
    counterfactual accounts;
  - Solana: an ed25519 signature of `approvalMessageText(...)`.
- What is approved is the digest of the plan, the decision and the ceiling.
  Prepare re-quotes; if the fresh value exceeds the ceiling the approval is
  stale (`409 POLICY_APPROVAL_STALE`). Rejecting cancels the intent.
- A decision is final (`409 APPROVAL_DECIDED`); an undecided approval
  expires (`410 POLICY_APPROVAL_EXPIRED`). Events: `policy.approval_requested`
  and `policy.approval_decided`.

## The decision log

Every decision is appended under the project lock with `seq`, `prevHash`
and `chainHash = 0x + sha256(prevHash + "\n" + canonical JSON of the record)`,
so any edit or gap is detectable with `verifyDecisionChain` from
`@kletia/core`. Records carry the owner (`keyId`), the caller
(`actorKeyId`), the stage, outcome, chain, USD value, every violation and
trigger, and `requestDigest` (the request itself is not stored).

`GET /v1/policy/decisions` filters by `outcome`, `stage`, `keyId`,
`intentId`, `since` and pages with `after`; it returns the project's chain
head. Decisions are kept 30 days (`KLETIA_POLICY_DECISION_RETENTION_DAYS`,
1 to 3,650). Beyond 50,000 decisions per project and day, allowed dry-run plans and
evaluations are no longer stored; refusals, holds and everything
that prepares are always stored.

## Simulator

`POST /v1/policy/evaluate` plans a request as a dry run for a key of your
subtree and explains every rule (`pass`, `fail`, `trigger`, `warn`), with
usage per window, the timetable and the code a real request would get.
`policy` replaces the key's own rule book with a draft (what-if) and `at`
moves the clock for the timetable. When the request cannot be planned,
`planError` says why and `complete: false` marks that only request-level
rules ran (an `allow` is then not a full pass). Nothing is stored, reserved or
held. 30 evaluations per minute per key.

## Webhooks

Rule Book and key events go to the subject key's webhooks:
`policy.violation`, `policy.approval_requested`, `policy.approval_decided`,
`policy.amendment_pending`, `policy.amended`, `policy.spend_threshold`,
`key.created`, `key.revoked`. A webhook created with `"scope": "subtree"`
also receives the events (and the intent, receipt and link events) of every
descendant agent key, and on a project key the project-wide rule book events.

## Usage per key

`GET /v1/usage?scope=subtree` adds `subtree.keys`: for each key of the
caller's subtree (project keys: the whole project), its requests in the
window, intents created by status and the rolling 24 h / 7 d USD notional
counted against caps.

## Running agents safely

The Rule Book bounds what Kletia plans and prepares for a key. It cannot
stop a wallet that signs transactions built elsewhere. For autonomous agents,
keep the wallet out of the model's process: the model talks to Kletia
through MCP with an agent key (it can plan, check and create intents and
hand out approval and signing links); a separate signer holds the wallet,
executes intent ids and refuses payloads whose `policy.chainHashes` do not
match the rule books it expects. Add wallet-level limits where your wallet
supports them.

Known limits:

- A private custom contract registration of an ancestor key is not usable by
  an agent key through `contracts.allow` alone; register it with project
  visibility.
- In-memory stores (no `KLETIA_DATABASE_URL`) are single-instance.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `KLETIA_POLICIES_ENABLED` | `true` | `false` stops enforcement (rule books stay stored). |
| `KLETIA_POLICY_DECISION_RETENTION_DAYS` | `30` | Decision log retention. |
| `KLETIA_DATABASE_URL` | none | Rule books, exposures, decisions and approvals in PostgreSQL (required for more than one instance). |
| `KLETIA_PLATFORM_SECRET` | none | Seals stored agent-key responses for `Idempotency-Key` replay. |
