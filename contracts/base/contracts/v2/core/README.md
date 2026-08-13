# Kletia Intent Router V2

This directory contains the non-upgradeable Base settlement core. It is not a
route finder: route enumeration, quotes, simulation, risk scoring, and intent
planning remain offchain. The core only settles a signed, typed result through a
governance-approved adapter.

## Trust and governance boundary

- Deploy `KletiaIntentRouterV2` with an OpenZeppelin `TimelockController` as
  owner. Use a Safe as proposer/canceller. An EOA owner is not a production
  configuration.
- The guardian may pause the router or disable an adapter. It cannot enable an
  adapter, unpause, change fees/treasury, rescue assets, or change ownership.
- Adapters and protocol targets are runtime-code-hash pinned. Only register
  reviewed non-proxy adapters and non-upgradeable protocol entrypoints. A proxy
  can change implementation without changing its proxy runtime code hash; that
  risk cannot be solved by `EXTCODEHASH` and must be excluded or separately
  monitored by deployment policy.
- Exact source verification is required for the router and every adapter, but
  verification is not a security audit.

## Settlement invariants

- The router never returns or transfers its global token/native balance.
- Input collection, protocol spending, output receipt, treasury fee delivery,
  and ERC-20 recipient delivery use exact balance deltas. Distribution must
  restore the router's output-token balance to its exact pre-swap baseline.
- Fee-on-transfer, rebasing, partial-spend, identical normalized-token, and
  zero-output flows fail closed.
- Native input is direct-owner only and normalized to the immutable wrapped
  native token. A relayer never supplies value for another owner.
- Exact approvals are cleared after the protocol call and the resulting
  allowance is read back and required to be zero.
- The signed EIP-712 intent binds the chain, router, action type, owner,
  recipient, tokens, amounts, exact adapter configuration, adapter data,
  unordered nonce, time window, optional executor, and maximum fee.
- Known protocol, adapter, wrapped-native and token contract addresses cannot
  be output recipients. Treasury changes use two-step acceptance and known
  system addresses cannot accept that role.
- Deployed ERC-1271 wallets are checked at execution time. ERC-6492
  counterfactual wrappers are explicitly unsupported in this release.

## Release boundary

V2 initially executes exact-input swaps only. `BridgeIntent` is a canonical
future signing type; there is intentionally no executable bridge entrypoint.
Bridge support must ship through a distinct typed adapter whose origin-deposit
and destination-fill semantics are documented and tested.

Before enabling a new adapter on Base Mainnet, run the unit suite on the
supported Node version, add fork tests against each exact target, close the
recorded release review, and exercise the final Timelock/Safe/guardian topology
against a pinned local fork of Base Mainnet. An external audit is a separate
optional process; this release does not deploy to Base Sepolia.
