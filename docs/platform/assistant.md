# Portfolio assistant

Ask about your own wallets in plain words and get an answer computed from the
[Data API](data.md): "what's my biggest position?", "how much did I spend on
fees last month?", "did I bridge to Solana this week?", "how is my Aave loan
doing?". A portfolio request that wants action ("rebalance my portfolio to
60/40 ETH/USDC", "sell my worst performer", "move my idle stables to the best
yield", "close everything risky") comes back as ordinary sentences with
amounts taken from your holdings; each one is planned, reviewed and confirmed
like a sentence you typed. The assistant itself never plans, stores or signs
anything.

On the desk, a question typed in the composer gets an answer card in the
thread. Integrators call `POST /v1/assistant/ask`, agents the MCP tool
`ask_portfolio`, and the SDK `client.assistant.ask`.

## What goes to the assistant

`assistantRouteOf` in `@kletia/core` decides, the same way on the desk and in
the API:

| Route | Examples | What happens |
|---|---|---|
| `portfolio-question` | "how much ETH do I have?", "show my trades on base", "which of my assets lost the most?" | Answered from your data |
| `portfolio-action` | "rebalance my portfolio to 60/40 ETH/USDC", "sell my worst performer", "move my idle stables to the best yield", "close everything risky", "de-risk my portfolio" | Sentences built from your holdings, to plan |
| `market-question` | "what's the price of ETH", "what's the best yield for USDC" | Answered from market data |
| none | "swap 1 SOL to USDC", "sell all my SOL", "exit all my lending positions" | The sentence reader plans it as usual |

A sentence that starts with an action verb is never a question: the reader
plans it, or refuses it for its question mark. The reader keeps refusing every
question ([clarify](clarify.md)), so a question can never become a plan.

## How an answer is made

1. **Refusals first.** Questions that ask for keys or seed phrases, carry
   instructions aimed at the assistant ("ignore previous instructions"), ask
   for advice or predictions, or name a wallet that is not yours (an address,
   an ENS or SNS name, "my friend's balance", "how much ETH does bob have")
   are answered `refused`, before any data is read.
2. **Deterministic reading.** A typed query planner reads the question into an
   `AssistantQuery`: a subject (`summary`, `holdings`, `positions`, `health`,
   `transactions`, `fees`, `pnl`, `earnings`, `allocation`, `prices`,
   `yields`), filters (activity kinds, assets, networks, bridge destinations,
   protocols), a time window and an aggregate (`list`, `total`, `top`,
   `bottom`, `count`, `exists`).
3. **Computed in code.** The query runs against the data, and every number the
   answer states is a **fact** with its `source` and `asOf`. Unknown or
   partial data is said (`status: "unknown"` or `"partial"` with `gaps`),
   never filled in.
4. **Optional model steps**, under consent only (below): a model may read a
   question the parser cannot into the same typed query (validated field by
   field), and may word the answer from the facts.
5. **Grounding rule.** Every number, asset, network, month, address and link in
   a model's wording must come from the facts (or the window and assumptions
   the answer states, or the names the question itself used). If anything
   does not match, the deterministic template is used instead. Addresses and
   links are never allowed.

Time windows are UTC and weeks start on Monday: "today", "yesterday", "this
week", "last week", "this month", "last month", "in September", "the last 10
days", "this year". Vague words ("recently", "lately") are read as the last
30 days and the answer says so in `assumptions`.

## Request and answer

```http
POST /v1/assistant/ask
Authorization: Bearer kl_dev_…
Content-Type: application/json

{ "question": "How much did I spend on fees last month?", "wallets": { "evm": ["0x4f18…6e5C"] } }
```

```json
{
  "answer": {
    "route": "portfolio-question",
    "status": "answered",
    "text": "You paid $1.40 in fees in September 2026, over 4 transactions.",
    "facts": [
      { "id": "f1", "label": "Fees paid in September 2026", "value": "$1.40", "number": 1.4, "unit": "usd", "source": "chain", "asOf": "2026-10-24T12:00:00.000Z" },
      { "id": "f2", "label": "Transactions counted", "value": "4", "number": 4, "unit": "count", "source": "chain", "asOf": "2026-10-24T12:00:00.000Z" }
    ],
    "query": { "subject": "fees", "filter": {}, "aggregate": "total", "window": { "name": "last_month", "from": "2026-09-01T00:00:00.000Z", "to": "2026-10-01T00:00:00.000Z", "label": "September 2026" } },
    "table": { "columns": [ … ], "rows": [ … ] },
    "followUps": ["Show my transactions this month", "Which of my assets lost the most this month?"],
    "assumptions": [],
    "gaps": [],
    "wording": "template",
    "understoodBy": "parser",
    "wallets": [{ "label": "EVM wallet 1", "address": "0x4f18…6e5C", "vm": "evm" }],
    "asOf": "2026-10-24T12:00:00.000Z"
  }
}
```

