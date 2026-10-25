# Data retention and recipients

What Kletia stores, where, for how long, who else receives what, and how to
delete it. Every period below is enforced by code (the file is named); where
nothing deletes a record automatically, this page says so. The public summary
is the site's [Privacy & data](https://kletiaai.xyz/privacy) page.

Kletia never holds keys and never signs: your wallet signs every transaction,
and signed transactions are public on their networks (amounts, addresses,
timing), whatever Kletia stores.

## Where data lives

- **API storage.** With `KLETIA_DATABASE_URL` set, PostgreSQL (the tables
  named below). Without it, process memory: bounded LRU stores, all lost on
  restart. The periods below apply to both; memory stores may forget sooner.
- **Application logs.** The host's log stream (Render on the hosted
  deployment). Kletia writes request ids, error codes, counts and sanitized
  upstream errors (URLs, `0x` hex of 40+ characters and base58 runs of 32+
  characters replaced). It does not write request text or wallet addresses on
  purpose, and names an intent by `iref:` plus 16 hex characters of
  SHA-256(`"kletia.intent-ref.v1:" + id`), never by its id (the id is a
  bearer capability). How long the host keeps logs is the host's setting.
  Access logs of the host or a proxy can record full URLs: see
  [Data API](data.md) for the POST reads that keep addresses out of URLs.
