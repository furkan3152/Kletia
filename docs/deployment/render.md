# Kletia Render release runbook

Kletia is released from one repository as two Render services and one private
PostgreSQL database:

- `apps/api`: unified Base, Arc, Arbitrum and Stellar API.
- `apps/web`: unified Vite static application.
- `kletia-stellar-event-archive`: Payment Center and durable workflow state.

The committed `render.yaml` is the deployment source of truth. Network
profiles are isolated inside the two services; they are not separate apps.
Contract and circuit workspaces are never Render services.

## Release boundary

The default public release contains:

- Base Mainnet reviewed intent execution and x402 surfaces;
- Arc Testnet reviewed Kletia protocols;
- capability-gated Arbitrum One;
- Stellar Testnet native execution;
- Stellar secp256r1/WebAuthn contract accounts through the pinned Smart Account
  Kit release and its reviewed Testnet relayer;
- Stellar Payment Center discovery, durable sessions and evidence; and
- the reviewed Arc -> Circle CCTP -> Arbitrum Sepolia -> Aave staged executor.

The following remain labs and must not be enabled by the core Render Blueprint:

- Policy V1/V2 control planes and prover artifacts;
- solver bond/auction;
- private payments alpha;
- Workflow V3/V4 research stores; and
- Stellar MPP.

Their deployed Testnet contracts remain historical/research evidence. They are
not required by `/api/release/mvp-readiness` and cannot make the core Payment
Center ready.

## Deployment commands

Backend Web Service:

- branch: `main`
- root: `apps/api`
- build: `npm ci --include=dev --legacy-peer-deps && npm run build`
- start: `npm start`
- health path: `/health`
- Node: `22.23.1`

Frontend Static Site:

- branch: `main`
- root: `apps/web`
- build: `npm ci --include=dev --legacy-peer-deps && npm run build`
- publish directory: `dist`
- SPA rewrite: `/*` -> `/index.html`
- Node: `22.23.1`

Do not select `src/index.ts` as a production entrypoint and do not add a start
command to the Static Site. The emitted API entrypoint is `dist/index.js`.

## Domains

- frontend: `https://kletiaai.xyz`
- API: `https://api.kletiaai.xyz`

Keep the Render subdomains available until custom-domain DNS, TLS, CORS and
wallet flows have passed. If Cloudflare is used, begin in DNS-only mode; adding
another proxy requires a fresh `TRUST_PROXY_HOPS` and rate-limit spoof review.

## Server-only environment

The following values belong only to the API service:

- `BASE_RPC_URL`
- `ARBITRUM_RPC_URL` when Arbitrum is enabled
- `ARBITRUM_SEPOLIA_RPC_URL`
- `OPENROUTER_API_KEY`
- `WEBACY_API_KEY`
- `ALLORA_API_KEY`
- `ALCHEMY_API_KEY`
- `ACROSS_API_KEY`
- `ACROSS_INTEGRATOR_ID`
- Coinbase/CDP credentials required by enabled onramp, x402 or paymaster paths
- `X402_TREASURY_ADDRESS`
- database URLs and generated workflow/session encryption or signing secrets

Never upload a Stellar secret seed, Base/Arc private key, deployer identity,
passkey credential or user recovery material. The application prepares and
verifies operations; users authorize money movement in their own wallet or
passkey account.

## Public network and contract configuration

The Blueprint fixes these non-secret boundaries:

- Base chain `8453` and Intent Router V2 release pins;
- Arc chain `5042002`, Vault V2 address and runtime code hash;
- Stellar Testnet passphrase, Horizon and RPC;
- `STELLAR_PASSKEY_ACCOUNTS_ENABLED=true`;
- pinned Smart Account Kit Testnet relayer origin;
- `STELLAR_LAST_MILE_ENABLED=true`;
- Arbitrum Sepolia chain `421614` when its live readiness passes; and
- `STELLAR_LABS_ENABLED=false`.

`VITE_*` values are public JavaScript configuration. Provider dashboard keys
used in browser RPC or WalletConnect must be domain- and rate-restricted; they
are not secrets.

