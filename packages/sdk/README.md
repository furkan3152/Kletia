# @kletia/sdk

TypeScript SDK for the Kletia intent API. Plan cross-network intents across
EVM networks and Solana, execute them with your users' wallets, stream events
and verify webhooks. Depends only on [`@kletia/core`](../core/README.md).

```bash
npm install @kletia/sdk
```

## Plan an intent

```ts
import { KletiaClient, formatAccountId } from "@kletia/sdk";

// In the browser: the keyless public tier, or a `baseUrl` that proxies
// through your server (which adds `Authorization: Bearer kl_dev_…`).
const kletia = new KletiaClient();

const intent = await kletia.intents.create({
  text: "bridge 25 USDC from base to solana then swap half to JitoSOL",
  accounts: [
    formatAccountId("base", evmAddress),
    formatAccountId("solana", solanaAddress),
  ],
  constraints: { maxSlippageBps: 50 },
});

console.log(intent.summary.title, intent.steps.map((step) => step.title));
```

`apiKey` is for server-side code only (listing intents, webhooks, higher
rate limits). Never put a `kl_dev_` key in browser bundles: anyone who reads
it can list your intents and manage your webhooks. On your server:

```ts
const kletia = new KletiaClient({ apiKey: process.env.KLETIA_API_KEY });
```

From the browser, either omit `apiKey` (public tier) or point `baseUrl` at
your own proxy, e.g. `new KletiaClient({ baseUrl: location.origin + "/api/kletia" })`,
which forwards `/api/kletia/v1/*` to the Kletia API with your key attached.

## Execute it with real wallets

```ts
import { eip1193Signer, executeIntent, walletStandardSolanaSigner } from "@kletia/sdk";

const final = await executeIntent(kletia, intent, {
  evm: eip1193Signer(window.ethereum, evmAddress),
  solana: walletStandardSolanaSigner(phantomWallet, phantomAccount, "solana:mainnet"),
}, {
  onUpdate: (next) => render(next),
});
```

`executeIntent` prepares each ready step, asks the wallet bound to that step
to sign, submits the transaction references for on-chain verification and
waits for cross-network settlement before unlocking dependent steps.

### Recovering broadcast transactions

Reporting references is retried (three attempts, honouring `Retry-After`)
while the API error is retryable. If Kletia still cannot record them, or a
wallet fails part-way through a multi-transaction step after a value-moving
transaction landed, `executeIntent` throws a `KletiaExecutionError` whose
`references` lists what the wallet already broadcast (the API error is its
`cause`). Do not sign that step again:

- Calling `executeIntent` again in the same process resubmits those
  references instead of preparing the step, so the wallet is not asked twice.
- From another process (or after a reload), pass them back:
  `executeIntent(kletia, intentId, signers, { pendingReferences: { [error.stepId]: error.references } })`,
  or call `kletia.intents.submitStep(error.intentId, error.stepId, error.references)`.
- If Kletia rejects them (for example a partial set), check them on the
  explorer and plan a new intent; the step is not signed again.

A step that stopped after only token approvals has no `references`: an
approval moves no funds, so it is prepared and signed again normally.

### Custom-contract steps need a confirmed review

`call` and `action` steps run an integrator's own contract or Solana Action,
which Kletia has not audited. `executeIntent` signs them only after your
`onReview` hook showed the user the review of exactly the prepared
transactions and resolved `true`:

```ts
await executeIntent(kletia, intent, signers, {
  // review: who, what, permissions, result, provenance, "Not audited by Kletia"
  onReview: async (step, review, { planned, transactions }) => showReviewCard(review), // true only once the user confirmed
});
```

Anything but `true` stops before any wallet prompt and `executeIntent`
returns the intent (the step stays `awaiting_signature`). Render the review
in its order (who, what, permissions, result, provenance, notice) and ask
for an explicit acknowledgement when `review.contract.source` is
`unverified`/`unknown` or `review.integrator.domainVerified` is false. The
SDK refuses such a step with a `KletiaExecutionError`, and nothing is
signed, when:

- no `onReview` is given (checked before prepare, so nothing is built);
- the prepared payload has no review, or its simulation is not `ok`;
- the EVM transactions are not what the review and the registration say:
  anything but an optional allowance reset, one exact approval of the step's
  input token to the pinned spender for the amount the review shows, and one
  call to the registered contract and function with the reviewed value
  (never above the registered cap);
- a Solana Action step carries more than one transaction.

## Stream events and wait for completion

```ts
await kletia.intents.stream(intent.id, (event) => {
  if (event.type === "intent.step_updated") console.log(event.data.stepId, event.data.status);
});

// Resolves once the intent is completed, partially_completed, failed, expired or cancelled.
const final = await kletia.intents.wait(intent.id, {
  timeoutMs: 10 * 60_000,
  onUpdate: (next) => render(next),
});
```

