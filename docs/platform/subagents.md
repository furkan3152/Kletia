# Sub-agents: agents that ask for agents

A **main agent** (an agent key whose rule book grants
`permissions.createChildKeys`) can ask for a **sub-agent**: a new agent key
below itself with a rule book that is never wider than its own. Nothing is
minted until the project's owner approves the request with a wallet
signature, or a project key holder approves it in the portal. Sub-agents are
**permissionless** by default: they plan and prepare intents inside their caps
and never manage keys, webhooks, contracts, sessions, links or automations. Perps
stay off unless the parent's chain trades them, at no higher leverage and on no
other venue; so do [prediction markets](predictions.md), at no higher stake per
order (`predictions.maxStakeUsd` must be set) and on no other venue.

Kletia never holds keys and never signs. A sub-agent is an API key like any
other agent key: every request it makes is checked against the whole chain
(project, every ancestor, itself), and a wallet still signs every
transaction.

- Reference: `checkSubagentPolicy`, `subagentApprovalMessage`,
  `describeSubagentGrant` and `SUBAGENT_LIMITS` in `@kletia/core`.
- Endpoints: OpenAPI tag `Sub-agents`; errors in [errors.md](errors.md).
- Agents: the [MCP tools](mcp.md) `request_subagent`, `list_subagents`,
  `claim_subagent` and `revoke_subagent`.
- Portal: **Agents** (`/developers/agent-tree`).

## Design

### Roles

