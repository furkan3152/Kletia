# Stellar Payment Center Architecture

## Product rule

Stellar is used when Kletia must turn an onchain asset into a verified payment
outcome. It is not inserted into a route merely because the intent is
multichain.

| Intent outcome | Owning workspace |
| --- | --- |
| Swap, lend, borrow, stake, or bridge between DeFi networks | Source EVM workspace |
| Send XLM/USDC or swap XLM/USDC | Stellar native tools |
| Deliver fiat through bank, cash, mobile, or instant-payment rail | Stellar Payment Center |

## One connected system

1. `intentWorkspace.ts` extracts only payment semantics: source network,
   amount rule, country, currency, and rail.
2. `PasskeyAccountCard.tsx` creates or restores the user's Stellar contract
   account controlled by WebAuthn secp256r1.
3. `lastMile.ts` in the API discovers only allowlisted anchors and verifies
   their SEP-1 endpoints.
4. SEP-24 `/info` must enable withdrawal of Circle Testnet USDC within the
   provider's exact amount bounds.
5. SEP-38 `/info` must advertise the requested country, currency, and rail.
6. SEP-38 `/price` must accept `context=sep24` and supplies the live indicative
   result. Kletia ranks only responses that pass every identity and schema gate.
7. The execution module binds SEP-45 authentication, an authenticated firm
   quote, SEP-24 hosted withdrawal state, exact transfer readiness, and
   transaction recovery. Optional SEP-12 remediation and CCTP source funding
   remain separate capability-gated stages.
8. SEP-31 remains a separate partner-only adapter. It cannot be enabled without
   a sending-anchor identity and bilateral receiving-anchor agreement.

## Trust boundaries

```text
Browser
  owns: passkey, wallet approvals, payment intent, local private fields
  sends: non-PII quote tuple

Kletia API
  owns: allowlist, schema validation, live route comparison, checkpoints
  never owns: passkey private key, wallet private key, bank data

Anchor
  owns: KYC collection, firm quote, local payout, refund state

Public networks
  prove: source approval/burn, Stellar mint/payment, contract authorization
```

## Current capability states

| Capability | Current status |
| --- | --- |
| secp256r1 passkey C-account | Testnet implementation, unaudited |
| SEP-1 discovery | Implemented, allowlist-only |
| SEP-24 and SEP-38 compatibility check | Implemented |
| Live indicative SEP-38 price | Implemented when a compatible anchor is configured |
| Reviewed Testanchor reference manifest | Implemented; simulated delivery only |
| SEP-45 anchor authentication | Implemented and adversarially checked locally; user C-account live proof still required |
| SEP-12 KYC remediation | Planned when required by the anchor |
| Firm SEP-38 quote | Implemented for a compatible authenticated provider; no compatible reviewed provider currently configured |
| SEP-24 hosted withdrawal/status recovery | Implemented locally; funded lifecycle not yet evidenced |
| Exact passkey C-account USDC transfer | Implemented for G destination and SEP-24 `id` memo converted to M; user-signed live proof still required |
| SEP-24 completion/refund evidence | Status validation implemented; real provider lifecycle not yet evidenced |
| SEP-31 bilateral partner lifecycle | Separate future workstream |
| CCTP source funding bound to payout | Planned |
| Funded end-to-end payout | Not yet evidenced |

## Failure rules

- No allowlisted anchor: unavailable.
- Anchor endpoint leaves the reviewed host list: rejected.
- Missing SEP-24 or SEP-38: provider excluded.
- SEP-38 rejects `context=sep24`: provider excluded; no cross-context quote substitution.
- Wrong USDC issuer: provider excluded.
- Unsupported country/currency/rail: provider excluded.
- Indicative quote: display only; no settlement button.
- Firm quote or hosted withdrawal without a compatible authenticated provider:
  unavailable; no synthetic quote or transaction is created.
- Anchor has not reached `pending_user_transfer_start`: no Stellar transfer is
  prepared.
- Unsupported SEP-24 memo type or mismatched amount/account/quote: transfer is
  blocked rather than downgraded.
- Submitted financial checkpoint: recover by its existing identifier; never
  silently resend.
- `pending_external`, `information_update_required`, `refunded`, and
  `completed` must remain distinct.

## Legacy labs

Solver auctions, policy-control-plane contracts, private-payment research, MPP,
and V3/V4 generic workflows remain in the repository but are not imported by
the default Payment Center and are disabled in runtime examples. They may be
removed in a later dedicated cleanup after their deployment evidence is
archived and no current release script imports them.
