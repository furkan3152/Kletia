# Solana

Solana is a first-class Kletia network. It is served by two layers:

- **`apps/api/src/networks/solana`** — network primitives: RPC, portfolio,
  token metadata and prices, Jupiter quotes and swap transactions, venue-pinned
  Raydium / Orca instruction transport, SOL / SPL /
  Token-2022 transfers, provider-instruction assembly, signature verification
  and Kamino lending-rate discovery. Mounted at `/api/solana`.
- **Platform API v1** (`/v1`) — chain-agnostic intents. Solana steps, and
  cross-network steps between Solana and EVM networks, are planned and executed
  through the same intent graph as every other network.

## Networks

| Key | CAIP-2 | Wallet Standard chain | Lane |
|---|---|---|---|
| `solana` | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | `solana:mainnet` | production |
| `solana-devnet` | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` | `solana:devnet` | testnet |

## Capabilities

| Capability | Venue | Notes |
|---|---|---|
| Portfolio | Solana RPC + Jupiter Price API v3 | SOL plus SPL and Token-2022 accounts, merged per mint |
| Swap | Jupiter | Exact-in, slippage 1–300 bps (default 50), price impact above 5% refused |
| Direct swap | Raydium CLMM / CP | One direct pool, explicit `raydium` protocol; Jupiter transports quotes and V1 instructions, with splitting/intermediate tokens disabled |
| Direct swap | Orca Whirlpools | One direct pool, explicit `orca` protocol; legacy and V2 Whirlpool swaps through Jupiter V1 transport |
| Liquid staking | Jupiter route into JitoSOL, mSOL or JupSOL | Executed as a swap into the LST |
| Transfer | System / SPL Token / Token-2022 | Destination associated token account created idempotently; mint decimals re-checked on-chain; Token-2022 mints that charge a transfer fee are refused (`TOKEN_TRANSFER_FEE_UNSUPPORTED`) |
| Bridge | Relay | Solana ↔ Base and Solana ↔ Arbitrum, including bridge-and-swap in one transaction |
| Lending | Kamino main market / Jupiter Lend Earn | Pinned reserve deposits and withdrawals through `/v1`; Kamino supply/borrow rates are also available read-only |

### Explicit DEX routes

The Jupiter aggregator can already choose liquidity from many DEXes. The
`raydium` and `orca` adapters add a stricter choice: a developer or user can
require that the swap use a single pool of that named venue, without silently
falling back to another DEX. Examples:

```text
swap 0.01 SOL for USDC on solana via raydium
swap 0.01 SOL for USDC on solana using orca
```

Structured actions set `protocol: "raydium"` or `protocol: "orca"`. Both use
the configured Jupiter quote and swap-instruction endpoint; these are venue
integrations over that transport, rather than separate direct quoting APIs.
They currently accept Solana mainnet, exact-in, classic SPL tokens and native
SOL, slippage of 1–300 bps, and output to the acting wallet. Token-2022 mints,
multi-hop or split routes, arbitrary extra transactions and unknown instruction
variants fail closed. A transfer step can send the resulting assets to another
wallet.

| Program | Canonical mainnet address |
|---|---|
| Raydium CLMM | `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK` |
| Raydium CP | `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C` |
| Orca Whirlpools | `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc` |

Canonical programs are defined in `@kletia/core`'s `VENUE_CONTRACTS`. At plan
and prepare, the quoted pool's on-chain owner, account discriminator and exact
mints must match those pins. Prepare also binds the pool's config, vaults and
observation account, wallet authority, associated token accounts, encoded
input, output floor and slippage. Only bounded compute instructions, the
wallet's associated-account creation and exact native-SOL wrap / unwrap
instructions may surround the swap. Every provider signer must be the bound
wallet.

The transaction is rebuilt with a fresh blockhash, independently simulated,
and returned only if simulation proves a CPI into the reviewed pool. Missing
RPC simulation or inner-instruction evidence is an error, never a fallback
warning. Verification checks the landed instruction and pool again, the
actual venue CPI, exact input and output credited to the acting wallet. Native
SOL accounting includes both canonical associated accounts' lamport deltas,
so account rent refunds and pre-existing wrapped SOL are excluded from the
swap proceeds without a tolerance. The guaranteed floor uses
integer rounding down; Jupiter's displayed HTTP threshold can round up by one
base unit, so Kletia does not promise that extra unit.

Official implementation references: [Jupiter Swap API schema](https://github.com/jup-ag/jupiter-quote-api-node/blob/main/swagger.yaml),
[Jupiter route instruction IDL](https://github.com/jup-ag/instruction-parser/blob/main/src/idl/jupiter.ts),
[Raydium program IDs](https://github.com/raydium-io/raydium-sdk-V2/blob/master/src/common/programId.ts),
[Raydium CLMM pool state](https://github.com/raydium-io/raydium-clmm/blob/master/programs/amm/src/states/pool.rs),
[Raydium CP pool state](https://github.com/raydium-io/raydium-cp-swap/blob/master/programs/cp-swap/src/states/pool.rs),
and [Orca Whirlpool pool state](https://github.com/orca-so/whirlpools/blob/main/programs/whirlpool/src/state/whirlpool.rs).

On 2026-10-10, read-only mainnet checks successfully planned and prepared
0.01 SOL → USDC at 50 bps through both Raydium CLMM and Orca Whirlpool V2,
including exact account validation and independent RPC simulation with the
venue CPI. No transaction was signed or broadcast; these checks prove live
quote / unsigned preparation and simulation, not funded settlement. The
fixture suite covers spoofed quotes/pools/mints, wrong signers, extra transfers
and approvals, slippage/fee changes, unavailable simulations, lookup-table
resolution and mismatched landed economic outcomes.

## Safety model

- Kletia builds **unsigned** v0 transactions; the user's wallet signs them.
- Every prepared transaction is simulated (`sigVerify: false`) before it is
  returned, and simulation failures are reported, never hidden.
- Provider instructions (Relay) are rejected if any instruction requires a
  signer other than the fee payer.
- Transfer and bridge recipients on Solana must be wallets: an existing token
  account, mint, or program-owned account holding data is refused at planning
  and prepare (`SOLANA_RECIPIENT_NOT_WALLET`). Addresses with no account yet
  are allowed. If the recipient cannot be read, the request fails rather than
  skipping the check.
- A submitted signature advances an intent step only after Kletia observes it
  at `confirmed` or `finalized` commitment with the bound account as fee payer.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | Mainnet RPC (use a private RPC in production) |
| `SOLANA_DEVNET_RPC_URL` | `https://api.devnet.solana.com` | Devnet RPC |
| `JUPITER_API_KEY` | unset | Switches to the keyed `https://api.jup.ag` endpoint |
| `JUPITER_API_URL` | `https://lite-api.jup.ag` | Override the Jupiter endpoint |
| `KAMINO_API_URL` | `https://api.kamino.finance` | Kamino API |
| `SOLANA_HTTP_TIMEOUT_MS` | `10000` | Provider timeout |

## HTTP endpoints (`/api/solana`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Mainnet and devnet RPC health |
| GET | `/portfolio/:owner?network=` | Balances with USD values |
| GET | `/tokens/search?q=` | Jupiter token search |
| GET | `/quote?from=&to=&amount=&slippageBps=` | Jupiter quote (human amounts) |
| POST | `/swap/prepare` | Quote plus unsigned swap transaction |
| POST | `/transfer/prepare` | Unsigned SOL / SPL transfer |
| GET | `/tx/:signature?network=&signer=` | Confirmation evidence; with `signer`, stays `processed` until the fee payer can be checked |
| GET | `/yields` | Kamino lending rates |
