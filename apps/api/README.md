# Kletia API

The canonical intent API for the unified Kletia application. It serves Base
Mainnet, Arc Testnet and the capability-gated Arbitrum One Public Beta through
one HTTP boundary while preserving independent chain identity, assets,
protocol targets, transaction builders, and runtime validation.

The committed `.npmrc` keeps TypeScript and declaration packages available in
production-mode CI builds. They compile `src` into `dist`; the runtime still
starts only the emitted `dist/index.js` with `npm start`.

## Source ownership

- `src/networks/base`: Base DeFi, Basenames, bridging, token launch, paymaster,
  x402, protocol registries, and Base-only routes.
- `src/networks/arc`: Arc contract ABIs, programmable-money intents, Circle App
  Kit integration, and Arc-only routes.
- `src/networks/arbitrum`: reviewed Arbitrum assets, Uniswap V3 routing, Aave
  V3 position actions, and chain/protocol attestation.
- `src/shared`: parsing, entity resolution, chain registry, HTTP middleware,
  response envelopes, policy agents, observability, and common safety gates.
- `src/cross-chain`: sealed Base-to-Arbitrum workflow plans, Across quote and
  checkpoint handling, resume/advance routes, and gas-acquisition policy.
- `src/integrations`: bounded external-provider HTTP routes such as Allora and
  Webacy. Provider errors never become invented financial data.
- `src/scripts`: operator-only verification, evidence, cleanup, and reserve
  funding commands; scripts are excluded from the production build.

Network-owned transaction construction must never be added to a shared folder.
Arc Testnet is not permitted inside Base/Arbitrum Mainnet capital workflows.

## Commands

```bash
npm ci --legacy-peer-deps
npm run typecheck
npm test
npm run build
npm run dev
```

Copy `.env.example` to `.env` for local development. Private keys are not API
runtime configuration; deployment and reserve-funding credentials belong only
to the relevant ignored contract-operator environment.
