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
  // Keyless public tier. To attribute intents to your developer key, proxy
  // through your server instead: clientOptions={{ baseUrl: "https://your-app.example/kletia" }}
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

The widget runs in the browser, so never pass a `kl_dev_` developer key to
it: anyone can read it from your bundle and use it to list your intents and
manage your webhooks. Use the keyless public tier (omit `clientOptions`) or a
`baseUrl` pointing at a proxy route on your server (requests go to
`<baseUrl>/v1/…`) that forwards them to the Kletia API and adds
`Authorization: Bearer kl_dev_…` there.

If a wallet has already broadcast a step's transactions but Kletia could not
record them (for example a network error), the widget keeps those references
and the button changes to **Resubmit**: it reports them instead of asking the
wallet to sign the step again.

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
| `client` / `clientOptions` | `KletiaClient` / options | API origin (`baseUrl`). Never put a `kl_dev_` key in browser code; proxy through your server to attribute intents to your key |
| `signers` | `{ evm?, solana? }` | Enables execution |
| `theme` | `"light" \| "dark" \| "auto"` | Default `auto` |
| `examples` | `string[]` | Example chips |
| `maxSlippageBps` | `number` | Per-swap slippage ceiling |
| `metadata` | `Record<string, string>` | Echoed in events and webhooks |
| `onIntentCreated` / `onUpdate` / `onComplete` / `onError` | callbacks | Lifecycle hooks |

## License

MIT
