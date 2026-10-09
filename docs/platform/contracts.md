# Custom contracts (bring your own contract)

Integrators can plug **their own** EVM contracts and Solana programs (through
[Solana Actions](https://solana.com/developers/guides/advanced/actions)) into
Kletia intents, for example *"bridge 100 USDC from base to arbitrum then
deposit it into acme vault"*. A registration belongs to one API key; only
intents created with that key (or a key of its project, when shared) can use
it.

> **Not audited by Kletia.** Kletia checks a registered contract's code
> identity, encodes every call itself, simulates every transaction and
> verifies the outcome on-chain. It does not review the contract's logic.
> Every review shown to users starts with that notice.

- Endpoints: [`/v1/contracts`](#endpoints), [`/v1/sessions`](#sessions)
  (OpenAPI tags *Contracts* and *Sessions* in `GET /v1/openapi.json`)
- Types and the definition validator: `@kletia/core`
  (`ContractDefinition`, `validateContractDefinition`, `ContractReview`, …)
- Errors: [errors.md](errors.md) (`CONTRACT_*`, `ACTION_*`, `PROGRAM_*`,
  `SESSION_*`, `SIMULATION_*`)

## How it fits together

| Concept | What it is |
|---|---|
| Registration (`ct_` + 24 hex) | One EVM contract (`vm: "evm"`) or one Solana Actions origin with its program allowlist (`vm: "svm"`), owned by one API key |
| Entry (action) | One callable action of a registration: one ABI function (EVM) or one action URL template (Solana) |
| Revision | The registration's append-only history. Each revision has a `definitionHash` (sha256 of the canonical security-relevant fields) and its own pins |
| `call` / `action` step | An intent step bound to (registration, revision, entry); protocol `custom-call` (EVM) or `solana-actions` (Solana). The step carries a self-contained snapshot (`step.call`) so verification never needs the registry |
| Session (`cs_` + 32 hex) | A short-lived template your backend creates so the embed can run your fixed actions for a visitor's wallet |

Two ways to put a registered contract in front of a user:

1. **Intent id** (you already know the user's wallet): your backend creates
   the intent with its key (`POST /v1/intents` with
   `{ "kind": "call", "contract": "ct_…", "entry": "deposit", … }`), and the
   frontend opens it (`<kletia-intent intent="int_…">` in
   [embed.md](embed.md), or the SDK / widget).
2. **Session** (the embed connects the wallet): your backend creates a
   session (`POST /v1/sessions`); the embed calls
   `POST /v1/sessions/{id}/intents` with the visitor's accounts. See
   [Sessions](#sessions).

Either way the user reviews every step and signs in their own wallet.

## Registering an EVM contract

```http
POST /v1/contracts
Authorization: Bearer kl_dev_…
Idempotency-Key: 5f0a…
Content-Type: application/json
```

```json
{
  "vm": "evm",
  "network": "base",
  "address": "0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183",
  "integrator": { "name": "Acme Yield", "website": "https://acme.example" },
  "visibility": "private",
  "abi": [
    { "type": "function", "name": "deposit", "stateMutability": "nonpayable",
      "inputs": [{ "name": "assets", "type": "uint256" }, { "name": "receiver", "type": "address" }],
      "outputs": [{ "name": "shares", "type": "uint256" }] },
    { "type": "event", "name": "Deposit", "anonymous": false,
      "inputs": [
        { "name": "sender", "type": "address", "indexed": true },
        { "name": "owner", "type": "address", "indexed": true },
        { "name": "assets", "type": "uint256", "indexed": false },
        { "name": "shares", "type": "uint256", "indexed": false }] }
  ],
  "actions": [
    {
      "id": "deposit",
      "label": "Deposit into Acme USDC vault",
      "function": "deposit(uint256,address)",
      "args": ["$amount", "$account"],
      "input": { "token": "USDC", "approval": { "spender": "$self" } },
      "output": { "token": "$self", "toleranceBps": 10 },
      "events": [
        { "event": "Deposit", "emitter": "$self",
          "where": { "owner": "$account", "assets": "$amount" }, "output": "shares" }
      ],
      "phrases": { "verbs": ["deposit", "supply"], "aliases": ["acme vault"] },
      "limits": { "maxAmount": "25000" }
    }
  ]
}
```

Response: `201 { "contract": ContractView }`. The body is validated by
`validateContractDefinition` from `@kletia/core`, so the SDK, the CLI and the
portal report the same issues before anything is sent; the stored and hashed
definition is its **normalised** form (checksummed addresses, defaults filled
in, event references rewritten to full signatures).

### Fields

| Field | Rules |
|---|---|
| `network` | An EVM network key (`base`, `arbitrum`, `ethereum`, `optimism`, `polygon`, `arc`, `arbitrum-sepolia`) |
| `address` | The contract. Tokens, routers and aggregators, Permit2, Multicall3, precompiles and every address up to `0xffff`, system contracts, OP-stack predeploys, ERC-4337 EntryPoints and the deployment's deny list are refused (`CONTRACT_DENIED`) |
| `integrator` | `name`: 2-40 characters of `A-Z a-z 0-9 space . , & ' ( ) -`. Names that use a registry brand ("Aave", "Kletia", …) need that brand's own `website` **and** a verified domain. `website`: HTTPS origin, required on mainnet |
| `visibility` | `private` (default: only this key) or `project` (every key of the key's project may use it) |
| `abi` | At most 40 `function` / `event` / `error` items. The ABI is an allowlist: every function item must be used by an action |
| `addresses` | At most 4 `{ label, address }`: other contracts an action may name as approval spender or event emitter; pinned like the target |
| `actions` | 1-10 entries, below |

Per action (entry):

| Field | Rules |
|---|---|
| `id` | `^[a-z][a-z0-9_-]{0,39}$`, unique |
| `label` | At most 80 characters; shown in reviews and step titles |
| `function` | Canonical signature that exists in `abi`; `nonpayable` or `payable` (`view`/`pure` refused) |
| `args` | One [binding](#argument-bindings) per ABI input, in order |
| `input` | The token the call spends: a registry symbol on the network, a CAIP-19 id, or `native`. Registry assets only. ERC-20 inputs must bind `$amount` to an argument |
| `input.approval` | ERC-20 only: `{ "spender": "$self" \| "<label>" }`. Always an **exact** `approve(spender, amount)`, only when the current allowance is below the amount (USDT-style tokens get a reset `approve(0)` first) |
| `value` | `{ "bind": "$amount" \| "<wei>", "max": "<wei>" }`: required for `payable`; `$amount` only with `input.token: "native"`; refused above `max` |
| `output` | `{ "token": "$self" \| "<label>" \| "0x…", "toleranceBps": 0-100 }` (default 10). ERC-20 outputs only. Enables `amount: "max"` after the step and output verification |
| `events` | 1-3 [event bindings](#event-bindings): the proof of success |
| `params` | At most 6 user parameters `{ name, type: uint \| int \| bool \| enum, min?, max?, enum?, default?, required? }` (never addresses or bytes); every declared parameter must be bound |
| `recipient` | `account` (default: `$recipient` is the acting account) or `any` (third-party recipients allowed and flagged in the review) |
| `phrases` | `verbs` (1-4, `^[a-z]{2,16}$`) and `aliases` (1-4) for natural language. Aliases may not be a network, an asset symbol, a built-in venue word, `kletia` or a grammar keyword; a key's registrations on one network may not share a (verb, alias) pair |
| `limits` | `minAmount` / `maxAmount` in input-token units; `maxAmount` is required on mainnet for spending actions |

Only `label` and `phrases` can change without a new revision; everything else
is security-relevant and part of `definitionHash`.

### Argument bindings

| Binding | ABI types | Value |
|---|---|---|
| `"$amount"` | `uint*` | Base units of the step input (exact amount, or the funded share of the previous step) |
| `"$account"` | `address` | The step account (the signer) |
| `"$recipient"` | `address` | The step recipient (the account unless `recipient: "any"`) |
| `"$token"` | `address` | The ERC-20 input token |
| `"$self"` | `address` | The registered contract |
| `"$minimumOutput"` | `uint*` | Guaranteed minimum of the declared output |
| `"$deadline"` | `uint*` | Unix seconds: payload expiry + 900 |
| `"$previous.output.amount"` | `uint*` | Full output of the previous step on the same network |
| `"$previous.output.asset"` | `address` | Output token of the previous step |
| `"$param.<name>"` | per parameter type | A validated user parameter |
| `{ "literal": … }` | numbers (decimal strings), `bool`, `bytesN`, `string` (≤ 64), `address`, `bytes` **only** `"0x"` | Fixed by the integrator; shown as such in the review |
| `{ "tuple": [ … ] }` / `{ "array": [ … ] }` | tuples / arrays | Per member; arrays literal-only, at most 8 elements |

Kletia never builds arbitrary calldata: every call is encoded from the
registered ABI and these bindings, and the engine re-decodes and re-encodes
the prepared call to check it byte for byte. `function`-typed arguments,
`bytes[]` and `bytes` other than `"0x"` are refused
(`CONTRACT_ARGUMENT_FORBIDDEN`). An `address` argument named like a
beneficiary (`receiver`, `recipient`, `to`, `owner`, `beneficiary`,
`onBehalfOf`, `account`, `user`, `for`, `dst`, `destination`, with or without
a leading `_`) must bind to `$account` or `$recipient`
(`CONTRACT_BINDING_INVALID`), so a deposit can never be credited to anyone
but the user.

### Forbidden functions

Refused by selector **and** by name, whatever the ABI claims
(`CONTRACT_FUNCTION_FORBIDDEN`): `approve`, `increaseAllowance`,
`decreaseAllowance`, `setApprovalForAll`, `permit` (EIP-2612 and DAI),
`transfer`, `transferFrom`, the `safeTransferFrom` family,
`transferWithAuthorization` / `receiveWithAuthorization`, `upgradeTo`,
`upgradeToAndCall`, `changeAdmin`, `initialize` / `reinitialize`,
`transferOwnership` / `renounceOwnership` / `acceptOwnership`, `setOwner`,
`setImplementation`, `multicall`, Multicall3 `aggregate*` / `tryAggregate`,
`execute` / `exec*` / Safe `execTransaction`, `delegate` /
`approveDelegation`, `selfdestruct` and `kill`. `GET /v1/contracts/inspect`
marks each function of a verified ABI as allowed or forbidden with the
reason.

### Event bindings

```json
{ "event": "Deposit", "emitter": "$self", "where": { "owner": "$account", "assets": "$amount" }, "output": "shares" }
```

- `event`: name or full signature of a non-anonymous ABI event.
- `emitter`: `$self` or an `addresses` label; the log must come from that
  pinned address (a proxy's logs carry the proxy address).
- `where`: event input → `$account`, `$recipient`, `$amount`, `$token`,
  `$self` or `{ "literal": … }`. At least one entry binds the user
  (`$account` or `$recipient`), so an unrelated emission never proves success.
  `$amount` is the amount decoded from the landed call.
- `output`: the event input reporting the output amount; it must equal the
  output token credited to the user.

## Registering a Solana Action

```json
{
  "vm": "svm",
  "network": "solana",
  "integrator": { "name": "Acme Stake", "website": "https://acme.example" },
  "origin": "https://actions.acme.example",
  "programs": ["<primary program id>"],
  "payees": [{ "label": "Acme fee", "address": "<base58>", "maxLamports": "5000000" }],
  "actions": [
    {
      "id": "stake",
      "label": "Stake USDC with Acme",
      "href": "https://actions.acme.example/api/actions/stake?amount={amount}&lock={lockDays}",
      "primaryProgram": "<primary program id>",
      "input": { "token": "USDC" },
      "output": { "mint": "<receipt mint>", "toleranceBps": 10 },
      "params": [{ "name": "lockDays", "type": "uint", "min": "1", "max": "365", "default": "30" }],
      "phrases": { "verbs": ["stake"], "aliases": ["acme stake"] },
      "limits": { "maxAmount": "10000" }
    }
  ]
}
```

- `origin`: HTTPS, a public DNS name, port 443 or 1024+; it must resolve only
  to public addresses (`ACTION_URL_FORBIDDEN` otherwise). Every `href` is on
  it; `{amount}` (decimal), `{amountBaseUnits}` and `{<param>}` are the only
  placeholders.
- `programs` (1-6): the allowlisted top-level programs, pinned. Built-in
  programs (System, Token, Token-2022, ATA, ComputeBudget, Memo, Address
  Lookup Table, Lighthouse) are handled by fixed rules and cannot be
  allowlisted; native and loader programs, venue programs, registry mints and
  the deployment's deny list are refused (`PROGRAM_NOT_ALLOWED`).
- `payees` (≤ 2): the only third parties a top-level System transfer may pay,
  each with a lamport cap. A payee only widens the transfer rule: the
  transaction must still invoke the action's `primaryProgram`, so a bare
  SOL transfer (for example the `transfer-sol` sample action) is always
  refused. Plain payments are Kletia's own `send` action.
- Registration fetches each action's metadata (`GET` the `href` without
  placeholders: 8 s, 64 KB, no redirects) and records `title`, `label` and
  `disabled` on the entry (`actions[].metadata`).

Kletia executes only actions that return a single transaction for the user
(`type: "transaction"`); `message`, `post`, `external-link` and chained
responses are refused (`ACTION_RESPONSE_UNSUPPORTED`). The transaction must
have one signer (the user as fee payer, unsigned), no durable nonce, only
allowlisted or built-in programs at the top level (Lighthouse: assertion
instructions only), no approvals, authority changes or transfers of the
user's tokens, and bounded compute and priority fees; anything else is
refused with `ACTION_TRANSACTION_REJECTED` and the precise reason. Kletia
sends the user's address to your action server when it fetches a
transaction; the review says so.

**The user's signature reaches only your allowlisted programs.** The user
signs the whole transaction, and Solana lets any program that receives the
user's wallet in a cross-program invocation (CPI) act with that signature on
everything the user controls: stake accounts, mints, nonce accounts,
positions in other protocols. Kletia therefore scans the simulated and the
landed inner instructions and refuses:

- native and loader programs anywhere in the CPI tree (Stake, Vote, the BPF
  loaders, Address Lookup Table, Config, ...), whatever the allowlist says;
- any program outside `programs` and the built-ins (System, Token,
  Token-2022, ATA, Memo) that receives the user's wallet. A program that never
  receives the wallet cannot sign for the user, so it may run (for example an
  AMM a router calls with its own authority);
- on the built-ins, any use of the user's authority whose effect the balance
  checks do not see: approvals, authority changes, mints, freezes and thaws,
  spends from token accounts the user is only a delegate or multisig signer
  of, closes of the user's token accounts to someone else, and System
  Assign / Allocate / seed / nonce instructions. Transfers and burns from the
  user's own token accounts and account creation are held to the amount
  rules.

The simulation also compares the states of the transaction's writable
accounts: an account of a native program (a stake account, program data, a
lookup table), a System account other than the user's wallet, a mint the user
can mint or freeze, or a token account the user is only a delegate of must
not lose value or change hands.

Allowlisting a program trusts it with the user's signature: it can act on
anything the user holds **in that program** (positions, obligations,
escrows). Allowlist only programs you control, never a third-party protocol
the user may have funds in. A router whose route hands the wallet to
programs you have not allowlisted is refused: for example the public Jupiter
blink passes the user's wallet to AMM programs that change with every quote,
so it only runs when the route's programs are allowlisted. The review lists
the programs the signature reaches.

## What registration checks

1. The definition (above).
2. Duplicates (`409 CONTRACT_EXISTS`: one registration per key, network and
   address or origin), the per-key cap (`409 CONTRACT_LIMIT_REACHED`, 25) and
   (verb, alias) collisions with the key's other registrations on the
   network (`400 CONTRACT_DEFINITION_INVALID`).
3. **Code identity (pins).** EVM: deployed code (`CONTRACT_NOT_DEPLOYED`),
   EIP-7702 delegated accounts refused (`CONTRACT_DELEGATED_EOA`), the code
   hash, and for EIP-1967 / beacon / EIP-1822 / ZeppelinOS / EIP-1167 proxies
   the implementation (and admin, beacon) with their code hashes. Diamonds and
   proxy shapes that cannot be pinned are refused
   (`CONTRACT_PROXY_UNSUPPORTED`), as is a contract whose Sourcify proxy
   resolution disagrees with the implementation read on-chain. Every
   `addresses` entry is pinned the same way. Solana: each program's loader,
   program data account, last deploy slot and upgrade authority.
4. **Source verification** (recorded, shown in reviews, never blocking):
   Sourcify for EVM contracts and their implementation (`exact_match`,
   `match`, `unverified`, or `unknown` when Sourcify did not answer), OtterSec
   for Solana programs.
5. **Risk screening** when the deployment configures Webacy: a high risk
   score refuses the registration (`CONTRACT_DENIED`).

Registration needs a developer or operator key and the key's **current**
secret: a secret inside its rotation grace window gets `403
KEY_SECRET_ROTATED`. Registrations, updates and reverifications share 20 per
hour per key; tests and inspections share 20 per minute per key (`429
RATE_LIMITED`).

## Activation, revisions and domain verification

- On **mainnet** networks a registration starts `pending` and activates after
  the activation delay (`activatesAt`, default 15 minutes). The key's webhooks
  receive `contract.registered` at once and `contract.activated` at
  activation, so a stolen key cannot silently put a drainer in front of your
  users. Tests work while pending; planning answers `409 CONTRACT_PENDING`
  (retryable, with `Retry-After` set to the seconds until `activatesAt`).
  **Testnets** activate at once.
- An integrator name that uses a reserved brand also waits for **domain
  verification**: publish

  ```json
  { "contracts": ["ct_5f1c2a9b7e3d4c6a8b0e1f23"] }
  ```

  at `https://<your website host>/.well-known/kletia.json` (HTTPS, public
  address, no redirects, at most 16 KB) and call `POST
  /v1/contracts/{id}/reverify`. Kletia re-checks the file daily. Without a
  verified domain every registration still works, with a lower per-step cap
  ($1,000 instead of $10,000 by default) and a "Domain not verified" warning
  in the review; a reserved-brand registration whose file disappears is
  suspended (`domain_unverified`).
- `PATCH /v1/contracts/{id}` takes a partial definition merged onto the
  latest revision (`null` removes an optional field; `vm`, `network`,
  `address` and `origin` cannot change). Changing only `label` and `phrases`
  edits the current revision in place. Any other change is validated and
  pinned again and becomes revision N+1: pending for the delay on mainnet
  (revision N keeps serving meanwhile; `contract.registered` announces N+1),
  immediate on testnets. Once N+1 activates, intents planned on N stop
  preparing with `409 CONTRACT_REVISION_CHANGED`: create a new intent.
- `DELETE /v1/contracts/{id}` soft-deletes (idempotent, `204`). Planned
  intents that use it stop preparing (`409 CONTRACT_NOT_USABLE`); submitted
  steps keep verifying.

The `ContractView` fields (`definitionHash`, `pins`, `actions`, …) describe
the latest revision (`revision`); intents use `activeRevision`. The owner's
`GET /v1/contracts/{id}` also lists `revisions` (newest first) and includes
the ABI (or programs and payees).

## Suspension and reverify

The engine re-reads the pins at **every prepare** and at the **receipt block**
when it verifies a submitted step, and a background watcher re-reads them
every 10 minutes. A change suspends the registration (`pins_changed`,
`program_changed`), as does an on-chain outcome that does not match the
declared events and asset changes (`outcome_mismatch`); `contract.suspended`
is sent with the reason. Preparing answers `409 CONTRACT_CHANGED` /
`CONTRACT_SUSPENDED`; a step whose contract changed between prepare and
inclusion becomes `indeterminate` (`CONTRACT_CHANGED_DURING_EXECUTION`).

After an intended upgrade, inspect the new code and call `POST
/v1/contracts/{id}/reverify`: it re-pins, re-checks Sourcify / OtterSec and
the domain file, and creates a new revision (pending for the delay on
mainnet). When it activates the registration is active again
(`contract.reactivated`). Unchanged code only refreshes the verification.

An operator can suspend any registration (`POST
/v1/contracts/{id}/suspend` with `{ "reason": "…" }`, operator key); the
reason reads `operator: …` and the integrator cannot lift it.

## Test and inspect

- `POST /v1/contracts/{id}/test` with `{ "entry", "account", "amount"?,
  "params"?, "recipient"? }` runs the plan and prepare pipeline as a dry run
  for one account: bindings, approvals, the mandatory simulation and the
  exact review users will see (`200 { "test": ContractTestResult }`). The
  owner tests the latest revision, also while it is pending. Nothing is
  stored or signed, and no calldata to persist is returned.
- `GET /v1/contracts/inspect?network=base&address=0x…` shows what registering
  an address would pin and allow: deployment, EIP-7702, the deny-list reason,
  pins and proxy, Sourcify status, the verified ABI and every function marked
  allowed or forbidden. `?network=solana&programs=<id>,<id>` shows program
  pins, deny-list reasons and OtterSec status (`200 { "inspection": … }`).

## Using a registration in intents

Structured actions (`kind: "call"` on EVM networks, `kind: "action"` on
Solana networks):

```json
{
  "actions": [
    { "kind": "bridge", "network": "base", "from": "USDC", "toNetwork": "arbitrum", "amount": "100" },
    { "kind": "call", "network": "arbitrum", "contract": "ct_…", "entry": "deposit", "amount": "max" }
  ],
  "accounts": ["eip155:8453:0x…"]
}
```

or text with your aliases and verbs, planned with your key:
`"bridge 100 USDC from base to arbitrum then deposit it into acme vault"`.
`contract` takes a registration id or one of its aliases. A call after a
bridge is funded by the bridge's guaranteed minimum; the bridge auction is
unchanged.

Scoping: only intents created **with the registration's key** (or a key of
its project, for `visibility: "project"`) can reference it; a key that may
not use it, and every keyless request, gets `422 CONTRACT_UNKNOWN`, exactly
like an unknown id. The check runs at plan and again at prepare, against the
key that created the intent. A revoked key's registrations stop working with
it.

### Simulation and the review

Every call and action step is simulated at plan and **again at prepare
against the user's real state** (EVM `eth_simulateV1`, Solana
`simulateTransaction`); a step is never prepared unsimulated
(`503 SIMULATION_UNAVAILABLE` when no endpoint can simulate, retryable). The
simulation must show exactly the declared input debit, no other debit or
approval, no leftover allowance and the declared output reaching the user
(`422 SIMULATION_ASSET_CHANGE_REFUSED` otherwise; `SIMULATION_FAILED` for a
revert).

Each step carries a `ContractReview` (`step.call.review`, refreshed at
prepare and returned as `payload.review`). Show it before handing the
transactions to the wallet, in this order: **who** (integrator, website,
domain verified or not), **what** (label, function, arguments with where each
value comes from), **permissions** (exact approvals), **result** (simulated
asset changes, network fee), **provenance** (source verification, proxy and
implementation, programs and upgrade authorities), **notice** ("Not audited
by Kletia …"). When the source is unverified or unknown, or the domain is
unverified, ask the user for an explicit acknowledgement before signing.

### Caps

| Cap | Default | Setting |
|---|---|---|
| Per step (priced) | $10,000 | `KLETIA_CONTRACT_STEP_MAX_USD` |
| Per step, domain not verified | $1,000 | `KLETIA_CONTRACT_UNVERIFIED_STEP_MAX_USD` |
| Per key, per UTC day, counted at the first prepare of each step | $100,000 | `KLETIA_CONTRACT_KEY_DAILY_MAX_USD` (`422 CONTRACT_SPEND_LIMIT`) |

An input without a USD price is allowed only up to the entry's own
`maxAmount`. `GET /v1/usage` reports the key's `contracts`:
`{ registered, suspended, preparedToday, notionalTodayUsd }`.

### Verification

After submit, an EVM call step settles only when the landed transaction is
the prepared one (byte-exact binding), it succeeded, a declared event came
from the pinned emitter with its `where` bindings satisfied, the user's token
movements match (exact input debit, no other debit or approval, declared
output at least the planned floor) and the pins at the receipt block still
match. A Solana action step additionally requires the prepared instructions,
in order (the wallet may add only ComputeBudget and Lighthouse assertion
instructions, which move nothing; a Lighthouse MemoryWrite or MemoryClose, or
an addition that calls another program, makes it another transaction:
`REFERENCE_MISMATCH`, and the step keeps waiting for the prepared one), no
authority or owner changes on the user's accounts, and the CPI scan above
over the landed inner instructions.

## Sessions

Sessions let the embed run your fixed actions for a visitor whose wallet you
do not know yet.

```http
POST /v1/sessions
Authorization: Bearer kl_dev_…
```

```json
{
  "actions": [
    { "kind": "bridge", "network": "base", "from": "USDC", "toNetwork": "arbitrum", "amount": "100" },
    { "kind": "call", "network": "arbitrum", "contract": "ct_…", "entry": "deposit", "amount": "max" }
  ],
  "amount": { "action": 0, "min": "10", "max": "1000" },
  "allowedOrigins": ["https://acme.example"],
  "expiresInSeconds": 900,
  "maxIntents": 1,
  "metadata": { "orderId": "A-1029" },
  "clientReference": "order-A-1029"
}
```

→ `201 { "session": { "id": "cs_…", "expiresAt": "…", "embedUrl": "https://kletiaai.xyz/embed#session=cs_…", … } }`

- Structured actions only (no `text`); every `call` / `action` must use a
  registration the key may use (`422 CONTRACT_UNKNOWN` /
  `CONTRACT_ACTION_UNKNOWN`). The template is planned once as a dry run with
  placeholder accounts, so a broken template fails at creation.
- `amount` lets the visitor choose the amount of one action within bounds
  (that action's `amount` is the default).
- `allowedOrigins`: 1-10 origins of the pages that may embed the session
  (HTTPS, or `http://localhost` for development). TTL 60-3600 s (default
  900), `maxIntents` 1-100 (default 1), at most 1,000 active sessions per key
  (`429 RATE_LIMITED` beyond). `metadata` takes at most 19 entries; every
  intent gets `metadata.sessionId`.
- `GET /v1/sessions/{id}` (public: the id is the capability) returns the
  integrator identity (from the first registration the template uses, else
  the first allowed origin's host), allowed origins, action labels, amount
  bounds, `status` (`active`, `expired`, `used`), `maxIntents` and `used`.
  Never the key or the project.
- `POST /v1/sessions/{id}/intents` (public) with
  `{ "accounts": [...], "amount"?: "…", "hostOrigin": "https://acme.example" }`
  re-checks expiry (`410 SESSION_EXPIRED`), the use count with one atomic
  increment (`409 SESSION_USED`) and `hostOrigin` (`403
  SESSION_ORIGIN_FORBIDDEN`; the frame checks the real host origin first),
  then plans the template with the visitor's accounts under **your** key and
  returns `201 { "intent" }`. A plan that fails gives the use back. With
  several uses, each intent's `clientReference` is suffixed `:<n>`, where
  `n` counts claimed uses and is never reused (a use given back keeps its
  number, so concurrent visitors never collide); an intent of another
  visitor is never handed out (`409 CLIENT_REFERENCE_EXISTS`).

A leaked session id lets someone else run the same fixed actions with their
own funds and wallet, nothing more. A revoked key's sessions stop working.

## Webhooks

`contract.registered`, `contract.activated`, `contract.suspended` and
`contract.reactivated` go to the webhooks of the registration's own key
(never to another key), with
`data: { contractId, ownerKeyId, network, target, revision, reason? }`.
A webhook created without `events` subscribes to every type that exists at
creation time, so webhooks created before these types existed do not receive
them; create a new webhook (or list the types in `events`) to get them.
`intent.step_updated` events of call/action steps identify the step; read
`step.call.contract` and `step.call.entry` from the intent.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/v1/contracts` | key | Register (`201`; `Idempotency-Key`) |
| GET | `/v1/contracts` | key | The key's registrations and its project's visible ones (`?network=&vm=&status=`) |
| GET | `/v1/contracts/inspect` | key | What registering an address or programs would pin and allow |
| GET | `/v1/contracts/{id}` | key | One registration (owner: with ABI and revisions) |
| PATCH | `/v1/contracts/{id}` | key (owner) | Update (`Idempotency-Key`) |
| DELETE | `/v1/contracts/{id}` | key (owner) | Soft delete (`204`, idempotent) |
| POST | `/v1/contracts/{id}/test` | key | Dry run of one entry for an account |
| POST | `/v1/contracts/{id}/reverify` | key (owner) | Re-pin and re-check after an upgrade (`Idempotency-Key`) |
| POST | `/v1/contracts/{id}/suspend` | operator | Suspend any registration |
| POST | `/v1/sessions` | key | Create a session (`Idempotency-Key`) |
| GET | `/v1/sessions/{id}` | public | Session view for the embed |
| POST | `/v1/sessions/{id}/intents` | public | Turn a session into an intent for the visitor |

## Operator settings

| Variable | Default | Purpose |
|---|---|---|
| `KLETIA_CONTRACTS_ENABLED` | `true` | Kill switch: `false` makes registration, tests, inspection, planning and preparing of call/action steps answer `503 CONTRACTS_DISABLED`; verification of submitted steps continues |
| `KLETIA_CONTRACT_ACTIVATION_DELAY_SECONDS` | `900` | Activation delay of mainnet registrations and security-relevant revisions (testnets: 0) |
| `KLETIA_CONTRACT_DENYLIST` | unset | Extra denied targets, `network:address,…` |
| `KLETIA_SOLANA_PROGRAM_DENYLIST` | unset | Extra denied programs (`<program id>` for every Solana network, or `network:<program id>`) |
| `KLETIA_CONTRACT_STEP_MAX_USD`, `KLETIA_CONTRACT_UNVERIFIED_STEP_MAX_USD`, `KLETIA_CONTRACT_KEY_DAILY_MAX_USD` | 10,000 / 1,000 / 100,000 | [Caps](#caps) |
| `KLETIA_SIMULATION_RPC_URLS_<NETWORK>` | public endpoints verified to serve `eth_simulateV1` | Simulation endpoints per EVM network (comma separated); each is capability-probed before use |
| `WEBACY_API_KEY` | unset | Enables address risk screening at registration |

`GET /v1/health` reports `contracts: { enabled, simulation }` (per network,
whether an endpoint can simulate now) and the storage kind of contracts and
sessions. Registrations, revisions, daily spend and sessions are stored in
memory, or in Postgres (`kletia_contracts`, `kletia_contract_revisions`,
`kletia_contract_spend`, `kletia_sessions`) when `KLETIA_DATABASE_URL` is set.

## Errors

| Code | Status | When |
|---|---|---|
| `CONTRACT_DEFINITION_INVALID` | 400 | The definition breaks a rule; see `error.issues` |
| `CONTRACT_FUNCTION_FORBIDDEN`, `CONTRACT_ARGUMENT_FORBIDDEN`, `CONTRACT_BINDING_INVALID` | 422 | A forbidden function, argument type or binding |
| `CONTRACT_DENIED`, `PROGRAM_NOT_ALLOWED`, `ACTION_URL_FORBIDDEN` | 422 | A denied target, program or URL |
| `CONTRACT_NOT_DEPLOYED`, `CONTRACT_DELEGATED_EOA`, `CONTRACT_PROXY_UNSUPPORTED` | 422 | The code identity cannot be pinned |
| `CONTRACT_NOT_FOUND` | 404 | Unknown, deleted or not visible to the key |
| `CONTRACT_EXISTS`, `CONTRACT_LIMIT_REACHED` | 409 | Duplicate target, or 25 registrations |
| `CONTRACT_UNKNOWN`, `CONTRACT_ACTION_UNKNOWN`, `CONTRACT_PARAM_INVALID`, `CONTRACT_AMOUNT_LIMIT` | 422 | Planning with a registration the key may not use, an unknown entry, bad parameters, an amount outside limits or caps |
| `CONTRACT_PENDING`, `CONTRACT_SUSPENDED`, `CONTRACT_NOT_USABLE`, `CONTRACT_CHANGED`, `CONTRACT_REVISION_CHANGED`, `PROGRAM_CHANGED` | 409 | The registration's state does not allow planning or preparing now |
| `CONTRACT_SPEND_LIMIT` | 422 | The key's daily notional cap |
| `SIMULATION_UNAVAILABLE`, `CONTRACTS_DISABLED` | 503 | Retry later |
| `SIMULATION_FAILED`, `SIMULATION_ASSET_CHANGE_REFUSED`, `ACTION_RESPONSE_UNSUPPORTED`, `ACTION_TRANSACTION_REJECTED` | 422 | The simulated or returned transaction breaks the rules |
| `ACTION_ENDPOINT_UNAVAILABLE`, `ACTION_RESPONSE_INVALID` | 502 | Your action server failed |
| `CONTRACT_CHANGED_DURING_EXECUTION` | step failure | The code changed between prepare and inclusion (`indeterminate`) |
| `SESSION_NOT_FOUND` / `SESSION_EXPIRED` / `SESSION_USED` / `SESSION_ORIGIN_FORBIDDEN` | 404 / 410 / 409 / 403 | Sessions |
| `CONTRACT_HANDOFF_UNSUPPORTED` | 422 | MCP `create_signing_link` for an intent with a custom contract |

## Residual risk

No control removes this: a contract that behaves honestly in simulation and
differently on-chain (for example keyed on `block.coinbase`, `tx.gasprice` or
a mutable storage pointer that is not a proxy slot) can still take what the
user approved **for that one step**. Exact approvals, value caps, the
per-step and per-day caps, the post-landing outcome check and the suspension
it triggers bound the damage to the step amount. On Solana, the same holds
for the user's balances and for accounts the CPI scan covers; what the user
holds inside an allowlisted program is in that program's hands (see
"The user's signature reaches only your allowlisted programs"). This is why the review always
says "Not audited by Kletia" and why integrators are named on every step.
