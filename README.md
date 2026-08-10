# Kletia Omni-Engine

Kletia is a network-context-aware Web3 intent engine that uses a single application shell for Base Mainnet and Arc Testnet. When the active network changes, the wallet chain, intent parser, transaction targets, widgets, asset names, and application state change along with it.

## Supported networks

| Profile | Network | Gas / native asset | USDC | Network features |
| --- | --- | --- | --- | --- |
| `base` | Base Mainnet (`8453`) | ETH | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 decimals) | Base routing engine, Basename, Allora, Airdrop, x402, and Webacy. Agent mode is disabled until signed ownership is added. |
| `arc` | Arc Testnet (`5042002`) | Native USDC | 18 decimals for native/RPC transactions; 6 decimals for user display. ERC-20 interface: `0x3600000000000000000000000000000000000000` | Arc swap, vault, staking, lending, liquidity, batch, and memo |

Base's public RPC is rate-limited for production. Use a dedicated provider for the server-side `BASE_RPC_URL` in production. Since `VITE_BASE_RPC_URL` is embedded into the browser bundle, it must not contain a secret CDP Node URL/key; it should only be a public or domain-restricted client RPC. Arc settings comply with [Arc connection docs](https://docs.arc.io/arc/references/rpc-endpoints), and Base settings comply with [Base connection docs](https://docs.base.org/base-chain/quickstart/connecting-to-base).

## Canonical application

- Frontend: `frontend/base_mainnet`
- Backend: `backend/base_mainnet`
- Deploy definition: `render.yaml`

The `arc_testnet` folders are reference copies of the old, separated application. The canonical directories must be used to run or deploy the unified application. To prevent accidentally launching the old network, the legacy `start`, `dev`, and `preview` commands will halt with a clear deprecation error. This consolidation does not change contract sources or deployed contracts.

## Security and network isolation

- The application mode updates only after the wallet's actual chain switch is successful.
- Every intent request is tagged with `network`, `chainId`, `requestId`, and the user's wallet; the backend rejects mismatched network/chain requests.
- Base and Arc conversations are kept in separate store buckets. The persisted history does not include calldata, routes, allowances, or transaction hashes.
- The multi-step clarification context is not written to a shared memory with the wallet address; it uses an unpredictable, short-lived conversation ID tied to the network and wallet.
- Arc targets must pass the deployment manifest allowlist and live RPC bytecode check; Base targets must pass the action-based execution allowlist and the Webacy policy. If the security service fails validation, the transaction fails closed.
- Approval and final transactions are simulated with the actual account/target/calldata/value. A backend route requiring approval is not presented as a successful simulation; it is strictly required after the final `eth_call` approval receipt. Fixed gas fallback is not used.
- A transaction hash is not considered a success; the receipt is fetched and the successful status is verified.
- Live provider errors are not replaced with `0`, an empty position, or an estimated price; the source is marked as `partial` or `unavailable`.

## Requirements

- Node.js 22.13 or higher (`.nvmrc`: 22.13.0) for unified development/frontend build. The backend Docker image is additionally verified on Node 20.
- npm
- An EVM wallet supporting Base Mainnet and Arc Testnet

## Backend

```bash
cd backend/base_mainnet
cp .env.example .env
npm ci --legacy-peer-deps
npm run dev
```

To verify the production behavior locally, use `npm run build` followed by `npm start`. The Docker image performs this compilation step in the build layer and only includes runtime dependencies in the final image.

Minimum network settings:

```dotenv
PORT=3001
BASE_RPC_URL=https://your-private-base-rpc.example
ARC_RPC_URL=https://rpc.testnet.arc.network
OPENROUTER_API_KEY=
WEBACY_API_KEY=
CORS_ORIGINS=http://localhost:5174
```

Agent, Allora, CDP/paymaster, and x402 variables are explained in `backend/base_mainnet/.env.example`. A private key, wallet export, or actual `.env` file must not be added to Git.

The Base bridge route uses the live Across production API; therefore, `ACROSS_API_KEY` and the 2-byte `ACROSS_INTEGRATOR_ID` are required. The fee ceiling is set by `ACROSS_MAX_RELAY_FEE_BPS`. The paymaster proxy adds a server-controlled `CDP_PAYMASTER_POLICY_ID` to every request; the paymaster must not be enabled without a CDP Portal contract/method allowlist, user limits, and a global spending cap.

## Frontend

```bash
cd frontend/base_mainnet
cp .env.example .env
npm ci --legacy-peer-deps
npm run dev
```

The frontend runs on `http://localhost:5174` by default.

```dotenv
VITE_BACKEND_URL=http://127.0.0.1:3001
VITE_BASE_RPC_URL=https://your-public-or-domain-restricted-base-rpc.example
VITE_ALLOW_PUBLIC_BASE_RPC_FALLBACK=false
VITE_ARC_RPC_URL=https://rpc.testnet.arc.network
VITE_WALLETCONNECT_PROJECT_ID=
```

If `VITE_WALLETCONNECT_PROJECT_ID` is empty, injected and Base Wallet connections continue to work; the WalletConnect/QR option will not be initialized with a fake project ID.

`VITE_BASE_RPC_URL` is required for production builds. If omitted, the application will fail-closed initially rather than silently falling back to the rate-limited public Base RPC. Define this variable, which is set to `sync: false` in the Render environment, before deployment. If using an old local `.env`, the Arc value must also be `https://rpc.testnet.arc.network`.

## Verification

```bash
cd backend/base_mainnet
npm run typecheck
npm run build
npm run test:network
npm run verify:base-registry
npm test

cd ../../frontend/base_mainnet
npm run lint
npm run build
node --test tests/useTransactionExecutor.test.mjs
```

`test:network` checks the network/chain matching and the Base–Arc target isolation contract. `verify:base-registry` only performs read-only bytecode, market, and liquidity discovery on Base Mainnet; it does not send transactions. Use a test wallet strictly for live chain transactions; do not use the mainnet key in Arc tests or on the client side.

Base protocol scope, official address sources, and Fee Router allowlist decisions are maintained in `docs/base-defi-protocol-registry.md`. See `docs/Kletia_Architecture_OnePager.md` for an architectural overview.

## Deploy

`render.yaml` deploys the canonical frontend and backend directories. In production, at least a dedicated Base RPC, `CORS_ORIGINS` containing the frontend URL, and API keys for live services must be defined. A WalletConnect project ID is also required if a QR connection will be offered. If a paymaster is to be used, a contract/method allowlist and spending limits must additionally be configured on the CDP Portal side as a mandatory defense layer.
