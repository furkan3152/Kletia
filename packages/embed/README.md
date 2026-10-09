# @kletia/embed

The Kletia intent widget for any site, with or without a framework: a
`<kletia-intent>` custom element and `mountKletiaIntent()`. It renders
Kletia's hosted `/embed` page in a sandboxed iframe, sizes the frame to its
content and re-emits the visitor's progress as DOM events. No dependencies;
each build is one file.

Visitors plan and sign inside the frame with their own wallets. Your page
never receives calldata, signatures, addresses or amounts, and cannot start a
signature.

## Script tag

```html
<script
  src="https://cdn.jsdelivr.net/npm/@kletia/embed@0.1.0/dist/kletia-embed.min.js"
  integrity="sha384-…"
  crossorigin="anonymous"
></script>

<kletia-intent text="swap 1 SOL to USDC" reference="order-42"></kletia-intent>

<script>
  document.addEventListener("kletia:completed", (event) => {
    console.log(event.detail.intentId, event.detail.status);
  });
</script>
```

The script defines the element and exposes `window.KletiaEmbed`.

## npm

```bash
npm install @kletia/embed
```

```ts
import { mountKletiaIntent } from "@kletia/embed";

const widget = mountKletiaIntent("#slot", {
  theme: "dark",
  text: "bridge 25 USDC from base to solana",
  onCompleted: ({ intentId, status }) => verifyOnServer(intentId, status),
});
```

## Attributes

`intent` (`int_…`, an intent your backend created with its key) or `session`
(`cs_…`, a session your backend created), sent in the URL fragment so they
never reach access logs or referrers; `theme` (`light` | `dark` | `auto`), `text` (≤ 500 characters), `examples`
(comma-separated, ≤ 6), `bg` (`transparent`), `height` (pixels until the
frame reports its content height, default 600; the frame then follows its
content), `origin` (default
`https://kletiaai.xyz`; https, or http on localhost), `reference`
(`^[A-Za-z0-9_.:-]{1,80}$`, stored as `metadata.hostRef`, publicly readable
with the intent) and `label` (the frame's accessible name).

```html
<!-- Your backend created the intent (POST /v1/intents with its key). -->
<kletia-intent intent="int_3f9a…"></kletia-intent>
<!-- Or a session (POST /v1/sessions); this page's origin must be in allowedOrigins. -->
<kletia-intent session="cs_9c1e…"></kletia-intent>
```

Before anything is signed the frame shows the fare breakdown (asset-change
preview with certainty labels and fees in USD), the review of every custom
contract with "Not audited by Kletia" and an acknowledgement when something
is unverified, Rule Book holds and refusals with their rule ids, and, once a
receipt is issued, a share action. Details in
[docs/platform/embed.md](../../docs/platform/embed.md#what-the-visitor-sees-before-signing).

## Events

`kletia:ready`, `kletia:resize`, `kletia:intent-planned` (a preview, no id),
`kletia:intent-created` (a stored intent and its id), `kletia:step-updated`,
`kletia:completed` and `kletia:error`. Each is a
composed, bubbling `CustomEvent`; `detail` holds ids, statuses, heights and
error codes only.

**Events are not proof of payment.** Before fulfilling anything, read the
intent on your server with `GET /v1/intents/:id` and check its status, steps
and `metadata.hostRef`.

## Security

- The frame is sandboxed without top navigation and only gets
  `clipboard-write`.
- The element connects with a `MessageChannel` and `postMessage(…, origin)`,
  never `"*"`. The frame accepts one connect, only from its parent, only when
  the parent's origin matches the URL's `origin` parameter and
  `location.ancestorOrigins`, and it tells the visitor that your site is
  notified before it shares any intent id.

The full guide, including the bridge protocol, a raw iframe recipe and
troubleshooting, is in [docs/platform/embed.md](../../docs/platform/embed.md).

## License

MIT
