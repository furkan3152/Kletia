# Kletia Web

The canonical Kletia browser application. One React shell hosts three isolated
execution profiles: Base Mainnet, Arc Testnet, and the capability-gated
Arbitrum One Public Beta.

## Source ownership

- `src/app`: the application composition root and global theme stylesheet.
- `src/networks/base`, `src/networks/arc`, `src/networks/arbitrum`: network-owned
  UI, runtime bindings, transaction policies, and wallet-facing evidence.
- `src/shared`: reusable chat, layout, state, configuration, hooks, types,
  validation, and utility code. Shared code may coordinate profiles but may not
  construct an unscoped transaction.
- `src/cross-chain`: the staged workflow timeline. Cross-chain plans are not
  represented as globally atomic.
- `src/integrations`: external provider interfaces such as Allora and Webacy.

## Commands

```bash
npm ci --legacy-peer-deps
npm run dev
npm run lint
npm run build
```

Render publishes `dist` as a Static Site, so the production service has no
start command. `npm start` is retained only for an intentional local or
self-hosted Node preview of an already-built bundle.

Configuration is documented in [`.env.example`](.env.example). Browser-facing
`VITE_*` values are public and must never contain private keys or server API
secrets.

Arbitrum remains hidden unless `VITE_ARBITRUM_MVP_ENABLED=true`. The matching
API capability must also be enabled and attested; the browser flag alone does
not authorize an Arbitrum route.
