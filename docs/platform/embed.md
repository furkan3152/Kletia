# Embed Kletia on any site

`@kletia/embed` puts the Kletia intent widget on any page, with or without a
framework: a `<kletia-intent>` custom element, or `mountKletiaIntent()` from
JavaScript. The element renders Kletia's hosted `/embed` page in a sandboxed
iframe, sizes the frame to its content and tells your page what the visitor
did through DOM events (`kletia:ready`, `kletia:intent-planned`,
`kletia:intent-created`, `kletia:step-updated`, `kletia:completed`,
`kletia:question`, `kletia:error`, `kletia:resize`).

The visitor plans and signs inside the frame with their own wallet. Your page
never sees calldata, signatures, addresses or amounts, and it cannot sign or
submit anything on the visitor's behalf.

For React apps that want the widget in their own DOM, use
[`@kletia/widget`](../../packages/widget/README.md) instead.

## Quick start

The fastest path is the [Embed builder](https://kletiaai.xyz/developers/embed):
pick what the widget offers and how it looks, check it in the live preview,
and copy the HTML, npm, React or iframe code (the HTML pins this
deployment's integrity hash for you). [examples/html-embed](../../examples/html-embed/README.md)
is the same page as a runnable example.

With a script tag, served by the Kletia origin itself (one self-contained
file at an immutable, versioned path; pin it with its Subresource Integrity
hash):

```html
<script
  src="https://kletiaai.xyz/sdk/embed/0.1.0/kletia-embed.min.js"
  integrity="sha384-…"
  crossorigin="anonymous"
></script>

<kletia-intent
  text="swap 1 SOL to USDC"
  examples="swap 1 SOL to USDC,stake 2 SOL with jito"
  reference="order-42"
></kletia-intent>

<script>
  document.querySelector("kletia-intent").addEventListener("kletia:completed", (event) => {
    // A hint, not a payment: confirm on your server (see "Verify on your server").
    fetch("/api/orders/42/check-intent", { method: "POST", body: JSON.stringify(event.detail) });
  });
</script>
```

Every Kletia web deployment serves the built embed files and a manifest:

| Path | What | Headers |
|---|---|---|
| `/sdk/embed/<version>/kletia-embed.min.js` | the classic script (global `KletiaEmbed`) | `Cache-Control: public, max-age=31536000, immutable`, `Access-Control-Allow-Origin: *`, `Cross-Origin-Resource-Policy: cross-origin`, `Content-Type: text/javascript` |
| `/sdk/embed/<version>/index.js` | the ESM build | the same |
| `/sdk/embed/manifest.json` | `{ "schema": "kletia.embed-manifest/v1", "version", "files": { "kletia-embed.min.js": { "path", "integrity", "bytes" }, "index.js": { … } } }` | `Cache-Control: no-cache`, `Access-Control-Allow-Origin: *` |

The version is `@kletia/embed`'s own (`packages/embed/package.json`, also
`KletiaEmbed.EMBED_VERSION`), and `integrity` is the SHA-384 of the exact
bytes served, written by the web build (`apps/web/scripts/emit-embed-script.mjs`).
Read the hash for the tag from the manifest:

```bash
curl -s https://kletiaai.xyz/sdk/embed/manifest.json
```

or compute it from the file you pin:

```bash
curl -s https://kletiaai.xyz/sdk/embed/0.1.0/kletia-embed.min.js \
  | openssl dgst -sha384 -binary | openssl base64 -A
```

A browser refuses a script whose bytes do not match `integrity`, and
`crossorigin="anonymous"` is required for the check across origins. Loaded
from a Kletia origin, the script also makes that origin the element's default
`origin`, so a page using a self-hosted or local Kletia needs no `origin`
attribute. Once the npm package is published, the same file is also on npm
CDNs (`https://cdn.jsdelivr.net/npm/@kletia/embed@<version>/dist/kletia-embed.min.js`);
from there the default origin is `https://kletiaai.xyz`. The script defines `<kletia-intent>` and exposes
`window.KletiaEmbed` (`mountKletiaIntent`, `defineKletiaIntent`,
`buildEmbedUrl`, `EMBED_VERSION`).

With npm:

```bash
npm install @kletia/embed
```

```ts
import { mountKletiaIntent } from "@kletia/embed"; // importing also defines <kletia-intent>

const widget = mountKletiaIntent("#checkout-widget", {
  theme: "dark",
  bg: "transparent",
  text: "bridge 25 USDC from base to solana",
  reference: "order-42",
  onIntentPlanned: ({ status }) => console.log("preview", status),
  onIntentCreated: ({ intentId }) => console.log("stored", intentId),
  onCompleted: ({ intentId, status }) => notifyServer(intentId, status),
  onError: ({ code }) => console.warn(code),
});

widget.update({ text: "stake 2 SOL with jito" }); // reloads the frame
widget.destroy();
```

The ESM build (`dist/index.js`) is also a single file, so
`<script type="module">` with a CDN URL works too. Both builds have no
dependencies and run in any browser with custom elements and `MessageChannel`.

## Attributes

| Attribute | Values | Default | Notes |
|---|---|---|---|
| `theme` | `light`, `dark`, `auto` | `auto` | `auto` follows the visitor's system setting. |
| `text` | up to 500 characters | none | Prefilled intent. The visitor can edit it and always reviews the plan before signing. |
| `examples` | comma-separated, up to 6 × 120 characters | Kletia's examples | Example chips. |
| `bg` | `transparent` | opaque | Lets your page background show around the widget. |
| `height` | pixels (`640`, `640px`) | `600` | Height until the frame reports its content height; from then on the frame follows the content, between 320 px and `max-height`. Set it close to your widget's height to avoid a jump on load. |
| `max-height` | pixels, 320–4000 | `1600` | The frame never grows past this height; taller content scrolls inside the frame. |
| `origin` | an https origin, or `http://localhost:<port>` | the origin the script came from, else `https://kletiaai.xyz` | Where `/embed` is served. A script loaded from a Kletia deployment's versioned path (`<origin>/sdk/embed/<version>/kletia-embed.min.js` or `…/index.js`) defaults to that origin, so a self-hosted Kletia needs no `origin`; from anywhere else (npm, a CDN) the default is `https://kletiaai.xyz`. An explicit `origin` always wins. Anything else (paths, plain http) emits `EMBED_ORIGIN_INVALID` and renders nothing. |
| `reference` | `^[A-Za-z0-9_.:-]{1,80}$` | none | Your reference, stored on created intents as `metadata.hostRef` and echoed in `kletia:intent-planned` and `kletia:intent-created`. Anyone with the intent id can read it: **never put personal data in it**. |
| `label` | text | `Kletia intent widget` | Accessible name of the frame. |
| `intent` | `int_` + 32 hex | none | Opens an intent your backend created with its API key, instead of planning from text. See [Intents and sessions your backend creates](#intents-and-sessions-your-backend-creates). |
| `session` | `cs_` + 32 hex | none | Runs a session your backend created: the frame plans your fixed actions for the visitor's wallet. `intent` wins when both are set. |
| `key` | `kl_pub_` + 32 letters and digits | none | Your project's publishable key: no backend needed. See [Publishable keys and stored flows](#publishable-keys-and-stored-flows). A secret key (`kl_dev_…`, `kl_agt_…`) or any other shape is ignored with a console warning, never forwarded. |
| `flow` | `^[a-z][a-z0-9-]{0,31}$` | none | A stored flow of the project, run with `key`. `intent` and `session` win over `key`. |
| `accent`, `accent-ink`, `surface`, `ink`, `line` | six hex digits, `#` optional | stock colours | The light palette (or the only one). See [Appearance](#appearance). |
| `accent-dark`, `accent-ink-dark`, `surface-dark`, `ink-dark`, `line-dark` | six hex digits | stock dark colours | Used when the resolved scheme is dark. Without them, dark mode keeps the stock dark colours and borrows only your `accent`. |
| `radius` | 0–16 | `0` | Corner radius in pixels (stamps stay square). |
| `border` | 1–3 | `3` | Border width; inner elements use one pixel less (at least 1). |
| `shadow` | `hard`, `soft`, `none` | `hard` | |
| `font` | `inter`, `system`, `serif`, `mono`, `rounded` | `inter` | Local font stacks only: no remote font is ever loaded. |
| `density` | `comfortable`, `compact` | `comfortable` | Padding, gaps and text size; buttons keep their 44 px height. |
| `header` | `kletia`, `none` | `kletia` | `none` hides the header; the "Preview" / account label moves to the footer. |
| `networks` | comma-separated network keys, up to 9 | all | The networks your page works with. See [Networks, actions and the starting network](#networks-actions-and-the-starting-network). |
| `actions` | comma-separated: `swap`, `bridge`, `transfer`, `stake`, `deposit`, `withdraw` | all | The kinds of action your page offers. |
| `source-network` | a key from `networks`, or `auto` | none | Where the money starts. `auto` lets Kletia pick the network that holds the funds. Sent to the frame as `source`. |

Invalid values are dropped by the element and again by the frame, never
forwarded: a colour must be six hex digits (`red;}`, `url(…)` or `#12345g`
go nowhere), numbers must be in range and names must be known. There is no
attribute to turn off clarifying questions: they are always on.

Changing any attribute except `height`, `max-height` and `label` reloads the
frame (changes in the same task are batched); those three apply in place. Style the frame from your page with `kletia-intent::part(frame)`;
for a fixed-height box that scrolls inside, override the height there
(`kletia-intent::part(frame) { height: 560px !important; }`).

## Appearance

The appearance attributes restyle the widget inside the frame with the
[appearance tokens](theming.md) (`kletia.appearance/v1`):

```html
<kletia-intent
  accent="7C3AED" surface="FFFFFF" ink="1E1B4B"
  accent-dark="A78BFA" surface-dark="17132B" ink-dark="EDE9FE"
  radius="10" border="2" shadow="soft" font="system" density="compact"
  bg="transparent"
></kletia-intent>
```

- **Contrast is enforced, never relaxed.** Body text must reach 4.5:1 on the
  surface, borders and the focus ring 3:1; a colour that misses its floor
  falls back to a readable one (or the stock pair). Text on the accent is
  picked automatically when you leave `accent-ink` out.
- **Safety signage never changes**: the host notice, the external-recipient
  warning, the fare (its ticket stock, certainty labels and "at least"
  plate), contract reviews, acknowledgement gates, policy holds, receipt
  stamps and the footer keep their colours and stay visible. See
  [theming](theming.md#what-never-changes-and-why).
- **Use `bg="transparent"` with a custom `surface`.** The frame page keeps
  its own background otherwise, so a coloured widget sits on Kletia's paper
  inside your page. Transparent lets your page show around the widget.

## Networks, actions and the starting network

`networks`, `actions` and `source-network` scope the widget to what your page
offers:

```html
<kletia-intent networks="base,solana" actions="swap,bridge" source-network="auto"></kletia-intent>
```

- **Networks** must be keys of one capital lane (mainnet networks, or the
  testnets `arbitrum-sepolia`, `arc`, `solana-devnet`); unknown keys and keys
  of the other lane are dropped.
- **Plans outside the scope are refused before Execute.** The frame plans as
  usual, then lists what does not fit ("This site works with Base and Solana.
  This plan also uses Ethereum (step 1).") under **Not available here**, keeps
  Execute disabled and emits `kletia:error` with `EMBED_SCOPE_REFUSED`. A
  bridge's destination and a transfer's recipient network count. Unstaking
  counts as staking; kinds outside the six (borrowing, custom contract calls)
  never fit an `actions` scope.
- **The wallet bar offers only the wallets the frame needs**: the virtual
  machines of `networks`, of a session's actions and of an integrator
  intent's steps. A widget scoped to `base` shows no Solana button; a session
  that only touches Arbitrum Sepolia offers an EVM wallet only. Text mode
  without `networks` offers both.
- **`source-network`** is passed to the planner as `sourceNetwork`: a network
  key (dropped when it is not in `networks`) or `auto`. Before a wallet is
  connected the frame plans previews for demo accounts, where `auto` behaves
  as if it were absent.

The scope is a boundary of the experience on your page: the visitor still
reviews and signs every step in their own wallet.

Wallet code loads only when it is needed: the frame shows its connect buttons
right away, starts downloading the wallet runtime when the visitor hovers or
focuses one, and opens that wallet's picker on the click. A visit that only
plans previews downloads no wallet code; a visitor who connected a wallet in
this frame before gets the runtime at once, so the wallet reconnects by
itself.

## Intents and sessions your backend creates

Custom contracts ([contracts.md](contracts.md)) and other integrator-only
actions need your API key, which never goes into a browser. Your backend
creates the work and the frame only names it; the id travels in the URL
fragment (`/embed#intent=int_…`, `/embed#session=cs_…`), which browsers never
send to a server, so it stays out of access logs and referrers. Malformed ids
are dropped by the element and again by the frame.

**An intent (you already know the visitor's wallet).** Your backend calls
`POST /v1/intents` with its key, the visitor's accounts and the actions (for
example a `call` step), and hands the id to your page:

```html
<kletia-intent intent="int_3f9a…" reference="order-42"></kletia-intent>
```

The frame reads the intent (`GET /v1/intents/{id}`, never a new plan),
shows its review and fare, and asks the visitor to connect the wallet the
intent was planned for ("This intent was prepared for 0x5eed…c0de on Base.
Connect that wallet to sign it."). Nothing is prepared until the visitor
presses Execute. The host gets `kletia:step-updated` and `kletia:completed`
for it (no `kletia:intent-created`: you made it).

**A session (the frame connects the wallet).** Your backend calls
`POST /v1/sessions` with its key, the fixed actions and `allowedOrigins`
([contracts.md#sessions](contracts.md#sessions)), and hands the session id
to your page:

```html
<kletia-intent session="cs_9c1e…"></kletia-intent>
```

The frame shows who is asking ("acme.example is asking you to: …", with your
integrator name and whether your domain is verified), the session's actions
and, when the session lets the visitor choose an amount, its bounds. Once the
visitor connects a wallet and presses **Plan with my wallet**, the frame turns
the session into an intent for that wallet with
`POST /v1/sessions/{id}/intents`. A session runs only inside the element (or
a host that completes the bridge handshake): the host origin the bridge
proved must be one of the session's `allowedOrigins`, otherwise the frame
refuses before anything is planned (the API checks the same origin again).
Opened on its own (a new tab, or a frame whose host never connects), the
frame does not even read the session. `kletia:intent-created` carries the
intent id and, as `reference`, the session's `clientReference` (`order-A-1029:1`
for the first use).

Either way the frame never takes instructions from your page: the bridge is
one-way (frame to host), and the only inputs are the attributes above.

## What the visitor sees before signing

- **The fare breakdown.** Every plan with a wallet comes with an
  [asset-change preview](preview.md): what leaves each wallet, what arrives
  where (expected, and "at least" on a yellow plate), money that only passes
  through a wallet (collapsed), fees in USD (network, venue, extra), the
  allowances granted and what is left of them, what to bring (for example gas
  on a network the visitor has never used) and when it arrives. Every number
  is labelled `simulated`, `simulated, funds assumed`, `venue minimum`,
  `quoted` or `estimated`, by a shape and in words; unpriced amounts say
  "price unavailable", never $0. Pressing Execute approves that fare: its
  digest goes to prepare as `acknowledgedPreview`, and a payload that is
  materially worse (`PREVIEW_CHANGED`), or whose fare differs, stops before
  the wallet with the old fare struck through until the visitor approves the
  new one. A preview issue Kletia marks as blocking is never signed.
- **Custom contracts.** Each `call` / `action` step shows its review: who
  (integrator, website, domain verified or not), what (the function and every
  argument with where its value comes from), permissions (exact approvals),
  the simulated result, provenance (source verification, proxy and
  implementation, Solana programs) and "Not audited by Kletia". An
  unverified source, program or domain needs an explicit acknowledgement
  before Execute, and after Kletia prepares the step the prepared review is
  shown again (with anything that moved since planning struck through) and
  needs a second confirmation ("Sign this step") before the wallet opens.
  Stopping at either check signs nothing.
- **Rule Book outcomes.** When your key's rule book holds the intent for
  approval, the frame says "Held for approval", names the rules that asked
  for it and links the approval request (an https `…/approve#apr_…` link:
  reading it is not approving it). Refusals (`POLICY_VIOLATION`, spend
  limits, schedules) name the rule ids and their observed and limit values.
- **Receipts.** When a finished intent's [receipt](receipts.md) is issued,
  the frame shows the receipt stamp and a "Share receipt…" action. Receipts
  are private until shared: the visitor picks what the link shows (route,
  amounts, proof or everything; showing transactions reveals the sending
  addresses) and gets a link to the receipt page. Nothing about it is sent to
  your page.

## Publishable keys and stored flows

A static site can run the widget for its own project without a backend
([projects.md](projects.md)): the project lists its allowed origins, its
verified brand, widget defaults and stored flows, and issues browser-safe
publishable keys (`kl_pub_…`). A publishable key can do only what the public
tier and the project's stored flows allow, only from the origins the project
allowed, under its own rate limit and Rule Book.

```html
<!-- Text mode: intents planned here are owned by the key (your webhooks fire). -->
<kletia-intent key="kl_pub_…"></kletia-intent>

<!-- A stored flow, for example a deposit into your registered contract. -->
<kletia-intent key="kl_pub_…" flow="deposit"></kletia-intent>
```

The key and the flow travel in the URL fragment (`/embed#key=kl_pub_…&flow=deposit`),
shape-checked by the element and again by the frame. Then the frame:

1. requires the bridge: opened on its own (a new tab, a raw iframe, a host
   that never connects), it loads nothing;
2. reads `GET /v1/publishable/profile` with the key, sending the host origin
   the bridge proved in `Kletia-Host-Origin`;
3. refuses when that origin is not one of the project's `allowedOrigins`
   ("This widget is not set up for evil.example. Nothing was planned.",
   `kletia:error` `PUBLISHABLE_ORIGIN_FORBIDDEN`), and refuses a flow the
   project does not have (`FLOW_UNKNOWN`);
4. applies the project's `defaults` (networks, actions, starting network,
   examples and appearance) under the element's own attributes, which win;
5. shows the project's name, verified domain and logo above the widget only
   when the profile says the domain is verified. No attribute or URL
   parameter can set a name or a logo;
6. shows a TESTNET ribbon when the project runs on the testnet lane;
7. runs text mode with the key, or mints the flow's single-use session
   (`POST /v1/sessions` with `{ flow, hostOrigin }`, 10 minutes) and runs it
   like any session: the same review, gates and wallet prompts.

The API checks the origin rules again on every request: a forged
`Kletia-Host-Origin` from a script outside a browser buys nothing a stranger
could not do with the public tier and your fixed flows, with their own funds
and wallet.

## Events

Every event is a `CustomEvent` dispatched on the element, with
`bubbles: true` and `composed: true`, so you can listen on the element or on
`document`.

| Event | `detail` | When |
|---|---|---|
| `kletia:ready` | `{ height }` | The frame accepted the connection. |
| `kletia:resize` | `{ height }` | The content height changed (the element resizes the frame itself). |
| `kletia:intent-planned` | `{ status, reference? }` | The visitor planned a preview before connecting a wallet. Previews are dry runs: nothing is stored and there is no id. |
| `kletia:intent-created` | `{ intentId, status, reference? }` | The visitor planned an intent with a connected wallet (or a session created one); Kletia stored it. For a session, `reference` is the session's `clientReference`. |
| `kletia:step-updated` | `{ intentId, stepId, stepIndex, network, status }` | A step of a stored intent changed status (`awaiting_signature`, `submitted`, `settled`, …). |
| `kletia:completed` | `{ intentId, status }` | Execution finished; `status` is the final intent status (`completed`, `partially_completed`, `failed`, …). |
| `kletia:question` | `{ count, reasons }` | The widget asks the visitor before it can plan (clarifying questions, always on): how many questions and their reason codes (`AMOUNT_MISSING`, `NETWORK_AMBIGUOUS`, …; see [clarify.md](clarify.md)). Never the visitor's text, options or values. Use it to log or to make room; `kletia:resize` already follows the height. |
| `kletia:error` | `{ code, message }` | Something failed. `message` is fixed text; the visitor's own error text never leaves the frame. |

Error codes in `kletia:error`:

- An API error code such as `INTENT_UNSUPPORTED` or `UPSTREAM_UNAVAILABLE`
  (see the [error catalog](errors.md)).
- `USER_REJECTED`: the visitor declined a wallet request.
- `EMBED_ERROR`: anything without a stable code.
- `EMBED_ORIGIN_INVALID`: the `origin` attribute is not allowed (emitted by the element).
- `BRIDGE_UNAVAILABLE`: the frame never answered the connection, or your page
  has no http(s) origin (for example a `file://` page). See
  [Troubleshooting](#troubleshooting).
- `EMBED_SCOPE_REFUSED`: a plan uses a network or a kind of action outside
  `networks` / `actions`; Execute stays disabled.
- `PUBLISHABLE_ORIGIN_FORBIDDEN`: the publishable key's project does not
  allow your page's origin; nothing was planned.
- `FLOW_UNKNOWN`: the `flow` is not one of the project's stored flows.
- `CONTRACT_PENDING`: the session's contract registration is still in its
  activation delay. The frame says when the checkout opens ("This checkout
  opens at 14:11 (in 9 min).") and keeps planning disabled until then.

Events never carry addresses, amounts, recipients or transaction hashes.

## Verify on your server

Events are notifications for your UI, not proof of payment. Anyone can
dispatch a `kletia:completed` event on your page from the browser console.
**Never fulfil an order from an event.** On your server:

1. Read the intent: `GET https://api.kletiaai.xyz/v1/intents/{intentId}`
   (see the [API reference](api-v1.md#endpoints), or `kletia.intents.get(id)`
   with [`@kletia/sdk`](../../packages/sdk/README.md)).
2. Check `status` (`completed`), `metadata.hostRef` (your `reference`), and
   that each step's recipient, asset and amount are what you expected.
3. Only then mark the order paid. For server-to-server updates without a
   browser, register a [webhook](api-v1.md#events-and-webhooks).

## How the element talks to the frame

The element and the frame speak bridge protocol v1:

1. The element loads `<origin>/embed?…&bridge=1&origin=<your page origin>`.
   The frame shows nothing to the host and posts nothing until step 2.
2. After each frame `load`, the element creates a `MessageChannel` and sends
   `{ kletia: "connect", v: 1 }` with one port, using
   `postMessage(message, <Kletia origin>, [port])`, so only a Kletia document
   can receive the port. The frame's bridge can start after `load`, so the
   element retries with backoff for about 16 seconds and emits
   `BRIDGE_UNAVAILABLE` if no attempt is answered.
3. The frame accepts **one** connect, and only when all of these hold:
   - the message comes from `window.parent` (not a sibling frame, an ad, or
     a popup);
   - its origin is a real http(s) origin (not the opaque `"null"`);
   - its origin equals the `origin` query parameter;
   - its origin equals `location.ancestorOrigins[0]` where the browser has it
     (Chrome, Safari, Firefox 148 and later; older Firefox relies on the
     checks above);
   - exactly one port is attached.

   Any later connect is ignored. Rejected connects log
   `Kletia embed: connect ignored (<reason>)` in the frame's console.
4. Every message from the frame goes over that port only. The frame never
   posts to `window.parent` or to `"*"`, and it accepts no commands from the
   host: a host can never start a signature.
5. Once connected, the frame shows the visitor a notice:
   "*your-site.example* is notified of your intent's progress and can look up
   the intents you create here." Intent ids are only sent while that notice
   is on screen, and only for stored intents. An intent id is a read
   capability: `GET /v1/intents/{id}` returns the intent, including the
   visitor's accounts.

Frame to host messages (`{ kletia: "event", v: 1, type, … }`): `ready`,
`resize`, `intent.planned`, `intent.created`, `intent.step_updated`,
`intent.completed` and `error`, with the fields of the matching DOM event.
The element validates every field and drops unknown types and extra fields.

A connect sent on the frame's `load` event is kept by the page until its
bridge starts, then judged by the same rules, so one connect per load is
enough for a hand-written host.

## The frame's sandbox

The element renders:

```html
<iframe
  src="https://kletiaai.xyz/embed?…"
  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
  allow="clipboard-write"
  referrerpolicy="strict-origin-when-cross-origin"
  loading="lazy"
  title="Kletia intent widget"
></iframe>
```

- `allow-same-origin` keeps the frame on Kletia's origin, which wallets and
  the API need. The frame is cross-origin to your page, so it cannot reach
  your DOM, cookies or storage.
- Browsers log a console warning for this pair ("An iframe which has both
  allow-scripts and allow-same-origin for its sandbox attribute can escape its
  sandboxing"). The escape it describes needs the frame to be on the page's
  own origin; on your site `/embed` is Kletia's origin, so the warning is
  expected and harmless. The Embed Builder's preview frames `/embed` on
  `kletiaai.xyz` itself, which is why the warning also shows there.
- `allow-popups` and `allow-popups-to-escape-sandbox` let wallet connectors
  open their own windows. There is no `allow-top-navigation`: the frame can
  never navigate your page.
- `allow="clipboard-write"` is the only permission granted; camera,
  microphone, geolocation and payment stay blocked.
- The referrer policy must not be `no-referrer`: browsers may then hide your
  origin from `location.ancestorOrigins` and the frame refuses to connect.

The element's styles use a constructable stylesheet plus inline CSSOM
properties, so a strict `style-src` Content Security Policy does not break
it. Your CSP needs `frame-src https://kletiaai.xyz` and, for the CDN script,
`script-src https://cdn.jsdelivr.net` (or unpkg).

## A raw iframe

Without the package, embed the page directly. With no `bridge` parameter the
frame sends no events at all:

```html
<iframe
  src="https://kletiaai.xyz/embed?theme=dark&text=swap%201%20SOL%20to%20USDC"
  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
  allow="clipboard-write"
  width="492" height="680" style="border:0" title="Kletia intent widget"
></iframe>
```

To receive events, add `bridge=1&origin=<your page origin>` and send the
connect yourself:

```js
const KLETIA = "https://kletiaai.xyz";
const frame = document.querySelector("iframe");
frame.addEventListener("load", () => {
  const channel = new MessageChannel();
  channel.port1.onmessage = ({ data }) => {
    if (data?.kletia !== "event" || data.v !== 1) return;
    if (data.type === "resize" || data.type === "ready") frame.style.height = `${data.height}px`;
    console.log(data.type, data);
  };
  frame.contentWindow.postMessage({ kletia: "connect", v: 1 }, KLETIA, [channel.port2]);
});
```

This minimal version sends one connect per load, which the frame keeps until
its bridge is ready. The element also retries, validates every field and
clamps the height to 320 px–`max-height`. Prefer the element. The appearance
and scope attributes are frame parameters of the same name (`source` for
`source-network`); the frame validates them again.

## Troubleshooting

- **No `kletia:ready`, then `BRIDGE_UNAVAILABLE`.** The Kletia deployment at
  `origin` predates bridge protocol v1, the page is not served over http(s),
  your CSP blocks the frame (`frame-src`), or something on your page set
  `referrerpolicy="no-referrer"` on the frame. Open the frame's console for
  `connect ignored (<reason>)`.
- **`EMBED_ORIGIN_INVALID`.** `origin` must be an https origin without a path,
  or `http://localhost`, `http://127.0.0.1` or `http://[::1]` with a port.
- **The notice space is blank for a moment.** With `bridge=1` the frame
  reserves the notice's space from the first paint so nothing shifts when
  your page connects; it collapses after 30 seconds if no connect arrives.
- **A visible box behind a transparent widget.** The element sets the frame's
  `color-scheme` to match `theme`; if you restyle the frame, keep
  `color-scheme: dark` for `theme="dark"` and `light` otherwise.
