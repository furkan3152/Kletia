# Arbitrum and Cross-chain Workflow MVP

## Runtime boundary

Arbitrum One is chain `42161` and is a Public Beta capability. The production
API accepts Arbitrum requests only when `ARBITRUM_MVP_ENABLED=true` and the
configured RPC reports the exact chain ID. Every request also revalidates the
reviewed Uniswap V3 and Aave V3 deployment identities before producing a route.
Base and Arc remain independently available when the beta is disabled.

Reviewed Arbitrum assets are ETH, WETH, native USDC, and ARB. Token symbols are
resolved within the active network catalog; an address from Base or Arc cannot
stand in for an Arbitrum token.

## Protocol scope

- Uniswap V3 Factory, SwapRouter, and QuoterV2 for exact-input swaps.
- Aave V3 Pool, PoolAddressesProvider, ProtocolDataProvider, and Oracle for
  supply, withdraw, variable-rate borrow, repay, and live reserve reads.
- Across V3 for staged Base-to-Arbitrum settlement and lifecycle evidence.

Addresses are pinned in `apps/api/src/networks/arbitrum/contracts.ts`. The API
also reads the Aave provider at runtime and rejects a pool, data-provider, or
oracle mismatch.

## Workflow lifecycle

`WorkflowPlanV1` is an HMAC-sealed server artifact. Each executable step binds
one wallet, network, chain ID, target, calldata hash, native value, and quote
expiry. The browser never creates the next step. It submits an exact receipt to
`POST /api/workflows/advance`; the API verifies the transaction and, for a
bridge, Across fill/refund state before compiling a fresh destination route.

The `MAX` value after a bridge means the sealed Across output amount. It does
not mean the user's full pre-existing destination balance. Quotes are never
silently retried after expiry or an indeterminate result.

Aave borrow sizing enforces a hard projected health-factor floor of `1.5` and a
risk-dependent target above that floor. Borrowing remains a separately signed
Arbitrum transaction after collateral is available; no MulticallHandler debt or
credit delegation is created.

## Release procedure

1. Deploy with API and web beta flags set to `false`.
2. Configure a dedicated Arbitrum RPC and a random `WORKFLOW_SIGNING_SECRET` on
   the API service. Configure Across API credentials for bridge workflows.
3. Verify `/api/health/arbitrum`, live no-value portfolio/rate reads, Uniswap
   quotes, Aave provider identities, and mobile layout.
4. Set both `ARBITRUM_MVP_ENABLED` and `VITE_ARBITRUM_MVP_ENABLED` to `true`,
   rebuild both services, and confirm that the wallet switches to chain 42161.
5. Any real mainnet transfer is performed only through the user-facing wallet
   review. No deployer key or automated funded signer is part of this MVP.

No new Kletia contract, deployment, or allowlist transaction is required.
