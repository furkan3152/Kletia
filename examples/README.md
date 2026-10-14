# Examples

Small apps that use Kletia the way an integrator would. They live outside the
npm workspaces: each installs the published packages (`@kletia/widget`,
`@kletia/sdk`, `@kletia/embed`) like any other project.

| Example | What it shows |
|---|---|
| [react-vite](react-vite/README.md) | `KletiaIntentWidget` with appearance tokens, a network and action scope, `sourceNetwork="auto"`, an EIP-1193 wallet, and plan-only previews before a wallet is connected |

Rules every example follows:

- No API key in browser code: browsers call the keyless public tier, or a
  route on your own server that adds the key.
- Nothing is signed without the visitor's wallet, and every plan is reviewed
  in the widget first.

`npm run check:examples` (repository root) checks them against this
checkout: it packs the workspace packages (run `npm run build:packages`
first), installs them into a temporary copy of each example, runs
`node --check` and the example's build, then a smoke run against an
in-process stub of `/v1` on 127.0.0.1 (no network, no key, nothing signed).
CI runs it as its own job; `npm run verify` runs it when
`KLETIA_CHECK_EXAMPLES=1`.
