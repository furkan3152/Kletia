# Ethereum

Ethereum (`ethereum`) is a production-lane EVM network of the Kletia intent
platform (Platform API v1). It was added in round 3 for its native USDC (CCTP V2
domain 0) and its coverage by Relay, LI.FI and deBridge DLN. Every
address below was read back on-chain on 2026-10-09 (`eth_chainId`, ERC-20
`symbol()`/`decimals()`, Aave `getReserveTokensAddresses`, Comet `baseToken()`,
ERC-4626 `asset()` and factory checks, `eth_getCode` for venue contracts).

## Identity

| Field | Value |
|---|---|
| Network key | `ethereum` |
| CAIP-2 | `eip155:1` |
| EVM chain id | 1 |
| Native asset | ETH (18 decimals) |
| Explorer | https://etherscan.io |
| Settlement ids | CCTP domain 0; Relay, deBridge, Across and LI.FI chain id 1 |

## Canonical assets

| Symbol | Address | Decimals | Cross-network group |
|---|---|---|---|
| ETH | native | 18 | ETH |
| USDC | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | 6 | USDC (Circle-native, CCTP V2) |
| WETH | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` | 18 | ETH |

## Venues in the registry

| Protocol | Pinned contracts |
|---|---|
| Aave V3 | Pool `0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2`, data provider `0x0a16f2FCC0D44FaE41cc54e079281D84A363bECD`; aUSDC `0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c`, aWETH `0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8` |
| Compound V3 | cUSDCv3 `0xc3d688B66703497DAA19211EEdff47f25384cdc3` (base token USDC), cWETHv3 `0xA17581A9E3356d9A858b789D68B4d866e593aE94` (base token WETH) |
| Morpho | Vault V2 (factory `0xA1D94F746dEfa1928926b84fB2596c06926C0405`): Steakhouse Prime USDC `0xbeef088055857739C12CD3765F20b7679Def0f51`, Gauntlet USDC Prime `0x8c106EEDAd96553e64287A5A6839c3Cc78afA3D0` |
| Relay | depository `0x4cD00E387622C35bDDB9b4c962C136462338BC31`, ERC-20 router `0xb92fe925DC43a0ECdE6c8b1a2709c170Ec4fFf4f`, approval proxy `0xCcC88a9d1B4ED6b0EABA998850414b24f1c315bE` |
| LI.FI | LiFiDiamond `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE`, fee forwarder `0xCE40449B773a3E6E5e769ADb4e567179d4828cbd` |
| deBridge DLN | DlnSource `0xeF4fB24aD0916217251F553c0596F8Edc630EB66`, DlnDestination `0xE7351Fd770A37282b91D153Ee690B63579D6dd7f` |
| Transfers | Native and ERC-20 transfers (`system-transfer`, `erc20-transfer`) |

ENS recipients (`*.eth`) are resolved on Ethereum through the name-resolver hook (registry `0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e`, Universal Resolver `0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe`) once a resolver is registered.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ETHEREUM_RPC_URL` | unset: https://ethereum-rpc.publicnode.com, https://cloudflare-eth.com, https://eth.drpc.org (with fallback) | RPC for reads, fee estimates and receipt verification. Use a keyed provider in production. |

## How capabilities become live

Everything above is registry data in `@kletia/core` (`CHAINS`, `ASSETS`,
`PROTOCOLS`, `YIELD_VENUES`, `VENUE_CONTRACTS`). A route is executable only
when an engine adapter serves it; `GET /v1/networks` derives the live routes
from the adapters the deployment runs, and `GET /v1/protocols` reports
`executable` per protocol. Adapters read every market, vault and contract
address from those tables and never take one from a provider at runtime.

## Safety notes

- The RPC client refuses every read until the endpoint answers `eth_chainId`
  with 1; an RPC configured for the wrong chain serves nothing.
- The network is in the production capital lane: it never shares an intent with
  a testnet (`CAPITAL_LANE_MIXED`).
- Submitted transactions verify only when chain, sender, target, calldata and
  value reproduce a payload prepared for the step (quote binding).
