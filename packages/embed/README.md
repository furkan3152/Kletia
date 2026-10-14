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

Every Kletia web deployment serves this package's built files at immutable,
versioned paths with a manifest of their SHA-384 hashes
(`/sdk/embed/manifest.json`). Pin the version and the hash; the
[Embed builder](https://kletiaai.xyz/developers/embed) writes the tag for you.

```html
<script
  src="https://kletiaai.xyz/sdk/embed/0.1.0/kletia-embed.min.js"
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

The script defines the element and exposes `window.KletiaEmbed`. Once
published, the same file is on npm CDNs too
(`https://cdn.jsdelivr.net/npm/@kletia/embed@<version>/dist/kletia-embed.min.js`).

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

`intent` (`int_…`, an intent your backend created with its key), `session`
(`cs_…`, a session your backend created), or `key` (your project's
publishable key, `kl_pub_…`) with an optional `flow` (a stored flow id), all
sent in the URL fragment so they never reach access logs or referrers (a
secret key in `key` is ignored with a console warning, never forwarded); `theme` (`light` | `dark` | `auto`), `text` (≤ 500 characters), `examples`
(comma-separated, ≤ 6), `bg` (`transparent`), `height` (pixels until the
frame reports its content height, default 600; the frame then follows its
content), `origin` (default
`https://kletiaai.xyz`; https, or http on localhost), `reference`
(`^[A-Za-z0-9_.:-]{1,80}$`, stored as `metadata.hostRef`, publicly readable
with the intent) and `label` (the frame's accessible name).

When the script is loaded from a Kletia deployment's versioned path
(`<origin>/sdk/embed/<version>/kletia-embed.min.js`), that origin is the
default `origin`; from npm or a CDN the default stays `https://kletiaai.xyz`.
`max-height` (320-4000, default 1600) caps the frame; taller content scrolls
inside it.

Appearance: `accent`, `accent-ink`, `surface`, `ink`, `line` (six hex digits)
and their `-dark` variants, `radius` (0-16), `border` (1-3), `shadow` (`hard`
| `soft` | `none`), `font` (`inter` | `system` | `serif` | `mono` |
`rounded`), `density` (`comfortable` | `compact`) and `header` (`kletia` |
`none`). Colours that miss their contrast floor fall back to readable ones,
and the fare, contract reviews, policy holds and the footer never change; see
[theming](../../docs/platform/theming.md). With a custom `surface`, set
`bg="transparent"`.

Scope: `networks` (network keys, at most 9), `actions` (`swap`, `bridge`,
`transfer`, `stake`, `deposit`, `withdraw`) and `source-network` (a key from
`networks`, or `auto`). The wallet bar offers only the wallets these
networks need, and a plan outside them is refused before Execute
(`kletia:error` with `EMBED_SCOPE_REFUSED`).

```html
<kletia-intent networks="base,solana" actions="swap,bridge" source-network="auto"
  accent="7C3AED" radius="10" border="2" shadow="soft" bg="transparent"></kletia-intent>
```

Invalid values are dropped by the element and again by the frame. Clarifying
questions are always on; there is no attribute to turn them off.

```html
<!-- Your backend created the intent (POST /v1/intents with its key). -->
<kletia-intent intent="int_3f9a…"></kletia-intent>
<!-- Or a session (POST /v1/sessions); this page's origin must be in allowedOrigins. -->
<kletia-intent session="cs_9c1e…"></kletia-intent>
<!-- Or no backend at all: your project's publishable key and a stored flow. -->
<kletia-intent key="kl_pub_…" flow="deposit"></kletia-intent>
```

With a publishable key the frame needs the bridge, checks your page's origin
against the project's allowed origins (and refuses with
`PUBLISHABLE_ORIGIN_FORBIDDEN` otherwise), applies the project's defaults
under your attributes, and shows your project's name and logo only when its
domain is verified. In `mountKletiaIntent` the options are `publishableKey`
and `flow`.

Before anything is signed the frame shows the fare breakdown (asset-change
preview with certainty labels and fees in USD), the review of every custom
contract with "Not audited by Kletia" and an acknowledgement when something
is unverified, Rule Book holds and refusals with their rule ids, and, once a
receipt is issued, a share action. Details in
[docs/platform/embed.md](../../docs/platform/embed.md#what-the-visitor-sees-before-signing).

## Events

`kletia:ready`, `kletia:resize`, `kletia:intent-planned` (a preview, no id),
`kletia:intent-created` (a stored intent and its id), `kletia:step-updated`,
`kletia:completed`, `kletia:question` (the widget asks before it can plan:
`{ count, reasons }`, reason codes only) and `kletia:error`
(`onQuestion` in `mountKletiaIntent`). Each is a composed, bubbling
`CustomEvent`; `detail` holds ids, statuses, heights, reason and error codes
only.

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
