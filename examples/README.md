# Examples

Small apps that use Kletia the way an integrator would. They live outside the
npm workspaces: each installs the published packages (`@kletia/widget`,
`@kletia/sdk`, `@kletia/embed`) like any other project.

| Example | What it shows |
|---|---|
| [react-vite](react-vite/README.md) | `KletiaIntentWidget` with appearance tokens, a network and action scope, `sourceNetwork="auto"`, an EIP-1193 wallet, and plan-only previews before a wallet is connected |
| [node-server](node-server/README.md) | A backend that keeps the key: `createKletiaProxy` for the browser, `POST /api/checkout` with the amount set on the server, a verified and de-duplicated webhook route, and `kletia listen` for local events |
| [own-contract](own-contract/README.md) | Bring your own contract, testnet first: inspect, validate, register and test a call (a rebasing aToken output), then one embed session per page view |

Rules every example follows:

- No API key in browser code: browsers call the keyless public tier, or
  your server through `createKletiaProxy` (node-server), which adds the key.
- Nothing is signed without the visitor's wallet, and every plan is reviewed
  in the widget first.

`npm run check:examples` (repository root) checks them against this
checkout: it packs the workspace packages (run `npm run build:packages`
first), installs them into a temporary copy of each example, runs
`node --check` and the example's build, then a smoke run against an
in-process stub of `/v1` on 127.0.0.1 (no network, no key, nothing signed).
The server examples have nothing to bundle: their `build` script is that
smoke run (`smoke.mjs`, also `npm run check` inside the example).
CI runs it as its own job; `npm run verify` runs it when
`KLETIA_CHECK_EXAMPLES=1`.
