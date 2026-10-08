# Solana

Solana is a first-class Kletia network. It is served by two layers:

- **`apps/api/src/networks/solana`** — network primitives: RPC, portfolio,
  token metadata and prices, Jupiter quotes and swap transactions, SOL / SPL /
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
| Liquid staking | Jupiter route into JitoSOL, mSOL or JupSOL | Executed as a swap into the LST |
| Transfer | System / SPL Token / Token-2022 | Destination associated token account created idempotently; mint decimals re-checked on-chain; Token-2022 mints that charge a transfer fee are refused (`TOKEN_TRANSFER_FEE_UNSUPPORTED`) |
| Bridge | Relay | Solana ↔ Base and Solana ↔ Arbitrum, including bridge-and-swap in one transaction |
| Lending discovery | Kamino main market | Read-only supply/borrow rates; reserves below 250k USD TVL hidden |

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
