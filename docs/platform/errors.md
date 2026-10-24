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
- `details` (a JSON object of at most 4 KB) appears on codes that carry
  structured context, for example `SOURCE_REQUIRED` with
  `details.candidates` (the networks whose balances were read) and
  `SOURCE_UNREACHABLE` with both networks. Clients that do not know a code's
  details can ignore them.
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
`PROVIDER_REJECTED`. A provider that is rate-limiting Kletia (HTTP 429
upstream) is retried briefly; if it still refuses, the answer is
`PROVIDER_RATE_LIMITED` (503, retry: yes) with a `Retry-After` header,
never a `<PROVIDER>_REJECTED` code.

`ACTION_ENDPOINT_UNAVAILABLE` (an integrator's Solana Action server) and
`SIMULATION_UNAVAILABLE` are catalog entries of their own, not provider
families.

## Custom contracts

A refused contract registration (`POST`/`PATCH /v1/contracts`) lists every
problem in `issues` and returns the most specific code among them, in this
order: `CONTRACT_DENIED`, `CONTRACT_FUNCTION_FORBIDDEN`,
`CONTRACT_ARGUMENT_FORBIDDEN`, `PROGRAM_NOT_ALLOWED`, `ACTION_URL_FORBIDDEN`,
`CONTRACT_BINDING_INVALID`, `CONTRACT_DEFINITION_INVALID`.
`validateContractDefinition` in `@kletia/core` returns the same issues and
code before any request is sent (`CONTRACT_ISSUE_PRECEDENCE`).

Registrations owned by another API key are indistinguishable from unknown
ones: the registry routes answer `CONTRACT_NOT_FOUND` and planning answers
`CONTRACT_UNKNOWN` for both. A call step whose contract
code changes between prepare and the receipt block fails with
`CONTRACT_CHANGED_DURING_EXECUTION`, moves to `indeterminate`, and the
registration is suspended.

## Step failures

Codes with status **step** never come back as an HTTP error. They appear as
`step.failure.code` on an intent (in `GET /v1/intents/{id}`, SSE and webhook
events) when a submitted transaction fails, never lands, or settles
differently from its quote. The reference rejections
(`REFERENCE_MISMATCH`, `REFERENCE_WRONG_SENDER`, `REFERENCE_WRONG_CHAIN`,
`REFERENCE_STALE`, `REFERENCE_ALREADY_USED`) are returned as `422` by submit
and leave the step unchanged.

## Rule Book refusals

When a key's rule book (policy) refuses a plan or a prepare, the envelope
carries `error.policy`: the decision id, the stage, the key whose rule book
refused, every violated rule id with its JSON path, observed value and limit,
and `retryAt` when a later retry can succeed. When several rules fail at once
the code follows this precedence, non-retryable first, so clients never
retry hopeless requests: `POLICY_VIOLATION`, `POLICY_OWNER_REVOKED`,
`POLICY_APPROVAL_REJECTED`, `POLICY_APPROVAL_STALE`,
`POLICY_APPROVAL_EXPIRED`, `POLICY_PRICE_UNAVAILABLE`, `POLICY_SPEND_LIMIT`,
`POLICY_SCHEDULE_CLOSED`, `POLICY_APPROVAL_REQUIRED` (`policyErrorCode` in
`@kletia/core`). `POLICY_PRICE_UNAVAILABLE` and `POLICY_APPROVAL_REJECTED`
are exact entries, not provider families.

## Receipts, links and previews

Receipt verification results (`SIGNATURE_INVALID`, `DISCLOSURE_MISMATCH`,
…) are not API errors: `verifyReceipt` in `@kletia/core` returns them as
`problems`. The same holds for preview change reasons (`PREVIEW_NEW_DEBIT`,
…), which `PREVIEW_CHANGED` lists in `error.issues`. Intent link codes split
between the publisher (`LINK_DEFINITION_INVALID`, `LINK_POLICY_CONFLICT`,
`LINK_IMMUTABLE_FIELD`) and the visitor (`LINK_INPUT_OUT_OF_BOUNDS`,
`LINK_SOURCE_NOT_ALLOWED`, `LINK_EXHAUSTED`, …); `validateLinkDefinition`
and `expandLink` in `@kletia/core` report the static ones before any
request is sent.

## Departure, journeys and clarifying questions

`SOURCE_REQUIRED` and `SOURCE_UNREACHABLE` are only returned when a request
sets `sourceNetwork`; clients that never send it keep the old behaviour.
`INTENT_IN_FLIGHT` answers `POST /v1/intents/{id}/stop` while a step can
still land (retry after `Retry-After`). A cross-network step that fails with
`SETTLEMENT_MISMATCH` and carries `observedCredit` delivered that amount to
the recipient's wallet on the destination network: the money is there, not
lost. The clarifying-question codes (`QUESTION_NOT_OPEN`, `ANSWER_INVALID`,
`EDIT_UNSUPPORTED`, `THREAD_*`) leave the thread exactly as it was, and
`MESSAGE_SECRET_REFUSED` means nothing from the message was read or stored.
`FEATURE_ERROR_CODES` in `@kletia/core` lists the codes each feature
introduced.

## Perps

`/v1/perps` refuses before anything is built: `PERPS_VENUE_DISABLED` (the
venue is read-only, today Drift v2), `PERPS_POLICY_DENIED` (the key's rule
book: agent keys need `perps.enabled`), `PERPS_LEVERAGE_TOO_HIGH` (the rule
book's `perps.maxLeverage`, default 20, or the venue's cap),
`PERPS_COLLATERAL_TOO_LOW`, `PERPS_MARKET_UNSUPPORTED` and
`PERPS_PRICE_UNAVAILABLE` (a missing or stale mark: it never guesses).
`PERPS_SIGNATURE_INVALID` and `PERPS_RELAY_REJECTED` answer the Hyperliquid
relay. See [perps.md](perps.md).

## Predictions

`/v1/predictions` refuses before anything is built: `PREDICTION_VENUE_DISABLED`
(Limitless Exchange is listed but not added), `PREDICTION_POLICY_DENIED` (the
key's rule book: agent keys need `predictions.enabled`),
`PREDICTION_STAKE_TOO_HIGH` (above `predictions.maxStakeUsd`),
`PREDICTION_MARKET_CLOSED`, `PREDICTION_OUTCOME_UNKNOWN`,
`PREDICTION_ORDER_TOO_SMALL`, `PREDICTION_ACCOUNT_UNSUPPORTED` (smart-contract
wallets trade only through Polymarket), `PREDICTION_BALANCE_TOO_LOW` and
`PREDICTION_PRICE_UNAVAILABLE` (an empty, unreadable or stale book: it never
guesses). The relay answers `PREDICTION_SIGNATURE_INVALID` (not the order
prepare built, expired, or not the account's signature),
`PREDICTION_SESSION_REQUIRED`, `PREDICTION_GEOBLOCKED` (Polymarket's location
rules; Kletia never works around them) and `PREDICTION_RELAY_REJECTED` (the
venue's own reason). See [predictions.md](predictions.md).

## Questions, confirmations and route limits

`CLARIFY_REQUIRED` answers a text intent (without `?clarify=true`) that
needs a question or a confirmation before it can be planned; the questions
are in `details.questions`, and the same text with `?clarify=true` asks them.
`CONFIRM_AUTHORITY_REQUIRED` means a model-assisted reading waits for the
person's own confirmation (from the Kletia desk or with the wallet-bound
token its confirm card issues); an API key or an agent cannot answer it.
`PLAN_TIMEOUT` (retry: yes) means venues did not quote within the planning
deadline; `PLAN_TOO_LARGE` lists the moves in `details`.
`LEG_BELOW_PLANNED_MINIMUM` is returned by prepare when a later leg's fresh
quote delivers less than its planned minimum: stop the intent to keep the
funds where they are, or plan the rest again.

## Catalog

### Request

| Code | Status | Retry | Meaning | What to do |
|---|---|---|---|---|
| <a id="error-AUTOMATION_DRAFT_INVALID"></a>`AUTOMATION_DRAFT_INVALID` | 400 | no | Invalid automation | Fix the fields listed in error.issues. validateAutomationDraft in @kletia/core reports the same issues locally. |
| <a id="error-DATA_TRACKING_LIMIT"></a>`DATA_TRACKING_LIMIT` | 422 | no | Too many tracked wallets | A tracked set holds at most 2 EVM and 2 Solana wallets. Stop tracking one first. |
| <a id="error-ACCOUNT_INVALID"></a>`ACCOUNT_INVALID` | 400 / 500 | no | Invalid account | Send accounts as CAIP-10 ids such as eip155:8453:0x… or solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:<address>. |
| <a id="error-ACTION_URL_FORBIDDEN"></a>`ACTION_URL_FORBIDDEN` | 422 | no | Action URL refused | Use public HTTPS URLs on the registered origin (port 443 or 1024+); private, loopback, credential and redirecting URLs are refused. |
| <a id="error-AMOUNT_REQUIRED"></a>`AMOUNT_REQUIRED` | 400 | no | Amount required | Give every action an amount (a decimal, or max on a dependent step). |
| <a id="error-CONTRACT_DEFINITION_INVALID"></a>`CONTRACT_DEFINITION_INVALID` | 400 | no | Invalid contract definition | Fix the fields listed in error.issues. validateContractDefinition in @kletia/core reports the same issues locally. |
| <a id="error-IDEMPOTENCY_KEY_INVALID"></a>`IDEMPOTENCY_KEY_INVALID` | 400 | no | Invalid Idempotency-Key | Use 1-128 characters from A-Z a-z 0-9 _ . : - (optionally as a quoted string), for example a UUID. |
| <a id="error-IDEMPOTENCY_KEY_REQUIRES_API_KEY"></a>`IDEMPOTENCY_KEY_REQUIRES_API_KEY` | 400 | no | Idempotency-Key needs an API key | Send the request with an API key, or drop the Idempotency-Key header on the public tier. |
| <a id="error-IDEMPOTENCY_NOT_SUPPORTED"></a>`IDEMPOTENCY_NOT_SUPPORTED` | 400 | no | Idempotency-Key not supported here | Drop the Idempotency-Key header on this endpoint; prepare re-quotes on every call. |
| <a id="error-INVALID_JSON"></a>`INVALID_JSON` | 400 | no | Malformed JSON | Send a JSON object or array as the request body. |
| <a id="error-INVALID_REQUEST"></a>`INVALID_REQUEST` | 400 | no | Invalid request | Fix the fields listed in error.issues and send the request again. |
| <a id="error-INVALID_REQUEST_BODY"></a>`INVALID_REQUEST_BODY` | 400 | no | Unreadable request body | Send a complete UTF-8 JSON body with a correct Content-Length. |
| <a id="error-LINK_DEFINITION_INVALID"></a>`LINK_DEFINITION_INVALID` | 400 | no | Invalid link definition | Fix the fields listed in error.issues. validateLinkDefinition in @kletia/core reports the same issues locally. |
| <a id="error-LINK_IMMUTABLE_FIELD"></a>`LINK_IMMUTABLE_FIELD` | 422 | no | Link field cannot change | A link's promise only tightens: raise min, lower max, remove sources, lower uses, expire earlier or turn the blink off. Create a new link for anything else. |
| <a id="error-MESSAGE_SECRET_REFUSED"></a>`MESSAGE_SECRET_REFUSED` | 400 | no | Secret in a message | Never send private keys, seed phrases or API keys. Nothing was stored. |
| <a id="error-METHOD_NOT_ALLOWED"></a>`METHOD_NOT_ALLOWED` | 405 | no | Method not allowed | Use one of the methods listed in the Allow header. |
| <a id="error-ORDER_INVALID"></a>`ORDER_INVALID` | 400 | no | Invalid order | Fix the fields listed in error.issues: kind, sell, buy, amount, price (limit) or period and count (DCA). |
| <a id="error-ORDER_SIGNATURE_MISMATCH"></a>`ORDER_SIGNATURE_MISMATCH` | 422 | no | Signed payload differs from the prepared one | Sign exactly the transaction or typed data returned by prepare, with the owner wallet, and submit it unchanged. |
| <a id="error-PAYLOAD_TOO_LARGE"></a>`PAYLOAD_TOO_LARGE` | 413 | no | Request body too large | Keep request bodies under 64 KB. |
| <a id="error-PERPS_SIGNATURE_INVALID"></a>`PERPS_SIGNATURE_INVALID` | 400 | no | Perps action or signature invalid | Send back the action and nonce exactly as prepare returned them, with the 65-byte signature from the account that prepared them. |
| <a id="error-POLICY_INVALID"></a>`POLICY_INVALID` | 400 | no | Invalid rule book | Fix the fields listed in error.issues. validatePolicy in @kletia/core reports the same issues locally. |
| <a id="error-PROJECT_SETTINGS_INVALID"></a>`PROJECT_SETTINGS_INVALID` | 400 | no | Invalid project settings | Fix the fields listed in error.issues and send the change again. |
| <a id="error-RECEIPT_ANCHOR_INVALID"></a>`RECEIPT_ANCHOR_INVALID` | 422 | no | Anchor transaction refused | The reported transaction is not a successful EAS timestamp(batchDigest) call for this batch on Base. Report the transaction that timestamped it. |
| <a id="error-REFERENCES_INVALID"></a>`REFERENCES_INVALID` | 400 | no | Invalid references | Send { "references": [...] } with one transaction hash or signature per prepared transaction. |
| <a id="error-REFERENCE_COUNT_MISMATCH"></a>`REFERENCE_COUNT_MISMATCH` | 400 | no | Wrong number of references | Submit exactly one reference per prepared transaction, in order. |
| <a id="error-REFERENCE_INVALID"></a>`REFERENCE_INVALID` | 400 | no | Invalid reference | Send a 0x-prefixed 32-byte hash for EVM steps or a base58 signature for Solana steps. |
| <a id="error-SOLANA_ADDRESS_INVALID"></a>`SOLANA_ADDRESS_INVALID` | 400 | no | Invalid Solana address | Use a base58 Solana address. |
| <a id="error-SOLANA_AMOUNT_INVALID"></a>`SOLANA_AMOUNT_INVALID` | 400 | no | Invalid Solana amount | Use a positive amount within the token's precision. |
| <a id="error-SOLANA_MINT_INVALID"></a>`SOLANA_MINT_INVALID` | 400 / 422 | no | Invalid SPL mint | Use the mint address of an SPL token on this network. |
| <a id="error-SOLANA_SELF_TRANSFER"></a>`SOLANA_SELF_TRANSFER` | 400 | no | Transfer to self | Send to a different account. |
| <a id="error-SOLANA_SIGNATURE_INVALID"></a>`SOLANA_SIGNATURE_INVALID` | 400 | no | Invalid Solana signature | Submit the base58 signature of the sent transaction. |
| <a id="error-SOLANA_SLIPPAGE_OUT_OF_RANGE"></a>`SOLANA_SLIPPAGE_OUT_OF_RANGE` | 400 | no | Slippage out of range | Use a slippage between 1 and 1000 basis points. |
| <a id="error-SOLANA_SWAP_INVALID"></a>`SOLANA_SWAP_INVALID` | 422 | no | Invalid direct swap | Use two distinct initialized classic SPL mints and a positive u64 input amount. |
| <a id="error-SOLANA_SWAP_SAME_TOKEN"></a>`SOLANA_SWAP_SAME_TOKEN` | 400 | no | Swap to the same token | Choose different input and output tokens. |
| <a id="error-THREAD_INVALID"></a>`THREAD_INVALID` | 400 | no | Invalid thread | Send the thread exactly as the last response returned it, or start a new one. |
| <a id="error-THREAD_REQUIRES_API_KEY"></a>`THREAD_REQUIRES_API_KEY` | 400 | no | Remembered threads need an API key | Send an API key, or hold the thread yourself and send it back in thread. |
| <a id="error-UNSUPPORTED_MEDIA_TYPE"></a>`UNSUPPORTED_MEDIA_TYPE` | 415 | no | Unsupported media type | Send request bodies as UTF-8 application/json. |
| <a id="error-PREDICTION_SIGNATURE_INVALID"></a>`PREDICTION_SIGNATURE_INVALID` | 400 | no | Prediction order or signature invalid | Send back the order and ticket exactly as prepare returned them, with the 65-byte signature of the account that prepared them, before expiresAt. |
| <a id="error-PREDICTION_SESSION_REQUIRED"></a>`PREDICTION_SESSION_REQUIRED` | 400 | no | Venue session needed | Sign the venue's sign-in message (POST /v1/predictions/session) and send the session it returns; it lives 8 hours and holds no funds. |

### Authentication

| Code | Status | Retry | Meaning | What to do |
|---|---|---|---|---|
| <a id="error-AUTOMATION_OWNER_REQUIRED"></a>`AUTOMATION_OWNER_REQUIRED` | 401 | no | Automations need an owner | Send a project or agent API key, or a wallet session (Kletia-Account-Session) from the Kletia desk. |
| <a id="error-DATA_CALLER_REQUIRED"></a>`DATA_CALLER_REQUIRED` | 401 | no | History reads need a caller | Send an API key (publishable keys work) with evm= / solana= addresses, or a wallet session (Kletia-Account-Session) from the Kletia desk for a tracked wallet set. |
| <a id="error-DATA_PROOF_INVALID"></a>`DATA_PROOF_INVALID` | 401 | no | Wallet proof invalid | Each wallet added to tracking needs its own live wallet sign-in from the same site. Sign in with that wallet again and send its session token in proofs. |
| <a id="error-API_KEY_REQUIRED"></a>`API_KEY_REQUIRED` | 401 | no | API key required | Issue a key with POST /v1/keys and send it as Authorization: Bearer <key>. |
| <a id="error-INVALID_API_KEY"></a>`INVALID_API_KEY` | 401 | no | Invalid or revoked API key | Check the key, or issue a new one. Revoked and expired rotated keys stop working within 15 seconds. |
| <a id="error-INVALID_AUTHORIZATION"></a>`INVALID_AUTHORIZATION` | 401 | no | Malformed credentials | Send Authorization: Bearer <key> or X-Kletia-Key: <key>, not both with different keys. |
| <a id="error-ASSISTANT_OWNER_REQUIRED"></a>`ASSISTANT_OWNER_REQUIRED` | 401 | no | The assistant needs an owner | Send a project or agent API key with the wallets to ask about, or a wallet session (Kletia-Account-Session) from the Kletia desk. |
| <a id="error-ACCOUNT_SESSION_REQUIRED"></a>`ACCOUNT_SESSION_REQUIRED` | 401 | no | Account session required | Sign in with your wallet in the developer portal (POST /v1/accounts/session) and send the token as Kletia-Account-Session from the same origin. |
| <a id="error-ACCOUNT_NONCE_INVALID"></a>`ACCOUNT_NONCE_INVALID` | 401 | no | Sign-in message invalid | The sign-in message is unknown, used, expired or altered. Request a new one with POST /v1/accounts/nonce and sign it unchanged. |
| <a id="error-ACCOUNT_SIGNATURE_INVALID"></a>`ACCOUNT_SIGNATURE_INVALID` | 401 | no | Sign-in signature invalid | Sign the exact message with the wallet it names, then request a new message: each one works once. |

### Permission

| Code | Status | Retry | Meaning | What to do |
|---|---|---|---|---|
| <a id="error-AUTOMATION_ACCOUNT_FORBIDDEN"></a>`AUTOMATION_ACCOUNT_FORBIDDEN` | 403 | no | Account is not the signed-in wallet | A wallet's automations spend from and watch that wallet's own address only. Sign in with the wallet that holds the account. |
| <a id="error-AGENT_KEY_FORBIDDEN"></a>`AGENT_KEY_FORBIDDEN` | 403 | no | Not allowed for agent keys | Agent keys never manage project keys or rule books, and need the matching permission (webhooks, registerContracts, sessions, createChildKeys, links, automations) for the rest. Use a project key. |
| <a id="error-ASSISTANT_ACCOUNT_FORBIDDEN"></a>`ASSISTANT_ACCOUNT_FORBIDDEN` | 403 | no | Not a wallet this caller may read | A desk wallet session answers for its own wallet only; an agent key only for accounts its rule book pins (accounts.allow); publishable keys never. Ask about your own wallets. |
| <a id="error-APPROVAL_SIGNATURE_INVALID"></a>`APPROVAL_SIGNATURE_INVALID` | 403 | no | Approval signature invalid | Sign the exact typed data (EIP-712 "Kletia Approvals") or message text of this approval with the listed wallet, before it expires. |
| <a id="error-APPROVER_NOT_ALLOWED"></a>`APPROVER_NOT_ALLOWED` | 403 | no | Not an approver of this intent | Approve with an active project key outside the requester's subtree, or with a wallet the rule book lists. Agent keys never approve, and requireWallet refuses keys. |
| <a id="error-CONFIRM_AUTHORITY_REQUIRED"></a>`CONFIRM_AUTHORITY_REQUIRED` | 403 | no | Only the person can confirm this reading | A model-assisted reading is confirmed from the Kletia desk or with the wallet-bound token its confirm card issues, never by an API or agent answer. Hand the thread to the person, for example in a signing link. |
| <a id="error-CONTRACT_DENIED"></a>`CONTRACT_DENIED` | 422 | no | Contract not allowed | Tokens, routers, Permit2, Multicall3, precompiles, system contracts and deny-listed addresses can never be registered or called. Register the contract that performs the action. |
| <a id="error-KEY_SECRET_ROTATED"></a>`KEY_SECRET_ROTATED` | 403 | no | Rotated key secret | This secret still authenticates during its grace window but cannot manage keys. Use the current secret. |
| <a id="error-LINK_POLICY_CONFLICT"></a>`LINK_POLICY_CONFLICT` | 422 | no | Link outside the key's rule book | The link reaches networks, assets, recipients, contracts or amounts the publisher key's rule book refuses (rule ids in error.issues). Tighten the link or use another key. |
| <a id="error-MCP_ORIGIN_FORBIDDEN"></a>`MCP_ORIGIN_FORBIDDEN` | 403 | no | Origin not allowed for MCP | Call /v1/mcp without an Origin header (server-side agents) or from an allowed HTTPS origin. |
| <a id="error-PERPS_POLICY_DENIED"></a>`PERPS_POLICY_DENIED` | 403 | no | Perps refused by the rule book | The key's rule book disables perps (agent keys by default), pauses, or does not allow this venue. Ask a project key to set perps.enabled and perps.venues. |
| <a id="error-POLICY_APPROVAL_REJECTED"></a>`POLICY_APPROVAL_REJECTED` | 403 | no | Approval rejected | An approver rejected this intent and it was cancelled. Plan a new intent if appropriate. |
| <a id="error-POLICY_APPROVAL_REQUIRED"></a>`POLICY_APPROVAL_REQUIRED` | 403 | yes | Approval required | The intent is on hold for an approver. Share error.policy.approval.url with an approver; retry after Retry-After once it is approved. |
| <a id="error-POLICY_OWNER_REVOKED"></a>`POLICY_OWNER_REVOKED` | 403 | no | Intent owner key revoked | The key that owns this intent, or one of its ancestors, is revoked or expired, so nothing more is prepared. Steps already submitted keep settling. |
| <a id="error-POLICY_SCHEDULE_CLOSED"></a>`POLICY_SCHEDULE_CLOSED` | 403 | yes | Outside the rule book's timetable | Payloads are prepared only inside the timetable's windows. Retry after Retry-After seconds, when the next window opens. |
| <a id="error-POLICY_SPEND_LIMIT"></a>`POLICY_SPEND_LIMIT` | 403 | yes | Spend cap reached | A rolling 24 h or 7 d USD cap of the key, an ancestor or the project is used up. Retry after Retry-After (error.policy.retryAt), or ask a project key to raise the cap. |
| <a id="error-POLICY_VIOLATION"></a>`POLICY_VIOLATION` | 403 | no | Refused by the rule book | error.policy lists every violated rule id, the key whose rule book refused, the observed value and the limit. Change the request; splitting it or adding accounts does not help. |
| <a id="error-PUBLISHABLE_KEY_FORBIDDEN"></a>`PUBLISHABLE_KEY_FORBIDDEN` | 403 | no | Not allowed for publishable keys | Publishable keys plan intents, start sessions from the project's stored flows and read the project profile. Use a server key for everything else. |
| <a id="error-PUBLISHABLE_ORIGIN_FORBIDDEN"></a>`PUBLISHABLE_ORIGIN_FORBIDDEN` | 403 | no | Origin not allowed for this project | Call from a page origin listed in the project's allowedOrigins, or add the origin with PATCH /v1/projects/current. |
| <a id="error-SECRET_KEY_FROM_BROWSER"></a>`SECRET_KEY_FROM_BROWSER` | 403 | no | Server key sent from a browser | This key is a server key. Call Kletia from your server, through createKletiaProxy, or use a publishable key in browsers. |
| <a id="error-SESSION_ORIGIN_FORBIDDEN"></a>`SESSION_ORIGIN_FORBIDDEN` | 403 | no | Origin not allowed for this session | Embed the session only on one of its allowedOrigins, or create a session that lists this origin. |
| <a id="error-ACCOUNT_ORIGIN_FORBIDDEN"></a>`ACCOUNT_ORIGIN_FORBIDDEN` | 403 | no | Origin not allowed for developer accounts | Developer accounts are used from the Kletia developer portal only. Manage keys from servers with a project key and /v1/keys. |
| <a id="error-SUBAGENT_APPROVER_NOT_ALLOWED"></a>`SUBAGENT_APPROVER_NOT_ALLOWED` | 403 | no | Not allowed to decide this request | Decide with the wallet that owns the project or with an active project key of the project (current secret). Agent keys never decide. |
| <a id="error-SUBAGENT_CLAIM_INVALID"></a>`SUBAGENT_CLAIM_INVALID` | 403 | no | Sub-agent claim refused | Claim with the requesting agent's key and the claim token from the request, once, within 15 minutes of the approval. A late claim revokes the key: request again. |
| <a id="error-SUBAGENT_POLICY_NOT_SUBSET"></a>`SUBAGENT_POLICY_NOT_SUBSET` | 403 | no | Sub-agent wider than its parent | The requested rule book is wider than the parent's chain in the fields listed in error.issues (or asks for a permission sub-agents never get). Narrow those fields and request again. |
| <a id="error-SUBAGENT_SIGNATURE_INVALID"></a>`SUBAGENT_SIGNATURE_INVALID` | 403 | no | Sub-agent decision signature invalid | Request a new message with POST /v1/agents/requests/{id}/challenge and sign it unchanged with the owner wallet before it expires; each message works once. |
| <a id="error-PREDICTION_POLICY_DENIED"></a>`PREDICTION_POLICY_DENIED` | 403 | no | Prediction markets refused by the rule book | The key's rule book disables prediction markets (agent keys by default), pauses, or does not allow this venue. Ask a project key to set predictions.enabled and predictions.venues. |
| <a id="error-PREDICTION_GEOBLOCKED"></a>`PREDICTION_GEOBLOCKED` | 403 | no | Restricted by the venue's location rules | The venue does not accept new orders from this location (its terms list the restricted places). Kletia does not work around that; closing a position may still be allowed. |

### Not found

| Code | Status | Retry | Meaning | What to do |
|---|---|---|---|---|
| <a id="error-AUTOMATION_NOT_FOUND"></a>`AUTOMATION_NOT_FOUND` | 404 | no | Automation not found | Check the id (au_ + 24 hex). GET /v1/automations lists the caller's own automations. |
| <a id="error-DATA_NOT_TRACKED"></a>`DATA_NOT_TRACKED` | 404 | no | Wallet not tracked | Turn tracking on for the signed-in wallet with POST /v1/data/tracking (the desk's Dashboard does it), or read addresses with an API key instead. |
| <a id="error-DATA_TRANSACTION_NOT_FOUND"></a>`DATA_TRANSACTION_NOT_FOUND` | 404 | no | Transaction not found for these wallets | Use an id (&lt;network&gt;:&lt;hash&gt;) from GET /v1/data/transactions of the same wallets; the transaction must involve one of them. |
| <a id="error-APPROVAL_NOT_FOUND"></a>`APPROVAL_NOT_FOUND` | 404 | no | Approval not found | Check the approval id from the link (/approve#apr_…) or error.policy.approval. |
| <a id="error-CONTRACT_NOT_FOUND"></a>`CONTRACT_NOT_FOUND` | 404 | no | Contract registration not found | List registrations with GET /v1/contracts; a key sees its own and the project-visible ones of its project. |
| <a id="error-FLOW_UNKNOWN"></a>`FLOW_UNKNOWN` | 404 | no | Flow not found | Use the id of a flow stored in the project's settings; GET /v1/publishable/profile lists them. |
| <a id="error-INTENT_NOT_FOUND"></a>`INTENT_NOT_FOUND` | 404 | no | Intent not found | Check the intent id. Dry runs are never stored. |
| <a id="error-KEY_NOT_FOUND"></a>`KEY_NOT_FOUND` | 404 | no | API key not found | List your project's keys with GET /v1/keys; only active keys of your own project can be managed. |
| <a id="error-PROJECT_NOT_FOUND"></a>`PROJECT_NOT_FOUND` | 404 | no | Project not found | List the signed-in wallet's projects with GET /v1/accounts/projects; claim a project with one of its project keys first. |
| <a id="error-LINK_NOT_FOUND"></a>`LINK_NOT_FOUND` | 404 | no | Link not found | Check the link id (lk_ + 24 hex). A key lists its own links with GET /v1/links. |
| <a id="error-NOT_FOUND"></a>`NOT_FOUND` | 404 | no | Unknown route | Check the path against GET /v1/openapi.json. |
| <a id="error-ORDER_NOT_FOUND"></a>`ORDER_NOT_FOUND` | 404 | no | Order not found | Check the order id (<protocol>:<network>:<native id>) and its owner. GET /v1/orders?owner= lists them. |
| <a id="error-ORDER_PREPARATION_NOT_FOUND"></a>`ORDER_PREPARATION_NOT_FOUND` | 404 | no | Order preparation not found | Prepare the order again with POST /v1/orders/prepare; preparations are kept briefly and only on the instance that made them. |
| <a id="error-POLICY_NOT_FOUND"></a>`POLICY_NOT_FOUND` | 404 | no | Rule book not found | This key or project has no rule book (or no pending amendment to cancel). Create one with PUT /v1/keys/{id}/policy. |
| <a id="error-PREVIEW_NOT_FOUND"></a>`PREVIEW_NOT_FOUND` | 404 | no | No preview yet | Compute one with POST /v1/intents/{id}/preview, or create the intent with ?preview=true. |
| <a id="error-RECEIPT_LOG_NOT_FOUND"></a>`RECEIPT_LOG_NOT_FOUND` | 404 | no | Log batch not found | List batches with GET /v1/receipts/log; batches close hourly, and an unbatched digest has no inclusion yet. |
| <a id="error-RECEIPT_NOT_FOUND"></a>`RECEIPT_NOT_FOUND` | 404 | no | Receipt not found | Unknown or unshared receipts look the same. The intent's owner reads receipts with GET /v1/intents/{id}/receipt and shares them. |
| <a id="error-RECEIPT_SHARE_NOT_FOUND"></a>`RECEIPT_SHARE_NOT_FOUND` | 404 | no | Receipt share not found | The share link is unknown or was revoked. Ask the receipt's owner for a new link. |
| <a id="error-SESSION_NOT_FOUND"></a>`SESSION_NOT_FOUND` | 404 | no | Session not found | Check the session id. Sessions are created by the integrator's backend with POST /v1/sessions. |
| <a id="error-STEP_NOT_FOUND"></a>`STEP_NOT_FOUND` | 404 | no | Step not found | Use a step id from intent.steps (s1, s2, ...). |
| <a id="error-SUBAGENT_REQUEST_NOT_FOUND"></a>`SUBAGENT_REQUEST_NOT_FOUND` | 404 | no | Sub-agent request not found | Check the request id (sar_ + 32 hex). A key sees the requests of its own subtree with GET /v1/agents/{id}/subagents. |
| <a id="error-THREAD_NOT_FOUND"></a>`THREAD_NOT_FOUND` | 404 | no | Unknown thread | The thread expired or belongs to another key. Start a new one. |
| <a id="error-WEBHOOK_NOT_FOUND"></a>`WEBHOOK_NOT_FOUND` | 404 | no | Webhook not found | List your webhooks with GET /v1/webhooks; each key sees only its own. |
| <a id="error-PREDICTION_MARKET_NOT_FOUND"></a>`PREDICTION_MARKET_NOT_FOUND` | 404 / 422 | no | Prediction market not found | No open market matches the id or the words. Search GET /v1/predictions/markets?q=… and use a market id from the answer. |

### Conflict

| Code | Status | Retry | Meaning | What to do |
|---|---|---|---|---|
| <a id="error-AUTOMATION_CONFLICT"></a>`AUTOMATION_CONFLICT` | 409 | yes | Automation changed | Another change to this automation landed first. Read it again and retry. |
| <a id="error-AUTOMATION_ENDED"></a>`AUTOMATION_ENDED` | 409 | no | Automation ended | A completed or expired automation cannot resume. Create a new one. |
| <a id="error-DATA_WALLET_TRACKED"></a>`DATA_WALLET_TRACKED` | 409 | no | Wallet tracked elsewhere | A wallet belongs to one tracked set at a time. Sign in with it and stop tracking there (DELETE /v1/data/tracking) first. |
| <a id="error-AUTOMATION_LIMIT_REACHED"></a>`AUTOMATION_LIMIT_REACHED` | 409 | no | Too many automations | An owner holds at most 50 live automations and creates at most 30 an hour. Delete some first. |
| <a id="error-AGENT_KEY_LIMIT_REACHED"></a>`AGENT_KEY_LIMIT_REACHED` | 409 | no | Too many agent keys | A project holds at most 100 active agent keys. Revoke one first. |
| <a id="error-APPROVAL_DECIDED"></a>`APPROVAL_DECIDED` | 409 | no | Approval already decided | The approval was already approved, rejected or expired; a decision is final. Read it with GET /v1/policy/approvals/{id}. |
| <a id="error-CLIENT_REFERENCE_EXISTS"></a>`CLIENT_REFERENCE_EXISTS` | 409 | no | clientReference already used | Use a new clientReference, or read the existing intent. |
| <a id="error-CONTRACT_CHANGED"></a>`CONTRACT_CHANGED` | 409 | no | Contract code changed | The contract's code or proxy implementation no longer matches its pins, so the registration is suspended. The integrator must inspect it and call reverify. |
| <a id="error-CONTRACT_EXISTS"></a>`CONTRACT_EXISTS` | 409 | no | Contract already registered | This key already registered this address (or origin) on this network. Change it with PATCH /v1/contracts/{id}. |
| <a id="error-CONTRACT_LIMIT_REACHED"></a>`CONTRACT_LIMIT_REACHED` | 409 | no | Too many contract registrations | A key holds at most 25 registrations. Delete one with DELETE /v1/contracts/{id} first. |
| <a id="error-CONTRACT_NOT_USABLE"></a>`CONTRACT_NOT_USABLE` | 409 | no | Contract not usable by this intent | The intent's API key may no longer use this registration (deleted, or visibility changed). Create a new intent with a key that may use it. |
| <a id="error-CONTRACT_PENDING"></a>`CONTRACT_PENDING` | 409 | yes | Contract pending activation | Mainnet registrations and security-relevant revisions activate after a delay. Retry after Retry-After seconds; POST /v1/contracts/{id}/test works meanwhile. |
| <a id="error-CONTRACT_REVISION_CHANGED"></a>`CONTRACT_REVISION_CHANGED` | 409 | no | Contract revision changed | A newer revision of the registration is active than the one this intent was planned on. Create a new intent. |
| <a id="error-CONTRACT_SUSPENDED"></a>`CONTRACT_SUSPENDED` | 409 | no | Contract suspended | The registration is suspended (code change, outcome mismatch or operator). Inspect it with GET /v1/contracts/{id}; after an intended upgrade call reverify. |
| <a id="error-IDEMPOTENCY_REQUEST_IN_PROGRESS"></a>`IDEMPOTENCY_REQUEST_IN_PROGRESS` | 409 | yes | Request with this key in progress | The first request with this Idempotency-Key is still running. Retry after Retry-After seconds. |
| <a id="error-INTENT_CANCELLED"></a>`INTENT_CANCELLED` | 409 | no | Intent cancelled | Create a new intent. |
| <a id="error-INTENT_COMPLETED"></a>`INTENT_COMPLETED` | 409 | no | Intent completed | Nothing is left to execute. |
| <a id="error-INTENT_CONFLICT"></a>`INTENT_CONFLICT` | 409 | yes | Concurrent update | The intent changed while the request ran. Read it again and retry. |
| <a id="error-INTENT_EXISTS"></a>`INTENT_EXISTS` | 409 | yes | Intent id collision | Send the request again. |
| <a id="error-INTENT_IN_FLIGHT"></a>`INTENT_IN_FLIGHT` | 409 | yes | A step is in flight | Wait until it settles or its prepared payload expires (Retry-After), then stop the intent. |
| <a id="error-INTENT_NOT_CANCELLABLE"></a>`INTENT_NOT_CANCELLABLE` | 409 | no | Intent cannot be cancelled | A step was already submitted; follow it to settlement instead. |
| <a id="error-KEY_COLLISION"></a>`KEY_COLLISION` | 409 | yes | Key generation collided | Send the request again. |
| <a id="error-KEY_DEPTH_EXCEEDED"></a>`KEY_DEPTH_EXCEEDED` | 409 | no | Agent key tree too deep | Agent keys sit at most 3 levels below a project key. Create the key under a shallower parent. |
| <a id="error-KEY_LIMIT_REACHED"></a>`KEY_LIMIT_REACHED` | 409 | no | Too many active keys | A project holds at most 5 active keys. Revoke one with DELETE /v1/keys/{id} first. |
| <a id="error-KEY_NOT_MANAGEABLE"></a>`KEY_NOT_MANAGEABLE` | 409 | no | Operator keys are immutable | Operator keys come from server configuration; change KLETIA_OPERATOR_API_KEYS instead. |
| <a id="error-LEG_BELOW_PLANNED_MINIMUM"></a>`LEG_BELOW_PLANNED_MINIMUM` | 409 | no | Leg below its planned minimum | A fresh quote for this leg delivers less than the minimum it was planned with. Keep the funds where the previous leg left them (stop the intent), or plan the rest again with the new quote. |
| <a id="error-LINK_ACCOUNT_LIMIT"></a>`LINK_ACCOUNT_LIMIT` | 409 | no | Account used this link enough | This account reached the link's per-account limit. |
| <a id="error-LINK_CONTRACT_CHANGED"></a>`LINK_CONTRACT_CHANGED` | 409 | no | Link contract changed | The pinned contract registration has a newer revision, so the link paused itself. The publisher must review and resume it. |
| <a id="error-LINK_EXHAUSTED"></a>`LINK_EXHAUSTED` | 409 | yes | Link used up | Every use of the link is reserved or consumed. Uses of abandoned intents are released, so retry later. |
| <a id="error-LINK_LIMIT_REACHED"></a>`LINK_LIMIT_REACHED` | 409 | no | Too many links | A key holds at most 200 active links and creates at most 60 an hour. Delete or let some expire first. |
| <a id="error-LINK_PAUSED"></a>`LINK_PAUSED` | 409 | no | Link paused | The publisher paused the link, or it paused itself because a pinned recipient name or contract changed. Ask the publisher. |
| <a id="error-LINK_PENDING"></a>`LINK_PENDING` | 409 | yes | Link not active yet | Links that pay a fixed third party or call a custom contract activate after a delay. Retry after Retry-After seconds. |
| <a id="error-LINK_RECIPIENT_CHANGED"></a>`LINK_RECIPIENT_CHANGED` | 409 | no | Link recipient changed | A pinned recipient name now resolves elsewhere, so the link paused itself. The publisher must review and resume it. |
| <a id="error-LINK_SUSPENDED"></a>`LINK_SUSPENDED` | 409 | no | Link suspended | Kletia suspended the link. Funds of steps already completed are in your wallet. |
| <a id="error-ORDER_NOT_CANCELLABLE"></a>`ORDER_NOT_CANCELLABLE` | 409 | no | Order not cancellable | Only open orders can be cancelled. Read the order with GET /v1/orders?owner= to see its status. |
| <a id="error-ORDER_PREPARATION_USED"></a>`ORDER_PREPARATION_USED` | 409 | no | Order preparation already submitted | This preparation was relayed with another signature. Prepare a new order. |
| <a id="error-POLICY_AMENDMENT_PENDING"></a>`POLICY_AMENDMENT_PENDING` | 409 | no | Amendment pending | A loosening amendment is waiting to activate. Cancel it with DELETE …/policy/pending first, or wait for activatesAt. |
| <a id="error-POLICY_APPROVAL_STALE"></a>`POLICY_APPROVAL_STALE` | 409 | no | Approval no longer covers the intent | Fresh prices put the intent above the approved ceiling. Plan a new intent and ask for a new approval. |
| <a id="error-POLICY_CONFLICT"></a>`POLICY_CONFLICT` | 409 | no | Rule book changed | The If-Match hash is not the current version. Read the rule book again and resend the change. |
| <a id="error-PREVIEW_CHANGED"></a>`PREVIEW_CHANGED` | 409 | no | Preview changed | The fresh simulation is materially worse than the preview you acknowledged (error.preview, changes in error.issues). Show it again and prepare with its digest. |
| <a id="error-PROGRAM_CHANGED"></a>`PROGRAM_CHANGED` | 409 | no | Program changed | An allowlisted program was redeployed or changed upgrade authority, so the registration is suspended until the integrator calls reverify. |
| <a id="error-PROJECT_CONFLICT"></a>`PROJECT_CONFLICT` | 409 | no | Project settings changed | The If-Match hash is not the current version. Read the project again and resend the change. |
| <a id="error-PROJECT_ALREADY_OWNED"></a>`PROJECT_ALREADY_OWNED` | 409 | no | Project owned by another wallet | A project has one owner wallet for good. Sign in with that wallet to manage it. |
| <a id="error-PROJECT_LIMIT_REACHED"></a>`PROJECT_LIMIT_REACHED` | 409 | no | Too many projects | A wallet owns at most 20 projects. Manage keys of an existing project instead. |
| <a id="error-QUESTION_NOT_OPEN"></a>`QUESTION_NOT_OPEN` | 409 | no | Question not open | Read the thread again and answer one of its open questions. |
| <a id="error-QUOTE_MOVED"></a>`QUOTE_MOVED` | 409 | no | Price moved | The price moved beyond the slippage limit since planning. Create a new intent to re-quote. |
| <a id="error-RECEIPT_ANCHOR_EXISTS"></a>`RECEIPT_ANCHOR_EXISTS` | 409 | no | Batch already anchored | This log batch already has an anchoring transaction on record. |
| <a id="error-RECEIPT_NOT_APPLICABLE"></a>`RECEIPT_NOT_APPLICABLE` | 409 | no | No receipt for this intent | Expired intents executed nothing, so they get no receipt. |
| <a id="error-RECEIPT_NOT_READY"></a>`RECEIPT_NOT_READY` | 409 | yes | Receipt not ready | Receipts are issued after the intent ends and every anchor is finalized. Retry later; GET /v1/intents/{id}/receipt answers 202 with expectedBy meanwhile. |
| <a id="error-RECEIPT_SHARE_LIMIT"></a>`RECEIPT_SHARE_LIMIT` | 409 | no | Too many receipt shares | A receipt has at most 10 active shares. Revoke one first. |
| <a id="error-RECIPIENT_NAME_CHANGED"></a>`RECIPIENT_NAME_CHANGED` | 409 | no | Recipient name changed | The recipient's name now resolves to another address. Create a new intent to pay the new address. |
| <a id="error-SESSION_USED"></a>`SESSION_USED` | 409 | no | Session already used | The session reached its maxIntents. Ask the integrator's backend for a new session. |
| <a id="error-STEP_NOT_AWAITING_SIGNATURE"></a>`STEP_NOT_AWAITING_SIGNATURE` | 409 | no | Step not awaiting a signature | Prepare the step before submitting references. |
| <a id="error-STEP_NOT_PREPARABLE"></a>`STEP_NOT_PREPARABLE` | 409 | no | Step cannot be prepared | Only ready or awaiting_signature steps can be prepared. |
| <a id="error-STEP_NOT_READY"></a>`STEP_NOT_READY` | 409 | yes | Step not ready | Wait until the steps it depends on have settled, then prepare it. |
| <a id="error-STEP_TRANSITION_INVALID"></a>`STEP_TRANSITION_INVALID` | 409 | no | Invalid step transition | Read the intent again; the step already moved on. |
| <a id="error-SUBAGENT_LIMIT_REACHED"></a>`SUBAGENT_LIMIT_REACHED` | 409 | no | Too many sub-agents | A parent has at most 10 children and open requests together, and at most 5 open requests. Revoke a sub-agent or wait for a decision first. |
| <a id="error-SUBAGENT_PARENT_INACTIVE"></a>`SUBAGENT_PARENT_INACTIVE` | 409 | no | Parent agent inactive | The requesting agent key or one of its ancestors is revoked or expired, so the request was cancelled. |
| <a id="error-SUBAGENT_REQUEST_DECIDED"></a>`SUBAGENT_REQUEST_DECIDED` | 409 | no | Sub-agent request already decided | The request was already approved, denied, expired or cancelled; a decision is final. Read it with GET /v1/agents/requests/{id}. |
| <a id="error-THREAD_CLOSED"></a>`THREAD_CLOSED` | 409 | no | Thread closed | The task was cancelled or reached 50 turns. Start a new thread. |
| <a id="error-THREAD_CONFLICT"></a>`THREAD_CONFLICT` | 409 | no | Thread changed | Another turn changed this thread. Read it again and resend. |
| <a id="error-WEBHOOK_EXISTS"></a>`WEBHOOK_EXISTS` | 409 | no | Webhook already registered | A webhook with this URL already exists for this key. |
| <a id="error-WEBHOOK_LIMIT_REACHED"></a>`WEBHOOK_LIMIT_REACHED` | 409 | no | Too many webhooks | A key can register at most 10 webhooks. Delete one first. |

### Expired

| Code | Status | Retry | Meaning | What to do |
|---|---|---|---|---|
| <a id="error-DEADLINE_PASSED"></a>`DEADLINE_PASSED` | 410 / 422 | no | Deadline passed | constraints.deadline is in the past. Plan again with a later deadline. |
| <a id="error-INTENT_EXPIRED"></a>`INTENT_EXPIRED` | 410 | no | Intent expired | The plan expired before execution started. Create a new intent to re-quote. |
| <a id="error-LINK_EXPIRED"></a>`LINK_EXPIRED` | 410 | no | Link expired or withdrawn | The link expired or its publisher withdrew it. Ask the publisher for a new link. |
| <a id="error-ORDER_PREPARATION_EXPIRED"></a>`ORDER_PREPARATION_EXPIRED` | 410 | no | Order preparation expired | The prepared transaction or signature request is too old. Prepare the order again. |
| <a id="error-POLICY_APPROVAL_EXPIRED"></a>`POLICY_APPROVAL_EXPIRED` | 410 | no | Approval expired | Nobody decided the approval in time. Plan a new intent to ask again. |
| <a id="error-RECEIPT_DISCLOSURES_WITHDRAWN"></a>`RECEIPT_DISCLOSURES_WITHDRAWN` | 410 | no | Receipt disclosures withdrawn | The owner withdrew this intent's disclosures, so no share can be created. The signed payloads remain. |
| <a id="error-RECEIPT_SHARE_EXPIRED"></a>`RECEIPT_SHARE_EXPIRED` | 410 | no | Receipt share expired | The share link expired. Ask the receipt's owner for a new link. |
| <a id="error-SESSION_EXPIRED"></a>`SESSION_EXPIRED` | 410 | no | Session expired | Sessions live 60-3600 seconds. Ask the integrator's backend for a new session. |
| <a id="error-SUBAGENT_REQUEST_EXPIRED"></a>`SUBAGENT_REQUEST_EXPIRED` | 410 | no | Sub-agent request expired | Nobody decided the request within 24 hours (or before the parent's expiry). File a new request. |

### Intent (understood but not executable)

| Code | Status | Retry | Meaning | What to do |
|---|---|---|---|---|
| <a id="error-ACCOUNT_AMBIGUOUS"></a>`ACCOUNT_AMBIGUOUS` | 422 | no | Ambiguous account | Several accounts of this kind were given; add the one to use on this network. |
| <a id="error-ACCOUNT_REQUIRED"></a>`ACCOUNT_REQUIRED` | 422 | no | Account missing | Add a CAIP-10 account for every network the intent touches. |
| <a id="error-ACTION_RESPONSE_UNSUPPORTED"></a>`ACTION_RESPONSE_UNSUPPORTED` | 422 | no | Action response not supported | Kletia executes Solana Actions that return a transaction. Sign-message, post, external-link and chained responses are refused. |
| <a id="error-ACTION_TRANSACTION_REJECTED"></a>`ACTION_TRANSACTION_REJECTED` | 422 | no | Action transaction refused | The action server's transaction broke Kletia's rules (signers, programs, instructions or simulated effects); see error.message. The integrator must fix the server. |
| <a id="error-AMOUNT_INVALID"></a>`AMOUNT_INVALID` | 422 | no | Invalid amount | Use a positive decimal within the asset's precision, or max on a dependent step. |
| <a id="error-AMOUNT_TOO_SMALL"></a>`AMOUNT_TOO_SMALL` | 422 | no | Amount too small | Increase the amount; it rounds to zero or is below the venue minimum. |
| <a id="error-ANSWER_INVALID"></a>`ANSWER_INVALID` | 422 | no | Answer does not fit | Pick one of the question's options, or send free text of the kind it asks for. |
| <a id="error-ASSET_INVALID"></a>`ASSET_INVALID` | 422 / 500 | no | Invalid asset | Use a symbol, an address or mint, or a CAIP-19 id. |
| <a id="error-ASSET_MISMATCH"></a>`ASSET_MISMATCH` | 422 | no | Asset mismatch | A dependent step must spend the asset the previous step produces. |
| <a id="error-ASSET_NETWORK_MISMATCH"></a>`ASSET_NETWORK_MISMATCH` | 422 | no | Asset on another network | Use an asset that lives on the step's network, or bridge first. |
| <a id="error-ASSET_REQUIRED"></a>`ASSET_REQUIRED` | 422 | no | Asset required | Name the input and output assets. |
| <a id="error-CAPITAL_LANE_MIXED"></a>`CAPITAL_LANE_MIXED` | 422 | no | Mainnet and testnet mixed | Keep every network of one intent on mainnet, or every one on testnet. |
| <a id="error-CLARIFY_REQUIRED"></a>`CLARIFY_REQUIRED` | 422 | no | Questions needed | The text needs an answer or a confirmation before it can be planned (error.details.questions). Send it with ?clarify=true and answer there, or rewrite it with the missing details. |
| <a id="error-CONTRACT_ACTION_UNKNOWN"></a>`CONTRACT_ACTION_UNKNOWN` | 422 | no | Unknown contract action | Use an entry id listed in the registration's actions. |
| <a id="error-CONTRACT_AMOUNT_LIMIT"></a>`CONTRACT_AMOUNT_LIMIT` | 422 | no | Amount outside the contract's limits | Use an amount within the action's minAmount and maxAmount and the per-step USD cap (lower while the integrator's domain is unverified). |
| <a id="error-CONTRACT_ARGUMENT_FORBIDDEN"></a>`CONTRACT_ARGUMENT_FORBIDDEN` | 422 | no | Argument type not allowed | bytes arguments accept only the empty literal 0x; bytes[] and function arguments cannot be registered (no arbitrary calldata). |
| <a id="error-CONTRACT_BINDING_INVALID"></a>`CONTRACT_BINDING_INVALID` | 422 | no | Invalid argument binding | Bind every argument to a compatible source or literal; receiver-like addresses must bind to $account or $recipient. See error.issues. |
| <a id="error-CONTRACT_DELEGATED_EOA"></a>`CONTRACT_DELEGATED_EOA` | 422 | no | Delegated account (EIP-7702) | EIP-7702 delegated accounts can swap their code at any time and cannot be registered. |
| <a id="error-CONTRACT_FUNCTION_FORBIDDEN"></a>`CONTRACT_FUNCTION_FORBIDDEN` | 422 | no | Function not allowed | Approvals, permits, transfers, ownership, upgrades, multicall, execute and read-only functions cannot be registered. Register the function that performs the action. |
| <a id="error-CONTRACT_HANDOFF_UNSUPPORTED"></a>`CONTRACT_HANDOFF_UNSUPPORTED` | 422 | no | Signing link not available | Intents with custom contract steps cannot become signing links. Create a session from your backend with POST /v1/sessions instead. |
| <a id="error-CONTRACT_NOT_DEPLOYED"></a>`CONTRACT_NOT_DEPLOYED` | 422 | no | No contract at this address | Register an address that holds deployed code on this network. |
| <a id="error-CONTRACT_PARAM_INVALID"></a>`CONTRACT_PARAM_INVALID` | 422 | no | Invalid contract parameter | Send only the parameters the action declares, within their types and bounds. |
| <a id="error-CONTRACT_PROXY_UNSUPPORTED"></a>`CONTRACT_PROXY_UNSUPPORTED` | 422 | no | Proxy pattern not supported | Only EIP-1967, beacon, EIP-1822, ZeppelinOS and EIP-1167 proxies can be pinned; diamonds and unrecognised proxies are refused. |
| <a id="error-CONTRACT_SPEND_LIMIT"></a>`CONTRACT_SPEND_LIMIT` | 422 | yes | Daily contract volume reached | This key reached its 24-hour notional cap for custom contract steps. Retry when the window moves on, or ask the operator for a higher cap. |
| <a id="error-CONTRACT_UNKNOWN"></a>`CONTRACT_UNKNOWN` | 422 | no | Unknown contract | Use a registration id or alias that the intent's API key registered (or a project-visible one). Intents created without a key cannot call registered contracts. |
| <a id="error-DEX_ASSET_UNSUPPORTED"></a>`DEX_ASSET_UNSUPPORTED` | 422 | no | Unsupported direct DEX asset | Use initialized classic SPL tokens with the registry's expected decimals. Token-2022 direct routes are not supported. |
| <a id="error-EDIT_UNSUPPORTED"></a>`EDIT_UNSUPPORTED` | 422 | no | Follow-up not understood | Say the change ("make it 50", "from arbitrum instead") or send a complete new sentence. |
| <a id="error-FEE_LIMIT_EXCEEDED"></a>`FEE_LIMIT_EXCEEDED` | 422 | no | Fees above the limit | Raise constraints.maxFeeUsd or move a larger amount. |
| <a id="error-GAS_TOPUP_UNAVAILABLE"></a>`GAS_TOPUP_UNAVAILABLE` | 422 | no | No venue can deliver gas there | No venue can deliver gas on that network for this route (Relay serves EVM destinations when the output is not the gas asset). Remove constraints.gasOnArrival for it, or bring gas yourself. |
| <a id="error-IDEMPOTENCY_KEY_REUSED"></a>`IDEMPOTENCY_KEY_REUSED` | 422 | no | Idempotency-Key reused | This key was used for a different request. Use a new key for a new request. |
| <a id="error-INSUFFICIENT_BALANCE"></a>`INSUFFICIENT_BALANCE` | 422 | no | Insufficient balance | Fund the account or lower the amount. |
| <a id="error-INTENT_HANDOFF"></a>`INTENT_HANDOFF` | 422 | no | Runs on another surface | The text is a perps trade, native order or automation: error.details.handoff has its typed input (or details.questions to answer first). Open that surface, or send the text with ?clarify=true. |
| <a id="error-INTENT_UNSUPPORTED"></a>`INTENT_UNSUPPORTED` | 422 | no | Intent not supported | Rephrase using one of the examples in error.hints, or send structured actions. |
| <a id="error-JUPITER_SIMULATION_FAILED"></a>`JUPITER_SIMULATION_FAILED` | 422 | no | Swap simulation failed | The swap would fail on-chain. Check the balance or try a smaller amount. |
| <a id="error-LINK_ACCOUNTS_REQUIRED"></a>`LINK_ACCOUNTS_REQUIRED` | 422 | no | Accounts missing for this link | Send one account per virtual machine the route signs on (error.issues names them). |
| <a id="error-LINK_INPUT_OUT_OF_BOUNDS"></a>`LINK_INPUT_OUT_OF_BOUNDS` | 422 | no | Amount outside the link's bounds | Choose an amount within the link's min and max for this asset (unverified publishers are limited to $1,000); deliver links take no amount. |
| <a id="error-LINK_NOT_BLINK_ELIGIBLE"></a>`LINK_NOT_BLINK_ELIGIBLE` | 422 | no | Link cannot be a blink | Blinks need a Solana-only visitor flow of at most 3 steps and a verified publisher domain; error.message gives the reason. |
| <a id="error-LINK_PUBLISHER_MISMATCH"></a>`LINK_PUBLISHER_MISMATCH` | 422 | no | Publisher does not match the contract | The publisher name and website must match the integrator of every contract registration the link calls. |
| <a id="error-LINK_SOURCE_NOT_ALLOWED"></a>`LINK_SOURCE_NOT_ALLOWED` | 422 | no | Funding source not allowed | Fund the link from one of its networks and assets (error.issues lists them). On the destination network a deliver link takes only the delivered asset. |
| <a id="error-NETWORK_UNSUPPORTED"></a>`NETWORK_UNSUPPORTED` | 422 / 500 | no | Network not supported | Use a network from GET /v1/networks that supports this action. |
| <a id="error-PERPS_COLLATERAL_TOO_LOW"></a>`PERPS_COLLATERAL_TOO_LOW` | 422 | no | Collateral below the venue minimum | Add collateral: the venue refuses (or, for a Hyperliquid deposit under 5 USDC, loses) smaller amounts. |
| <a id="error-PERPS_LEVERAGE_TOO_HIGH"></a>`PERPS_LEVERAGE_TOO_HIGH` | 422 | no | Leverage above the cap | Lower the leverage to the venue's or the rule book's cap (error message), or add collateral. |
| <a id="error-PERPS_MARKET_UNSUPPORTED"></a>`PERPS_MARKET_UNSUPPORTED` | 422 | no | Perps market not supported | Use a market and collateral the venue lists in GET /v1/perps/markets (USDC collateral; ETH, BTC, SOL). |
| <a id="error-PERPS_POSITION_NOT_FOUND"></a>`PERPS_POSITION_NOT_FOUND` | 422 | no | No such position | decrease and close need an open position on that venue, market and side for the account. Read GET /v1/perps/positions. |
| <a id="error-PERPS_RELAY_REJECTED"></a>`PERPS_RELAY_REJECTED` | 422 | no | Venue refused the signed action | The venue refused the order (margin, price band, size or nonce): the message says why. Prepare again after fixing it. |
| <a id="error-PERPS_VENUE_DISABLED"></a>`PERPS_VENUE_DISABLED` | 422 | no | Perps venue disabled | The venue is listed for reading only (GET /v1/perps/markets says why). Choose another venue. |
| <a id="error-PLAN_INVALID"></a>`PLAN_INVALID` | 422 / 502 | no | Plan invalid | Simplify the intent; at most 8 steps are planned. |
| <a id="error-PLAN_TOO_LARGE"></a>`PLAN_TOO_LARGE` | 422 | no | Plan too large | The request expands to more wallet signatures or venue auctions than one plan allows (error.details lists the moves). Split it into smaller requests. |
| <a id="error-POSITION_UNAVAILABLE"></a>`POSITION_UNAVAILABLE` | 502 | yes | Position not readable | Kletia could not read this venue position right now, or does not list positions for this venue yet. The funds are unaffected; check the venue directly or retry later. |
| <a id="error-POSITION_EMPTY"></a>`POSITION_EMPTY` | 422 | no | No position to withdraw | There is nothing deposited at this venue for the account. |
| <a id="error-PRICE_IMPACT_TOO_HIGH"></a>`PRICE_IMPACT_TOO_HIGH` | 422 | no | Price impact too high | Move a smaller amount; routes that cost more than 5% are refused. |
| <a id="error-PRICE_UNAVAILABLE"></a>`PRICE_UNAVAILABLE` | 422 | no | Price unavailable | No fresh oracle price covers an asset of this swap, so its price guard refuses it. Swap a priced asset, or plan again once the price feed updates. |
| <a id="error-PROGRAM_NOT_ALLOWED"></a>`PROGRAM_NOT_ALLOWED` | 422 | no | Program not allowed | Allowlist the action's top-level programs in the registration. Built-in, native and deny-listed programs cannot be allowlisted. |
| <a id="error-PROJECT_LOGO_INVALID"></a>`PROJECT_LOGO_INVALID` | 422 | no | Logo refused | Upload a PNG or WebP image of at most 64 KB, 32-512 px, with an aspect ratio between 1:1 and 4:1 and no animation. |
| <a id="error-RECIPIENT_CHECKSUM_INVALID"></a>`RECIPIENT_CHECKSUM_INVALID` | 422 | no | Recipient checksum invalid | Check the address: its capital letters do not match its EIP-55 checksum, which usually means a mistyped character. |
| <a id="error-RECIPIENT_INVALID"></a>`RECIPIENT_INVALID` | 422 | no | Invalid recipient | Use an address or CAIP-10 account on the destination network. |
| <a id="error-RECIPIENT_NAME_UNRESOLVED"></a>`RECIPIENT_NAME_UNRESOLVED` | 422 | no | Name does not resolve | The name has no address for this network. Use the recipient's address. |
| <a id="error-RECIPIENT_NAME_UNSUPPORTED"></a>`RECIPIENT_NAME_UNSUPPORTED` | 422 | no | Name not supported | This deployment cannot resolve this kind of name on this network. Use the recipient's address. |
| <a id="error-RECIPIENT_NETWORK_MISMATCH"></a>`RECIPIENT_NETWORK_MISMATCH` | 422 | no | Recipient on another network | Use a bridge to move funds across networks. |
| <a id="error-RECIPIENT_REQUIRED"></a>`RECIPIENT_REQUIRED` | 422 | no | Recipient required | Name the recipient of the transfer. |
| <a id="error-RECIPIENT_TOKEN_ACCOUNT_MISSING"></a>`RECIPIENT_TOKEN_ACCOUNT_MISSING` | 422 | no | Recipient token account missing | The Solana recipient has no token account for the bridged asset yet, so the bridge cannot mint to it. Create the account first, or use another bridge. |
| <a id="error-RELAY_SIGNATURE_STEP_UNSUPPORTED"></a>`RELAY_SIGNATURE_STEP_UNSUPPORTED` | 422 | no | Off-chain signature step | This route needs an off-chain signature, which Kletia does not execute. Try another amount or route. |
| <a id="error-RESERVE_UNAVAILABLE"></a>`RESERVE_UNAVAILABLE` | 422 | no | Lending reserve unavailable | The market is paused, frozen or capped for this asset. Try another asset or venue. |
| <a id="error-ROUTE_TOO_SLOW"></a>`ROUTE_TOO_SLOW` | 422 | no | No route fast enough | Every venue settles slower than constraints.maxSeconds. Raise it or drop the constraint. |
| <a id="error-ROUTE_UNAVAILABLE"></a>`ROUTE_UNAVAILABLE` | 422 | no | No route | The venue could not route this request now. Try another amount or asset. |
| <a id="error-ROUTE_UNPRICED"></a>`ROUTE_UNPRICED` | 422 | no | Route costs not priceable | No venue quoted costs Kletia can price for this route. Try another amount or asset. |
| <a id="error-ROUTE_UNSUPPORTED"></a>`ROUTE_UNSUPPORTED` | 422 | no | Route not supported | No venue routes this pair between these networks; see GET /v1/networks. |
| <a id="error-SELF_TRANSFER"></a>`SELF_TRANSFER` | 422 | no | Transfer to self | Send to a different account. |
| <a id="error-SESSION_EXPIRES_BEFORE_ACTIVATION"></a>`SESSION_EXPIRES_BEFORE_ACTIVATION` | 422 | no | Session ends before the contract activates | A pending registration of this session activates after the session expires. Raise expiresInSeconds past activatesAt, or create the session after activation. |
| <a id="error-SIMULATION_ASSET_CHANGE_REFUSED"></a>`SIMULATION_ASSET_CHANGE_REFUSED` | 422 | no | Simulated asset changes refused | The simulation moves the user's assets differently than declared (extra debit or approval, leftover allowance, missing output). Fix the registration or the amount. |
| <a id="error-SIMULATION_FAILED"></a>`SIMULATION_FAILED` | 422 | no | Simulation failed | The transaction would fail on-chain. Check the sending account's balance. |
| <a id="error-SOLANA_MINT_DECIMALS_MISMATCH"></a>`SOLANA_MINT_DECIMALS_MISMATCH` | 422 | no | Mint decimals changed | Plan the intent again. |
| <a id="error-SOLANA_MINT_NOT_FOUND"></a>`SOLANA_MINT_NOT_FOUND` | 422 | no | Mint not found | Use a mint that exists on this network. |
| <a id="error-SOLANA_PRICE_IMPACT_TOO_HIGH"></a>`SOLANA_PRICE_IMPACT_TOO_HIGH` | 422 | no | Price impact too high | Move a smaller amount; routes above 5% price impact are refused. |
| <a id="error-SOLANA_RECIPIENT_NOT_WALLET"></a>`SOLANA_RECIPIENT_NOT_WALLET` | 422 | no | Recipient is not a wallet | Send to a wallet address, not a program or token account. |
| <a id="error-SOLANA_TOKEN_UNKNOWN"></a>`SOLANA_TOKEN_UNKNOWN` | 422 | no | Unknown Solana token | Use a listed symbol or the token's mint address. |
| <a id="error-SOURCE_REQUIRED"></a>`SOURCE_REQUIRED` | 422 | no | Departure network needed | No network holds enough of the first step's asset (error.details.candidates lists the balances read). Say where the money starts: a sourceNetwork or "from <network>". |
| <a id="error-SOURCE_UNREACHABLE"></a>`SOURCE_UNREACHABLE` | 422 | no | Cannot start on that network | The first step cannot be funded from sourceNetwork (another capital lane, an asset that is not there, or no bridge for the pair); error.details names both networks. Start elsewhere. |
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
| <a id="error-APPROVAL_RESET_REQUIRED"></a>`APPROVAL_RESET_REQUIRED` | 422 | no | Allowance reset required | This token (Ethereum USDT) refuses a new approval over a non-zero allowance. Revoke the current allowance in your wallet, then plan again. |
| <a id="error-ORDER_NETWORK_REQUIRED"></a>`ORDER_NETWORK_REQUIRED` | 422 | no | Order network required | Both assets exist on several networks. Add network (solana, ethereum, arbitrum or base). |
| <a id="error-ORDER_UNSUPPORTED"></a>`ORDER_UNSUPPORTED` | 422 | no | Order not supported | Native orders run on Solana (Jupiter) and on Ethereum, Arbitrum and Base (CoW Protocol). error.details.reason names what is missing, e.g. a Safe for TWAP. |
| <a id="error-VENUE_UNVERIFIED"></a>`VENUE_UNVERIFIED` | 422 | no | Venue failed verification | The venue's on-chain state no longer matches Kletia's pinned registry (factory, asset, comptroller, gates). Choose another venue. |
| <a id="error-WEBHOOK_URL_FORBIDDEN"></a>`WEBHOOK_URL_FORBIDDEN` | 422 | no | Webhook URL refused | Use a public HTTPS endpoint on port 443 or 8443; private, loopback and metadata hosts are refused. |
| <a id="error-WEBHOOK_URL_UNRESOLVABLE"></a>`WEBHOOK_URL_UNRESOLVABLE` | 422 | no | Webhook host does not resolve | Use a host name with public DNS records. |
| <a id="error-PREDICTION_MARKET_CLOSED"></a>`PREDICTION_MARKET_CLOSED` | 422 | no | Prediction market not trading | The market is closed, resolved or not accepting orders. Redeem resolved shares with POST /v1/predictions/redeem, or pick another market. |
| <a id="error-PREDICTION_OUTCOME_UNKNOWN"></a>`PREDICTION_OUTCOME_UNKNOWN` | 422 | no | Outcome not in the market | Use an outcome label the market lists (GET /v1/predictions/markets/{id}: outcomes[].label). |
| <a id="error-PREDICTION_VENUE_DISABLED"></a>`PREDICTION_VENUE_DISABLED` | 422 | no | Prediction venue not added | Kletia builds nothing for this venue (GET /v1/predictions/markets lists venues with disabledReason). Use Polymarket. |
| <a id="error-PREDICTION_STAKE_TOO_HIGH"></a>`PREDICTION_STAKE_TOO_HIGH` | 422 | no | Stake above the cap | Lower the stake to the rule book's predictions.maxStakeUsd (error message), or ask a project key to raise it. |
| <a id="error-PREDICTION_ORDER_TOO_SMALL"></a>`PREDICTION_ORDER_TOO_SMALL` | 422 | no | Order below the venue minimum | The order buys or sells fewer shares than the market's minimum order size; raise the amount. |
| <a id="error-PREDICTION_ACCOUNT_UNSUPPORTED"></a>`PREDICTION_ACCOUNT_UNSUPPORTED` | 422 | no | Account kind not supported for trading | Kletia trades Polymarket only from a plain wallet (EOA) on Polygon that signs its own orders. Smart wallets (Polymarket Deposit, Proxy and Safe wallets) can read positions only. |
| <a id="error-PREDICTION_BALANCE_TOO_LOW"></a>`PREDICTION_BALANCE_TOO_LOW` | 422 | no | Not enough pUSD or shares | Polymarket settles in pUSD on Polygon: hold enough pUSD (or USDC.e, which prepare wraps), or the shares you sell. The message lists the balances read. |
| <a id="error-PREDICTION_POSITION_NOT_FOUND"></a>`PREDICTION_POSITION_NOT_FOUND` | 422 | no | No such position | The account holds no shares of that outcome. Read GET /v1/predictions/positions. |
| <a id="error-PREDICTION_NOT_RESOLVED"></a>`PREDICTION_NOT_RESOLVED` | 422 | no | Market not resolved | Shares redeem only after the market resolves on-chain. Sell them instead, or wait for the resolution. |
| <a id="error-PREDICTION_RELAY_REJECTED"></a>`PREDICTION_RELAY_REJECTED` | 422 | no | Venue refused the order | The venue refused the order (balance, allowance, price, size or market state): the message says why. Prepare again after fixing it. |

### Verification (submitted references and step failures)

| Code | Status | Retry | Meaning | What to do |
|---|---|---|---|---|
| <a id="error-CONTRACT_CHANGED_DURING_EXECUTION"></a>`CONTRACT_CHANGED_DURING_EXECUTION` | step | no | Contract changed during execution | The contract's code or implementation differed at the receipt block. The step is indeterminate and the registration suspended; inspect the transaction. |
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
| <a id="error-SETTLEMENT_MISMATCH"></a>`SETTLEMENT_MISMATCH` | step | no | Fill does not match the quote | The fill differs from the quote. If observedCredit is set, that amount is in the recipient's wallet on the destination; otherwise contact support with the intent id. |
| <a id="error-SETTLEMENT_REFUNDED"></a>`SETTLEMENT_REFUNDED` | step | no | Settlement refunded | The bridge refunded the deposit on the source network. Plan a new intent. |

### Rate limits

| Code | Status | Retry | Meaning | What to do |
|---|---|---|---|---|
| <a id="error-RATE_LIMITED"></a>`RATE_LIMITED` | 429 | yes | Rate limited | Wait for Retry-After seconds. Use an API key for higher limits. |
| <a id="error-TOO_MANY_STREAMS"></a>`TOO_MANY_STREAMS` | 429 | yes | Too many event streams | Close an open event stream; at most 10 per key and per IP. |

### Upstream providers and networks

| Code | Status | Retry | Meaning | What to do |
|---|---|---|---|---|
| <a id="error-ACTION_ENDPOINT_UNAVAILABLE"></a>`ACTION_ENDPOINT_UNAVAILABLE` | 502 | yes | Action server unavailable | The integrator's Solana Action server did not answer in time, failed, or sent too much. Retry shortly. |
| <a id="error-ACTION_RESPONSE_INVALID"></a>`ACTION_RESPONSE_INVALID` | 502 | yes | Invalid action response | The integrator's Solana Action server returned malformed JSON or an error. Retry shortly; the integrator may need to fix it. |
| <a id="error-DEX_INSTRUCTION_INVALID"></a>`DEX_INSTRUCTION_INVALID` | 502 | yes | Invalid direct DEX instructions | The provider returned a malformed or unsupported instruction bundle. Request a fresh route. |
| <a id="error-DEX_QUOTE_MISMATCH"></a>`DEX_QUOTE_MISMATCH` | 502 | yes | Direct DEX quote mismatch | The provider quote does not match the requested venue, mints, amount or slippage. Request a fresh quote. |
| <a id="error-JUPITER_QUOTE_INVALID"></a>`JUPITER_QUOTE_INVALID` | 502 | yes | Jupiter quote refused | Retry shortly. |
| <a id="error-JUPITER_QUOTE_MISMATCH"></a>`JUPITER_QUOTE_MISMATCH` | 502 | yes | Jupiter quote mismatch | Jupiter returned a quote for another request. Retry shortly. |
| <a id="error-JUPITER_SWAP_INVALID"></a>`JUPITER_SWAP_INVALID` | 502 | yes | Jupiter swap refused | Retry shortly. |
| <a id="error-LINK_DELIVERY_UNQUOTABLE"></a>`LINK_DELIVERY_UNQUOTABLE` | 502 | yes | Delivery could not be sized | No quote delivered at least the fixed amount within three tries. Retry shortly, or start from another network. |
| <a id="error-ORDER_RELAY_FAILED"></a>`ORDER_RELAY_FAILED` | 502 | no | Order relay failed | The protocol did not accept the signed order (error.message has its reason). Prepare the order again. |
| <a id="error-PAYLOAD_INVALID"></a>`PAYLOAD_INVALID` | 502 | yes | Prepared payload refused | The prepared transactions failed Kletia's safety checks and were not returned. Retry shortly. |
| <a id="error-PLAN_TIMEOUT"></a>`PLAN_TIMEOUT` | 504 | yes | Planning timed out | Venues did not quote within the planning deadline. Retry shortly, or ask for fewer steps or networks. |
| <a id="error-PROVIDER_INVALID_JSON"></a>`PROVIDER_INVALID_JSON` | 502 | yes | Invalid provider response | Retry shortly. |
| <a id="error-PROVIDER_RATE_LIMITED"></a>`PROVIDER_RATE_LIMITED` | 503 | yes | Provider rate limit | A routing or data provider (for example Jupiter) is limiting requests right now and Kletia's short retries did not get through. Nothing is wrong with the request: wait for Retry-After seconds and send it again. |
| <a id="error-PROVIDER_REJECTED"></a>`PROVIDER_REJECTED` | 422 / 502 | no | Provider rejected the request | The provider refused this request (422) or failed (502). Also returned as <PROVIDER>_REJECTED, e.g. JUPITER_REJECTED. |
| <a id="error-PROVIDER_RESPONSE_TOO_LARGE"></a>`PROVIDER_RESPONSE_TOO_LARGE` | 502 | yes | Provider response too large | Retry shortly. |
| <a id="error-PROVIDER_TRANSACTION_INVALID"></a>`PROVIDER_TRANSACTION_INVALID` | 502 | no | Provider transaction refused | The provider's transaction failed Kletia's safety checks and was not returned. Retry, or try another route. |
| <a id="error-PROVIDER_TRANSACTION_REJECTED"></a>`PROVIDER_TRANSACTION_REJECTED` | 502 | yes | Provider transaction rejected | The provider's transaction failed simulation or safety checks. Retry shortly or move a different amount. |
| <a id="error-PROVIDER_UNAVAILABLE"></a>`PROVIDER_UNAVAILABLE` | 502 | yes | Provider unavailable | A routing or data provider is temporarily unavailable. Retry shortly. Also returned as <PROVIDER>_UNAVAILABLE, e.g. RELAY_UNAVAILABLE. |
| <a id="error-RELAY_QUOTE_INVALID"></a>`RELAY_QUOTE_INVALID` | 502 | yes | Relay quote refused | Relay returned a quote that failed Kletia's checks. Retry shortly. |
| <a id="error-RPC_TIMEOUT"></a>`RPC_TIMEOUT` | 504 | yes | Network read timed out | Retry shortly. |
| <a id="error-HISTORY_PROVIDER_UNAVAILABLE"></a>`HISTORY_PROVIDER_UNAVAILABLE` | 502 | yes | History provider unavailable | Etherscan, Alchemy, Helius or the Solana RPC refused or failed the read (error.message says which and why). Retry shortly; the other accounts of the listing are unaffected. |
| <a id="error-RPC_UNAVAILABLE"></a>`RPC_UNAVAILABLE` | 502 | yes | Network read failed | A network RPC is temporarily unavailable. Retry shortly. |
| <a id="error-SIMULATION_UNVERIFIED"></a>`SIMULATION_UNVERIFIED` | 502 | yes | Direct DEX simulation unverified | The RPC simulation lacks the required reviewed pool CPI evidence. Use a complete RPC simulation or another venue. |
| <a id="error-SOLANA_FOREIGN_SIGNER"></a>`SOLANA_FOREIGN_SIGNER` | 502 | no | Unexpected signer | The provider's instructions required another signer and were refused. Retry, or try another route. |
| <a id="error-SOLANA_INSTRUCTION_INVALID"></a>`SOLANA_INSTRUCTION_INVALID` | 502 | yes | Provider instruction refused | The provider's instructions failed Kletia's checks. Retry shortly. |
| <a id="error-SOLANA_RPC_UNAVAILABLE"></a>`SOLANA_RPC_UNAVAILABLE` | 502 | yes | Solana RPC unavailable | Retry shortly. |
| <a id="error-UPSTREAM_TIMEOUT"></a>`UPSTREAM_TIMEOUT` | 504 | yes | Provider timed out | Retry shortly. |
| <a id="error-VENUE_TIMEOUT"></a>`VENUE_TIMEOUT` | 504 | yes | Venue timed out | A venue did not quote in time. Retry shortly. |

### Unavailable

| Code | Status | Retry | Meaning | What to do |
|---|---|---|---|---|
| <a id="error-CONTRACTS_DISABLED"></a>`CONTRACTS_DISABLED` | 503 | yes | Custom contracts unavailable | Custom contract and Solana Action steps are disabled on this deployment, or need an API key. Retry later, use a key, or plan without them. |
| <a id="error-LINKS_DISABLED"></a>`LINKS_DISABLED` | 503 | yes | Links unavailable | Intent links are switched off on this deployment. Retry later. |
| <a id="error-LINK_PAGE_UNAVAILABLE"></a>`LINK_PAGE_UNAVAILABLE` | 503 | yes | Link page unavailable | The page shell could not be loaded. Retry shortly; the link itself is unaffected. |
| <a id="error-NAME_RESOLUTION_UNAVAILABLE"></a>`NAME_RESOLUTION_UNAVAILABLE` | 503 | yes | Name records unavailable | The name's records could not be read. Retry shortly, or use an address. |
| <a id="error-PERPS_PRICE_UNAVAILABLE"></a>`PERPS_PRICE_UNAVAILABLE` | 503 | yes | Perps price unavailable | The venue's mark or oracle price is missing or stale, so Kletia neither quotes nor builds (fail closed). Retry shortly. |
| <a id="error-POLICY_PRICE_UNAVAILABLE"></a>`POLICY_PRICE_UNAVAILABLE` | 503 | yes | Price unavailable for a USD rule | A USD rule of the rule book needs an amount no fresh price source covers, so it fails closed. Retry shortly, or use a listed asset. |
| <a id="error-ASSISTANT_MODEL_NOT_CONFIGURED"></a>`ASSISTANT_MODEL_NOT_CONFIGURED` | 503 | no | Assistant model not configured | The operator must set KLETIA_ASSISTANT=on, KLETIA_ASSISTANT_MODELS, KLETIA_ASSISTANT_PROFILES and OPENROUTER_API_KEY. Questions are still answered without a model where the parser can read them. |
| <a id="error-RECEIPTS_DISABLED"></a>`RECEIPTS_DISABLED` | 503 | yes | Receipts unavailable | Receipts are switched off or no signing key is configured on this deployment. Retry later; reads of existing receipts keep working. |
| <a id="error-SIMULATION_UNAVAILABLE"></a>`SIMULATION_UNAVAILABLE` | 503 | yes | Simulation unavailable | No configured endpoint can simulate on this network now, and Kletia never prepares a custom contract step unsimulated. Retry shortly. |
| <a id="error-STORE_UNAVAILABLE"></a>`STORE_UNAVAILABLE` | 503 | yes | Storage unavailable | Retry shortly. Presented API keys cannot be verified meanwhile. |
| <a id="error-HISTORY_NOT_CONFIGURED"></a>`HISTORY_NOT_CONFIGURED` | 503 | no | History provider not configured | The operator must set ETHERSCAN_API_KEY (or ALCHEMY_API_KEY) for EVM history; Solana history works without a key (HELIUS_API_KEY makes it faster). |
| <a id="error-DATA_TRACKING_FULL"></a>`DATA_TRACKING_FULL` | 503 | yes | Tracking full | This instance holds no more tracked sets in memory. Retry later; deployments with a database have no such limit. |
| <a id="error-WEBHOOKS_NOT_CONFIGURED"></a>`WEBHOOKS_NOT_CONFIGURED` | 503 | no | Webhooks not configured | The operator must set KLETIA_PLATFORM_SECRET (at least 32 characters). |
| <a id="error-PREDICTION_PRICE_UNAVAILABLE"></a>`PREDICTION_PRICE_UNAVAILABLE` | 503 | yes | Order book unavailable | The outcome's order book is empty on the side the order takes, unreadable or stale, so Kletia neither quotes nor builds (fail closed). Retry shortly, or place a limit order. |
| <a id="error-PREDICTION_SESSION_UNAVAILABLE"></a>`PREDICTION_SESSION_UNAVAILABLE` | 503 | no | Venue sessions unavailable | This server cannot seal venue credentials (KLETIA_PLATFORM_SECRET is not configured), so it relays no order. Reads, quotes and prepare still work. |

### Internal

| Code | Status | Retry | Meaning | What to do |
|---|---|---|---|---|
| <a id="error-ADAPTERS_INVALID"></a>`ADAPTERS_INVALID` | 500 | yes | Adapter configuration invalid | The operator configured an invalid adapter set. |
| <a id="error-INTERNAL_ERROR"></a>`INTERNAL_ERROR` | 500 | yes | Internal error | Retry later. If it persists, report it with the requestId. |
| <a id="error-LINK_PLAN_OUT_OF_BOUNDS"></a>`LINK_PLAN_OUT_OF_BOUNDS` | 500 | no | Plan left the link's envelope | The planned intent did not match the link's fixed networks, recipients, contracts or input, so nothing was stored. Report it with the requestId. |
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
