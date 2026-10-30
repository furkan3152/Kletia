# Kletia contracts for Arc Testnet (@kletia/contracts-arc)

Solidity workspace for the contracts deployed on Arc Testnet (`5042002`): the
Kletia application token (KLET), the solvency-checked savings vault
(KletiaArcVaultV2) and the Arc DeFi contracts (swap, lending, staking).
`KletiaArcForwarder` is the shared ERC-2771 trust root for gasless calls.

## Layout

- `KletiaArcVaultV2`: the vault that takes new deposits; it enforces aggregate principal and interest liabilities.
- DeFi: `KletiaArcSwap`, `KletiaArcLending` and `KletiaArcStaking`.
- Payments: `KletiaArcBatchPay`, `KletiaArcMemoTransfer` and `KletiaArcAgentRegistry`.
- `contracts/legacy/`: old OTC contracts, kept only for deployment provenance.

## Setup

```bash
npm ci --legacy-peer-deps
npm run compile
```

Hardhat compiles with Solidity 0.8.24 and `evmVersion: cancun`.

## Scripts

| Command | What it does |
|---------|-------------|
| `npm run compile` | Compile the contracts. |
| `npm test` | Run the DeFi, Vault V2, AgentRegistry and payment tests on the in-memory Hardhat network. |
| `npm run reserves:status` | Read Arc reserve coverage without a signer. |
| `npm run reconcile:reserves` | Recalculate and fund liabilities (sends transactions). |
| `npm run deploy:vault-v2` | Reproduce the Vault V2 deployment on Arc Testnet. |

## Environment

- `ARC_PRIVATE_KEY`: needed for funding commands such as `reconcile:reserves`; it is also the Vault and Staking owner. Never expose it to the web app.
- `ARCSCAN_API_KEY`: verifies exact source and constructor arguments on ArcScan.

## Deployments

Everything here is deployed to Arc Testnet (chain ID 5042002). Addresses,
runtime code hashes and explorer verification states are in
[`deployments/arc-testnet.json`](deployments/arc-testnet.json); the vault
migration is described in [`VAULT_V2_MIGRATION.md`](VAULT_V2_MIGRATION.md).

Compilation and Testnet deployment evidence do not establish audit or Mainnet readiness. `reserves:status` reports observed coverage at the queried block; it is not a future funding guarantee.

Test-only receiver, token and oracle fixtures live in `contracts/test/`. The
suite exercises successful operations and adversarial rollback, solvency,
authorization, reentrancy, signature/replay and oracle-failure cases of the
deployed sources. Tests named "characterizes current deployment" document known
limitations of the deployed Swap, Staking and Lending contracts on this testnet
(no swap minimum output or deadline, APR changes that reprice uncheckpointed
rewards, a stale TWAP usable after an oracle outage); they pass because the
contracts behave that way today. Local fixtures do not replace deployed identity
validation, pinned-fork tests or funded evidence.

## License

MIT
