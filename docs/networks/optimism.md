# OP Mainnet

OP Mainnet (`optimism`) is a production-lane EVM network of the Kletia intent
platform (Platform API v1). It was added in round 3 for its native USDC (CCTP V2
domain 2) and its coverage by Relay, LI.FI and deBridge DLN. Every
address below was read back on-chain on 2026-10-09 (`eth_chainId`, ERC-20
`symbol()`/`decimals()`, Aave `getReserveTokensAddresses`, Comet `baseToken()`,
ERC-4626 `asset()` and factory checks, `eth_getCode` for venue contracts).

## Identity

| Field | Value |
|---|---|
| Network key | `optimism` |
| CAIP-2 | `eip155:10` |
| EVM chain id | 10 |
| Native asset | ETH (18 decimals) |
| Explorer | https://optimistic.etherscan.io |
| Settlement ids | CCTP domain 2; Relay, deBridge, Across and LI.FI chain id 10 |

## Canonical assets

| Symbol | Address | Decimals | Cross-network group |
|---|---|---|---|
| ETH | native | 18 | ETH |
| USDC | `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85` | 6 | USDC (Circle-native, CCTP V2) |
| WETH | `0x4200000000000000000000000000000000000006` | 18 | ETH |

## Venues in the registry

| Protocol | Pinned contracts |
|---|---|
| Aave V3 | Pool `0x794a61358D6845594F94dc1DB02A252b5b4814aD`, data provider `0x243Aa95cAC2a25651eda86e80bEe66114413c43b`; aUSDC `0x38d693cE1dF5AaDF7bC62595A37D667aD57922e5`, aWETH `0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8` (same addresses as Arbitrum, different deployments: venues are keyed by network and address) |
| Compound V3 | cUSDCv3 `0x2e44e174f7D53F0212823acC11C01A11d58c5bCB`, cWETHv3 `0xE36A30D249f7761327fd973001A32010b521b6Fd` |
| Moonwell | Comptroller `0xCa889f40aae37FFf165BccF69aeF1E82b5C511B9`; mUSDC `0x8E08617b0d66359D73Aa11E11017834C29155525`, mWETH `0xb4104C02BBf4E9be85AAa41a62974E4e28D59A33` (WETH router `0xc4Ab8C031717d7ecCCD653BE898e0f92410E11dC`) |
| Relay | depository `0x4cD00E387622C35bDDB9b4c962C136462338BC31`, ERC-20 router `0xb92fe925DC43a0ECdE6c8b1a2709c170Ec4fFf4f`, approval proxy `0xCcC88a9d1B4ED6b0EABA998850414b24f1c315bE` |
| LI.FI | LiFiDiamond `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE`, fee forwarder `0xCE40449B773a3E6E5e769ADb4e567179d4828cbd` |
| deBridge DLN | DlnSource `0xeF4fB24aD0916217251F553c0596F8Edc630EB66`, DlnDestination `0xE7351Fd770A37282b91D153Ee690B63579D6dd7f` |
| Transfers | Native and ERC-20 transfers (`system-transfer`, `erc20-transfer`) |

Grammar words: `optimism`, `op`, `op mainnet`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `OPTIMISM_RPC_URL` | unset: https://mainnet.optimism.io, https://optimism-rpc.publicnode.com, https://optimism.drpc.org (with fallback) | RPC for reads, fee estimates and receipt verification. Use a keyed provider in production. |

## How capabilities become live

Everything above is registry data in `@kletia/core` (`CHAINS`, `ASSETS`,
`PROTOCOLS`, `YIELD_VENUES`, `VENUE_CONTRACTS`). A route is executable only
when an engine adapter serves it; `GET /v1/networks` derives the live routes
from the adapters the deployment runs, and `GET /v1/protocols` reports
`executable` per protocol. Adapters read every market, vault and contract
address from those tables and never take one from a provider at runtime.

## Safety notes

- The RPC client refuses every read until the endpoint answers `eth_chainId`
  with 10; an RPC configured for the wrong chain serves nothing.
- The network is in the production capital lane: it never shares an intent with
  a testnet (`CAPITAL_LANE_MIXED`).
- Submitted transactions verify only when chain, sender, target, calldata and
  value reproduce a payload prepared for the step (quote binding).
