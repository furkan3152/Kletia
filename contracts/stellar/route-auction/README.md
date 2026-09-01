# Kletia Route Auction

`KletiaRouteAuction` is a bounded commit-reveal market for complex Kletia
workflows. Solvers first lock a constructor-pinned asset in
`KletiaSolverBondVault`, commit a hidden route bid, then reveal the route hash,
quote evidence hash and economic terms after the commit window closes.

The contract enforces bid count, minimum output, maximum solver fee, maximum
duration, bid expiry and an exact workflow-scoped bond lock. It selects the
highest promised net output, breaking ties by duration. This prevents a later
solver from copying a visible bid, but it does not make an off-chain quote true
or verify Base/Arbitrum execution. The constraints hash, quote evidence and
foreign-chain receipts still require the Kletia evidence pipeline.

Settlement distinguishes success, provable solver fault and indeterminate
outcomes. An indeterminate bridge or provider result leaves the bond unresolved
and can later recover to success or solver fault. The settlement authority must
separately release or slash the matching bond-vault lock; the auction never
silently turns timeout into fault. Anyone may mark an abandoned open auction as
`NoWinner`, or an abandoned finalized auction as `Indeterminate`, only after the
settlement window closes. The vault's separate grace period then provides a
solver-controlled recovery path.

Simple single-chain transactions do not need an auction. This contract is for
high-value, cross-chain or user-requested competitive execution.

Status: source/host tests and a runtime-attested Stellar Testnet deployment.
The manifest records a complete one-solver commit, reveal, finalization and
success settlement lifecycle. It is not audited or production-ready, and no
foreign-chain route was executed by the smoke auction.
