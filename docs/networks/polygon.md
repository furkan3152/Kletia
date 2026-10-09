# Polygon PoS

Polygon PoS (`polygon`) is a production-lane EVM network of the Kletia intent
platform (Platform API v1). It was added in round 3 for its native USDC (CCTP V2
domain 7) and its coverage by Relay, LI.FI and deBridge DLN. Every
address below was read back on-chain on 2026-10-09 (`eth_chainId`, ERC-20
`symbol()`/`decimals()`, Aave `getReserveTokensAddresses`, Comet `baseToken()`,
ERC-4626 `asset()` and factory checks, `eth_getCode` for venue contracts).

## Identity

| Field | Value |
|---|---|
| Network key | `polygon` |
| CAIP-2 | `eip155:137` |
| EVM chain id | 137 |
| Native asset | POL (18 decimals; no USD price source yet, so gas estimates in USD are omitted) |
| Explorer | https://polygonscan.com |
| Settlement ids | CCTP domain 7; Relay, deBridge, Across and LI.FI chain id 137 |

## Canonical assets

| Symbol | Address | Decimals | Cross-network group |
|---|---|---|---|
| POL | native | 18 | none |
| USDC | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` | 6 | USDC (Circle-native, CCTP V2) |
| WPOL | `0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270` | 18 | none |
| WETH | `0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619` | 18 | ETH (bridged; ETH bridged to Polygon arrives as WETH) |

## Venues in the registry

| Protocol | Pinned contracts |
|---|---|
| Aave V3 | Pool `0x794a61358D6845594F94dc1DB02A252b5b4814aD`, data provider `0x243Aa95cAC2a25651eda86e80bEe66114413c43b`; aUSDC (native USDC reserve) `0xA4D94019934D8333Ef880ABFFbF2FDd611C762BD`, aWETH `0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8` |
| Relay | depository `0x4cD00E387622C35bDDB9b4c962C136462338BC31`, ERC-20 router `0xb92fe925DC43a0ECdE6c8b1a2709c170Ec4fFf4f`, approval proxy `0xCcC88a9d1B4ED6b0EABA998850414b24f1c315bE` |
| LI.FI | LiFiDiamond `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE`, fee forwarder `0xCE40449B773a3E6E5e769ADb4e567179d4828cbd` |
| deBridge DLN | DlnSource `0xeF4fB24aD0916217251F553c0596F8Edc630EB66`, DlnDestination `0xE7351Fd770A37282b91D153Ee690B63579D6dd7f` |
| Transfers | Native and ERC-20 transfers (`system-transfer`, `erc20-transfer`) |

Grammar words: `polygon`, `polygon pos`, `matic`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `POLYGON_RPC_URL` | unset: https://polygon-bor-rpc.publicnode.com, https://polygon.drpc.org, https://1rpc.io/matic (polygon-rpc.com now requires a key and is not used) (with fallback) | RPC for reads, fee estimates and receipt verification. Use a keyed provider in production. |

## How capabilities become live

Everything above is registry data in `@kletia/core` (`CHAINS`, `ASSETS`,
`PROTOCOLS`, `YIELD_VENUES`, `VENUE_CONTRACTS`). A route is executable only
when an engine adapter serves it; `GET /v1/networks` derives the live routes
from the adapters the deployment runs, and `GET /v1/protocols` reports
`executable` per protocol. Adapters read every market, vault and contract
address from those tables and never take one from a provider at runtime.

## Safety notes

- The RPC client refuses every read until the endpoint answers `eth_chainId`
  with 137; an RPC configured for the wrong chain serves nothing.
- The network is in the production capital lane: it never shares an intent with
  a testnet (`CAPITAL_LANE_MIXED`).
- Submitted transactions verify only when chain, sender, target, calldata and
  value reproduce a payload prepared for the step (quote binding).
