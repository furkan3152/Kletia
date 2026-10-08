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

## Stream events

```ts
await kletia.intents.stream(intent.id, (event) => {
  if (event.type === "intent.step_updated") console.log(event.data.stepId, event.data.status);
});
```

## Verify webhooks

Verify against the exact raw body, before parsing it. With a Fetch `Request`
(edge runtimes, Next.js route handlers, Deno, Bun):

```ts
import { verifyWebhookSignature } from "@kletia/sdk";

const rawBody = await request.text();
const { valid } = await verifyWebhookSignature(secret, rawBody, request.headers.get("kletia-signature"));
```

With Node or Express, read the body raw (`express.raw`) and pass the header
value as is (`string | string[] | undefined`; the first value is used):

```ts
app.post("/webhooks/kletia", express.raw({ type: "application/json" }), async (req, res) => {
  const { valid } = await verifyWebhookSignature(secret, req.body.toString("utf8"), req.headers["kletia-signature"]);
  res.sendStatus(valid ? 204 : 400);
});
```

## Errors

Every non-2xx response throws `KletiaApiError` with a stable `code`, the HTTP
`status`, validation `issues`, `retryAfterSeconds` when the API sent
`Retry-After`, and the `requestId` for support. Wallet or execution failures
throw `KletiaExecutionError` with the `intentId`, `stepId` and, when
transactions were already broadcast but not recorded, their `references`.

## License

MIT
