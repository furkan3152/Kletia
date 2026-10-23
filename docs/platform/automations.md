# Automations

An automation is a rule: when its trigger holds, Kletia plans an intent for
the owner. Kletia never signs, so a fired run either waits in the owner's
inbox for a wallet signature, or is handed to a protocol-native order type
that executes it without the owner online (a *native order provider*, when
one supports the automation; `execution.mode` says which).

```text
trigger holds ──▶ run (one per window) ──▶ dry run ──▶ limits ──▶ stored intent ──▶ native provider?
                                                       │                               ├─ yes: run `prepared`
                                                       └─ outside: run `skipped`        └─ no:  run `needs_signature` (inbox)
```

## Owners

| Owner | How | Scope |
|---|---|---|
| API key (project or agent) | `Authorization: Bearer kl_dev_…` / `kl_agt_…` | The key's rule book applies to every run's plan (caps per run, schedules, recipients). Agent keys need `permissions.automations` to create, change or resume; pausing and deleting are always allowed. Events go to the key's webhooks. |
| Wallet (desk user) | `Kletia-Account-Session` from wallet sign-in, first-party origin | Every account the automation spends from or watches must be the signed-in wallet's own address (`403 AUTOMATION_ACCOUNT_FORBIDDEN`). No webhooks: the inbox. |

Without either, `401 AUTOMATION_OWNER_REQUIRED`. Another owner's id answers
`404 AUTOMATION_NOT_FOUND`. Publishable keys cannot use these routes.

## Triggers

Every trigger is evaluated once a minute, in UTC.

