# html-embed

The Kletia widget on a plain HTML page, the way a shop without a build step
adds it: one script tag and one element.

- The script comes from the Kletia origin itself
  (`<KLETIA_ORIGIN>/sdk/embed/<version>/kletia-embed.min.js`), pinned with
  the SHA-384 `integrity` the origin publishes in
  `/sdk/embed/manifest.json` and loaded with `crossorigin="anonymous"`. The
  browser refuses a script whose bytes changed. When the manifest cannot be
  read, the page loads no script (fail closed).
- Because the script remembers where it was loaded from, the element needs
  no `origin` attribute, for a local or self-hosted Kletia too.
- Appearance attributes (`accent`, `surface`, `radius`, `border`, `shadow`,
  `font`) and a scope (`networks`, `actions`).
- An events log of every `kletia:*` event, `kletia:question` included
  (counts and reason codes only, never values).
- `server.mjs` has no dependencies. Serve the page over http(s): a `file://`
  page has no origin, so the widget cannot connect to it.

## Run

```bash
node server.mjs                                         # against https://kletiaai.xyz
KLETIA_ORIGIN=http://localhost:5174 PORT=3000 node server.mjs   # against a local Kletia (npm run dev:web)
```

Then open http://localhost:3000. Without a wallet the widget plans dry runs
for demo accounts; connect a wallet to plan with your own accounts. Nothing is
signed without your wallet.

`npm run check` runs the smoke test: a stand-in Kletia origin on 127.0.0.1,
then the page must pin exactly its script and integrity, and load no script
when the manifest is missing.

Events are notifications, not proof of payment. Fulfil an order only after
your server reads the intent with `GET /v1/intents/{id}` and checks its
status, steps and `metadata.hostRef`.
