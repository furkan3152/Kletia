# Kletia real-data MVP test runbook

This runbook defines the smallest coherent Kletia release that can be tested
without mock quotes, placeholder contracts, fabricated payouts, or silent
transaction retries.

## What is inside the core MVP

- Base Mainnet: live Intent Router V2 and reviewed enabled adapter.
- Arc Testnet: live Kletia swap, lending, staking, Vault V2, memo, batch and
  multichain source execution.
- Arbitrum Sepolia: reviewed Circle Testnet USDC/CCTP identities and Aave supply
  endpoint for the Testnet corridor.
- Stellar Testnet native XLM/USDC execution.
- Stellar secp256r1 passkey C-account, pinned WebAuthn verifier, USDC SAC and
  fee-sponsoring Testnet relayer.
- Stellar Payment Center: allowlisted SEP-1 discovery, SEP-45 authentication,
  SEP-38 indicative/firm quotes, SEP-24 hosted withdrawal and status recovery,
  exact USDC transfer evidence, and durable sessions.
- Durable reviewed Workflow V2 checkpoints for the existing multichain
  executor.

Solver auctions, Policy V2/control-plane, shielded payments, MPP and generic
V3/V4 workflows remain reproducible research labs. They are not default MVP
dependencies and cannot make the Payment Center release pass.

## 1. Static release verification

Use the pinned Node version:

```bash
export PATH=/home/technopc/.nvm/versions/node/v22.23.1/bin:$PATH
npm run verify
```

This verifies source boundaries, adversarial Payment Center behavior, privacy
egress, intent/network binding, builds and Base/Arc contract compilation. It is
not a funded transaction or payout.

## 2. Configure the live Payment Center

The API must have these server-side values:

```text
STELLAR_LAST_MILE_ENABLED=true
STELLAR_ANCHOR_ALLOWLIST=https://reviewed-provider.example
STELLAR_ANCHOR_ENDPOINT_HOST_ALLOWLIST=https://reviewed-api.example
STELLAR_PAYMENT_CENTER_DATABASE_URL=<durable PostgreSQL URL>
PAYMENT_CENTER_SIGNING_SECRET=<at least 32 random characters>
STELLAR_PAYMENT_CENTER_ENCRYPTION_KEY=<at least 32 random characters>
```

The provider must also have an operator-reviewed manifest in
`paymentCenterProviders.ts`, must not be marked `referenceOnly`, and must
support real settlement. Its manifest must define an exact `releaseProbe`
(Testnet source, amount mode, amount, destination country/currency and delivery
method). Runtime readiness repeats that probe against the provider's live
SEP-24 `/info` and SEP-38 `context=sep24` price endpoint; an advertised feature
without a usable live route cannot turn the release green. Discovery must also
expose the exact Testnet network, Circle USDC and SEP-45 contract-account
surface.

`testanchor.stellar.org` is useful for protocol observation only. It currently
rejects Kletia's required SEP-38 `context=sep24` quote and simulates the
off-chain rail, so it must never satisfy the real-provider release gate.

## 3. Live no-mock preflight

```bash
export PATH=/home/technopc/.nvm/versions/node/v22.23.1/bin:$PATH
npm run verify:mvp-live
```

The same report is available while the API is running at:

```text
GET /api/release/mvp-readiness
```

The command and endpoint require live Base, Arc, Arbitrum Sepolia, Stellar,
passkey, durable-storage and Payment Center provider checks. HTTP 503 or a
non-zero command exit is the correct result while any required surface is
missing. Old Stellar labs do not influence this report.

## 4. Run locally

Use two terminals:

```bash
npm run dev:mvp:api
```

```bash
npm run dev:mvp:web
```

The browser needs a secure WebAuthn context (`localhost` or HTTPS). No operator
private key is injected; every passkey, EVM approval and money movement remains
user-authorized.

## 5. User-signed Payment Center smoke

Use a small Testnet amount and a reviewed provider.

1. Create or restore the Stellar passkey C-account and verify its displayed
   contract ID.
2. Ask for a supported local payout outcome, then verify country, currency,
   delivery method, exact amount mode and provider.
3. Compare live indicative quotes. An indicative quote must not enable payment.
4. Approve the exact SEP-45 challenge with the same passkey account.
5. Reserve the authenticated SEP-38 firm quote and complete the anchor-owned
   SEP-24 page. Bank/KYC data must not enter chat or Kletia logs.
6. Wait until the anchor reports `pending_user_transfer_start`. Earlier states
   must not prepare a Stellar transfer.
7. Review the exact Circle USDC SAC, amount and G/M destination, then approve
   the transfer with the passkey.
8. Confirm the exact transaction invocation and CAP-67 transfer event. A page
   refresh or timeout must recover the recorded hash, never send again.
9. Wait for provider `completed` evidence. A Stellar transaction hash alone is
   not a local-rail payout.
10. Run a separate refund or correctable-information drill and retain both
    provider and chain evidence.

For an Arc-funded payout, first complete the separately signed and evidenced
CCTP source checkpoints. The bridge, Stellar payment and anchor delivery are
not globally atomic.

## 6. Other funded smoke requirements

Base x402 still requires a real, deliberately small EIP-3009 payment. Success
requires both the exact `AuthorizationUsed` nonce and expected USDC `Transfer`;
an indeterminate result is recovered rather than retried.

## Honest completion boundary

A green static verification proves the code boundary. A green live preflight
proves configured dependencies are reachable and identity-bound. Only the
user-signed Testnet evidence above proves the payment lifecycle, and only a
real regulated provider can prove a real-world payout. None of these states is
a production audit or mainnet safety claim.
