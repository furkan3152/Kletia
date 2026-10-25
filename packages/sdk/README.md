# @kletia/sdk

TypeScript SDK for the Kletia intent API. Plan cross-network intents across
EVM networks and Solana, show what they will move before anyone signs,
execute them with your users' wallets under Rule Books, verify their receipts,
publish intent links, stream events and verify webhooks. Depends only on
[`@kletia/core`](../core/README.md) (`viem` is an optional extra for EAS
envelopes).

```bash
npm install @kletia/sdk
```

The packages are released together from a `packages-v*` tag of this
repository (core, sdk, widget, embed and cli, same version, published to npm
with provenance). Before a version is on npm, install the release's packages
from a checkout of that tag:

```bash
git clone --branch packages-v<version> https://github.com/furkan3152/Kletia.git
cd Kletia && npm ci && npm pack -w @kletia/core -w @kletia/sdk
cd ../your-app && npm install ../Kletia/kletia-core-*.tgz ../Kletia/kletia-sdk-*.tgz
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

From the browser, either omit `apiKey` (public tier), point `baseUrl` at
your server's [`createKletiaProxy`](#browser-proxy-createkletiaproxy), e.g.
`new KletiaClient({ baseUrl: location.origin + "/api/kletia" })`, or use a
[publishable key](#publishable-keys-and-projects).

### Clarifying questions

`intents.create` refuses an incomplete sentence. `intents.turn` asks
instead: one turn of `POST /v1/intents?clarify=true` answers `needs_input`
with questions, `planned` with the intent, or `cancelled`. Send the returned
`thread` back with an answer; once it is ready, a turn with the thread and no
input stores the intent (the commit).

```ts
const accounts = [formatAccountId("solana", solanaAddress)];
let turn = await kletia.intents.turn({ text: "swap SOL to USDC", accounts }, { dryRun: true, preview: true });
while (turn.status === "needs_input") {
  const question = turn.questions[0];              // prompt, why, options (label, detail, sentence), allowsText
  const option = await askUser(question);          // e.g. "all"
  turn = await kletia.intents.turn({ thread: turn.thread, accounts, answer: { question: question.id, option } }, { dryRun: true, preview: true });
}
if (turn.status === "planned") {
  show(turn.sentence, turn.assumptions, turn.preview);       // what Kletia assumed, as chips
  const stored = await kletia.intents.turn({ thread: turn.thread, accounts });  // commit
}
```

The thread is held by your client (`kletia.thread/v1`, at most 16 KB): the
API keeps nothing between turns. With an API key, `remember: true` on the
first turn makes Kletia hold it instead (later turns send `threadId`; 30
minutes idle, 24 hours at most, 50 turns); `kletia.threads.list()`,
`threads.get(id)` and `threads.delete(id)` manage the key's threads. A turn
that changes a Kletia-held thread is retried only with an Idempotency-Key
(the client generates one when it has a key), and `expectedRev` refuses a
thread that moved on (`THREAD_CONFLICT`); dry-run turns on client-held
threads are safe to retry. Refusals are `KletiaApiError`s with the clarify
codes (`ANSWER_INVALID`, `QUESTION_NOT_OPEN`, `THREAD_INVALID`,
`THREAD_NOT_FOUND`, `THREAD_CLOSED`, `THREAD_REQUIRES_API_KEY`,
`MESSAGE_SECRET_REFUSED`); the thread is unchanged after one.

### List your intents

```ts
const recent = await kletia.intents.list({ limit: 50 });          // key required; `list(50)` works too
const widget = await kletia.intents.list({ owner: publishableKeyId }); // an agent or publishable key below yours
```

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

### The journey: where the money is after every step

```ts
const { intent, preview, journey } = await kletia.intents.create(request, { journey: true }); // implies the preview
const live = await kletia.intents.journey(intent.id);            // { stops, legs, now, consequences, blockers }
const { intent: stopped } = await kletia.intents.stop(intent.id); // end it at the current stop

