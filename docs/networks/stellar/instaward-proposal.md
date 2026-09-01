# Kletia Stellar Payment Center — InstAward Proposal

## One-sentence product

Kletia turns a natural-language payment outcome such as “withdraw my Arc USDC
as TRY to my bank account” into a non-custodial, passkey-authenticated Stellar
payment flow that compares live anchor prices and tracks delivery or refund
evidence across every network boundary.

## The problem

Multichain wallets are good at moving tokens between blockchain addresses, but
the user usually wants a real-world outcome: the user receives local currency
through a bank, mobile-money, instant-payment, or cash rail. Today the user must
manually choose a bridge, find an off-ramp, repeat identity checks, understand
which account controls the transaction, and recover from several independent
failure states.

An AI agent can make this look simpler, but it cannot safely solve the missing
infrastructure by inventing a quote, an anchor, a successful payout, or a
cross-chain guarantee.

## Why Kletia needs Stellar

Stellar is not treated as Kletia's fourth DeFi network or as a decorative hop.
It is the payment interoperability layer where five related capabilities meet:

1. A Soroban contract account controlled by a WebAuthn secp256r1 passkey gives
   the user a seedless, non-custodial payment identity.
2. SEP-1 provides standard provider discovery.
3. SEP-38 provides comparable indicative and firm FX quotes.
4. SEP-45 binds anchor authentication to the same contract-account identity;
   SEP-12 provides remediation when the anchor requires identity fields.
5. SEP-24 provides the direct wallet-to-anchor hosted withdrawal lifecycle.

SEP-31 is valuable only after Kletia integrates as a sending-anchor partner. It
is not interchangeable with a user's SEP-45 session, so it is deliberately
kept out of the direct-wallet MVP.

Base and other EVM networks can provide passkeys and account abstraction, but
they do not provide this complete anchor-interoperability stack. Kletia still
uses Base and Arc where they are strongest: DeFi and programmable-money
execution. Stellar becomes necessary when the intended result leaves a chain
and reaches a real payment rail.

## Product boundary

The Stellar Payment Center is not a universal master wallet and does not own or
derive every EVM account. A Stellar passkey does not silently control Base, Arc,
or Arbitrum funds. Every source-chain approval and CCTP transfer remains a
separate wallet authorization.

Stellar is also not inserted into unrelated DeFi workflows. “Bridge Arc USDC to
Arbitrum Sepolia and supply to Aave” remains an Arc/Arbitrum workflow. “Use Arc
USDC to withdraw TRY to my Turkish bank account” enters the Stellar Payment Center
because the final outcome needs FX, KYC, a payout provider, delivery status, and
refund handling.

## Core user flow

```text
Natural-language outcome
        |
        v
Deterministic payment fields
(source, amount rule, country, currency, rail)
        |
        v
Stellar secp256r1 passkey identity
        |
        v
Allowlisted SEP-1 discovery
        |
        v
Live SEP-38 indicative route comparison
        |
        v
SEP-45 authentication
        |
        v
Firm SEP-38 quote + optional SEP-12 remediation
        |
        v
Optional source-chain CCTP -> Stellar
        |
        v
SEP-24 hosted withdrawal state machine
        |
        +--> completed
        +--> information update required
        +--> pending external rail
        +--> refunded / recovery required
```

The UI shows this as one payment, but it never presents the entire flow as
globally atomic. A submitted transaction is not resent merely because an API
timed out. Kletia recovers the existing transaction and quote identifiers.

## What is implemented now

- The existing Testnet passkey account uses a pinned Smart Account Kit release,
  WebAuthn secp256r1 authorization, a real Stellar C-account deployment, and a
  Testnet relayer. It is non-custodial and explicitly unaudited.
- The new Payment Center replaces the former advanced Stellar dashboard in the
  default product.
- Natural-language payout requests are mapped locally to source network,
  send-exact or receive-exact amount, country, currency, and payout rail.
- The API accepts only operator-reviewed anchor domains, reads SEP-1 without
  redirects, rejects private/IP endpoints, requires SEP-24 and SEP-38, checks
  exact Circle Testnet USDC identity, and requests a live SEP-38 `/price` using
  `context=sep24`.
- The SDF Testanchor is recorded as a reference-only manifest. It simulates the
  off-chain side and is never presented as a real bank-payout provider.
- Routes are ranked by maximum recipient output or minimum required USDC input.
- No configured or compatible provider means `unavailable`; no mock quote is
  created.
- Bank-account and KYC fields are deliberately excluded from the chat request.
- SEP-45 challenge verification binds the exact web-auth contract invocation,
  server signature, client C-account, nonce footprint, network, and returned
  JWT claims. The browser signs only the reviewed client authorization entry.
- Authenticated SEP-38 firm-quote and SEP-24 hosted-withdrawal clients are
  implemented with exact quote, asset, amount, account, endpoint, and expiry
  binding.
- SEP-24 status recovery opens a Stellar transfer only at
  `pending_user_transfer_start`. The passkey account invokes the USDC SAC
  directly; an `id` memo is converted to the exact muxed M destination.
- Submitted transfer evidence is bound to the exact transaction, invocation,
  CAP-67 transfer event, amount, source C-account, destination, and optional
  muxed ID. A recorded hash is recovered rather than resent.
- The UI distinguishes local implementation, reference-anchor observation,
  user-signed Testnet evidence, and completed payout evidence.

## What remains unproven or unimplemented

