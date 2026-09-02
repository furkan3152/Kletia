## Summary

Explain the user or operator outcome and the smallest coherent change that delivers it.

## Affected boundaries

- Networks and lanes:
- Core / labs / both:
- API, web, contract, circuit, provider, deployment, or documentation:
- Wallet/passkey/custody impact:

## Trust and failure model

Describe changes to identities, assets, targets, spenders, quotes, simulation, privacy disclosure, durable state, finality, or recovery. State how unavailable and indeterminate results behave.

## Evidence

List commands run and their results. Separate static checks, live readiness, Testnet/Mainnet transactions, and provider completion evidence.

```text
npm run verify:core
```

Public transaction or manifest references, if applicable:

## Screenshots

Required for user-visible changes. Include desktop and mobile states plus loading, error, unavailable, signature, and recovery states when affected.

## Checklist

- [ ] I read `CONTRIBUTING.md` and preserved network/lane ownership.
- [ ] I did not commit secrets, wallet material, personal data, databases, or generated output.
- [ ] Model/provider output cannot select trusted execution identities or fabricate success.
- [ ] Value-moving paths bind the exact account, network, asset, target, spender, amount, deadline, and transaction body.
- [ ] Submitted operations are verified or recovered without silent resubmission.
- [ ] Tests cover the happy path and relevant unavailable, stale, wrong-network, wrong-account, and recovery paths.
- [ ] I updated environment templates, manifests, readiness, and documentation when their contract changed.
- [ ] `npm run verify:core` passes; applicable labs/live results and honest blockers are recorded above.
- [ ] Breaking changes and migrations are explained below.

## Breaking changes and migration

Write “None” or explain operator/user action, compatibility duration, rollback, and deployment order.

## Related issues

Closes #
