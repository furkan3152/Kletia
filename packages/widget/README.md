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

The hosted page accepts `theme=light|dark|auto`, `text=<default intent>`, `examples=<comma-separated>` (up to 6) and `bg=transparent`. It never reads an API key from the URL and always uses the public tier. Users connect their own EVM and Solana wallets inside the frame; for `theme=dark&bg=transparent` on a light page, add `style="color-scheme: dark"` to the iframe.

## Hooks

`@kletia/widget/hooks` gives you the widget's logic without its UI, for your
own components. It reuses the React peer dependency and needs no
data-fetching library.

```tsx
import { KletiaProvider, useKletiaIntent, useIntent, useQuote } from "@kletia/widget/hooks";

<KletiaProvider options={{ baseUrl: "https://your-app.example/kletia" } /* never a kl_dev_ key in the browser */}>
  <Checkout />
</KletiaProvider>;

function Checkout({ accounts, signers }) {
  const { plan, execute, cancel, reset, intent, phase, error, pendingReferences } = useKletiaIntent({
    accounts,
    signers,
    metadata: { orderId: "A-1029" },
    maxSlippageBps: 50,
  });
  return (
    <>
      <button disabled={phase === "planning"} onClick={() => plan("bridge 25 USDC from base to solana")}>Plan</button>
      <button disabled={phase !== "planned"} onClick={() => execute()}>Execute</button>
      {intent ? <p>{intent.summary.title}: {intent.status}</p> : null}
    </>
  );
}
```

| Hook | Returns |
|---|---|
| `useKletiaIntent({ accounts, signers?, metadata?, maxSlippageBps?, dryRun? })` | `plan(text)`, `execute()`, `cancel()`, `reset()`, `intent`, `phase` (`idle`, `planning`, `planned`, `executing`, `cancelling`, `finished`), `error`, `pendingReferences` |
| `useIntent(intentId)` | `intent`, `status` (`loading`, `live` on the event stream, `polling`, `done`, `error`), `error`, `lastEvent` |
| `useQuote(request, { debounceMs: 400 })` | `data`, `status`, `error`, `reload()`; pass `null` to quote nothing |
| `useNetworks()`, `usePortfolio(accountId)` | `data`, `status`, `error`, `reload()` |
| `useKletiaClient()` | The client from `KletiaProvider` |

Safety behaviour:

- Unmounting, planning again or `reset()` aborts a running execution, and the
  signers it was given stop reaching the wallet, so no prompt opens for a
  component that is gone. Late responses of a replaced plan are ignored.
- If a wallet broadcast a step but Kletia could not record it, the
  references stay in `pendingReferences` and the next `execute()` reports
  them instead of signing the step again.
- `cancel()` stops a running execution first, then asks Kletia to cancel the
  intent (refused once a step was submitted; follow it to settlement then).
- `useQuote` debounces input changes, compares inputs by value, aborts the
  request in flight when the input changes or the component unmounts, and
  does not show a quote for a different input unless `keepPreviousData`.
- `useIntent` follows the event stream (resuming with `Last-Event-ID`) and
  polls while the stream is unavailable, until the intent is terminal.

The state machines behind the hooks (`createIntentSession`,
`createIntentFollower`, `createRequestLoader`) are exported too, for other
frameworks.

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