| Role | Who | May |
|---|---|---|
| Main agent | Agent key whose effective chain grants `permissions.createChildKeys` | Request sub-agents under itself, list them, claim an approved one, revoke its descendants. |
| Sub-agent | Agent key minted from an approved request | Plan, check, store and prepare intents within its rule book (and every ancestor's). Nothing else unless the request asked for a permission its parent has (see below). |
| Owner | The wallet that owns the project ([accounts.md](accounts.md)) | Approve or deny with a wallet signature. |
| Project key holder | Anyone holding an active `kl_dev_` key of the project (current secret) | Approve or deny in the portal or the API; revoke and pause any agent. |

Agent keys no longer create child keys directly (`POST /v1/keys/{id}/children`
answers `403 AGENT_KEY_FORBIDDEN` to an agent key): every key an agent gets
below itself goes through a request and a human decision. Project keys keep
creating agent keys directly.

### The request

`POST /v1/agents/{parentId}/subagents` with the parent's own agent key:

```json
{ "name": "invoice-payer", "purpose": "Pays approved supplier invoices on Base.",
  "policy": { "schema": "kletia.policy/v1", "mode": "live", "networks": { "allow": ["base"] },
              "kinds": { "allow": ["transfer"] }, "assets": { "allow": ["group:USDC"] },
              "caps": { "perIntentUsd": "200", "dailyUsd": "500", "weeklyUsd": "1500" } },
  "expiresInSeconds": 604800 }
```

- `name` 1-64 printable characters, `purpose` 1-280, `policy` a
  `kletia.policy/v1` document (or `template` + `fill`, as for child keys;
  default: the observer), `expiresInSeconds` 3,600 to 31,536,000 (default
  7 days).
- The child's rule book must be a **subset of the parent's effective chain**
  (`checkSubagentPolicy`): for every level of the chain (the project, every
  ancestor, the parent) the child is at least as tight, field by field:
  - allowlists (networks, lanes, kinds, protocols, contracts, assets,
    categories, accounts, recipient allowlists) are subsets; an absent
    allowlist means "everything" and is only allowed when the level has none;
  - denylists (protocols, recipients) are supersets;
  - limits and caps (`limits.*`, `caps.perStepUsd`, `perIntentUsd`,
    `dailyUsd`, `weeklyUsd`) are present and not higher wherever the level
    sets one;
  - the mode is at least as strict (`live` < `dry-run` < `paused`),
    recipients at least as strict (`own` < `allowlist` < `any`), names at
    least as strict, unlisted assets denied when the level denies them,
    nonce pinning on when the level pins;
  - the timetable is the same time zone and opens only inside the level's
    windows; confirmation thresholds are not higher, triggers a superset,
    approver wallets and keys only ones the chain already lists, the
    confirmation window not longer and the amendment delay not shorter;
  - **permissions**: `webhooks`, `registerContracts`, `sessions` and `links`
    are never granted to a sub-agent; `storeIntents`, `mcpCreateIntents` and
    `createChildKeys` only when the parent's chain grants them, and
    `createChildKeys` only above the depth limit. Every permission the request
    does not ask for is written as `false` in the minted rule book, so a
    sub-agent starts with none ("permissionless");
  - the expiry is not later than the parent's.

  "Subset" allows equality: a sub-agent can be as wide as its parent, never
  wider. A request that fails is refused with `403 SUBAGENT_POLICY_NOT_SUBSET`
  and one issue per field (`issues[].path`).
- Limits: sub-agents sit at most **3 levels** below a project key (the
  `KEY_DEPTH_EXCEEDED` limit of every agent key), a parent has at most **10**
  children and open requests together, and at most **5** open requests
  (`409 SUBAGENT_LIMIT_REACHED`).
- The answer (201) is the request (`sar_` + 32 hex) and a **claim token**
  (`kl_scl_` + 43 characters) shown once; only its SHA-256 is stored. A
  request stays open 24 hours (never past the parent's expiry).
- Event: `agent.subagent_requested`.

### Approval

The request names exactly what would be granted: the parent, the child's
rule book hash (`sha256:` of the canonical document), its caps, networks,
kinds, permissions and the key's expiry. `GET /v1/agents/requests/{id}` and
the portal show it in plain words with a diff against the parent
(`describeSubagentGrant`).

- **Owner wallet.** `POST /v1/agents/requests/{id}/challenge`
  `{ decision, walletKind, address, chainId? }` from the Kletia portal origin
  returns a message in the Sign-In-With-Ethereum / Sign-In-With-Solana shape
  (`subagentApprovalMessage`): the origin's domain, the wallet, the decision,
  request, project, parent, name, rule book hash, caps, networks, kinds,
  permissions, key expiry, a single-use nonce, the issue time and an expiry
  of 10 minutes. Only the project's owner wallet gets one
  (`403 SUBAGENT_APPROVER_NOT_ALLOWED`). The wallet signs it (EIP-191
  `personal_sign`, ERC-1271 / ERC-6492 for smart accounts on Base, Ethereum,
  Arbitrum, OP or Polygon; ed25519 for Solana) and the portal sends
  `{ message, signature }` to `…/approve` or `…/deny` from the same origin.
- **Replay protection.** The nonce is stored as a hash on the request and
  consumed (one conditional write) before the signature is checked; the
  message must be byte-for-byte the stored one (so the decision, rule book
  hash, domain and expiry cannot be changed); an expired, used or
  superseded message is `403 SUBAGENT_SIGNATURE_INVALID`. A smart-account
  check that cannot reach its chain is `502 RPC_UNAVAILABLE`, never valid.
- **Project key.** The same routes with an empty body and an active project
  key of the project with its current secret. Agent keys, publishable keys,
  operator keys and rotated-out secrets never decide.
- On approval the chain is read again: the parent and every ancestor must
  still be active (`409 SUBAGENT_PARENT_INACTIVE`) and the rule book must
  still be a subset (a parent tightened since the request:
  `403 SUBAGENT_POLICY_NOT_SUBSET`). A decision is final
  (`409 SUBAGENT_REQUEST_DECIDED`); an open request past its expiry is
  `410 SUBAGENT_REQUEST_EXPIRED`.
- Approval mints the child key **once** (a single conditional write moves the
  request from pending), writes its rule book as version 1, records a key
  decision in the project's hash-chained decision log and emits
  `key.created` and `agent.subagent_approved`. A denial emits
  `agent.subagent_denied`.

### Claim

The key is minted with a secret nobody sees. `POST
/v1/agents/requests/{id}/claim` `{ claimToken }`, with the requesting
parent's own key, sets a fresh secret and returns it once (`key.key`):

- the token is compared in constant time (`timingSafeEqual` of SHA-256
  digests), works once, and only within **15 minutes** of the approval;
- a wrong token, another key, a second claim or a late claim is
  `403 SUBAGENT_CLAIM_INVALID`; a late claim also revokes the unclaimed key,
  so a key nobody claimed never lingers. Ask again with a new request.
- The secret is never logged, never stored (only its hash) and never part of
  an event or a webhook.

### Revoke, pause, cascade

- `POST /v1/agents/{id}/revoke`: the key and its whole subtree stop at once
  (`DELETE /v1/keys/{id}` semantics; agents may revoke their own descendants
  only). Emits `key.revoked` and `agent.subagent_revoked` with the cascade.
- `POST /v1/agents/{id}/pause` (project keys): writes `mode: "paused"` into the
  key's rule book, a tightening that applies at once. Because every request
  reads the chain fresh, pausing or revoking a parent stops every descendant
  immediately. Resume from the Rule Book (loosening waits the amendment delay).
- Open requests of a parent that is revoked or expired are cancelled.

### Budget

Every payload a sub-agent prepares is written to the exposure ledger once per
scope of its chain: the sub-agent, every ancestor and the project. The
parent's `dailyUsd` and `weeklyUsd` caps therefore count everything its
sub-agents spend, so a sub-agent can never be used to exceed its parent's
budget. `GET /v1/agents/tree` shows each key's caps and its 24 h and 7 d use.

### Notifications

- Webhooks (subject: the parent key; routed like `key.*` events):
  `agent.subagent_requested`, `agent.subagent_approved`,
  `agent.subagent_denied`, `agent.subagent_revoked`.
- `GET /v1/agents/pending?account=<CAIP-10>` (public) answers only
  `{ pending }`, the number of open requests in projects that wallet owns,
  so the desk can show "a sub-agent waits for your approval" for the
  connected wallet. It reveals that count and nothing else (no names, ids or
  projects); the decision itself always needs the signature or a project
  key.

## Endpoints

| Method and path | Caller | What |
|---|---|---|
| `POST /v1/agents/{id}/subagents` | The agent `{id}` itself | Request a sub-agent; 201 with the request and the claim token (once). |
| `GET /v1/agents/{id}/subagents` | `{id}` or an ancestor; project keys | Requests and child keys of `{id}`. |
| `GET /v1/agents/tree` | Any key | The caller's subtree (project keys: the project) with caps, use and open requests. |
| `GET /v1/agents/requests/{id}` | A key of the request's subtree; project keys | One request, its summary and its diff against the parent. |
| `POST /v1/agents/requests/{id}/challenge` | Portal origin | The message the owner's wallet signs. |
| `POST /v1/agents/requests/{id}/approve` · `/deny` | Owner wallet signature or project key | Decide. |
| `POST /v1/agents/requests/{id}/claim` | The requesting agent | The sub-agent's secret, once. |
| `POST /v1/agents/{id}/revoke` | Project key; ancestors | Revoke the key and its subtree. |
| `POST /v1/agents/{id}/pause` | Project key | Pause the key (and so its subtree). |
| `GET /v1/agents/pending?account=` | Public | Open requests of the wallet's projects (a count). |

## MCP tools

| Tool | What |
|---|---|
| `request_subagent` | `{ name, purpose, policy?, template?, fill?, expiresInSeconds? }`: files a request under the connecting agent key; returns the request id, the claim token (once) and what the human will see. |
| `list_subagents` | The connecting key's requests (status) and sub-agents (caps, use). |
| `claim_subagent` | `{ requestId, claimToken }`: the approved sub-agent's key, once. |
| `revoke_subagent` | `{ keyId }`: revokes a sub-agent of the connecting key's subtree with its descendants. |

Hand the new key to the sub-agent's own process; it connects to MCP with it
and `get_policy` shows its leash.

## Configuration

Nothing to set. Requests live in PostgreSQL with `KLETIA_DATABASE_URL`
(`kletia_subagent_requests`), in memory otherwise (one instance only). Owner
wallet approvals need the project to have an owner
([accounts.md](accounts.md)).