- **Your browser.** `sessionStorage` (the desk's task index with redacted
  titles, the resume record of each task: intent id, step marks and
  references, and the assistant's model consent token) and `localStorage`
  (theme, sound, motion and departure choices, WalletConnect's own session
  data). Developer keys loaded in the portal stay in the tab's memory only.

## Intents (`POST /v1/intents`)

| What | Stored | Removed |
|---|---|---|
| Dry run (`?dryRun=true`) | Nothing in storage. Plan-time quote transactions stay in memory for previews until the quotes expire. | Not applicable |
| Request text (`request.text`), its normalized copies (`interpretation.normalizedText`, the plan record's `normalizedText`, a title that repeats it) | `kletia_intents.graph` | **24 hours after the intent is final** (completed, cancelled or expired); 7 days after its last change if it never becomes final. Replaced by `request.textRedaction`: a salted SHA-256 digest (`kletia.request-text.v1:`, a fresh 16-byte salt) and the length in code points. `updatedAt` does not change. |
| The rest of the intent: accounts, steps, amounts, recipients, quotes, routes, transaction references, metadata, `clientReference` | `kletia_intents.graph` | **30 days after the intent is final**; 90 days after its last change if it never becomes final |
| Transaction references (`<chain>:<hash>` → intent id, step id) | `kletia_intent_references` | Not deleted: they stop one transaction from completing two intents |
| Idempotent responses (keyed `POST` with `Idempotency-Key`) | `kletia_idempotency`, the response as sent (an intent included) | 24 hours after the request |
| Plan and prepare previews | `kletia_intent_previews` | 30 minutes |
| Kletia-held clarify threads (`remember: true`) | `kletia_threads`: Kletia's slots and labels, the request context (accounts, constraints, metadata), the canonical sentence of a planned turn, up to 5 intent ids | 30 minutes idle, 24 hours at most |
| Sessions from a project flow or an integrator | `kletia_sessions`: the template, allowed origins, use count | 24 hours after expiry |

The sweep runs hourly on long-running hosts (`startIntentRetentionPruner`,
`apps/api/src/platform/http/intentRetention.ts`; the rules are in
`apps/api/src/platform/engine/retentionPolicy.ts` and
`packages/core/src/retention.ts`). A serverless deployment that never runs the
background jobs never runs the sweep.

Why these periods: 24 hours covers the questions, re-quotes and reprints of a
finished intent and the receipt, which is issued after finality (usually
minutes). Thirty days keeps the intent readable for support and for wallet
history links during the usual statement period of the integrators using it,
and is past the receipt issuer's 7-day scan window, so no receipt is still
being built for a purged intent.

### Receipts

A [receipt](receipts.md) has a signed payload (a public skeleton and salted
commitments) and the disclosures that open the commitments.

- **Signed payloads and transparency-log leaves** (`kletia_receipts`,
  `kletia_receipt_batches`) are kept: they hold no request text, no amounts
  and no addresses in the clear, and the log must stay append-only.
- **When the text is removed**, the stored `intent.request` and `intent.plan`
  disclosures (and `intent.outcome` when its title was the text) are dropped
  from every receipt of the intent. From then on Kletia can no longer
  disclose those groups; a receipt downloaded earlier still carries them and
  still verifies offline. Shares already created keep their ciphertext,
  which Kletia cannot read (the key is only in the link).
- **When the intent is deleted** (30 days, or `DELETE /v1/intents/{id}`),
  every stored disclosure and every share of its receipts are deleted, as
  with `DELETE /v1/intents/{id}/receipt/disclosures`.

### Deleting an intent now

```bash
curl -X DELETE https://api.kletiaai.xyz/v1/intents/int_…
```

The intent id is the capability, as for reading it (no API key needed).
`204` deletes the intent and its receipts' stored disclosures and shares;
`404 INTENT_NOT_FOUND` when it is unknown or already gone; `409
INTENT_IN_FLIGHT` while a step is submitted, confirmed or settling (Kletia is
still following money in motion: retry once it settled or failed). The SDK:
`client.intents.delete(id)`. Signed receipt payloads, log leaves and
transaction references stay.

### The privacy trace

`POST /v1/intents` answers with `privacy` (`kletia_platform_privacy_trace_v1`,
`packages/core/src/privacyTrace.ts`): whether the request was stored, how long
the text and the intent stay, how to delete it, whether a model saw a masked
clause, and which quote providers were asked and whether they received the
account. The legacy `POST /api/intent` route returns
`kletia_intent_privacy_trace_v1`, which describes that route only (it keeps
nothing beyond a 15-minute in-memory clarification).

## Who else receives what

| Recipient | Receives | When |
|---|---|---|
| Quote providers: Relay, Across, LI.FI, deBridge, Jupiter (Raydium, Orca and Meteora routes go through Jupiter), Jupiter Lend, Kamino, KyberSwap (only when the operator enables the aggregator) and Circle's CCTP attestation service (no account) | Assets, amounts, networks and usually the wallet address (`interpretation.providersContacted[].sawAccount` says which) | At plan time, for every route compared; again at prepare. On-chain venues (Uniswap, Aave and the others) are quoted through RPC reads |
| Network RPC providers (the deployment's, else public ones) | Wallet addresses, balance and allowance reads, simulated transactions | Planning, prepare, settlement checks; your browser also reads them directly |
| Name services (ENS, Basenames, SNS) | A name you typed | When a recipient name is resolved |
| History providers: Etherscan, Alchemy, Helius (prices from DefiLlama and CoinGecko get symbols and times, no addresses) | Wallet addresses | Data API history reads and tracking |
| Model provider for reading (opt-in, see [clarify](clarify.md)) | One unread clause as a masked token list: Kletia words only, amounts and unknown words replaced, never addresses or names | Only with the switch on and consent; OpenRouter with a pinned provider, `zdr` and `data_collection: "deny"` |
| Model provider for the portfolio assistant (opt-in) | The question (addresses, names and links masked); to word an answer up to 24 computed facts (balances, amounts, fees, dates; wallets as "EVM wallet 1"), 4 gaps, 3 assumptions | Only with the switch on and consent; same OpenRouter settings ([assistant](assistant.md)) |
| Model provider for the legacy semantic planner (opt-in, legacy `/api/intent` only) | The full prompt, unmasked, and the earlier turns of that conversation | Only after the consent card; OpenRouter without a pinned provider or zero-data-retention routing |
| Webacy | The wallet address | Legacy Base intents only (address risk screening) |
| WalletConnect relay | Encrypted messages between the site and your wallet app, and connection metadata (IP, timing) | When you connect with WalletConnect |
| Your webhooks and event streams | The owner key's intent events | When an integrator configures them; queued bodies are encrypted at rest and completed rows are kept 7 days, delivery logs (no payloads) 7 days |

## Other stores

| Store | Holds | Removed |
|---|---|---|
| `kletia_account_sessions`, `kletia_account_nonces` | Desk wallet sign-in sessions and nonces | 8 hours / 5 minutes |
| `kletia_account_audit` | Sign-in attempts and account changes: wallet address, action, outcome, an IP hash | **Not deleted automatically** |
| `kletia_data_tracking` (+ members, snapshots, transactions) | Tracked wallets, value snapshots, a cache of their classified transactions | When tracking is turned off (`DELETE /v1/data/tracking`); hourly points after 8 days (daily points stay), at most 20,000 cached transactions per set |
| `kletia_policy_decisions` | Rule Book decisions: stage, outcome, codes, intent id, request digest (not the request) | 30 days (`KLETIA_POLICY_DECISION_RETENTION_DAYS`) |
| `kletia_policy_approvals`, `kletia_policy_exposures` | Held approvals; USD exposure per step | 30 days; 8 days |
| `kletia_link_uses` | Link uses with a hash of the account | 30 days |
| `kletia_automation_runs` | Automation runs | 90 days |
| `kletia_api_keys`, `kletia_projects`, `kletia_webhooks`, `kletia_contracts` | Integrator settings | Until the integrator deletes them |
| `admin_audit` | Operator panel actions with the operator's address | Not deleted automatically |

## How to delete

- An intent: `DELETE /v1/intents/{id}` (above), or wait for the sweep.
- Receipt disclosures only: `DELETE /v1/intents/{id}/receipt/disclosures`.
- A clarify thread: `DELETE /v1/threads/{id}` (API key).
- Tracking data: turn tracking off on the desk (`DELETE /v1/data/tracking`).
- The browser's copies: close the tab (sessionStorage) or clear the site's
  data.
- Anything else (audit rows, logs): ask the operator of the deployment; for
  the hosted Kletia, open an issue as described in `SECURITY.md`.
