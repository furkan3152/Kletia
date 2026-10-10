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

## Before anything is signed

- **Fare breakdown.** Plans ask for the [asset-change preview](../../docs/platform/preview.md)
  (`preview`, default on): what leaves each wallet, what arrives where
  (expected, and "at least"), money that only passes through, fees in USD,
  allowances, gas to bring on arrival and when it lands, every number
  labelled `simulated`, `simulated, funds assumed`, `venue minimum`, `quoted`
  or `estimated` (by shape and in words). Pressing **Execute** approves that
  fare and its digest is sent to prepare as `acknowledgedPreview`; a fare
  that changes (`PREVIEW_CHANGED`, or a prepared payload whose fare differs)
  stops before the wallet with the old fare struck through until the user
  approves the new one. A blocking preview issue is never signed.
- **Custom contracts.** Every `call` / `action` step shows its
  `ContractReview` (who, what, permissions, result, provenance, "Not audited
  by Kletia"); an unverified source, program or domain needs an
  acknowledgement before **Execute**, and the prepared review (with what
  moved since planning struck through) needs **Sign this step** before the
  wallet opens. **Stop** at either gate signs nothing.
- **Rule Book.** A hold for approval shows the rule ids and the approval
  link (https only); refusals show the rules, observed values and limits.
- **Receipts.** A finished intent shows its receipt stamp and **Share
  receipt…**: receipts are private until the user picks what a link shows.

## Intents and sessions your backend creates

```tsx
// Your backend created the intent with its API key (POST /v1/intents).
<KletiaIntentWidget intentId="int_3f9a…" accounts={accounts} signers={signers} />

// Your backend created a session (POST /v1/sessions); the widget turns it into
// an intent for the connected wallet. This page's origin must be in allowedOrigins.
<KletiaIntentWidget sessionId="cs_9c1e…" accounts={accounts} signers={signers} />
```

With `intentId` the widget shows the intent's review and fare and asks for
the wallet it was planned for. With `sessionId` it shows who is asking and
what, the amount within the session's bounds, and plans only once a wallet is
connected (`hostOrigin` defaults to `location.origin`).

If a wallet has already broadcast a step's transactions but Kletia could not
record them (for example a network error), the widget keeps those references
and the button changes to **Resubmit**: it reports them instead of asking the
wallet to sign the step again.

Without `signers` the widget plans and reviews intents but does not execute
them, which is useful for quotes and previews. For non-React pages, embed the hosted
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
| `useKletiaIntent({ accounts, signers?, metadata?, maxSlippageBps?, dryRun?, preview?, onPreview?, onReview?, onApprovalRequired? })` | `plan(text)`, `open(intentId)`, `startSession(sessionId, { hostOrigin?, amount? })`, `execute()`, `cancel()`, `reset()`, `intent`, `preview`, `phase` (`idle`, `planning`, `planned`, `executing`, `cancelling`, `finished`), `error`, `pendingReferences`. `open` loads an intent your backend created; `startSession` turns a session into an intent for `accounts` (`hostOrigin` defaults to `location.origin` and must be in the session's `allowedOrigins`). `onPreview` / `onReview` / `onApprovalRequired` are `executeIntent`'s gates (see `@kletia/sdk`); the preview gate runs with the plan's `preview` |
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
| `intentId` | `int_…` | Open an intent your backend created instead of planning from text |
| `sessionId` / `hostOrigin` | `cs_…` / origin | Run a session your backend created; `hostOrigin` (default `location.origin`) must be in its `allowedOrigins` |
| `preview` | `boolean` | Ask for the fare breakdown with every plan (default `true`) |
| `linkOrigin` | origin | Rebuild non-https approval and receipt links on this origin (the Kletia web app only) |
| `onIntentCreated` / `onIntentOpened` / `onUpdate` / `onComplete` / `onError` | callbacks | Lifecycle hooks (`onIntentOpened`: an `intentId` was loaded) |

## Display helpers

`@kletia/widget/review` exports the pure models the widget renders, for your
own UI: `fareModel(preview, intent)`, `contractReviewModel(review)`,
`policyHold(intent)`, `policyOutcome(error)`, `approvalHref`,
`receiptShareHref`, `receiptGroupsLabel`, `receiptPendingText`,
`RECEIPT_SHARE_PROFILES`, `RECEIPT_SHARE_GROUPS`, `CERTAINTY_INFO`. They return
plain text (control and direction-override characters removed) and only
https links. The components are exported too: `FareBreakdown`,
`ContractReview`, `PolicyNotice`, `ReceiptStamp`.

## License

MIT
