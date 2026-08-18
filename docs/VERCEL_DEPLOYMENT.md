# Vercel deployment

Kletia is deployed as two projects from the same repository. Never import a
contract deployment `.env` into either project and never expose a server key
through a `VITE_` variable.

## Frontend project

- Root Directory: `apps/web`
- Framework Preset: `Vite`
- Build Command: `npm run build`
- Output Directory: `dist`
- Node.js: `22.x`
- Production domain: `kletiaai.xyz`

Import this text in the frontend project's Environment Variables screen. Apply
it to Production and use separate preview URLs for Preview deployments.

```dotenv
VITE_BACKEND_URL=https://api.kletiaai.xyz
VITE_ALLOW_LOCAL_BACKEND=false
VITE_WALLETCONNECT_PROJECT_ID=<WALLETCONNECT_PROJECT_ID>
VITE_BASE_RPC_URL=https://mainnet.base.org
VITE_ALLOW_PUBLIC_BASE_RPC_FALLBACK=false
VITE_ARC_RPC_URL=https://rpc.testnet.arc.network
VITE_ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc
VITE_ARBITRUM_MVP_ENABLED=true
VITE_ARC_VAULT_EXECUTION_MODE=vault_v2
VITE_ARC_VAULT_V2_ADDRESS=0xBe385e3520C20D44697CC1bEEDc9DF759C3A184d
VITE_BASE_SWAP_EXECUTION_MODE=intent_v2
VITE_BASE_PAYMASTER_ENABLED=false
```

The three public RPC URLs above avoid embedding a private Alchemy key in the
browser. A domain-restricted browser RPC can replace them later.

## Backend project

- Root Directory: `apps/api`
- Framework Preset: `Other` or auto-detected Express
- Build/Output overrides: leave empty; Vercel detects `src/index.ts`
- Node.js: `22.x`
- Function region: Frankfurt (`fra1`, pinned in `vercel.json`)
- Production domain: `api.kletiaai.xyz`

Start with `apps/api/.env.example`, then import the following production
overrides. Values marked `PASTE` are server secrets from the existing local
`apps/api/.env`; never copy them into the frontend project.

```dotenv
CORS_ORIGINS=https://kletiaai.xyz,https://www.kletiaai.xyz
BASE_RPC_URL=<PASTE_PRIVATE_BASE_RPC_URL>
ARC_RPC_URL=https://rpc.testnet.arc.network
ARBITRUM_RPC_URL=<PASTE_PRIVATE_ARBITRUM_RPC_URL>
ARBITRUM_MVP_ENABLED=true
WORKFLOW_SIGNING_SECRET=<GENERATE_AT_LEAST_32_RANDOM_CHARACTERS>
ARC_VAULT_EXECUTION_MODE=vault_v2
ARC_VAULT_V2_ADDRESS=0xBe385e3520C20D44697CC1bEEDc9DF759C3A184d
ARC_VAULT_V2_RUNTIME_CODEHASH=0xa6cb476a1243a6d9bc71909a5774d1340061e91bcb47cd8aea3df1f5444bec1f
OPENROUTER_API_KEY=<PASTE>
ALLORA_API_KEY=<PASTE>
WEBACY_API_KEY=<PASTE>
ALCHEMY_API_KEY=<PASTE>
ACROSS_API_KEY=<PASTE>
ACROSS_INTEGRATOR_ID=<PASTE_2_BYTE_ID>
ACROSS_MAX_RELAY_FEE_BPS=300
CDP_NODE_API_KEY=<PASTE_IF_USED>
CDP_API_KEY_ID=<PASTE>
CDP_API_KEY_SECRET=<PASTE>
CDP_API_KEY_NAME=<PASTE_IF_ONRAMP_USES_THE_LEGACY_KEY>
CDP_API_KEY_PRIVATE_KEY=<PASTE_IF_ONRAMP_USES_THE_LEGACY_KEY>
CDP_PAYMASTER_POLICY_ID=<PASTE_ONLY_AFTER_POLICY_REVIEW>
PAYMASTER_PROXY_ENABLED=false
TRUST_PROXY_HOPS=1
BASE_SWAP_EXECUTION_MODE=intent_v2
BASE_TOKEN_DEPLOYMENT_MODE=launch_v2
KLETIA_FEE_RECIPIENT=<PASTE_PUBLIC_BASE_ADDRESS>
X402_TREASURY_ADDRESS=<PASTE_PUBLIC_BASE_ADDRESS>
X402_DEFAULT_PRICE_USDC=0.01
X402_BUYER_MAX_PAYMENT_USDC=1
X402_MAX_PRICE_ATOMIC=100000000
KLETIA_X402_ATTESTATION_REGISTRY_ADDRESS=0xE69DE5A5E92F4a52b15C651C1C1fc0fE36143889
KLETIA_X402_ATTESTATION_OWNER_ADDRESS=0x84f19Fdfd8C50C6349BFe86Cd90BE131387ab47D
KLETIA_V2_GUARDIAN_SAFE=0xCae3520A4348BEB2b74Ef52E8be2dE06f57fC0Bc
```

Also import the exact single-line values of
`KLETIA_INTENT_ROUTER_V2_ADDRESS`,
`KLETIA_INTENT_ROUTER_V2_EVIDENCE_JSON`,
`KLETIA_LAUNCH_FACTORY_V2_ADDRESS`, and
`KLETIA_LAUNCH_FACTORY_V2_EVIDENCE_JSON` from `apps/api/.env.example`. They are
public deployment evidence, but must remain byte-for-byte unchanged.

Do not add `PRIVATE_KEY`, `BASE_PRIVATE_KEY`, `ARC_PRIVATE_KEY`,
`ARC_OWNER_PRIVATE_KEY`, explorer API keys, or `PORT` to either Vercel project.
The application does not need deployment signers at runtime.

## Important backend scaling boundary

The Express application can boot as one Vercel Function, but token
clarification and Base x402 buyer sessions currently use bounded in-memory
single-use stores. Vercel may run more than one Fluid Compute instance, so a
second request is not guaranteed to reach the instance that created the
session. Use the existing long-running Render backend for production until
these two stores are moved to a shared TTL/CAS datastore. The Vercel backend is
safe for preview and stateless/read-only routes, but it must not be presented
as reliable for real x402 settlement or multi-turn clarification at horizontal
scale yet.

## Domain order

1. Deploy the backend and verify `/health`.
2. Attach `api.kletiaai.xyz` to the backend and update DNS as Vercel displays.
3. Deploy the frontend with `VITE_BACKEND_URL=https://api.kletiaai.xyz`.
4. Attach `kletiaai.xyz` and `www.kletiaai.xyz` to the frontend.
5. Redeploy both projects after importing environment variables; Vercel does
   not apply changed variables to an already-built deployment.
