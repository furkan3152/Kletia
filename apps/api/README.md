# Kletia API

The canonical intent API for the unified Kletia application. It serves Base
Mainnet and Arc Testnet through one HTTP boundary while preserving independent
chain identity, assets, protocol targets, transaction builders, and runtime
validation.

The committed `.npmrc` keeps TypeScript and declaration packages available in
production-mode CI builds. They compile `src` into `dist`; the runtime still
starts only the emitted `dist/index.js` with `npm start`.

## Source ownership

- `src/networks/base`: Base DeFi, Basenames, bridging, token launch, paymaster,
  x402, protocol registries, and Base-only routes.
- `src/networks/arc`: Arc contract ABIs, programmable-money intents, Circle App
  Kit integration, and Arc-only routes.
- `src/config/networks.ts`: shared chain registry and cross-network target
  rejection.
- `src/ai`, `src/assets`, `src/intent`, `src/middleware`, and `src/security`:
  shared parsing, entity resolution, response envelopes, and safety gates.

Network-owned transaction construction must never be added to a shared folder.

## Commands

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run dev
```

Copy `.env.example` to `.env` for local development. Private keys are not API
runtime configuration; deployment and reserve-funding credentials belong only
to the relevant ignored contract-operator environment.