`intents.wait` (and the lower-level `watchIntent`) follows the event stream,
reconnects with `Last-Event-ID` when the API closes it, and polls `refresh`
while streams are unavailable (for example `429 TOO_MANY_STREAMS`). It rejects
with `WAIT_TIMEOUT` after `timeoutMs`, with `REQUEST_ABORTED` when its signal
aborts, and with the API error for an unknown intent.

## Retries and idempotency

Requests that are safe to repeat are retried twice by default (`maxRetries`,
per client or per call) on network errors, timeouts, `429`, `5xx` and codes the
error catalog marks retryable. Backoff is exponential with jitter and honours
`Retry-After`; a server that asks for more than 60 seconds gets the error
back instead of an early retry.

| Request | Retried |
|---|---|
| `GET`, `DELETE`, quotes, dry runs, `refresh`, `contracts.test` | Yes |
| Create intent, cancel, submit, create webhook, create or rotate key, `contracts.register` / `update` / `reverify`, `sessions.create` | Only with an `Idempotency-Key` |
| Webhook tests, `sessions.createIntent` and other POSTs | No |
| `prepareStep` | **Never**, and never with an `Idempotency-Key` |

With an `apiKey`, the client generates one `Idempotency-Key` (a UUID) per call
for the state-changing POSTs and reuses it on every retry, so a retry after a
lost response gets the first response back (`Idempotent-Replayed: true`)
instead of creating a second intent or webhook. Pass your own key to make a
call idempotent across processes, or `false` to send none:

```ts
await kletia.intents.create(request, { idempotencyKey: `order-${order.id}` });
```

The public tier refuses the header, so keyless clients send none and do not
retry those POSTs. `prepareStep` builds fresh transactions from a new quote on
every call, so it is never repeated automatically.

A key that rotates itself with `graceSeconds: 0`, or revokes itself, ends the
secret the retry would present, so a lost response cannot be replayed. When
the retry is refused (`INVALID_API_KEY` or `KEY_SECRET_ROTATED` after an
attempt that got no answer), `keys.rotate` and `keys.revoke` reject with
`OUTCOME_UNKNOWN` instead: the change most likely happened, and a new secret
from that rotation cannot be recovered. Rotate a key from another key of the
project, or keep a grace period.

## Receive webhooks

`@kletia/sdk/server` verifies `Kletia-Signature` against the exact raw body
and gives you a typed event. It uses Web Crypto only (no `node:` imports), so
it runs on Node 20+, Bun, Deno, edge runtimes and Workers.

Fetch handlers: Next.js App Router, Bun, Deno, Workers, Hono:

```ts
// app/api/kletia/route.ts
import { createWebhookHandler } from "@kletia/sdk/server";

export const POST = createWebhookHandler({
  secret: process.env.KLETIA_WEBHOOK_SECRET!,
  isDuplicate: (eventId) => db.processedEvents.has(eventId),
  onEvent: async (event) => {
    if (event.type === "intent.status_changed" && event.data.status === "completed") {
      await fulfil(event.data.intentId); // record event.id in the same transaction
    }
  },
});
```

Express (mount `express.raw` on the route, before any JSON parser):

```ts
import { expressWebhookHandler } from "@kletia/sdk/server";

app.post("/webhooks/kletia", express.raw({ type: "application/json" }), expressWebhookHandler({ secret, onEvent }));
```

Hono: `app.post("/webhooks/kletia", honoWebhookHandler({ secret, onEvent }))`.
Plain `node:http` and the Next.js pages router (with
`export const config = { api: { bodyParser: false } }`) work with
`expressWebhookHandler`, which then reads the request stream itself.

The handlers answer `200` once `onEvent` resolved (or the event is a
duplicate), `400` with a reason when the delivery does not verify
(`malformed`, `expired`, `mismatch`, `invalid_body`, `header_mismatch`),
`413` above `maxBodyBytes` (256 KB), and `500` when `onEvent` throws, so
Kletia retries. A body some framework already parsed cannot be verified: the
handler answers `500` with instructions instead of guessing.

Delivery is at least once: retries, tests and replays can repeat an event, so
de-duplicate by `event.id` (`isDuplicate` / `markProcessed`, or
`memoryDeduplication()` for a single process). During a secret rotation pass
both secrets: `secret: [newSecret, oldSecret]`.

Lower level: `constructWebhookEvent(rawBody, signatureHeader, secret)` returns
the event or throws `KletiaWebhookError` with a `reason`, and
`verifyWebhookSignature` from `@kletia/core` checks a signature only.

