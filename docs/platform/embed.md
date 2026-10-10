# Embed Kletia on any site

`@kletia/embed` puts the Kletia intent widget on any page, with or without a
framework: a `<kletia-intent>` custom element, or `mountKletiaIntent()` from
JavaScript. The element renders Kletia's hosted `/embed` page in a sandboxed
iframe, sizes the frame to its content and tells your page what the visitor
did through DOM events (`kletia:ready`, `kletia:intent-planned`,
`kletia:intent-created`, `kletia:step-updated`, `kletia:completed`,
`kletia:error`, `kletia:resize`).

The visitor plans and signs inside the frame with their own wallet. Your page
never sees calldata, signatures, addresses or amounts, and it cannot sign or
submit anything on the visitor's behalf.

For React apps that want the widget in their own DOM, use
[`@kletia/widget`](../../packages/widget/README.md) instead.

## Quick start

With a script tag (one self-contained file; pin the version and add the
Subresource Integrity hash):

```html
<script
  src="https://cdn.jsdelivr.net/npm/@kletia/embed@0.1.0/dist/kletia-embed.min.js"
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

Compute the hash from the published file:

```bash
curl -s https://cdn.jsdelivr.net/npm/@kletia/embed@0.1.0/dist/kletia-embed.min.js \
  | openssl dgst -sha384 -binary | openssl base64 -A
```

`https://unpkg.com/@kletia/embed@0.1.0/dist/kletia-embed.min.js` serves the
same file. The script defines `<kletia-intent>` and exposes
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
| `height` | pixels (`640`, `640px`) | `600` | Height until the frame reports its content height; from then on the frame follows the content (320–1600 px). Set it close to your widget's height to avoid a jump on load. |
| `origin` | an https origin, or `http://localhost:<port>` | `https://kletiaai.xyz` | Where `/embed` is served. Set it for a self-hosted Kletia. Anything else (paths, plain http) emits `EMBED_ORIGIN_INVALID` and renders nothing. |
| `reference` | `^[A-Za-z0-9_.:-]{1,80}$` | none | Your reference, stored on created intents as `metadata.hostRef` and echoed in `kletia:intent-planned` and `kletia:intent-created`. Anyone with the intent id can read it: **never put personal data in it**. |
| `label` | text | `Kletia intent widget` | Accessible name of the frame. |
| `intent` | `int_` + 32 hex | none | Opens an intent your backend created with its API key, instead of planning from text. See [Intents and sessions your backend creates](#intents-and-sessions-your-backend-creates). |
| `session` | `cs_` + 32 hex | none | Runs a session your backend created: the frame plans your fixed actions for the visitor's wallet. `intent` wins when both are set. |

Changing `theme`, `text`, `examples`, `bg`, `origin`, `reference`, `intent`
or `session` reloads the frame (changes in the same task are batched);
`height` and `label` apply in place. Style the frame from your page with `kletia-intent::part(frame)`;
for a fixed-height box that scrolls inside, override the height there
(`kletia-intent::part(frame) { height: 560px !important; }`).

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
clamps the height to 320–1600 px. Prefer the element.

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
