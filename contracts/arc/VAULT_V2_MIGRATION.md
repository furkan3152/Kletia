# Arc Vault V2 migration

`KletiaArcVaultV2` permanently enforces aggregate principal and interest
reserves inside the contract. The legacy Vault remains immutable and cannot be
upgraded or drained by an administrator.

## Active deployment

- Address: `0xBe385e3520C20D44697CC1bEEDc9DF759C3A184d`
- Deployment transaction:
  `0x9494347ea1e07a8214cb923f2a244c9ec5280c9853e0e204a26d3e13093fdef2`
- Deployment block: `56838393`
- Runtime codehash:
  `0xa6cb476a1243a6d9bc71909a5774d1340061e91bcb47cd8aea3df1f5444bec1f`
- ArcScan status: exact source and constructor arguments verified
- Application mode: `vault_v2`; legacy contract is withdrawal-only

## Deployment reproduction

1. Recompute and fund the legacy Vault to cover every user's principal and
   accrued interest before inviting any withdrawal. Do not use a cached amount.
2. Set `ARC_PRIVATE_KEY`, `ARC_VAULT_V2_OWNER`, `ARC_VAULT_V2_GUARDIAN` and,
   only when overriding the canonical deployment, `ARC_TRUSTED_FORWARDER_ADDRESS`.
3. Run `npm run deploy:vault-v2 -- --network arc`.
4. Verify the exact source with the four constructor arguments emitted by the
   deployment script:

   ```bash
   npx hardhat verify --network arc <VAULT_V2_ADDRESS> \
     <TRUSTED_FORWARDER> <OWNER> <GUARDIAN> <APY_BPS>
   ```

   Re-read the deployed runtime code and require its `keccak256` to equal the
   `runtimeCodehash` emitted by the deployment script. A submitted/pending
   explorer request is not `verifiedExact`.
5. Add the confirmed address and transaction evidence to
   `deployments/arc-testnet.json` before changing application configuration.

## User migration

The legacy Vault has no owner migration or delegated withdrawal function. A
custodial bulk migration is therefore impossible and must not be fabricated.
Each legacy depositor must withdraw to the same wallet and then deposit into
V2. Smart accounts may batch these calls only when the wallet can spend the
native USDC received by the first call in the second call. EOAs use two
transactions.

During migration:

- stop new legacy deposits;
- keep legacy withdrawals and the application reserve guard available;
- route new deposits only to the exact-verified V2 address;
- show legacy and V2 positions separately until legacy `totalDeposited` is
  zero;
- never relabel a legacy position as migrated before both receipts confirm;
- keep Base Mainnet and every non-Vault Arc action unchanged.

Normal V2 withdrawals revert unless the Vault covers total principal plus the
global interest liability. `emergencyWithdraw` forfeits only the caller's
interest and cannot consume another user's principal.
