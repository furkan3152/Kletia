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
manage your webhooks. Use the keyless public tier (omit `clientOptions`), your
project's **publishable key** (`publishableKey="kl_pub_…"`, made for browser
code: it is sent as `Authorization: Bearer kl_pub_…`, only plans from the
origins your project allows and owns the intents for your project; see
[projects](../../docs/platform/projects.md)), or a `baseUrl` pointing at a
proxy route on your server (requests go to `<baseUrl>/v1/…`) that forwards
them to the Kletia API and adds `Authorization: Bearer kl_dev_…` there.

## Questions and the journey

- **Clarifying questions (always on).** Text is planned through clarify
  turns (`POST /v1/intents?clarify=true`, [clarify](../../docs/platform/clarify.md)):
  when a sentence leaves something open that only the user can decide (how
  much, where to, which network a recipient is on), the widget asks in a
  question card under the prompt instead of guessing. Choices are numbered
  radio buttons (arrow keys move, Enter or 1-9 picks, Esc is "Not now"),
  free text is offered where it makes sense, and Kletia's suggestion (only on
  "how" questions, such as the venue) is marked "Suggested" in words. Once
  planned, the defaults Kletia picked show as **Kletia assumed** chips;
  picking an alternative re-plans. A refused answer keeps the card and the
  thread. `onClarify` reports `{ count, reasons, questions: [{ reason, kind,
  purpose }] }`, never the values. There is no off switch.
