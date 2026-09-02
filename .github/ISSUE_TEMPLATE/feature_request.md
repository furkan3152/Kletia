---
name: Feature request
description: Propose a user outcome or protocol integration
title: "[Feature]: "
labels: [enhancement, needs-triage]
assignees: []
---

## User problem

Who needs this, what outcome are they trying to reach, and why is the current flow insufficient?

## Proposed experience

Describe the intent, review, signature, confirmation, and recovery experience. Include a compact example if useful.

## Network ownership

- Network(s) and lane(s):
- Core product or research labs:
- Assets/protocols/providers involved:
- Wallet or passkey authority:

## Trust and failure boundaries

- Which identities and live data must be verified?
- What information is disclosed to API, model, provider, RPC, and ledger?
- What must happen when discovery, quote, simulation, finality, or recovery is unavailable?
- What evidence proves completion beyond a transaction hash?

## Alternatives and scope

What simpler approach was considered? Which adjacent features are explicitly out of scope?

## Acceptance criteria

- [ ] No mock success or silent fallback
- [ ] Wrong network/account/asset is rejected
- [ ] User authorization is explicit
- [ ] Submitted and indeterminate operations recover safely
- [ ] Documentation, readiness, and tests define the honest claim boundary