await executeIntent(kletia, intent, signers, {
  onPreview: approveFare,
  onJourney: (next) => render(next),     // after the plan and when the journey changes (at most every 5 s)
  journeyAnswers: { "gas-to-continue:out:s1:base": "bring-gas" },
  onJourneyBlocked: (blockers) => ask(blockers),
});
```

A journey lists each stop (network, holder, custody, amounts with an
at-least bound, USD value and its source), each leg, and consequences
(`block`, `act`, `warn`, `info`) with options. With `onJourney` or
`journeyAnswers`, `executeIntent` reads the journey and stops before the
wallet prompt of a step that has an unanswered `block` consequence (an answer
must be one of that consequence's option ids), returning the intent like a
declined preview; a journey it cannot read stops the run before signing.
Options are data: the SDK never re-plans or stops anything on its own.
Without either option no journey is fetched. `stop` answers 409
`INTENT_IN_FLIGHT` (retryable, `Retry-After`) while a step is moving; never
stop while you hold broadcast references that were not submitted.

### Your data: what is kept, and deleting it

`kletia.intents.delete(id)` deletes a stored intent now, with its receipts'
stored disclosures and shares (409 `INTENT_IN_FLIGHT` while a step is
moving). Without it, the API removes the request text 24 hours after the
intent is final and deletes the intent 30 days after; the API's
`POST /v1/intents` response carries `privacy`, which says so for that request
(`intents.create` returns the intent only; `kletia.request` returns the whole
body). The `client.data.*` reads
send wallet addresses in a POST body, never in the URL. See
[data retention](../../docs/platform/data-retention.md).

### Holdings

```ts
const one = await kletia.portfolio(account, { positions: true });       // + venue positions
const many = await kletia.portfolios([baseAccount, solanaAccount], { positions: true }); // up to 12; failures listed
```

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

Every event of your key, as its webhooks would receive them (contract,
link, rule book and key events too), on one stream (key required, at most 2
per key; `kletia listen` forwards it to localhost signed like webhooks):

```ts
await kletia.events.stream((event) => console.log(event.type, event.id), {
  scope: "subtree",                         // also your agent and publishable keys
  types: ["contract.activated", "link.created"],
  lastEventId,                              // resume; de-duplicate by event id
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
| `GET`, `DELETE`, quotes, dry runs, `refresh`, `contracts.test`, `intents.preview`, `policies.validate`, `links.quote`, approval decisions (a decision replays) | Yes |
| Create intent, cancel, submit, create webhook, create or rotate key, `keys.createChild`, `contracts.register` / `update` / `reverify`, `sessions.create`, `receipts.share`, `policies.put`, `links.create` / `update` | Only with an `Idempotency-Key` |
| Webhook tests, `sessions.createIntent`, `links.createIntent`, `policies.evaluate`, rule book removals and other POSTs | No |
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
const sandbox = await kletia.keys.create("staging", { sandbox: true }); // testnet lane only; sandbox.lane === "testnet"
const keys = await kletia.keys.list();                       // last4 only, never secrets; each with its lane
const rotated = await kletia.keys.rotate(keys[0].id, { graceSeconds: 3600 });
await kletia.keys.revoke(oldKeyId);

const delivery = await kletia.webhooks.test(webhook.id);     // signed webhook.test, sent now
const log = await kletia.webhooks.deliveries(webhook.id, { limit: 50 });
const usage = await kletia.usage({ window: "7d" });
const catalog = await kletia.errors();
const lending = await kletia.venues({ network: "base", protocol: "morpho" }); // APY, TVL, exit liquidity
```

## Browser proxy: createKletiaProxy

`@kletia/sdk/server` turns your server into the browser's Kletia origin:
the key stays on the server and only what a visitor's browser needs is
forwarded.

```ts
import { createKletiaProxy, expressKletiaProxy } from "@kletia/sdk/server";

// Fetch handlers (Next.js route handlers, Hono, Workers, Bun, Deno):
const proxy = createKletiaProxy({ apiKey: process.env.KLETIA_API_KEY!, mount: "/api/kletia" });
export const GET = proxy, POST = proxy;    // app/api/kletia/[...path]/route.ts

// Express or node:http (before any JSON body parser):
app.use("/api/kletia", expressKletiaProxy({ apiKey: process.env.KLETIA_API_KEY!, mount: "/api/kletia" }));
```

In the page: `new KletiaClient({ baseUrl: location.origin + "/api/kletia" })`
or the widget's `baseUrl`. The default allowlist (`allow: "browser"`,
`BROWSER_PROXY_RULES`) forwards registry and quote reads, `POST /v1/intents`
(dry runs, previews and client-held clarify turns), intent reads and events
(Server-Sent Events streamed through), journey, stop, preview,
prepare/submit/refresh/cancel, receipt reads and shares, and the public
session and link routes. Everything else (keys, webhooks, contracts, rule
books, projects, usage, listing intents, Kletia-held threads) answers
`403 PROXY_ROUTE_FORBIDDEN` without reaching Kletia. The browser's
`Authorization`, `X-Kletia-Key`, `Cookie` and `Origin` are dropped (only a
few headers pass, `X-Request-Id` among them), bodies are capped
(`maxBodyBytes`, default 64 KB: 413) and redirects are never followed. Pass
`allow: [{ method: "GET", path: "/intents/:id" }, …]` to replace the list.
[examples/node-server](../../examples/node-server/README.md) runs it.

## Publishable keys and projects

A publishable key (`kl_pub_…`) identifies your project in browsers: it plans
intents (owned by the key, so its parent's subtree webhooks fire), starts
sessions from the project's stored flows and reads the project profile, from
the origins you allow and under the project's defaults.

```ts
// Browser
const kletia = new KletiaClient({ publishableKey: "kl_pub_…" });
const profile = await kletia.publishable.profile();       // brand, allowed origins, lane, defaults, flows
await kletia.sessions.create({ flow: "deposit", hostOrigin: location.origin });

// Server (project key)
const project = await server.projects.get();               // settings, version, hash, domain proof
await server.projects.update({ allowedOrigins: ["https://shop.example"] }, { ifMatch: project.hash });
await server.projects.verifyDomain();                      // https://<website>/.well-known/kletia.json
const { key } = await server.projects.createPublishableKey({ label: "website" }); // shown once
await server.projects.setLogo(pngBytes, "image/png");      // verified projects; PNG or WebP, 64 KB
```

With `publishableKey` the client refuses every server-only method locally
(`PUBLISHABLE_KEY_FORBIDDEN`, status 0, nothing sent) and never sends an
Idempotency-Key. `projects.update` takes the `hash` it is based on: a project
changed meanwhile answers 409 `PROJECT_CONFLICT`.

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

## Asset-change preview ("fare breakdown")

Every plan can come with what it moves: per account and asset, expected and
worst case, payments to others, fees and approvals, each with its certainty
(`simulated`, `quoted`, …). Nothing is prepared or signed to compute it.

```ts
const { intent, preview } = await kletia.intents.create(request, { preview: true });
const fresh = await kletia.intents.preview(intent.id, { refreshQuotes: false }); // POST, 6 per minute
const last = await kletia.intents.getPreview(intent.id);                          // GET, 404 PREVIEW_NOT_FOUND

await executeIntent(kletia, intent.id, signers, {
  preview,
  // Before each signature, with the intent preview and the step's own preview.
  onPreview: async (shown, stepPreview, { reason, changes }) => showFareAndAsk(shown, stepPreview, changes),
});
```

`executeIntent` sends the approved digest as `acknowledgedPreview`. When the
freshly simulated payload is materially worse (409 `PREVIEW_CHANGED`,
`KletiaPreviewChangedError` carries the fresh preview), when the API no longer
holds the digest, or when the fresh preview is materially worse by core
`materialChange` even though the API matched it, `onPreview` is asked again:
nothing is signed without that second approval. A preview whose digest does
not match its content, or that describes another payload (quote binding), is
refused. Without `onPreview`, steps proceed unless a preview issue has severity
`block`.

## Rule Books and agent keys

Give an AI agent its own key, bound by a rule book: networks, kinds, assets,
recipients, caps, schedule, confirmations above a threshold. Tightening applies
at once; loosening waits the rule book's amendment delay.

```ts
const kletia = new KletiaClient({ apiKey: process.env.KLETIA_API_KEY });   // a project key

const { key, policy } = await kletia.keys.createChild("key_7d2e…", {
  name: "research-bot", template: "payments-agent", expiresInSeconds: 30 * 86_400,
  fill: { recipients: ["eip155:*:0x…"], approverWallets: ["eip155:8453:0x…"] },
});                                              // key.key is the kl_agt_… secret, shown once
await kletia.policies.put(key.id, document, { ifMatch: policy.hash }); // Idempotency-Key automatic
const { policy: head, effective } = await kletia.policies.get(key.id);
await kletia.policies.cancelPending(key.id);
await kletia.policies.versions(key.id);
await kletia.policies.project.put(projectDocument);

const local = validatePolicy(document, { defaults: "agent" });       // offline, from @kletia/core
const diff = comparePolicies(head.document, document, { defaults: "agent" }); // { tightened, loosened }
const sim = await kletia.policies.evaluate({ keyId: key.id, request, stage: "plan" }); // every rule, also on deny
const log = await kletia.policies.decisions({ keyId: key.id, outcome: "deny", limit: 50 });
verifyDecisionChain(log.decisions, storedHead);                      // hash-chained audit log
const budget = await kletia.policies.spend(key.id);
```

Refusals are `KletiaPolicyError` (`decisionId`, `violations` with stable rule
ids, `retryAt`, `approval`, `stage`). An intent held for approval
(`POLICY_APPROVAL_REQUIRED`) carries `approval.url` (`<web>/approve#apr_…`),
which is safe to hand to the agent: reading is not approving.

```ts
await kletia.approvals.approve("apr_…");                       // a project key, never the requester
await kletia.approvals.reject("apr_…");                        // cancels the intent
await kletia.approvals.approveWithWallet("apr_…", eip1193ApprovalSigner(window.ethereum, "eip155:8453:0x…"));
await kletia.approvals.approveWithWallet("apr_…", walletStandardApprovalSigner(phantom, account)); // Solana signMessage
```

Wallet decisions sign exactly what `@kletia/core` builds (`approvalTypedData`,
EIP-712 "Kletia Approvals" on the signer's chain, or `approvalMessageText`),
after the SDK recomputed the approval digest from the intent it names.

### The policy-bound signer

Run an agent's signer behind a guard pinned by the operator (not the agent):

```ts
const guard = await createPolicyGuard({
  client: agentClient,                      // authenticated with the agent key
  keyId: "key_9a7f…",
  pinnedHash: process.env.AGENT_POLICY_HASH, // "sha256:…", from the operator's configuration
  networks: ["base", "solana"],             // optional local allowlist
});
await executeIntent(agentClient, intentId, { evm, solana }, {
  policyGuard: guard,
  onApprovalRequired: (approval) => notifyHuman(approval?.url), // returns instead of waiting
});
```

Before every signature the guard re-reads the key's chain and refuses unless
the key's rule book still hashes to the pin; the intent is stamped for this key
(`allow`, or `confirm` with an approved approval of exactly these steps);
`evaluatePolicyChain` allows it (USD as reported; rolling caps are the
server's); and the bytes are what the step needs: chain, sender, targets from
the core registries, approvals never above the step input, transfers to the
step recipient for exactly its amount, native value within input plus extra
costs, pinned nonces for signers that declare `honorsNonce`; on Solana the
network, the fee payer and a single signer. A refusal throws
`KletiaPolicyError` with `stage: "sign"`; nothing reaches the wallet.
`eip1193Signer` passes a pinned `nonce` to the wallet; set `honorsNonce` only
for signers known to use it.

## Verifiable receipts

Every finished intent gets a signed receipt once its transactions are final.

```ts
const result = await kletia.receipts.get("int_…", { wait: { timeoutMs: 45 * 60_000 } }); // polls 202, Retry-After
const check = await verifyReceipt(result.receipt!, { intentId: "int_…", keys });           // offline, @kletia/core
const { share } = await kletia.receipts.share("int_…", { profile: "proof", expiresInSeconds: 7 * 86_400 });
// share.url carries the decryption key in its fragment, returned once.
await kletia.receipts.unshare("int_…", share.id);
await kletia.receipts.list("int_…");
await kletia.receipts.keys();
await kletia.receipts.withdraw("int_…");   // delete stored disclosures and every share
```

`@kletia/sdk/receipts` is browser-safe (fetch and Web Crypto):

```ts
import { openShareUrl, reverifyReceipt, verifyEasEnvelope, DEFAULT_REVERIFY_RPCS } from "@kletia/sdk/receipts";

const opened = await openShareUrl("https://kletiaai.xyz/r/rcpt_…#s=rsh_…&k=…"); // fetch, decrypt locally, verify
const report = await reverifyReceipt(opened.receipt, { quorum: 2 });
// report.verdict: "verified" | "mismatch" | "inconclusive"
const eas = await verifyEasEnvelope(receipt);  // optional EAS offchain attestation; needs `npm install viem`
```

`reverifyReceipt` re-reads every anchor of every disclosed evidence group from
public RPCs (`DEFAULT_REVERIFY_RPCS`, or your own with `rpcs`), requires
`quorum` distinct sources to agree (1 when only one is configured, with a
`SINGLE_SOURCE` warning), checks finality, rebuilds the EVM quote binding from
the landed calldata and reads the log anchor (`EAS.getTimestamp`) on Base.
Per anchor: `match`, `mismatch`, `conflict`, `unavailable` (a pruned or
refusing public node is never evidence) or `not_finalized`. Read-only
throughout; RPC URLs in reports drop query strings and long path tokens.

Key trust: keys pinned in `@kletia/core` (`KLETIA_RECEIPT_KEY_PINS`), keys you
pass (`keys`), or by default the API's key set cross-checked with the web
origin's `/.well-known/kletia-receipt-keys.json` (`fetchReceiptKeys`): a key
only one origin lists is never trusted, and no trusted key means
`KEY_UNKNOWN`.

## Intent links

A link (`lk_…`, served at `kletiaai.xyz/go/<id>`) is a fixed destination
anyone can fund from the networks and assets you allow.

```ts
const { link } = await kletia.links.create(definition);  // validateLinkDefinition locally first; Idempotency-Key automatic
await kletia.links.list({ status: "active" });
await kletia.links.get(link.id);
await kletia.links.update(link.id, { funding: { amount: { mode: "input", bounds: { USDC: { min: "20", max: "5000" } } } } }); // tighten only
await kletia.links.pause(link.id);
await kletia.links.resume(link.id, { accept: ["recipient_changed"] });
await kletia.links.delete(link.id);
const stats = await kletia.links.stats(link.id, { window: "30d" });
kletia.links.pageUrl(link.id); kletia.links.cardUrl(link.id, "square");
const png = await kletia.links.card(link.id, { variant: "square" });

// Browser, no key:
const visitor = new KletiaClient();
const { preview } = await visitor.links.quote("lk_…", { source: { network: "arbitrum", asset: "USDC" }, amount: "250" });
const { intent } = await visitor.links.createIntent("lk_…", { accounts, source: { network: "arbitrum", asset: "USDC" }, amount: "250" });
await executeIntent(visitor, intent.id, signers, { onPreview });
```

## Errors

Every non-2xx response throws `KletiaApiError` with a stable `code` (typed as
the catalog codes from `@kletia/core`, plus SDK codes such as
`NETWORK_ERROR`, `REQUEST_TIMEOUT`, `REQUEST_ABORTED`, `WAIT_TIMEOUT` and
`OUTCOME_UNKNOWN`), the
HTTP `status`, validation `issues`, `hints`, `retryAfterSeconds` when the API
sent `Retry-After`, the `requestId` for support, its catalog `category`,
`docsUrl`, `retryable` (from the catalog) and `details`, the error's
structured context when the API sends one (for example the candidate
networks of `SOURCE_REQUIRED`).

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

Rule Book refusals are `KletiaPolicyError` (`policy` with `decisionId`,
`violations`, `retryAt`, `approval`, `stage`); a materially worse prepare is
`KletiaPreviewChangedError` (`preview`, `changes`).

Wallet or execution failures throw `KletiaExecutionError` with the
`intentId`, `stepId` and, when transactions were already broadcast but not
recorded, their `references`.

## License

MIT
