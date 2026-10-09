# Kletia Platform API errors

Every failed request returns the same envelope and a stable code:

```json
{
  "error": {
    "code": "INTENT_UNSUPPORTED",
    "message": "…",
    "issues": [{ "path": "text", "message": "…" }],
    "hints": ["swap 1 SOL to USDC", "…"],
    "docs": "https://kletiaai.xyz/developers#error-INTENT_UNSUPPORTED"
  },
  "requestId": "0f3c7e1a-2b4d-4c6e-8f90-a1b2c3d4e5f6"
}
```

- `code` is `UPPER_SNAKE_CASE` and never changes meaning. Branch on it, not on
  `message`.
- `issues` lists the offending fields (`path` is a JSON path into the request).
- `hints` appears on `INTENT_UNSUPPORTED`: phrases the grammar understands.
- `docs` links to the code's entry below (the host follows
  `KLETIA_WEB_ORIGIN` on self-hosted deployments).
- Every response carries `X-Request-Id`; quote it when reporting a problem.

The same catalog is machine-readable at `GET /v1/errors` and exported by
`@kletia/core` as `ERROR_CATALOG` (with `describeError`, `resolveErrorCode`,
`isRetryableError` and `errorDocsUrl`).

## Retrying

A code marked **retry: yes** can succeed if the *same* request is sent again
later: wait for `Retry-After` when present, otherwise back off exponentially.
Everything else needs a different request. For POSTs that create or change
state, send an `Idempotency-Key` (with an API key) so a retry can never run
twice; see [api-v1.md](api-v1.md#idempotency).

Provider failures carry the provider in the code: `RELAY_UNAVAILABLE`,
`JUPITER_REJECTED`, `LI_FI_UNAVAILABLE`, … Any `<PROVIDER>_UNAVAILABLE` code
means `PROVIDER_UNAVAILABLE` and any `<PROVIDER>_REJECTED` code means
`PROVIDER_REJECTED`.

## Step failures

Codes with status **step** never come back as an HTTP error. They appear as
`step.failure.code` on an intent (in `GET /v1/intents/{id}`, SSE and webhook
events) when a submitted transaction fails, never lands, or settles
differently from its quote. The reference rejections
(`REFERENCE_MISMATCH`, `REFERENCE_WRONG_SENDER`, `REFERENCE_WRONG_CHAIN`,
`REFERENCE_STALE`, `REFERENCE_ALREADY_USED`) are returned as `422` by submit
and leave the step unchanged.

## Catalog

### Request

| Code | Status | Retry | Meaning | What to do |
|---|---|---|---|---|
| <a id="error-ACCOUNT_INVALID"></a>`ACCOUNT_INVALID` | 400 / 500 | no | Invalid account | Send accounts as CAIP-10 ids such as eip155:8453:0x… or solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:<address>. |
| <a id="error-AMOUNT_REQUIRED"></a>`AMOUNT_REQUIRED` | 400 | no | Amount required | Give every action an amount (a decimal, or max on a dependent step). |
| <a id="error-IDEMPOTENCY_KEY_INVALID"></a>`IDEMPOTENCY_KEY_INVALID` | 400 | no | Invalid Idempotency-Key | Use 1-128 characters from A-Z a-z 0-9 _ . : - (optionally as a quoted string), for example a UUID. |
| <a id="error-IDEMPOTENCY_KEY_REQUIRES_API_KEY"></a>`IDEMPOTENCY_KEY_REQUIRES_API_KEY` | 400 | no | Idempotency-Key needs an API key | Send the request with an API key, or drop the Idempotency-Key header on the public tier. |
| <a id="error-IDEMPOTENCY_NOT_SUPPORTED"></a>`IDEMPOTENCY_NOT_SUPPORTED` | 400 | no | Idempotency-Key not supported here | Drop the Idempotency-Key header on this endpoint; prepare re-quotes on every call. |
| <a id="error-INVALID_JSON"></a>`INVALID_JSON` | 400 | no | Malformed JSON | Send a JSON object or array as the request body. |
| <a id="error-INVALID_REQUEST"></a>`INVALID_REQUEST` | 400 | no | Invalid request | Fix the fields listed in error.issues and send the request again. |
| <a id="error-INVALID_REQUEST_BODY"></a>`INVALID_REQUEST_BODY` | 400 | no | Unreadable request body | Send a complete UTF-8 JSON body with a correct Content-Length. |
| <a id="error-METHOD_NOT_ALLOWED"></a>`METHOD_NOT_ALLOWED` | 405 | no | Method not allowed | Use one of the methods listed in the Allow header. |
| <a id="error-PAYLOAD_TOO_LARGE"></a>`PAYLOAD_TOO_LARGE` | 413 | no | Request body too large | Keep request bodies under 64 KB. |
| <a id="error-REFERENCES_INVALID"></a>`REFERENCES_INVALID` | 400 | no | Invalid references | Send { "references": [...] } with one transaction hash or signature per prepared transaction. |
| <a id="error-REFERENCE_COUNT_MISMATCH"></a>`REFERENCE_COUNT_MISMATCH` | 400 | no | Wrong number of references | Submit exactly one reference per prepared transaction, in order. |
| <a id="error-REFERENCE_INVALID"></a>`REFERENCE_INVALID` | 400 | no | Invalid reference | Send a 0x-prefixed 32-byte hash for EVM steps or a base58 signature for Solana steps. |
| <a id="error-SOLANA_ADDRESS_INVALID"></a>`SOLANA_ADDRESS_INVALID` | 400 | no | Invalid Solana address | Use a base58 Solana address. |
| <a id="error-SOLANA_AMOUNT_INVALID"></a>`SOLANA_AMOUNT_INVALID` | 400 | no | Invalid Solana amount | Use a positive amount within the token's precision. |
| <a id="error-SOLANA_MINT_INVALID"></a>`SOLANA_MINT_INVALID` | 400 / 422 | no | Invalid SPL mint | Use the mint address of an SPL token on this network. |
| <a id="error-SOLANA_SELF_TRANSFER"></a>`SOLANA_SELF_TRANSFER` | 400 | no | Transfer to self | Send to a different account. |
| <a id="error-SOLANA_SIGNATURE_INVALID"></a>`SOLANA_SIGNATURE_INVALID` | 400 | no | Invalid Solana signature | Submit the base58 signature of the sent transaction. |
| <a id="error-SOLANA_SLIPPAGE_OUT_OF_RANGE"></a>`SOLANA_SLIPPAGE_OUT_OF_RANGE` | 400 | no | Slippage out of range | Use a slippage between 1 and 1000 basis points. |
| <a id="error-SOLANA_SWAP_SAME_TOKEN"></a>`SOLANA_SWAP_SAME_TOKEN` | 400 | no | Swap to the same token | Choose different input and output tokens. |
| <a id="error-UNSUPPORTED_MEDIA_TYPE"></a>`UNSUPPORTED_MEDIA_TYPE` | 415 | no | Unsupported media type | Send request bodies as UTF-8 application/json. |

### Authentication

| Code | Status | Retry | Meaning | What to do |
|---|---|---|---|---|
| <a id="error-API_KEY_REQUIRED"></a>`API_KEY_REQUIRED` | 401 | no | API key required | Issue a key with POST /v1/keys and send it as Authorization: Bearer <key>. |
| <a id="error-INVALID_API_KEY"></a>`INVALID_API_KEY` | 401 | no | Invalid or revoked API key | Check the key, or issue a new one. Revoked and expired rotated keys stop working within 15 seconds. |
| <a id="error-INVALID_AUTHORIZATION"></a>`INVALID_AUTHORIZATION` | 401 | no | Malformed credentials | Send Authorization: Bearer <key> or X-Kletia-Key: <key>, not both with different keys. |

### Permission

| Code | Status | Retry | Meaning | What to do |
|---|---|---|---|---|
| <a id="error-KEY_SECRET_ROTATED"></a>`KEY_SECRET_ROTATED` | 403 | no | Rotated key secret | This secret still authenticates during its grace window but cannot manage keys. Use the current secret. |
| <a id="error-MCP_ORIGIN_FORBIDDEN"></a>`MCP_ORIGIN_FORBIDDEN` | 403 | no | Origin not allowed for MCP | Call /v1/mcp without an Origin header (server-side agents) or from an allowed HTTPS origin. |

### Not found

| Code | Status | Retry | Meaning | What to do |
|---|---|---|---|---|
| <a id="error-INTENT_NOT_FOUND"></a>`INTENT_NOT_FOUND` | 404 | no | Intent not found | Check the intent id. Dry runs are never stored. |
| <a id="error-KEY_NOT_FOUND"></a>`KEY_NOT_FOUND` | 404 | no | API key not found | List your project's keys with GET /v1/keys; only active keys of your own project can be managed. |
| <a id="error-NOT_FOUND"></a>`NOT_FOUND` | 404 | no | Unknown route | Check the path against GET /v1/openapi.json. |
| <a id="error-STEP_NOT_FOUND"></a>`STEP_NOT_FOUND` | 404 | no | Step not found | Use a step id from intent.steps (s1, s2, ...). |
| <a id="error-WEBHOOK_NOT_FOUND"></a>`WEBHOOK_NOT_FOUND` | 404 | no | Webhook not found | List your webhooks with GET /v1/webhooks; each key sees only its own. |

### Conflict

| Code | Status | Retry | Meaning | What to do |
|---|---|---|---|---|
| <a id="error-CLIENT_REFERENCE_EXISTS"></a>`CLIENT_REFERENCE_EXISTS` | 409 | no | clientReference already used | Use a new clientReference, or read the existing intent. |
| <a id="error-IDEMPOTENCY_REQUEST_IN_PROGRESS"></a>`IDEMPOTENCY_REQUEST_IN_PROGRESS` | 409 | yes | Request with this key in progress | The first request with this Idempotency-Key is still running. Retry after Retry-After seconds. |
| <a id="error-INTENT_CANCELLED"></a>`INTENT_CANCELLED` | 409 | no | Intent cancelled | Create a new intent. |
| <a id="error-INTENT_COMPLETED"></a>`INTENT_COMPLETED` | 409 | no | Intent completed | Nothing is left to execute. |
| <a id="error-INTENT_CONFLICT"></a>`INTENT_CONFLICT` | 409 | yes | Concurrent update | The intent changed while the request ran. Read it again and retry. |
| <a id="error-INTENT_EXISTS"></a>`INTENT_EXISTS` | 409 | yes | Intent id collision | Send the request again. |
| <a id="error-INTENT_NOT_CANCELLABLE"></a>`INTENT_NOT_CANCELLABLE` | 409 | no | Intent cannot be cancelled | A step was already submitted; follow it to settlement instead. |
| <a id="error-KEY_COLLISION"></a>`KEY_COLLISION` | 409 | yes | Key generation collided | Send the request again. |
| <a id="error-KEY_LIMIT_REACHED"></a>`KEY_LIMIT_REACHED` | 409 | no | Too many active keys | A project holds at most 5 active keys. Revoke one with DELETE /v1/keys/{id} first. |
| <a id="error-KEY_NOT_MANAGEABLE"></a>`KEY_NOT_MANAGEABLE` | 409 | no | Operator keys are immutable | Operator keys come from server configuration; change KLETIA_OPERATOR_API_KEYS instead. |
| <a id="error-QUOTE_MOVED"></a>`QUOTE_MOVED` | 409 | no | Price moved | The price moved beyond the slippage limit since planning. Create a new intent to re-quote. |
| <a id="error-RECIPIENT_NAME_CHANGED"></a>`RECIPIENT_NAME_CHANGED` | 409 | no | Recipient name changed | The recipient's name now resolves to another address. Create a new intent to pay the new address. |
| <a id="error-STEP_NOT_AWAITING_SIGNATURE"></a>`STEP_NOT_AWAITING_SIGNATURE` | 409 | no | Step not awaiting a signature | Prepare the step before submitting references. |
| <a id="error-STEP_NOT_PREPARABLE"></a>`STEP_NOT_PREPARABLE` | 409 | no | Step cannot be prepared | Only ready or awaiting_signature steps can be prepared. |
| <a id="error-STEP_NOT_READY"></a>`STEP_NOT_READY` | 409 | yes | Step not ready | Wait until the steps it depends on have settled, then prepare it. |
| <a id="error-STEP_TRANSITION_INVALID"></a>`STEP_TRANSITION_INVALID` | 409 | no | Invalid step transition | Read the intent again; the step already moved on. |
| <a id="error-WEBHOOK_EXISTS"></a>`WEBHOOK_EXISTS` | 409 | no | Webhook already registered | A webhook with this URL already exists for this key. |
| <a id="error-WEBHOOK_LIMIT_REACHED"></a>`WEBHOOK_LIMIT_REACHED` | 409 | no | Too many webhooks | A key can register at most 10 webhooks. Delete one first. |

### Expired

| Code | Status | Retry | Meaning | What to do |
|---|---|---|---|---|
| <a id="error-DEADLINE_PASSED"></a>`DEADLINE_PASSED` | 410 / 422 | no | Deadline passed | constraints.deadline is in the past. Plan again with a later deadline. |
| <a id="error-INTENT_EXPIRED"></a>`INTENT_EXPIRED` | 410 | no | Intent expired | The plan expired before execution started. Create a new intent to re-quote. |

### Intent (understood but not executable)

| Code | Status | Retry | Meaning | What to do |
|---|---|---|---|---|
| <a id="error-ACCOUNT_AMBIGUOUS"></a>`ACCOUNT_AMBIGUOUS` | 422 | no | Ambiguous account | Several accounts of this kind were given; add the one to use on this network. |
| <a id="error-ACCOUNT_REQUIRED"></a>`ACCOUNT_REQUIRED` | 422 | no | Account missing | Add a CAIP-10 account for every network the intent touches. |
| <a id="error-AMOUNT_INVALID"></a>`AMOUNT_INVALID` | 422 | no | Invalid amount | Use a positive decimal within the asset's precision, or max on a dependent step. |
| <a id="error-AMOUNT_TOO_SMALL"></a>`AMOUNT_TOO_SMALL` | 422 | no | Amount too small | Increase the amount; it rounds to zero or is below the venue minimum. |
| <a id="error-ASSET_INVALID"></a>`ASSET_INVALID` | 422 / 500 | no | Invalid asset | Use a symbol, an address or mint, or a CAIP-19 id. |
| <a id="error-ASSET_MISMATCH"></a>`ASSET_MISMATCH` | 422 | no | Asset mismatch | A dependent step must spend the asset the previous step produces. |
| <a id="error-ASSET_NETWORK_MISMATCH"></a>`ASSET_NETWORK_MISMATCH` | 422 | no | Asset on another network | Use an asset that lives on the step's network, or bridge first. |
| <a id="error-ASSET_REQUIRED"></a>`ASSET_REQUIRED` | 422 | no | Asset required | Name the input and output assets. |
| <a id="error-CAPITAL_LANE_MIXED"></a>`CAPITAL_LANE_MIXED` | 422 | no | Mainnet and testnet mixed | Keep every network of one intent on mainnet, or every one on testnet. |
| <a id="error-FEE_LIMIT_EXCEEDED"></a>`FEE_LIMIT_EXCEEDED` | 422 | no | Fees above the limit | Raise constraints.maxFeeUsd or move a larger amount. |
| <a id="error-IDEMPOTENCY_KEY_REUSED"></a>`IDEMPOTENCY_KEY_REUSED` | 422 | no | Idempotency-Key reused | This key was used for a different request. Use a new key for a new request. |
| <a id="error-INSUFFICIENT_BALANCE"></a>`INSUFFICIENT_BALANCE` | 422 | no | Insufficient balance | Fund the account or lower the amount. |
| <a id="error-INTENT_UNSUPPORTED"></a>`INTENT_UNSUPPORTED` | 422 | no | Intent not supported | Rephrase using one of the examples in error.hints, or send structured actions. |
| <a id="error-JUPITER_SIMULATION_FAILED"></a>`JUPITER_SIMULATION_FAILED` | 422 | no | Swap simulation failed | The swap would fail on-chain. Check the balance or try a smaller amount. |
| <a id="error-NETWORK_UNSUPPORTED"></a>`NETWORK_UNSUPPORTED` | 422 / 500 | no | Network not supported | Use a network from GET /v1/networks that supports this action. |
| <a id="error-PLAN_INVALID"></a>`PLAN_INVALID` | 422 / 502 | no | Plan invalid | Simplify the intent; at most 8 steps are planned. |
| <a id="error-POSITION_EMPTY"></a>`POSITION_EMPTY` | 422 | no | No position to withdraw | There is nothing deposited at this venue for the account. |
| <a id="error-PRICE_IMPACT_TOO_HIGH"></a>`PRICE_IMPACT_TOO_HIGH` | 422 | no | Price impact too high | Move a smaller amount; routes that cost more than 5% are refused. |
| <a id="error-RECIPIENT_INVALID"></a>`RECIPIENT_INVALID` | 422 | no | Invalid recipient | Use an address or CAIP-10 account on the destination network. |
| <a id="error-RECIPIENT_NAME_UNRESOLVED"></a>`RECIPIENT_NAME_UNRESOLVED` | 422 | no | Name does not resolve | The name has no address for this network. Use the recipient's address. |
| <a id="error-RECIPIENT_NAME_UNSUPPORTED"></a>`RECIPIENT_NAME_UNSUPPORTED` | 422 | no | Name not supported | This deployment cannot resolve this kind of name on this network. Use the recipient's address. |
| <a id="error-RECIPIENT_NETWORK_MISMATCH"></a>`RECIPIENT_NETWORK_MISMATCH` | 422 | no | Recipient on another network | Use a bridge to move funds across networks. |
| <a id="error-RECIPIENT_REQUIRED"></a>`RECIPIENT_REQUIRED` | 422 | no | Recipient required | Name the recipient of the transfer. |
| <a id="error-RELAY_SIGNATURE_STEP_UNSUPPORTED"></a>`RELAY_SIGNATURE_STEP_UNSUPPORTED` | 422 | no | Off-chain signature step | This route needs an off-chain signature, which Kletia does not execute. Try another amount or route. |
| <a id="error-RESERVE_UNAVAILABLE"></a>`RESERVE_UNAVAILABLE` | 422 | no | Lending reserve unavailable | The market is paused, frozen or capped for this asset. Try another asset or venue. |
| <a id="error-ROUTE_TOO_SLOW"></a>`ROUTE_TOO_SLOW` | 422 | no | No route fast enough | Every venue settles slower than constraints.maxSeconds. Raise it or drop the constraint. |
| <a id="error-ROUTE_UNAVAILABLE"></a>`ROUTE_UNAVAILABLE` | 422 | no | No route | The venue could not route this request now. Try another amount or asset. |
| <a id="error-ROUTE_UNPRICED"></a>`ROUTE_UNPRICED` | 422 | no | Route costs not priceable | No venue quoted costs Kletia can price for this route. Try another amount or asset. |
| <a id="error-ROUTE_UNSUPPORTED"></a>`ROUTE_UNSUPPORTED` | 422 | no | Route not supported | No venue routes this pair between these networks; see GET /v1/networks. |
| <a id="error-SELF_TRANSFER"></a>`SELF_TRANSFER` | 422 | no | Transfer to self | Send to a different account. |
| <a id="error-SIMULATION_FAILED"></a>`SIMULATION_FAILED` | 422 | no | Simulation failed | The transaction would fail on-chain. Check the sending account's balance. |
| <a id="error-SOLANA_MINT_DECIMALS_MISMATCH"></a>`SOLANA_MINT_DECIMALS_MISMATCH` | 422 | no | Mint decimals changed | Plan the intent again. |
| <a id="error-SOLANA_MINT_NOT_FOUND"></a>`SOLANA_MINT_NOT_FOUND` | 422 | no | Mint not found | Use a mint that exists on this network. |
| <a id="error-SOLANA_PRICE_IMPACT_TOO_HIGH"></a>`SOLANA_PRICE_IMPACT_TOO_HIGH` | 422 | no | Price impact too high | Move a smaller amount; routes above 5% price impact are refused. |
| <a id="error-SOLANA_RECIPIENT_NOT_WALLET"></a>`SOLANA_RECIPIENT_NOT_WALLET` | 422 | no | Recipient is not a wallet | Send to a wallet address, not a program or token account. |
| <a id="error-SOLANA_TOKEN_UNKNOWN"></a>`SOLANA_TOKEN_UNKNOWN` | 422 | no | Unknown Solana token | Use a listed symbol or the token's mint address. |
| <a id="error-SWAP_SAME_ASSET"></a>`SWAP_SAME_ASSET` | 422 | no | Swap to the same asset | Choose different input and output assets. |
| <a id="error-TESTNET_NOT_ALLOWED"></a>`TESTNET_NOT_ALLOWED` | 422 | no | Testnets not allowed | Set constraints.allowTestnets to true to plan on testnets. |
| <a id="error-TOKEN_TRANSFER_FEE_UNSUPPORTED"></a>`TOKEN_TRANSFER_FEE_UNSUPPORTED` | 422 | no | Transfer-fee token | Token-2022 mints with transfer fees are not supported. |
| <a id="error-TOKEN_UNKNOWN"></a>`TOKEN_UNKNOWN` | 422 | no | Unknown token | Use a listed symbol (GET /v1/assets) or the token's address or mint. |
| <a id="error-TOKEN_UNVERIFIED"></a>`TOKEN_UNVERIFIED` | 422 | no | Unverified token | Use the token's mint address to proceed deliberately. |
| <a id="error-VENUE_ASSET_MISMATCH"></a>`VENUE_ASSET_MISMATCH` | 422 | no | Venue holds another asset | Choose a venue for the asset you are moving. |
| <a id="error-VENUE_BORROW_OPEN"></a>`VENUE_BORROW_OPEN` | 422 | no | Open borrow on this market | A supply would repay the account's borrow instead of earning. Repay it first or choose another venue. |
| <a id="error-VENUE_ILLIQUID"></a>`VENUE_ILLIQUID` | 422 | no | Venue lacks exit liquidity | Borrowers hold the venue's funds right now. Withdraw less, use another venue, or retry later. |
| <a id="error-VENUE_UNKNOWN"></a>`VENUE_UNKNOWN` | 422 | no | Unknown venue | Use a venue listed for this network and protocol (see error.message for known ones). |
| <a id="error-VENUE_UNSUPPORTED"></a>`VENUE_UNSUPPORTED` | 422 | no | Venue not executable | The venue is listed for discovery only. Choose an executable venue. |
| <a id="error-VENUE_UNVERIFIED"></a>`VENUE_UNVERIFIED` | 422 | no | Venue failed verification | The venue's on-chain state no longer matches Kletia's pinned registry (factory, asset, comptroller, gates). Choose another venue. |
| <a id="error-WEBHOOK_URL_FORBIDDEN"></a>`WEBHOOK_URL_FORBIDDEN` | 422 | no | Webhook URL refused | Use a public HTTPS endpoint on port 443 or 8443; private, loopback and metadata hosts are refused. |
| <a id="error-WEBHOOK_URL_UNRESOLVABLE"></a>`WEBHOOK_URL_UNRESOLVABLE` | 422 | no | Webhook host does not resolve | Use a host name with public DNS records. |

### Verification (submitted references and step failures)

| Code | Status | Retry | Meaning | What to do |
|---|---|---|---|---|
| <a id="error-OUTCOME_NOT_PROVEN"></a>`OUTCOME_NOT_PROVEN` | step | no | Outcome not proven | The transactions landed, but their on-chain effect does not match the plan. Inspect them; contact support with the intent id. |
| <a id="error-REFERENCE_ALREADY_USED"></a>`REFERENCE_ALREADY_USED` | 422 · step | no | Transaction already used | This transaction already completed another step. Submit the hashes or signatures of the transactions prepared for this step, sent by the step account. |
| <a id="error-REFERENCE_MISMATCH"></a>`REFERENCE_MISMATCH` | 422 · step | no | Not the prepared transaction | The transaction does not match the payload prepared for this step. Submit the hashes or signatures of the transactions prepared for this step, sent by the step account. |
| <a id="error-REFERENCE_STALE"></a>`REFERENCE_STALE` | 422 · step | no | Transaction predates the payload | The transaction landed before this step was prepared. Submit the hashes or signatures of the transactions prepared for this step, sent by the step account. |
| <a id="error-REFERENCE_WRONG_CHAIN"></a>`REFERENCE_WRONG_CHAIN` | 422 · step | no | Transaction on another chain | Send the prepared transaction on the step's network. |
| <a id="error-REFERENCE_WRONG_SENDER"></a>`REFERENCE_WRONG_SENDER` | 422 · step | no | Transaction from another account | The step account must send (or fee-pay) the prepared transaction. |
| <a id="error-STEP_NOT_PREPARED"></a>`STEP_NOT_PREPARED` | step | no | Step not prepared | Prepare the step, sign the payload, then submit. |
| <a id="error-SUPPLY_REPAID_DEBT"></a>`SUPPLY_REPAID_DEBT` | step | no | Supply repaid a borrow | The deposit repaid an open Compound borrow instead of opening a supply position. Inspect the account's position. |
| <a id="error-TRANSACTION_EXPIRED"></a>`TRANSACTION_EXPIRED` | step | no | Transaction expired | The transaction never landed before its blockhash expired. Prepare the step again. |
| <a id="error-TRANSACTION_FAILED"></a>`TRANSACTION_FAILED` | step | no | Transaction failed | The transaction landed but failed on-chain. Inspect it in the explorer; prepare again if appropriate. |
| <a id="error-TRANSACTION_REVERTED"></a>`TRANSACTION_REVERTED` | step | no | Transaction reverted | The transaction reverted on-chain. Inspect it in the explorer; prepare again if appropriate. |
| <a id="error-VENUE_REJECTED"></a>`VENUE_REJECTED` | step | no | Venue rejected the operation | The transaction succeeded but the venue returned an error code instead of acting. Funds stayed in the account; plan again. |

### Settlement (step failures)

| Code | Status | Retry | Meaning | What to do |
|---|---|---|---|---|
| <a id="error-SETTLEMENT_FAILED"></a>`SETTLEMENT_FAILED` | step | no | Settlement failed | The cross-network fill failed. Check the source transaction for a refund. |
| <a id="error-SETTLEMENT_MISMATCH"></a>`SETTLEMENT_MISMATCH` | step | no | Fill does not match the quote | The destination fill differs from the quoted route. Contact support with the intent id. |
| <a id="error-SETTLEMENT_REFUNDED"></a>`SETTLEMENT_REFUNDED` | step | no | Settlement refunded | The bridge refunded the deposit on the source network. Plan a new intent. |

### Rate limits

| Code | Status | Retry | Meaning | What to do |
|---|---|---|---|---|
| <a id="error-RATE_LIMITED"></a>`RATE_LIMITED` | 429 | yes | Rate limited | Wait for Retry-After seconds. Use an API key for higher limits. |
| <a id="error-TOO_MANY_STREAMS"></a>`TOO_MANY_STREAMS` | 429 | yes | Too many event streams | Close an open event stream; at most 10 per key and per IP. |

### Upstream providers and networks

| Code | Status | Retry | Meaning | What to do |
|---|---|---|---|---|
| <a id="error-JUPITER_QUOTE_INVALID"></a>`JUPITER_QUOTE_INVALID` | 502 | yes | Jupiter quote refused | Retry shortly. |
| <a id="error-JUPITER_QUOTE_MISMATCH"></a>`JUPITER_QUOTE_MISMATCH` | 502 | yes | Jupiter quote mismatch | Jupiter returned a quote for another request. Retry shortly. |
| <a id="error-JUPITER_SWAP_INVALID"></a>`JUPITER_SWAP_INVALID` | 502 | yes | Jupiter swap refused | Retry shortly. |
| <a id="error-PAYLOAD_INVALID"></a>`PAYLOAD_INVALID` | 502 | yes | Prepared payload refused | The prepared transactions failed Kletia's safety checks and were not returned. Retry shortly. |
| <a id="error-PROVIDER_INVALID_JSON"></a>`PROVIDER_INVALID_JSON` | 502 | yes | Invalid provider response | Retry shortly. |
| <a id="error-PROVIDER_REJECTED"></a>`PROVIDER_REJECTED` | 422 / 502 | no | Provider rejected the request | The provider refused this request (422) or failed (502). Also returned as <PROVIDER>_REJECTED, e.g. JUPITER_REJECTED. |
| <a id="error-PROVIDER_RESPONSE_TOO_LARGE"></a>`PROVIDER_RESPONSE_TOO_LARGE` | 502 | yes | Provider response too large | Retry shortly. |
| <a id="error-PROVIDER_TRANSACTION_INVALID"></a>`PROVIDER_TRANSACTION_INVALID` | 502 | no | Provider transaction refused | The provider's transaction failed Kletia's safety checks and was not returned. Retry, or try another route. |
| <a id="error-PROVIDER_TRANSACTION_REJECTED"></a>`PROVIDER_TRANSACTION_REJECTED` | 502 | yes | Provider transaction rejected | The provider's transaction failed simulation or safety checks. Retry shortly or move a different amount. |
| <a id="error-PROVIDER_UNAVAILABLE"></a>`PROVIDER_UNAVAILABLE` | 502 | yes | Provider unavailable | A routing or data provider is temporarily unavailable. Retry shortly. Also returned as <PROVIDER>_UNAVAILABLE, e.g. RELAY_UNAVAILABLE. |
| <a id="error-RELAY_QUOTE_INVALID"></a>`RELAY_QUOTE_INVALID` | 502 | yes | Relay quote refused | Relay returned a quote that failed Kletia's checks. Retry shortly. |
| <a id="error-RPC_TIMEOUT"></a>`RPC_TIMEOUT` | 504 | yes | Network read timed out | Retry shortly. |
| <a id="error-RPC_UNAVAILABLE"></a>`RPC_UNAVAILABLE` | 502 | yes | Network read failed | A network RPC is temporarily unavailable. Retry shortly. |
| <a id="error-SOLANA_FOREIGN_SIGNER"></a>`SOLANA_FOREIGN_SIGNER` | 502 | no | Unexpected signer | The provider's instructions required another signer and were refused. Retry, or try another route. |
| <a id="error-SOLANA_INSTRUCTION_INVALID"></a>`SOLANA_INSTRUCTION_INVALID` | 502 | yes | Provider instruction refused | The provider's instructions failed Kletia's checks. Retry shortly. |
| <a id="error-SOLANA_RPC_UNAVAILABLE"></a>`SOLANA_RPC_UNAVAILABLE` | 502 | yes | Solana RPC unavailable | Retry shortly. |
| <a id="error-UPSTREAM_TIMEOUT"></a>`UPSTREAM_TIMEOUT` | 504 | yes | Provider timed out | Retry shortly. |
| <a id="error-VENUE_TIMEOUT"></a>`VENUE_TIMEOUT` | 504 | yes | Venue timed out | A venue did not quote in time. Retry shortly. |

### Unavailable

| Code | Status | Retry | Meaning | What to do |
|---|---|---|---|---|
| <a id="error-NAME_RESOLUTION_UNAVAILABLE"></a>`NAME_RESOLUTION_UNAVAILABLE` | 503 | yes | Name records unavailable | The name's records could not be read. Retry shortly, or use an address. |
| <a id="error-STORE_UNAVAILABLE"></a>`STORE_UNAVAILABLE` | 503 | yes | Storage unavailable | Retry shortly. Presented API keys cannot be verified meanwhile. |
| <a id="error-WEBHOOKS_NOT_CONFIGURED"></a>`WEBHOOKS_NOT_CONFIGURED` | 503 | no | Webhooks not configured | The operator must set KLETIA_PLATFORM_SECRET (at least 32 characters). |

### Internal

| Code | Status | Retry | Meaning | What to do |
|---|---|---|---|---|
| <a id="error-ADAPTERS_INVALID"></a>`ADAPTERS_INVALID` | 500 | yes | Adapter configuration invalid | The operator configured an invalid adapter set. |
| <a id="error-INTERNAL_ERROR"></a>`INTERNAL_ERROR` | 500 | yes | Internal error | Retry later. If it persists, report it with the requestId. |
| <a id="error-NAME_RESOLVER_INVALID"></a>`NAME_RESOLVER_INVALID` | 500 | yes | Name resolver misconfigured | The operator registered an invalid name resolver. |
| <a id="error-PLATFORM_ERROR"></a>`PLATFORM_ERROR` | 500 | yes | Unclassified platform error | Retry later. If it persists, report it with the requestId. |
| <a id="error-PROTOCOL_UNSUPPORTED"></a>`PROTOCOL_UNSUPPORTED` | 500 | yes | Protocol adapter missing | Plan the intent again. |
| <a id="error-RELAY_REQUEST_INVALID"></a>`RELAY_REQUEST_INVALID` | 500 | yes | Relay request invalid | Retry later. If it persists, report it with the requestId. |
| <a id="error-STEP_INVALID"></a>`STEP_INVALID` | 500 · step | no | Step invalid | The stored step cannot be executed. Create a new intent. |
| <a id="error-TRANSFER_BUILD_FAILED"></a>`TRANSFER_BUILD_FAILED` | 500 | yes | Transfer could not be built | Retry later. If it persists, report it with the requestId. |
| <a id="error-VENUE_INVALID"></a>`VENUE_INVALID` | 500 | no | Venue does not match its adapter | The step's registry venue does not fit the adapter executing it. Create a new intent. |

## Adding a code

1. Add the entry to `ERROR_CATALOG` in `packages/core/src/errors.ts` and
   rebuild `@kletia/core`.
2. Add its row here.
3. `cd apps/api && npm run test:platform`: the catalog drift test
   (`src/platform/http/__tests__/errorCatalog.test.ts`) parses the API source
   and fails for any emitted code that is not catalogued, or catalogued with
   another status.
