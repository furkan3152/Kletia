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
   `yields`, `perps`, `orders`, `automations`, `predictions`, `exposure`),
   filters (activity kinds, assets, networks, bridge destinations, protocols,
   and for transfers the direction), a time window and an aggregate (`list`,
   `total`, `top`, `bottom`, `count`, `exists`). Open perps, orders,
   automations and prediction positions are read from the positions'
   extras; with a window and a yes/no or count shape ("did I bet on
   Polymarket this week?") the history answers instead.
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
  (`Kletia-Account-Session`, first-party origin): answers cover its tracked
  set (its own wallets, each proven by a sign-in), or the session wallet
  alone while tracking is off; naming any other wallet is
  `403 ASSISTANT_ACCOUNT_FORBIDDEN`. With tracking off, history and results
  answer `unknown` with the desk step: Portfolio, then History, then "Turn on
  tracking".
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

What the model provider receives, exactly:

- **To read the question:** the question only, at most 300 characters, with
  EVM and Solana addresses, `.eth` / `.sol` names and links replaced by
  `<wallet>` and `<link>`.
- **To word the answer:** the masked question, up to 24 facts Kletia computed
  (each a label and a printed value, for example the label "USDC on Base"
  with the value "$1,204.10"), up to 4 gaps
  and up to 3 assumptions. Facts are balances, amounts, fees, prices, counts
  and dates of the signed-in wallets; wallets appear as "EVM wallet 1" or
  "Solana wallet 1", never as addresses. Transaction lists and hashes are not
  sent.

Calls follow the reading layer's conventions: OpenRouter with a pinned serving
provider and no fallbacks, requested with OpenRouter's zero-data-retention
(`zdr`) and `data_collection: "deny"` routing flags (OpenRouter routes only to
providers that state those policies; Kletia cannot audit them), structured
output, a 3.5 s per-call cap under a 4 s deadline, a circuit breaker, 30 calls
an hour per wallet or key and 300 a day per project. Kletia stores neither
the question nor the answer.
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
`summary`, `transactions(query)`, `pnl(query)`, `positions({ extras })`,
`snapshots`, `yields` and `prices`. `dataApiPort` backs it with the data
API's typed functions ([data](data.md), `data/api.ts`) under one `DataScope`:
an API key's named wallets (`walletScope` semantics: links to its own intents
and automations only), or a desk session's tracked set (`sessionScope`).

- **Transactions**: the on-chain history, read for the question's window up to
  4 pages of 100 rows. The data API's 18 kinds fold into the planner's:
  send and receive are a `transfer` ("what did I send" and "what did I
  receive" keep the direction), bridge-out and bridge-in a `bridge`,
  `approve`, `perp`, `order`, `prediction`, `failed` (a reverted
  transaction, whatever it tried), `claim` (a contract call whose method
  claims), the rest `other`. A bridge's destination is the network of its
  arrival in your wallets: departures without an arrival are said in the
  gaps, never counted to a destination. Fees count every transaction the
  wallet paid for, reverted ones included; a missing fee price (or Alchemy,
  which reports no fees) is a gap, never $0.
- **Coverage**: each account the history could not read in full is a gap line
  with the variables that would enable it (`ETHERSCAN_API_KEY` or
  `ALCHEMY_API_KEY` for EVM, `HELIUS_API_KEY` for faster Solana history);
  nothing read at all is `unknown`, part of it `partial`.
- **Results**: FIFO realized plus unrealized by asset (`/v1/data/pnl`) over
  the history service's nearest period at or above the window (24 hours, 7
  or 30 days, all time); a wider period is said in the gaps, never passed off
  as the window. A tracked set adds its value change from snapshots.
  Earnings per position (rewards, interest) are not read yet and answer
  `unknown`.
- **Extras**: open perps (unrealized PnL at the mark; closed positions,
  funding and fees are not included), open native orders, automations and
  Polymarket positions (market titles appear only in the table, sanitized,
  never in the answer text).

### Links in the desk

A fact or table row about a transaction carries `link: { kind:
"transaction", id }`: the desk's answer card opens that row in History (its
network filtered, the row open). A rate carries `link: { kind: "deposit",
sentence }` with the same sentence as the dashboard's "Move here", which the
card puts in the composer; nothing is planned until it is sent.

## Eval

`npm run eval:assistant -w @kletia/api` runs the assistant corpus
(`apps/api/src/platform/assistant/__tests__/fixtures/assistant-corpus.json`:
fixture wallets, prices, yields and 120 questions with the facts and
answers expected, including prompt injection in token names, transaction
symbols and prediction-market titles, questions about someone else's wallet,
requests for keys, advice and ambiguous time windows) offline on the
deterministic path and enforces: at
least 90% correct, 0 answers with an ungrounded number, asset, network or
month, 0 answers that mention another fixture wallet, and every action
sentence read by the intent engine as a plan or a question for the same
holdings. The fixture wallets are recorded data API reads (on-chain history
with per-network coverage, a provider not configured, Alchemy without fees,
a Solana read cut short, FIFO PnL, snapshots, perps, orders, automations and
Polymarket positions) served through the real `dataApiPort`, so the eval
exercises the same mapping, paging and coverage handling as the API. The
intent corpus (`eval:intents`) holds the same question shapes in
its `refuse` family, so a question can never become a plan.
