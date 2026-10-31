# React + Vite example

`KletiaIntentWidget` in a Vite app: appearance tokens, a network and action
scope, an EIP-1193 wallet (`window.ethereum`) and plan-only previews before a
wallet is connected.

```bash
cd examples/react-vite
npm install            # before the npm release, see ../README.md for the tarball install
npm run dev            # http://127.0.0.1:5180
```

Point it at a local Kletia with `VITE_KLETIA_API_URL=http://localhost:3000 npm run dev`.

What it shows:

- `src/config.js`: the appearance (`kletia.appearance/v1`), the networks
  (`base`, `solana`) and actions (`swap`, `bridge`) the page offers. A plan
  that reaches another network or kind of action is refused before Execute,
  with the offending steps listed.
- `src/wallet.js`: connecting an injected EVM wallet and turning it into the
  widget's `accounts` and `signers` with `eip1193Signer`. Without a wallet the
  widget plans dry runs for demo accounts (`PREVIEW_ACCOUNT_IDS`): nothing is
  stored and nothing can be signed.
- `src/App.jsx`: the widget with `sourceNetwork="auto"` (Kletia starts from
  the network that holds the funds).

The browser only calls the public tier: no API key belongs in this app. See
[the widget README](../../packages/widget/README.md) and
[theming](../../docs/platform/theming.md).

`npm run check:examples` at the repository root packs the workspace
packages, installs them here in a temporary copy, builds this app and renders
it against a stub of `/v1` (no network).
