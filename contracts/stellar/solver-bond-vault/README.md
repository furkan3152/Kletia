# Kletia Solver Bond Vault

`KletiaSolverBondVault` is an asset-backed participation vault for Kletia
solvers. A solver deposits the constructor-pinned Stellar Asset Contract,
voluntarily locks a portion of that balance to one workflow root, and cannot
withdraw while active or while any bond remains locked.

The coordinator address is immutable. It may release a lock with an opaque
settlement hash or slash the exact locked amount with an opaque evidence hash.
Those hashes do not prove foreign-chain execution by themselves. Deployment
must therefore bind the coordinator to a separately reviewed evidence or
governance path; an application server key is not an acceptable production
coordinator.

The contract never calls Base or Arbitrum, never grants an agent spending
authority over user funds, and never treats timeout or an indeterminate bridge
result as solver fault. Its bond asset, treasury and bounded resolution grace
are immutable constructor bindings. Once both the settlement deadline and that
grace period have elapsed, the solver can reclaim an unresolved lock; an
unavailable coordinator therefore cannot freeze it permanently. If XLM is
selected as the bond asset, it is application collateral, not Stellar
validator staking.

Status: source/host tests and a runtime-attested Stellar Testnet deployment.
The manifest records a complete deposit, workflow lock and release lifecycle.
It is not audited or production-ready, and the development deployment uses one
secure-store Testnet account for administrator, coordinator and treasury roles.