`status` is `answered`, `partial` (some data could not be read; `gaps` says
what), `unknown` (the data is not available; nothing is guessed), `refused`
or `needs-model` (the parser could not read the question and the model steps
are off or not consented). An answer may carry a `table` or a bar `chart`.

An action request adds:

```json
"action": {
  "goal": "rebalance",
  "summary": "Rebalance to 60.0% ETH / 40.0% USDC on Base",
  "sentences": ["swap 3.98799 USDC to ETH on base"]
}
```

Plan each sentence with `POST /v1/intents` (or the MCP tool `plan_intent`):
the normal [clarify](clarify.md), preview, confirm and sign flow applies.
Amounts are rounded down so they never exceed what is held; swaps of "all my"
an asset keep the network fee as the reader always does. "Risky" means any
asset that is not a stablecoin, and holdings worth less than $10.00 are left
out of "close everything risky"; "worst performer" ranks by percentage change
over the window (default the last 30 days), stablecoins excluded.

## Who may ask about which wallets

- **API keys** (project, operator, agent) name the wallets in `wallets` (at
  most 2 EVM and 2 Solana addresses). An **agent key** may ask only about
  accounts its rule book chain pins in `accounts.allow` (every pinned level);
  the wallet set is narrowed to them, and a key that pins none is refused.
  **Publishable keys** are refused. The Kletia history a key can see is its
  own intents.
- **The desk** (no key) uses the signed-in wallet session
  (`Kletia-Account-Session`, first-party origin): answers cover that wallet
  only; naming another wallet is `403 ASSISTANT_ACCOUNT_FORBIDDEN`.
- Neither: `401 ASSISTANT_OWNER_REQUIRED`.

Every ask spends the data budget like a portfolio read (one unit per
account). Questions containing secret material are refused with
`400 MESSAGE_SECRET_REFUSED`.

## Model steps and consent

Off by default. They need the deployment switch and consent, the same model as
[model-assisted reading](clarify.md):

- server keys: the project setting `modelReading: "enabled"` plus
  `"model": "on"` in the request;
- the desk: `"model": "on"` with a session consent token from
  `POST /v1/assistant/consent` (desk wallet session only; server keys get
  `403 CONFIRM_AUTHORITY_REQUIRED`, and `503 ASSISTANT_MODEL_NOT_CONFIGURED`
  when the switch is off).

Only the question (addresses and names masked as `<wallet>`) is sent to read
it, and only the facts' labels and printed values, the gaps and the
assumptions to word an answer: never addresses, balance lists or histories.
Calls follow the reading layer's conventions: OpenRouter with a pinned serving
provider and no fallbacks, zero data retention, no data collection,
structured output, a 3.5 s per-call cap under a 4 s deadline, a circuit
breaker, 30 calls an hour per wallet or key and 300 a day per project.
`answer.wording` is `model` only when the worded text passed the grounding
check; `answer.understoodBy` says whether the parser or a model read the
question. Without a model, the deterministic path answers what it can and
says plainly when a question needs the model.

| Variable | Meaning |
|---|---|
| `KLETIA_ASSISTANT` | `off` (default) or `on` |
| `KLETIA_ASSISTANT_MODELS` | OpenRouter model ids: the primary and an optional fallback used only when the first fails outright |
| `KLETIA_ASSISTANT_PROFILES` | JSON `{ "<model id>": { "provider": "<pinned provider>", "temperature": 0 } }`; a model without a pinned provider keeps the steps off |
| `OPENROUTER_API_KEY` | Shared with model-assisted reading |

## The data behind it

The engine reads through a narrow port (`apps/api/src/platform/assistant/dataPort.ts`):
`summary`, `transactions(query)`, `pnl(query)`, `positions`, `snapshots`,
`yields` and `prices`, in the shapes of `packages/core/src/data.ts`. Today it
is backed by the data service: holdings, positions, loan health, yields and
prices are complete; transaction history is the calling key's Kletia-planned
transactions only (a desk session has none yet, answered `unknown`), and
per-asset results and earnings need price history that is not connected yet.
Answers say so instead of guessing.

## Eval

`npm run eval:assistant -w @kletia/api` runs the assistant corpus
(`apps/api/src/platform/assistant/__tests__/fixtures/assistant-corpus.json`:
fixture wallets, prices, yields and over 60 questions with the facts and
answers expected, including prompt injection in token names and transaction
symbols, questions about someone else's wallet, requests for keys, advice and
ambiguous time windows) offline on the deterministic path and enforces: at
least 90% correct, 0 answers with an ungrounded number, asset, network or
month, 0 answers that mention another fixture wallet, and every action
sentence read by the intent engine as a plan or a question for the same
holdings. The intent corpus (`eval:intents`) holds the same question shapes in
its `refuse` family, so a question can never become a plan.