## Keys, webhooks and usage

```ts
const keys = await kletia.keys.list();                       // last4 only, never secrets
const rotated = await kletia.keys.rotate(keys[0].id, { graceSeconds: 3600 });
await kletia.keys.revoke(oldKeyId);

const delivery = await kletia.webhooks.test(webhook.id);     // signed webhook.test, sent now
const log = await kletia.webhooks.deliveries(webhook.id, { limit: 50 });
const usage = await kletia.usage({ window: "7d" });
const catalog = await kletia.errors();
const lending = await kletia.venues({ network: "base", protocol: "morpho" }); // APY, TVL, exit liquidity
```

## Custom contracts

Plug your own EVM contract functions, or a Solana Actions endpoint, into
intents ("bring your own contract"). Server-side, with your key: a
registration belongs to the key that created it, and only intents created
with that key (or a key of the same project, for `visibility: "project"`) can
use it. The rules (argument bindings, forbidden functions, pins, simulation,
review) are in the [contracts guide](../../docs/platform/contracts.md).

```ts
import { validateContractDefinition } from "@kletia/core";

// The same static checks the API runs, before anything is sent.
const checked = validateContractDefinition(definition);
if (!checked.ok) throw new Error(checked.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));

const { contract } = await kletia.contracts.register(definition); // mainnet: pending until contract.activatesAt
const test = await kletia.contracts.test(contract.id, {           // plan + prepare + simulation; nothing stored or signed
  entry: "deposit",
  account: "eip155:8453:0xYourTestAccount",
  amount: "100",
});
console.log(test.review.simulation.assetChanges, test.review.approvals);

await kletia.contracts.list({ network: "base", status: "active" });
await kletia.contracts.get(contract.id);                          // the owner also gets the ABI and revisions
await kletia.contracts.update(contract.id, { actions });          // a new revision unless only labels or phrases change
await kletia.contracts.reverify(contract.id);                     // after an intended upgrade, or once the domain file is up
await kletia.contracts.delete(contract.id);
const info = await kletia.contracts.inspect({ network: "base", address: "0x…" }); // pins, proxy, Sourcify, allowed functions
```

`register` returns `{ contract }`; the other methods return the contract view
itself. Intents then use the registration by id or by its aliases:

```ts
await kletia.intents.create({ text: "bridge 100 USDC from base to arbitrum then deposit it into acme vault", accounts });
await kletia.intents.create({ actions: [{ kind: "call", network: "base", contract: contract.id, entry: "deposit", amount: "100" }], accounts });
```

### Sessions: let a page start a fixed flow without a key

Your backend fixes the actions; a page listed in `allowedOrigins` turns the
session into an intent for the visitor's own accounts, then executes it like
any other intent (with `onReview` for custom-contract steps).

```ts
// Server, with your key.
const session = await kletia.sessions.create({
  actions: [{ kind: "call", network: "base", contract: "ct_…", entry: "deposit", amount: "100" }],
  amount: { action: 0, min: "10", max: "1000" }, // the visitor may pick an amount in this range
  allowedOrigins: ["https://acme.example"],
  expiresInSeconds: 900,
});
// session.embedUrl: https://kletiaai.xyz/embed#session=cs_…

// Browser, no key. hostOrigin defaults to location.origin.
const { intent } = await new KletiaClient().sessions.createIntent(session.id, { accounts, amount: "250" });
```

`sessions.get(id)` returns the public view (integrator, labels, amount
bounds, expiry). `createIntent` is never retried: each call uses the session.

## Errors

Every non-2xx response throws `KletiaApiError` with a stable `code` (typed as
the catalog codes from `@kletia/core`, plus SDK codes such as
`NETWORK_ERROR`, `REQUEST_TIMEOUT`, `REQUEST_ABORTED`, `WAIT_TIMEOUT` and
`OUTCOME_UNKNOWN`), the
HTTP `status`, validation `issues`, `hints`, `retryAfterSeconds` when the API
sent `Retry-After`, the `requestId` for support, its catalog `category`,
`docsUrl`, and `retryable` (from the catalog).

```ts
import { isKletiaError } from "@kletia/sdk";

try {
  await kletia.intents.create(request);
} catch (error) {
  if (isKletiaError(error, "INSUFFICIENT_BALANCE")) showTopUp();
  else if (isKletiaError(error, "PROVIDER_UNAVAILABLE")) retryLater(); // also matches RELAY_UNAVAILABLE, …
  else throw error;
}
```

Wallet or execution failures throw `KletiaExecutionError` with the
`intentId`, `stepId` and, when transactions were already broadcast but not
recorded, their `references`.

## License

MIT