| `kind` | Fields | Fires |
|---|---|---|
| `schedule` | `every: { unit: hour \| day \| week \| month, count }`, `startAt`, `endAt?`, `maxRuns?`, `timezone?` | At `startAt + n × every`. Steps are fixed UTC durations (months keep the start's day, clamped to short months), so daylight saving never moves a run; `timezone` is for display. A missed slot is not caught up: the latest due slot fires once. |
| `price` | `asset`, `network`, `direction: above \| below`, `priceUsd`, `hysteresisBps?` | When the oracle price (the Rule Book's sources: Chainlink, Pyth, Jupiter; fresh readings only) crosses the line. |
| `balance` | `account` (CAIP-10), `asset`, `direction`, `amount`, `hysteresisBps?` | When the account's balance crosses the amount. |
| `apy` | `asset`, `networks`, `minDeltaBps`, `current?` | When the best EVM lending venue for the asset beats the current one by `minDeltaBps` (or at once when there is no position yet). |
| `event` | `account`, `asset`, `minAmount?` | When the balance grows by at least `minAmount` between two reads (an incoming transfer). |

Crossings fire once and then wait: the trigger re-arms only after the value
moves back past the line by `hysteresisBps` (default 100 = 1 %), so a price
hovering at 120 fires one run, not one a minute. The first observation only
arms: a condition already true when the automation is created fires at the
next crossing. A read that fails observes nothing and never fires.

## Actions

- `{ "kind": "intent", "text"?, "actions"?, "accounts", "sourceNetwork"?, "constraints"? }`:
  the same request as `POST /v1/intents`, planned again at every run. Kletia
  sets `metadata.automationId`, `metadata.automationRunId` and
  `clientReference: "automation:<runId>"`.
- `{ "kind": "rebalance", "accounts", "amount"? }` (apy triggers only):
  withdraw everything from the current venue, bridge when the best venue is
  on another network, deposit at the best venue; `amount` is the first
  deposit when there is no position yet.

## Limits

| Field | Effect |
|---|---|
| `maxUsdPerRun`, `maxUsdTotal` | Checked on the dry run's inputs, priced by the oracles. An unpriced input skips the run (`unpriced`). Skipped runs never count against the total. |
| `expiresAt` | Default 180 days, at most 366. The automation then ends (`expired`). |
| `cooldownSeconds` | Least time between two planned runs (`cooldown`). |
| `networks`, `protocols` | Every step of the plan must stay inside (`network_not_allowed`, `protocol_not_allowed`). |
| `maxSlippageBps` | Caps the plan's slippage per swap step (the tighter of this and the action's own). |

Rule books still apply on top for key owners: a refusal (`POLICY_SPEND_LIMIT`,
`POLICY_VIOLATION`, …) fails the run with that code.

## Runs

One run per *window*, ever: a schedule slot (`slot:<ISO>`), a crossing
(`cross:<n>`), an incoming transfer (`in:<n>`) or a rebalance (`apy:<n>`).
The window is unique in storage, so two evaluators racing (or a retry after
a crash) never plan twice.

| `status` | Meaning |
|---|---|
| `firing` | Being planned (a run left here 15 minutes is failed as interrupted). |
| `needs_signature` | An intent is planned and waits for the owner's wallet (the inbox). |
| `prepared` | A native order provider took it (`provider.reference`). |
| `skipped` | A limit refused it (`reason`). |
| `failed` | Planning failed (`reason` is the error code). |

## API

| Route | |
|---|---|
| `POST /v1/automations` | Create (`201 { automation }`; `Idempotency-Key` with a key). |
| `GET /v1/automations` | The owner's automations, with `nextRunAt`, `lastRunAt`, `runs`, `spentUsd`. |
| `GET /v1/automations/inbox` | Runs of the last 7 days whose intent is still `planned` or `executing`. Open each intent's normal sign flow (`/v1/intents/{id}/steps/{stepId}/prepare`). |
| `GET`, `PATCH`, `DELETE /v1/automations/{id}` | Read; change `label` and `limits` only (`409 AUTOMATION_CONFLICT` on a concurrent change); delete. |
| `POST /v1/automations/{id}/pause`, `…/resume` | A completed or expired automation does not resume (`409 AUTOMATION_ENDED`). |
| `GET /v1/automations/{id}/runs` | Newest first, `?limit=` up to 100. |

```bash
curl -X POST https://api.kletiaai.xyz/v1/automations \
  -H "Authorization: Bearer $KLETIA_KEY" -H "Content-Type: application/json" \
  -d '{
    "label": "Weekly ETH",
    "trigger": { "kind": "schedule", "every": { "unit": "week", "count": 1 }, "startAt": "2026-10-26T06:00:00Z", "timezone": "Europe/Istanbul" },
    "action": { "kind": "intent", "text": "buy $50 of ETH", "accounts": ["eip155:8453:0x4f183e308f24c81c05303821AD025812fBFd807D"] },
    "limits": { "maxUsdPerRun": "60", "maxUsdTotal": "1000" }
  }'
```

`validateAutomationDraft` in `@kletia/core` reports the same issues locally.

From a sentence, the reader returns the validated draft as a hand-off
([clarify](clarify.md#hand-offs)): "buy $50 of ETH every Monday", "if SOL
drops below 120 sell half", "every month send 100 USDC to vitalik.eth on
base", "keep my USDC in the best yield", "when USDC arrives, deposit it into
aave". It prefers a native order where one runs the same thing (a swap with
an end, a take-profit sell) and says so. A run's sentence is checked to read
again without questions: runs plan it through the exact deterministic reader
(`CreateIntentOptions.exactReading`), so "sell half of my SOL for USDC on
solana" sells half of the balance at that run.
`planAutomationFromGoal({ trigger, action }, { now, accounts })` turns a
typed goal ("every Monday", "if SOL drops below 120") into a draft; it
computes the UTC `startAt` from a local weekday and time once.

Limits: 50 live automations and 30 creations an hour per owner; 1000 runs
at most per schedule (`maxRuns`).

## Events

`automation.created`, `automation.updated` (paused, resumed, changed,
completed, expired), `automation.deleted`, `automation.fired`,
`automation.skipped` and `automation.failed`, with `{ automationId,
ownerKeyId, runId?, intentId?, status?, reason? }`, go to the owning key's
webhooks (and `scope: "subtree"` webhooks of its ancestors) and its event
stream. Wallet-owned automations send none.

## Evaluator

Long-running hosts evaluate every minute (`startPlatformBackground`). With
Postgres (`KLETIA_DATABASE_URL`) one instance runs each pass under an
advisory lock; tables `kletia_automations` and `kletia_automation_runs` are
created on first use. Without a database, automations live in memory and
are lost on restart. Runs are kept 90 days.

## Native order providers

`NativeOrderProvider` (`@kletia/core`) is the interface protocol order types
plug into: `supports(automation)` and `execute({ automation, runId, intent })`
→ `{ accepted: true, reference }` or `{ accepted: false, reason }`. The API
registers them with `configureNativeOrderProviders`. A declined or failing
offer falls back to the owner's signature; nothing is executed on a guess.

## The desk

The **Automations** view of `/app` creates automations from templates (buy
every week, take profit or stop loss, keep a stablecoin in the best yield,
sweep incoming funds, pay someone monthly), lists them with their next and
last run, pauses, resumes and deletes them, and shows the inbox: each fired
run opens the normal review-and-sign flow. It signs in with the wallet
(the same wallet sign-in as developer accounts) and can raise a browser
notification when a new run waits.
