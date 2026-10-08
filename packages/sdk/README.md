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

const kletia = new KletiaClient({ apiKey: process.env.KLETIA_API_KEY });

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

## Stream events

```ts
await kletia.intents.stream(intent.id, (event) => {
  if (event.type === "intent.step_updated") console.log(event.data.stepId, event.data.status);
});
```

## Verify webhooks

```ts
import { verifyWebhookSignature } from "@kletia/sdk";

const { valid } = await verifyWebhookSignature(secret, rawBody, request.headers["kletia-signature"]);
```

## Errors

Every non-2xx response throws `KletiaApiError` with a stable `code`, the HTTP
`status`, validation `issues` and the `requestId` for support. Wallet or
execution failures throw `KletiaExecutionError` with the `intentId` and
`stepId`.

## License

MIT