- **Journey.** Every plan comes with its [journey](../../docs/platform/journey.md):
  an itinerary after the fare and before the steps (`kw-journey`, never
  hideable by appearance) that says where the money is after each step, who
  holds it, how much (expected and at least, with the same certainty shapes
  as the fare plus a filled square for amounts observed on-chain) and what
  follows, as notices with fixed road signs (octagon Stop, diamond Act,
  triangle Warning, circle Info; the rest folded under "More about this
  route"). A **Stop** notice (for example no gas to sign the next leg) asks
  one question and keeps **Execute** off until it is answered; "I will handle
  it" is always one of the answers. The journey is read with the plan and
  when a step changes (never polled); once the intent is over, or a leg
  failed, it says where the money is now.

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

## Appearance and scope

```tsx
<KletiaIntentWidget
  accounts={accounts}
  defaultText="bridge 25 USDC from base to solana"
  appearance={{
    light: { accent: "#6D28D9", surface: "#FFFFFF", ink: "#1E1B4B" },
    dark: { accent: "#A78BFA", surface: "#17132B", ink: "#EDE9FE" },
    radius: 10,
    border: 2,
    shadow: "soft",
    font: "system",
    density: "compact",
  }}
  networks={["base", "solana"]}
  actions={["swap", "bridge"]}
  sourceNetwork="auto"
/>
```

- **`appearance`** takes the [appearance tokens](../../docs/platform/theming.md)
  (`kletia.appearance/v1`). Colours that miss their contrast floor fall back
  to readable ones; the fare, contract reviews, policy holds, stamps, refusals
  and the footer never change. Without `appearance` the widget looks exactly
  as before. You can also override the public `--kw-*` variables from an
  ancestor (`.checkout .kw-root { --kw-accent: #0f766e; }`); see
  [the escape hatch](../../docs/platform/theming.md#the-react-escape-hatch).
- **`networks` / `actions`** scope the widget. A plan that touches another
  network (a bridge destination or a recipient's network included) or uses
  another kind of action is shown with **Not available here**, the offending
  steps listed, and **Execute** stays disabled; `onError` receives a
  `KletiaScopeError` (`code: "EMBED_SCOPE_REFUSED"`). `outOfScope(intent,
  { networks, actions })` gives you the same answer for your own checks.
- **`sourceNetwork`** (a network key or `"auto"`) is sent as the request's
  `sourceNetwork`; a key outside `networks` is dropped.
- **`header: "none"`** hides the header and moves the lane label ("Preview"
  until `signers` are passed, then the account count) to the footer.
- Clarifying questions are always on: there is no prop to turn them off.

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
| `useKletiaIntent({ accounts, signers?, metadata?, maxSlippageBps?, sourceNetwork?, dryRun?, preview?, journey?, onPreview?, onReview?, onApprovalRequired? })` | `plan(text)` (a clarify turn: it may ask first, `phase: "clarifying"` with `clarify.questions`), `answer({ questionId, optionId \| text })`, `chooseAssumption(id, optionId)`, `say(text)` (a follow-up such as "make it 50"), `clarify` (questions, assumptions, thread), `journey` and `answerJourney(consequenceId, optionId)` (with `journey: true`; open blockers keep `execute()` from signing), `open(intentId)`, `startSession(sessionId, { hostOrigin?, amount? })`, `execute()`, `cancel()`, `reset()`, `intent`, `preview`, `phase` (`idle`, `planning`, `clarifying`, `planned`, `executing`, `cancelling`, `finished`), `error`, `pendingReferences`. `open` loads an intent your backend created; `startSession` turns a session into an intent for `accounts` (`hostOrigin` defaults to `location.origin` and must be in the session's `allowedOrigins`). `onPreview` / `onReview` / `onApprovalRequired` are `executeIntent`'s gates (see `@kletia/sdk`); the preview gate runs with the plan's `preview` |
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
- An answer to a question that is no longer open (after `reset()`, a new
  sentence or a newer turn) is never sent, and a late reply to one is
  ignored. Threads are held in memory only (never `localStorage`).

The state machines behind the hooks (`createIntentSession`,
`createIntentFollower`, `createRequestLoader`) are exported too, for other
frameworks.

## Props

| Prop | Type | Notes |
|---|---|---|
| `accounts` | `AccountId[]` | CAIP-10 accounts the user controls (required to plan) |
| `client` / `clientOptions` | `KletiaClient` / options | API origin (`baseUrl`). Never put a `kl_dev_` key in browser code; proxy through your server to attribute intents to your key |
| `publishableKey` | `kl_pub_…` | Your project's publishable key, sent as `Authorization: Bearer kl_pub_…` (ignored when `client` is given). With an explicit `hostOrigin`, requests also carry `Kletia-Host-Origin` (the hosted frame) |
| `signers` | `{ evm?, solana? }` | Enables execution |
| `theme` | `"light" \| "dark" \| "auto"` | Default: `appearance.colorScheme`, else `auto` |
| `appearance` | `KletiaAppearance` | Appearance tokens (see [theming](../../docs/platform/theming.md)) |
| `networks` | `NetworkKey[]` | Networks the widget works with; other plans are refused before Execute |
| `actions` | `("swap" \| "bridge" \| "transfer" \| "stake" \| "deposit" \| "withdraw")[]` | Kinds of action offered; other plans are refused before Execute |
| `sourceNetwork` | `NetworkKey \| "auto"` | Where the money starts (sent as `sourceNetwork`) |
| `examples` | `string[]` | Example chips |
| `maxSlippageBps` | `number` | Per-swap slippage ceiling |
| `metadata` | `Record<string, string>` | Echoed in events and webhooks |
| `intentId` | `int_…` | Open an intent your backend created instead of planning from text |
| `sessionId` / `hostOrigin` | `cs_…` / origin | Run a session your backend created; `hostOrigin` (default `location.origin`) must be in its `allowedOrigins` |
| `preview` | `boolean` | Ask for the fare breakdown with every plan (default `true`) |
| `linkOrigin` | origin | Rebuild non-https approval and receipt links on this origin (the Kletia web app only) |
| `onIntentCreated` / `onIntentOpened` / `onSessionLoaded` / `onUpdate` / `onComplete` / `onError` | callbacks | Lifecycle hooks (`onIntentOpened`: an `intentId` was loaded; `onSessionLoaded`: a `sessionId` was loaded) |
| `onClarify` | `(event: ClarifyEvent) => void` | Kletia asked: `{ count, reasons, questions: [{ reason, kind, purpose }] }`, never values |

## Display helpers

`@kletia/widget/review` exports the pure models the widget renders, for your
own UI: `fareModel(preview, intent)`, `contractReviewModel(review)`,
`policyHold(intent)`, `policyOutcome(error)`, `approvalHref`,
`receiptShareHref`, `receiptGroupsLabel`, `receiptPendingText`,
`RECEIPT_SHARE_PROFILES`, `RECEIPT_SHARE_GROUPS`, `CERTAINTY_INFO`, and for
the journey and questions `journeyModel(journey, { answered })`,
`journeyPromptView(consequence)`, `validJourneyAnswers`, `SEVERITY_SIGNS`,
`JOURNEY_CERTAINTY_INFO`, `clarifyView(turnResponse)`, `assumptionViews`
and `clarifyEventOf`. They return plain text (control and
direction-override characters removed) and only https links. The components
are exported too: `FareBreakdown`, `ContractReview`, `PolicyNotice`,
`ReceiptStamp`, `ClarifyCard` (`{ question, onAnswer, onDismiss, compact? }`,
for clarify questions and journey prompts), `AssumptionChips`
(`{ assumptions, onChange }`) and `JourneyRoute`.

## License

MIT