## Payment Center provider gate

`STELLAR_ANCHOR_ALLOWLIST` and
`STELLAR_ANCHOR_ENDPOINT_HOST_ALLOWLIST` must contain only operator-reviewed
HTTPS origins. A provider is release-ready only when all of these are true:

1. `stellar.toml` matches Stellar Testnet and publishes the reviewed endpoints.
2. SEP-24 withdrawal is enabled for the exact Stellar asset.
3. SEP-38 returns a live quote for `context=sep24` and the configured delivery
   corridor.
4. SEP-45 advertises a contract-auth endpoint, auth contract and signing key.
5. The provider has a reviewed real-world settlement rail, KYC/refund handling
   and an exact release probe in `paymentCenterProviders.ts`.
6. A user-signed session has funded settlement evidence; discovery or a hosted
   demo alone is insufficient.

`testanchor.stellar.org` is intentionally reference-only. It can test protocol
shapes but cannot satisfy the real-world provider release gate. If no reviewed
provider meets every condition, the Payment Center remains fail-closed while
native Stellar payments and passkey accounts continue to work.

The Blueprint allowlists Testanchor only for this bounded interoperability
probe. Replacing or extending that allowlist requires a manifest and live
release probe; an operator cannot turn an arbitrary domain into a reviewed
settlement provider with configuration alone.

Self-hosting Stellar Anchor Platform supplies protocol infrastructure, not a
bank/payment rail. A public production anchor additionally requires a business
server, KYC program, off-chain transfer/refund operations, production database
and Kafka security, independent operational monitoring and legal/provider
agreements. Never expose the official quick-start defaults publicly.

## Local and CI gates

Run with the repository-pinned Node version:

```bash
export PATH=/home/technopc/.nvm/versions/node/v22.23.1/bin:$PATH
npm ci --include=dev
npm run verify:core
npm run verify:stellar-release-operator-live
npm run verify:mvp-live
```

`verify:mvp-live` may exit non-zero because a real reviewed payment provider is
not configured. That is the correct release behavior. It must still report the
individual Base, Arc, Stellar, passkey, Arbitrum Sepolia and durable-store
checks independently.

Run labs separately only when explicitly testing research surfaces:

```bash
npm run verify:labs
```

Production dependency audit is also required for `apps/api`, `apps/web`,
`contracts/base` and `contracts/arc`. A major dependency migration is not an
acceptable automatic audit fix; update it in isolation and repeat the full
wallet and network matrix.

## Public rollout verification

After CI succeeds and Render deploys the exact commit:

1. `/health` returns 200 without making an RPC request.
2. `/api/health/base` reports chain `8453` ready.
3. `/api/health/arc` reports chain `5042002` ready.
4. `/api/stellar/readiness` reports live Testnet ledger/RPC identity.
5. `/api/stellar/passkey/readiness` matches the pinned account WASM,
   WebAuthn verifier, XLM/USDC SACs and Testnet relayer.
6. `/api/arbitrum-sepolia/readiness` matches chain `421614`, Circle USDC and
   reviewed Aave identities when enabled.
7. `/api/release/mvp-readiness` reports every check and does not convert an
   unavailable payout provider into a green result.
8. `https://kletiaai.xyz` and a nested route load without localhost requests.
9. Base -> Arc -> Stellar -> Arbitrum switching clears stale executable state.
10. Test one read-only intent on every enabled network before a value-bearing
    intent.
11. Create a browser passkey only on HTTPS or `localhost`; verify the resulting
    C-account and transaction on Stellar Testnet.
12. Verify submitted value-bearing operations by receipt/event/protocol state,
    not only by a transaction hash.
13. Confirm no server secret appears in the static bundle and CORS allows only
    committed production origins.

## Evidence language

- A successful build proves buildability.
- Live readiness proves observed identities and dependencies.
- A Testnet transaction proves only that exact Testnet operation.
- A virtual WebAuthn authenticator proves the software flow, not a human
  biometric ceremony.
- Provider discovery or SEP metadata does not prove fiat settlement.
- No local or Testnet result is a security audit or Mainnet production claim.