- Kletia has not completed a user-passkey SEP-45 session and funded withdrawal
  against a reviewed provider that supports the exact required tuple.
- Optional SEP-12 KYC remediation is not connected.
- The authenticated firm-quote and SEP-24 clients are implemented, but the SDF
  Testanchor currently rejects the required SEP-38 `context=sep24` route and is
  reference-only; it therefore cannot supply execution evidence for Kletia.
- No real provider completion, refund, or correctable-information lifecycle has
  been evidenced.
- A bilateral SEP-31 sending-anchor integration is a separate future track.
- Source-chain CCTP into Stellar is not bound to a selected payout transaction.
- No funded end-to-end bank payout has been demonstrated.
- No production audit or mainnet claim is made.

## Milestones

### M1 — Live discovery and indicative routing

- Finalize allowlisted SEP-1 discovery and strict endpoint validation.
- Validate SEP-24 USDC withdrawal support and the exact SEP-38
  country/currency/rail tuple with `context=sep24`.
- Compare live indicative quotes without collecting recipient PII.
- Publish deterministic parser, API boundary, and browser journey tests.

Success evidence: two independently configured live providers or one provider
plus a documented incompatibility result; every response records provider,
time, requested tuple, quote type, and `mockData: false`.

### M2 — Passkey-authenticated anchor session

- Complete the implemented SEP-45 challenge retrieval and exact
  authorization-entry review against a compatible reviewed provider.
- Capture a user-passkey signature from the existing secp256r1 contract
  account.
- Preserve validation of anchor signing key, web-auth contract ID, network
  passphrase, JWT subject, expiry, audience, and client-domain binding.
- Keep SEP-10 only as a Classic-account compatibility path.

Success evidence: a Testnet anchor issues a valid session whose subject is the
same C-address shown in Kletia; tampered challenge, network, domain, and subject
tests fail closed.

### M3 — Firm quote and SEP-24 lifecycle

- Collect only fields requested by the selected anchor; use SEP-12 only when it
  exposes a required remediation step.
- Keep bank data outside chat history, AI prompts, and Kletia logs by using the
  anchor-owned SEP-24 interactive flow.
- Exercise the implemented firm-quote, hosted-withdrawal, polling, exact SAC
  transfer, and duplicate-send recovery paths against a compatible provider.
- Complete interactive transaction-info update handling when exposed by that
  provider.
- Evidence `completed`, `pending_external`, `error`, and `refunded`
  independently.

Success evidence: a funded Testnet lifecycle reaches completion and a separate
recovery drill reaches a verified refund or correctable-information state.

### M4 — Multichain source funding

- Bind Arc Testnet and supported EVM Testnet USDC to the selected payout plan.
- Obtain a fresh Circle CCTP fee/route and bind its source/destination domains.
- Require source approval, burn, attestation, Stellar mint, and anchor payment as
  separate checkpoints.
- Never mix production and Testnet capital lanes.

Success evidence: the exact source burn and Stellar mint are linked to one
firm quote and one SEP-24 withdrawal; timeout recovery never resends funds.

## Security and privacy rules

- AI interprets language; it never selects contract IDs, anchor endpoints,
  quote values, XDR, or success states.
- Anchor domains are operator allowlisted. Discovered endpoints must be HTTPS
  and on an explicitly reviewed host.
- Indicative quotes never authorize settlement.
- A passkey policy signature is not a token approval or bridge signature.
- KYC and bank data go only to the selected anchor after explicit user review.
- Every source-chain and Stellar money movement is separately authorized.
- A transaction hash alone is not payout evidence.
- `indeterminate`, `pending_external`, `refunded`, and `completed` are distinct
  terminal or recovery states.

## Removed from the default product

The former solver auction, policy-control-plane, private-payment research,
generic V3/V4 workflow, MPP, and experimental protocol panels are no longer the
default Stellar story. Their source and deployment evidence remain in the
repository as disabled labs, but they do not appear in ordinary navigation and
are not required to explain the product.

This is intentional product reduction. A bonded auction without independently
running solvers does not improve a user's payment. A policy root does not prove
foreign-chain execution. A shielded Testnet pool does not make a public CCTP
route private. These components can return only if a concrete payment milestone
requires them and they pass a separate product review.

## Objective grant claim

Kletia is building a multichain superapp whose real-world payment exit is made
possible by Stellar's passkey contract accounts and anchor standards. The
current code implements the strict authentication, quote, hosted-withdrawal,
passkey transfer, and recovery boundaries and proves the reference-anchor
compatibility failure honestly; it does not yet prove an end-to-end payout. The
grant work is to close that exact external-integration gap with a reviewed
anchor, funded Testnet evidence, and recovery drills instead of adding more
unrelated features.

## Dependency and kill criteria

The critical external dependency is a reviewed anchor that supports the exact
Circle Testnet USDC, SEP-24, SEP-38 `context=sep24`, and SEP-45 combination. If
no such provider is available, Kletia must not present the flow as executable.
SEP-12 is required only when the provider exposes a KYC remediation path. The
fallback milestone is to deploy the official Stellar Anchor Platform as a
transparent Testnet reference anchor, then replace its simulated business rail
with a real regulated partner before any production claim. A later SEP-31
milestone additionally requires a bilateral sending-anchor agreement.

The feature should be stopped or redesigned if it cannot demonstrate a real
delivery/refund lifecycle, if the passkey identity cannot authenticate with the
selected anchor, or if routing adds Stellar without improving the recipient's
payment outcome.
