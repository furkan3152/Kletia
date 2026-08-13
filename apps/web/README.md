# Kletia Web

The canonical Kletia browser application. One React shell hosts two isolated
execution profiles: Base Mainnet and Arc Testnet.

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

Network-specific runtime code lives under `src/networks/base` and
`src/networks/arc`. Network-owned interface modules live under
`src/components/base` and `src/components/arc`. Shared layout, chat, state,
and security boundaries remain at `src` level.
