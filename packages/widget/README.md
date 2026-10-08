# @kletia/widget

Drop-in React widget for Kletia cross-network intents. Users describe an
outcome, review the planned step graph, and execute it with their own EVM and
Solana wallets. Styles are scoped (`kw-` classes) and injected once; no CSS
import is needed.

```bash
npm install @kletia/widget @kletia/sdk
```

```tsx
import { KletiaIntentWidget } from "@kletia/widget";
import { eip1193Signer, formatAccountId, walletStandardSolanaSigner } from "@kletia/sdk";

<KletiaIntentWidget
  clientOptions={{ apiKey: "kl_dev_…" }}
  accounts={[formatAccountId("base", evmAddress), formatAccountId("solana", solanaAddress)]}
  signers={{
    evm: eip1193Signer(window.ethereum, evmAddress),
    solana: walletStandardSolanaSigner(wallet, account, "solana:mainnet"),
  }}
  theme="auto"
  metadata={{ orderId: "A-1029" }}
  onComplete={(intent) => console.log(intent.status)}
/>;
```

Without `signers` the widget plans and reviews intents but does not execute
them — useful for quotes and previews. For non-React pages, embed the hosted
widget with an iframe:

```html
<iframe src="https://kletiaai.xyz/embed" width="480" height="640" title="Kletia intents"></iframe>
```

## Props

| Prop | Type | Notes |
|---|---|---|
| `accounts` | `AccountId[]` | CAIP-10 accounts the user controls (required to plan) |
| `client` / `clientOptions` | `KletiaClient` / options | API origin and developer key |
| `signers` | `{ evm?, solana? }` | Enables execution |
| `theme` | `"light" \| "dark" \| "auto"` | Default `auto` |
| `examples` | `string[]` | Example chips |
| `maxSlippageBps` | `number` | Per-swap slippage ceiling |
| `metadata` | `Record<string, string>` | Echoed in events and webhooks |
| `onIntentCreated` / `onUpdate` / `onComplete` / `onError` | callbacks | Lifecycle hooks |

## License

MIT
