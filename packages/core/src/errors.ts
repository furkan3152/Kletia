/**
 * Error catalog for Platform API v1.
 *
 * Every `error.code` the API returns, and every `step.failure.code` an intent
 * step can carry, is listed here with its HTTP status, a category, whether
 * repeating the same request later can succeed, and what to do about it. The
 * API serves this table at `GET /v1/errors`, links each error to
 * `https://kletiaai.xyz/developers#error-<CODE>`, and a drift test keeps it in
 * step with the codes the API source can emit.
 *
 * Provider failures are reported with the provider in the code
 * (`RELAY_UNAVAILABLE`, `JUPITER_REJECTED`, ...). Those dynamic codes resolve
 * to their family entry (`PROVIDER_UNAVAILABLE`, `PROVIDER_REJECTED`) through
 * `resolveErrorCode`.
 */

export type KletiaErrorStatus = 400 | 401 | 403 | 404 | 405 | 409 | 410 | 413 | 415 | 422 | 429 | 500 | 502 | 503 | 504;

export const ERROR_CATEGORIES = [
  "request",
  "authentication",
  "permission",
  "not_found",
  "conflict",
  "expired",
  "intent",
  "verification",
  "settlement",
  "rate_limit",
  "upstream",
  "unavailable",
  "internal",
] as const;

export type KletiaErrorCategory = (typeof ERROR_CATEGORIES)[number];

export interface ErrorCatalogEntry {
  /** HTTP status when the code is returned as an API error; null when it only appears as `step.failure.code`. */
  readonly status: KletiaErrorStatus | null;
  /** Further statuses the same code is returned with on another path (rare; e.g. an internal invariant). */
  readonly otherStatuses?: readonly KletiaErrorStatus[];
  readonly category: KletiaErrorCategory;
  /** True when repeating the same request later can succeed without changing it. */
  readonly retryable: boolean;
  /** Also reported as `step.failure.code` on an intent step. */
  readonly step?: boolean;
  readonly title: string;
  readonly remedy: string;
}

type Entry = ErrorCatalogEntry;

const request = (title: string, remedy: string, status: KletiaErrorStatus = 400, extra: Partial<Entry> = {}): Entry => ({
  status,
  category: "request",
  retryable: false,
  title,
  remedy,
  ...extra,
});
const intent = (title: string, remedy: string, extra: Partial<Entry> = {}): Entry => ({
  status: 422,
  category: "intent",
  retryable: false,
  title,
  remedy,
  ...extra,
});
const conflict = (title: string, remedy: string, retryable = false, extra: Partial<Entry> = {}): Entry => ({
  status: 409,
  category: "conflict",
  retryable,
  title,
  remedy,
  ...extra,
});
const upstream = (title: string, remedy: string, status: KletiaErrorStatus = 502, extra: Partial<Entry> = {}): Entry => ({
  status,
  category: "upstream",
  retryable: true,
  title,
  remedy,
  ...extra,
});
const internal = (title: string, remedy = "Retry later. If it persists, report it with the requestId."): Entry => ({
  status: 500,
  category: "internal",
  retryable: true,
  title,
  remedy,
});
const verification = (title: string, remedy: string, status: KletiaErrorStatus | null = 422): Entry => ({
  status,
  category: "verification",
  retryable: false,
  step: true,
  title,
  remedy,
});

const RESUBMIT = "Submit the hashes or signatures of the transactions prepared for this step, sent by the step account.";

export const ERROR_CATALOG = {
  /* ------------------------------------------------------------ request */
  INVALID_REQUEST: request("Invalid request", "Fix the fields listed in error.issues and send the request again."),
  INVALID_JSON: request("Malformed JSON", "Send a JSON object or array as the request body."),
  INVALID_REQUEST_BODY: request("Unreadable request body", "Send a complete UTF-8 JSON body with a correct Content-Length."),
  PAYLOAD_TOO_LARGE: request("Request body too large", "Keep request bodies under 64 KB.", 413),
  UNSUPPORTED_MEDIA_TYPE: request("Unsupported media type", "Send request bodies as UTF-8 application/json.", 415),
  METHOD_NOT_ALLOWED: request("Method not allowed", "Use one of the methods listed in the Allow header.", 405),
  NOT_FOUND: { status: 404, category: "not_found", retryable: false, title: "Unknown route", remedy: "Check the path against GET /v1/openapi.json." },
  AMOUNT_REQUIRED: request("Amount required", "Give every action an amount (a decimal, or max on a dependent step)."),
  ACCOUNT_INVALID: request("Invalid account", "Send accounts as CAIP-10 ids such as eip155:8453:0x… or solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:<address>.", 400, {
    otherStatuses: [500],
  }),
  REFERENCES_INVALID: request("Invalid references", "Send { \"references\": [...] } with one transaction hash or signature per prepared transaction."),
  REFERENCE_INVALID: request("Invalid reference", "Send a 0x-prefixed 32-byte hash for EVM steps or a base58 signature for Solana steps."),
  REFERENCE_COUNT_MISMATCH: request("Wrong number of references", "Submit exactly one reference per prepared transaction, in order."),
  IDEMPOTENCY_KEY_INVALID: request("Invalid Idempotency-Key", "Use 1-128 characters from A-Z a-z 0-9 _ . : - (optionally as a quoted string), for example a UUID."),
  IDEMPOTENCY_KEY_REQUIRES_API_KEY: request("Idempotency-Key needs an API key", "Send the request with an API key, or drop the Idempotency-Key header on the public tier."),
  IDEMPOTENCY_NOT_SUPPORTED: request("Idempotency-Key not supported here", "Drop the Idempotency-Key header on this endpoint; prepare re-quotes on every call."),
  SOLANA_ADDRESS_INVALID: request("Invalid Solana address", "Use a base58 Solana address."),
  SOLANA_AMOUNT_INVALID: request("Invalid Solana amount", "Use a positive amount within the token's precision."),
  SOLANA_MINT_INVALID: request("Invalid SPL mint", "Use the mint address of an SPL token on this network.", 400, { otherStatuses: [422] }),
  SOLANA_SIGNATURE_INVALID: request("Invalid Solana signature", "Submit the base58 signature of the sent transaction."),
  SOLANA_SELF_TRANSFER: request("Transfer to self", "Send to a different account."),
  SOLANA_SWAP_SAME_TOKEN: request("Swap to the same token", "Choose different input and output tokens."),
  SOLANA_SLIPPAGE_OUT_OF_RANGE: request("Slippage out of range", "Use a slippage between 1 and 1000 basis points."),
  CONTRACT_DEFINITION_INVALID: request("Invalid contract definition", "Fix the fields listed in error.issues. validateContractDefinition in @kletia/core reports the same issues locally."),
  ACTION_URL_FORBIDDEN: request("Action URL refused", "Use public HTTPS URLs on the registered origin (port 443 or 1024+); private, loopback, credential and redirecting URLs are refused.", 422),
  POLICY_INVALID: request("Invalid rule book", "Fix the fields listed in error.issues. validatePolicy in @kletia/core reports the same issues locally."),
  LINK_DEFINITION_INVALID: request("Invalid link definition", "Fix the fields listed in error.issues. validateLinkDefinition in @kletia/core reports the same issues locally."),
  LINK_IMMUTABLE_FIELD: request("Link field cannot change", "A link's promise only tightens: raise min, lower max, remove sources, lower uses, expire earlier or turn the blink off. Create a new link for anything else.", 422),
  RECEIPT_ANCHOR_INVALID: request("Anchor transaction refused", "The reported transaction is not a successful EAS timestamp(batchDigest) call for this batch on Base. Report the transaction that timestamped it.", 422),

  /* ------------------------------------------------------ authentication */
  API_KEY_REQUIRED: { status: 401, category: "authentication", retryable: false, title: "API key required", remedy: "Issue a key with POST /v1/keys and send it as Authorization: Bearer <key>." },
  INVALID_API_KEY: { status: 401, category: "authentication", retryable: false, title: "Invalid or revoked API key", remedy: "Check the key, or issue a new one. Revoked and expired rotated keys stop working within 15 seconds." },
  INVALID_AUTHORIZATION: { status: 401, category: "authentication", retryable: false, title: "Malformed credentials", remedy: "Send Authorization: Bearer <key> or X-Kletia-Key: <key>, not both with different keys." },
  KEY_SECRET_ROTATED: { status: 403, category: "permission", retryable: false, title: "Rotated key secret", remedy: "This secret still authenticates during its grace window but cannot manage keys. Use the current secret." },
  MCP_ORIGIN_FORBIDDEN: { status: 403, category: "permission", retryable: false, title: "Origin not allowed for MCP", remedy: "Call /v1/mcp without an Origin header (server-side agents) or from an allowed HTTPS origin." },
  CONTRACT_DENIED: { status: 422, category: "permission", retryable: false, title: "Contract not allowed", remedy: "Tokens, routers, Permit2, Multicall3, precompiles, system contracts and deny-listed addresses can never be registered or called. Register the contract that performs the action." },
  SESSION_ORIGIN_FORBIDDEN: { status: 403, category: "permission", retryable: false, title: "Origin not allowed for this session", remedy: "Embed the session only on one of its allowedOrigins, or create a session that lists this origin." },
  POLICY_VIOLATION: { status: 403, category: "permission", retryable: false, title: "Refused by the rule book", remedy: "error.policy lists every violated rule id, the key whose rule book refused, the observed value and the limit. Change the request; splitting it or adding accounts does not help." },
  POLICY_SPEND_LIMIT: { status: 403, category: "permission", retryable: true, title: "Spend cap reached", remedy: "A rolling 24 h or 7 d USD cap of the key, an ancestor or the project is used up. Retry after Retry-After (error.policy.retryAt), or ask a project key to raise the cap." },
  POLICY_SCHEDULE_CLOSED: { status: 403, category: "permission", retryable: true, title: "Outside the rule book's timetable", remedy: "Payloads are prepared only inside the timetable's windows. Retry after Retry-After seconds, when the next window opens." },
  POLICY_OWNER_REVOKED: { status: 403, category: "permission", retryable: false, title: "Intent owner key revoked", remedy: "The key that owns this intent, or one of its ancestors, is revoked or expired, so nothing more is prepared. Steps already submitted keep settling." },
  POLICY_APPROVAL_REQUIRED: { status: 403, category: "permission", retryable: true, title: "Approval required", remedy: "The intent is on hold for an approver. Share error.policy.approval.url with an approver; retry after Retry-After once it is approved." },
  POLICY_APPROVAL_REJECTED: { status: 403, category: "permission", retryable: false, title: "Approval rejected", remedy: "An approver rejected this intent and it was cancelled. Plan a new intent if appropriate." },
  AGENT_KEY_FORBIDDEN: { status: 403, category: "permission", retryable: false, title: "Not allowed for agent keys", remedy: "Agent keys never manage project keys or rule books, and need the matching permission (webhooks, registerContracts, sessions, createChildKeys, links) for the rest. Use a project key." },
  APPROVAL_SIGNATURE_INVALID: { status: 403, category: "permission", retryable: false, title: "Approval signature invalid", remedy: "Sign the exact typed data (EIP-712 \"Kletia Approvals\") or message text of this approval with the listed wallet, before it expires." },
  APPROVER_NOT_ALLOWED: { status: 403, category: "permission", retryable: false, title: "Not an approver of this intent", remedy: "Approve with an active project key outside the requester's subtree, or with a wallet the rule book lists. Agent keys never approve, and requireWallet refuses keys." },
  LINK_POLICY_CONFLICT: { status: 422, category: "permission", retryable: false, title: "Link outside the key's rule book", remedy: "The link reaches networks, assets, recipients, contracts or amounts the publisher key's rule book refuses (rule ids in error.issues). Tighten the link or use another key." },

  /* ---------------------------------------------------------------- keys */
  KEY_NOT_FOUND: { status: 404, category: "not_found", retryable: false, title: "API key not found", remedy: "List your project's keys with GET /v1/keys; only active keys of your own project can be managed." },
  KEY_NOT_MANAGEABLE: conflict("Operator keys are immutable", "Operator keys come from server configuration; change KLETIA_OPERATOR_API_KEYS instead."),
  KEY_LIMIT_REACHED: conflict("Too many active keys", "A project holds at most 5 active keys. Revoke one with DELETE /v1/keys/{id} first."),
  KEY_COLLISION: conflict("Key generation collided", "Send the request again.", true),

  /* ----------------------------------------------------------- not found */
  INTENT_NOT_FOUND: { status: 404, category: "not_found", retryable: false, title: "Intent not found", remedy: "Check the intent id. Dry runs are never stored." },
  STEP_NOT_FOUND: { status: 404, category: "not_found", retryable: false, title: "Step not found", remedy: "Use a step id from intent.steps (s1, s2, ...)." },
  WEBHOOK_NOT_FOUND: { status: 404, category: "not_found", retryable: false, title: "Webhook not found", remedy: "List your webhooks with GET /v1/webhooks; each key sees only its own." },
  CONTRACT_NOT_FOUND: { status: 404, category: "not_found", retryable: false, title: "Contract registration not found", remedy: "List registrations with GET /v1/contracts; a key sees its own and the project-visible ones of its project." },
  SESSION_NOT_FOUND: { status: 404, category: "not_found", retryable: false, title: "Session not found", remedy: "Check the session id. Sessions are created by the integrator's backend with POST /v1/sessions." },
  RECEIPT_NOT_FOUND: { status: 404, category: "not_found", retryable: false, title: "Receipt not found", remedy: "Unknown or unshared receipts look the same. The intent's owner reads receipts with GET /v1/intents/{id}/receipt and shares them." },
  RECEIPT_SHARE_NOT_FOUND: { status: 404, category: "not_found", retryable: false, title: "Receipt share not found", remedy: "The share link is unknown or was revoked. Ask the receipt's owner for a new link." },
  RECEIPT_LOG_NOT_FOUND: { status: 404, category: "not_found", retryable: false, title: "Log batch not found", remedy: "List batches with GET /v1/receipts/log; batches close hourly, and an unbatched digest has no inclusion yet." },
  POLICY_NOT_FOUND: { status: 404, category: "not_found", retryable: false, title: "Rule book not found", remedy: "This key or project has no rule book (or no pending amendment to cancel). Create one with PUT /v1/keys/{id}/policy." },
  APPROVAL_NOT_FOUND: { status: 404, category: "not_found", retryable: false, title: "Approval not found", remedy: "Check the approval id from the link (/approve#apr_…) or error.policy.approval." },
  LINK_NOT_FOUND: { status: 404, category: "not_found", retryable: false, title: "Link not found", remedy: "Check the link id (lk_ + 24 hex). A key lists its own links with GET /v1/links." },
  PREVIEW_NOT_FOUND: { status: 404, category: "not_found", retryable: false, title: "No preview yet", remedy: "Compute one with POST /v1/intents/{id}/preview, or create the intent with ?preview=true." },

  /* ------------------------------------------------------------ conflict */
  INTENT_CONFLICT: conflict("Concurrent update", "The intent changed while the request ran. Read it again and retry.", true),
  INTENT_EXISTS: conflict("Intent id collision", "Send the request again.", true),
  CLIENT_REFERENCE_EXISTS: conflict("clientReference already used", "Use a new clientReference, or read the existing intent."),
  INTENT_CANCELLED: conflict("Intent cancelled", "Create a new intent."),
  INTENT_COMPLETED: conflict("Intent completed", "Nothing is left to execute."),
  INTENT_NOT_CANCELLABLE: conflict("Intent cannot be cancelled", "A step was already submitted; follow it to settlement instead."),
  QUOTE_MOVED: conflict("Price moved", "The price moved beyond the slippage limit since planning. Create a new intent to re-quote."),
  STEP_NOT_READY: conflict("Step not ready", "Wait until the steps it depends on have settled, then prepare it.", true),
  STEP_NOT_PREPARABLE: conflict("Step cannot be prepared", "Only ready or awaiting_signature steps can be prepared."),
  STEP_NOT_AWAITING_SIGNATURE: conflict("Step not awaiting a signature", "Prepare the step before submitting references."),
  STEP_TRANSITION_INVALID: conflict("Invalid step transition", "Read the intent again; the step already moved on."),
  WEBHOOK_EXISTS: conflict("Webhook already registered", "A webhook with this URL already exists for this key."),
  WEBHOOK_LIMIT_REACHED: conflict("Too many webhooks", "A key can register at most 10 webhooks. Delete one first."),
  IDEMPOTENCY_REQUEST_IN_PROGRESS: conflict("Request with this key in progress", "The first request with this Idempotency-Key is still running. Retry after Retry-After seconds.", true),
  RECIPIENT_NAME_CHANGED: conflict("Recipient name changed", "The recipient's name now resolves to another address. Create a new intent to pay the new address."),
  CONTRACT_EXISTS: conflict("Contract already registered", "This key already registered this address (or origin) on this network. Change it with PATCH /v1/contracts/{id}."),
  CONTRACT_LIMIT_REACHED: conflict("Too many contract registrations", "A key holds at most 25 registrations. Delete one with DELETE /v1/contracts/{id} first."),
  CONTRACT_PENDING: conflict("Contract pending activation", "Mainnet registrations and security-relevant revisions activate after a delay. Retry after Retry-After seconds; POST /v1/contracts/{id}/test works meanwhile.", true),
  CONTRACT_SUSPENDED: conflict("Contract suspended", "The registration is suspended (code change, outcome mismatch or operator). Inspect it with GET /v1/contracts/{id}; after an intended upgrade call reverify."),
  CONTRACT_NOT_USABLE: conflict("Contract not usable by this intent", "The intent's API key may no longer use this registration (deleted, or visibility changed). Create a new intent with a key that may use it."),
  CONTRACT_CHANGED: conflict("Contract code changed", "The contract's code or proxy implementation no longer matches its pins, so the registration is suspended. The integrator must inspect it and call reverify."),
  CONTRACT_REVISION_CHANGED: conflict("Contract revision changed", "A newer revision of the registration is active than the one this intent was planned on. Create a new intent."),
  PROGRAM_CHANGED: conflict("Program changed", "An allowlisted program was redeployed or changed upgrade authority, so the registration is suspended until the integrator calls reverify."),
  SESSION_USED: conflict("Session already used", "The session reached its maxIntents. Ask the integrator's backend for a new session."),
  RECEIPT_NOT_READY: conflict("Receipt not ready", "Receipts are issued after the intent ends and every anchor is finalized. Retry later; GET /v1/intents/{id}/receipt answers 202 with expectedBy meanwhile.", true),
  RECEIPT_NOT_APPLICABLE: conflict("No receipt for this intent", "Expired intents executed nothing, so they get no receipt."),
  RECEIPT_SHARE_LIMIT: conflict("Too many receipt shares", "A receipt has at most 10 active shares. Revoke one first."),
  RECEIPT_ANCHOR_EXISTS: conflict("Batch already anchored", "This log batch already has an anchoring transaction on record."),
  POLICY_APPROVAL_STALE: conflict("Approval no longer covers the intent", "Fresh prices put the intent above the approved ceiling. Plan a new intent and ask for a new approval."),
  POLICY_CONFLICT: conflict("Rule book changed", "The If-Match hash is not the current version. Read the rule book again and resend the change."),
  POLICY_AMENDMENT_PENDING: conflict("Amendment pending", "A loosening amendment is waiting to activate. Cancel it with DELETE …/policy/pending first, or wait for activatesAt."),
  AGENT_KEY_LIMIT_REACHED: conflict("Too many agent keys", "A project holds at most 100 active agent keys. Revoke one first."),
  KEY_DEPTH_EXCEEDED: conflict("Agent key tree too deep", "Agent keys sit at most 2 levels below a project key. Create the key under a shallower parent."),
  APPROVAL_DECIDED: conflict("Approval already decided", "The approval was already approved, rejected or expired; a decision is final. Read it with GET /v1/policy/approvals/{id}."),
  LINK_LIMIT_REACHED: conflict("Too many links", "A key holds at most 200 active links and creates at most 60 an hour. Delete or let some expire first."),
  LINK_PENDING: conflict("Link not active yet", "Links that pay a fixed third party or call a custom contract activate after a delay. Retry after Retry-After seconds.", true),
  LINK_PAUSED: conflict("Link paused", "The publisher paused the link, or it paused itself because a pinned recipient name or contract changed. Ask the publisher."),
  LINK_SUSPENDED: conflict("Link suspended", "Kletia suspended the link. Funds of steps already completed are in your wallet."),
  LINK_EXHAUSTED: conflict("Link used up", "Every use of the link is reserved or consumed. Uses of abandoned intents are released, so retry later.", true),
  LINK_ACCOUNT_LIMIT: conflict("Account used this link enough", "This account reached the link's per-account limit."),
  LINK_RECIPIENT_CHANGED: conflict("Link recipient changed", "A pinned recipient name now resolves elsewhere, so the link paused itself. The publisher must review and resume it."),
  LINK_CONTRACT_CHANGED: conflict("Link contract changed", "The pinned contract registration has a newer revision, so the link paused itself. The publisher must review and resume it."),
  PREVIEW_CHANGED: conflict("Preview changed", "The fresh simulation is materially worse than the preview you acknowledged (error.preview, changes in error.issues). Show it again and prepare with its digest."),

  /* ------------------------------------------------------------- expired */
  INTENT_EXPIRED: { status: 410, category: "expired", retryable: false, title: "Intent expired", remedy: "The plan expired before execution started. Create a new intent to re-quote." },
  DEADLINE_PASSED: { status: 410, otherStatuses: [422], category: "expired", retryable: false, title: "Deadline passed", remedy: "constraints.deadline is in the past. Plan again with a later deadline." },
  SESSION_EXPIRED: { status: 410, category: "expired", retryable: false, title: "Session expired", remedy: "Sessions live 60-3600 seconds. Ask the integrator's backend for a new session." },
  RECEIPT_SHARE_EXPIRED: { status: 410, category: "expired", retryable: false, title: "Receipt share expired", remedy: "The share link expired. Ask the receipt's owner for a new link." },
  RECEIPT_DISCLOSURES_WITHDRAWN: { status: 410, category: "expired", retryable: false, title: "Receipt disclosures withdrawn", remedy: "The owner withdrew this intent's disclosures, so no share can be created. The signed payloads remain." },
  POLICY_APPROVAL_EXPIRED: { status: 410, category: "expired", retryable: false, title: "Approval expired", remedy: "Nobody decided the approval in time. Plan a new intent to ask again." },
  LINK_EXPIRED: { status: 410, category: "expired", retryable: false, title: "Link expired or withdrawn", remedy: "The link expired or its publisher withdrew it. Ask the publisher for a new link." },

  /* -------------------------------------------------------------- intent */
  INTENT_UNSUPPORTED: intent("Intent not supported", "Rephrase using one of the examples in error.hints, or send structured actions."),
  ACCOUNT_REQUIRED: intent("Account missing", "Add a CAIP-10 account for every network the intent touches."),
  ACCOUNT_AMBIGUOUS: intent("Ambiguous account", "Several accounts of this kind were given; add the one to use on this network."),
  AMOUNT_INVALID: intent("Invalid amount", "Use a positive decimal within the asset's precision, or max on a dependent step."),
  AMOUNT_TOO_SMALL: intent("Amount too small", "Increase the amount; it rounds to zero or is below the venue minimum."),
  ASSET_INVALID: intent("Invalid asset", "Use a symbol, an address or mint, or a CAIP-19 id.", { otherStatuses: [500] }),
  ASSET_MISMATCH: intent("Asset mismatch", "A dependent step must spend the asset the previous step produces."),
  ASSET_NETWORK_MISMATCH: intent("Asset on another network", "Use an asset that lives on the step's network, or bridge first."),
  ASSET_REQUIRED: intent("Asset required", "Name the input and output assets."),
  CAPITAL_LANE_MIXED: intent("Mainnet and testnet mixed", "Keep every network of one intent on mainnet, or every one on testnet."),
  FEE_LIMIT_EXCEEDED: intent("Fees above the limit", "Raise constraints.maxFeeUsd or move a larger amount."),
  INSUFFICIENT_BALANCE: intent("Insufficient balance", "Fund the account or lower the amount."),
  NETWORK_UNSUPPORTED: intent("Network not supported", "Use a network from GET /v1/networks that supports this action.", { otherStatuses: [500] }),
  PLAN_INVALID: intent("Plan invalid", "Simplify the intent; at most 8 steps are planned.", { otherStatuses: [502] }),
  POSITION_EMPTY: intent("No position to withdraw", "There is nothing deposited at this venue for the account."),
  PRICE_IMPACT_TOO_HIGH: intent("Price impact too high", "Move a smaller amount; routes that cost more than 5% are refused."),
  RECIPIENT_INVALID: intent("Invalid recipient", "Use an address or CAIP-10 account on the destination network."),
  RECIPIENT_NETWORK_MISMATCH: intent("Recipient on another network", "Use a bridge to move funds across networks."),
  RECIPIENT_REQUIRED: intent("Recipient required", "Name the recipient of the transfer."),
  RECIPIENT_NAME_UNSUPPORTED: intent("Name not supported", "This deployment cannot resolve this kind of name on this network. Use the recipient's address."),
  RECIPIENT_NAME_UNRESOLVED: intent("Name does not resolve", "The name has no address for this network. Use the recipient's address."),
  RELAY_SIGNATURE_STEP_UNSUPPORTED: intent("Off-chain signature step", "This route needs an off-chain signature, which Kletia does not execute. Try another amount or route."),
  RESERVE_UNAVAILABLE: intent("Lending reserve unavailable", "The market is paused, frozen or capped for this asset. Try another asset or venue."),
  ROUTE_UNAVAILABLE: intent("No route", "The venue could not route this request now. Try another amount or asset."),
  ROUTE_UNSUPPORTED: intent("Route not supported", "No venue routes this pair between these networks; see GET /v1/networks."),
  ROUTE_TOO_SLOW: intent("No route fast enough", "Every venue settles slower than constraints.maxSeconds. Raise it or drop the constraint."),
  ROUTE_UNPRICED: intent("Route costs not priceable", "No venue quoted costs Kletia can price for this route. Try another amount or asset."),
  SELF_TRANSFER: intent("Transfer to self", "Send to a different account."),
  SIMULATION_FAILED: intent("Simulation failed", "The transaction would fail on-chain. Check the sending account's balance."),
  SWAP_SAME_ASSET: intent("Swap to the same asset", "Choose different input and output assets."),
  TESTNET_NOT_ALLOWED: intent("Testnets not allowed", "Set constraints.allowTestnets to true to plan on testnets."),
  TOKEN_UNKNOWN: intent("Unknown token", "Use a listed symbol (GET /v1/assets) or the token's address or mint."),
  TOKEN_UNVERIFIED: intent("Unverified token", "Use the token's mint address to proceed deliberately."),
  TOKEN_TRANSFER_FEE_UNSUPPORTED: intent("Transfer-fee token", "Token-2022 mints with transfer fees are not supported."),
  VENUE_UNKNOWN: intent("Unknown venue", "Use a venue listed for this network and protocol (see error.message for known ones)."),
  VENUE_UNSUPPORTED: intent("Venue not executable", "The venue is listed for discovery only. Choose an executable venue."),
  VENUE_ASSET_MISMATCH: intent("Venue holds another asset", "Choose a venue for the asset you are moving."),
  VENUE_UNVERIFIED: intent("Venue failed verification", "The venue's on-chain state no longer matches Kletia's pinned registry (factory, asset, comptroller, gates). Choose another venue."),
  VENUE_ILLIQUID: intent("Venue lacks exit liquidity", "Borrowers hold the venue's funds right now. Withdraw less, use another venue, or retry later."),
  VENUE_BORROW_OPEN: intent("Open borrow on this market", "A supply would repay the account's borrow instead of earning. Repay it first or choose another venue."),
  WEBHOOK_URL_FORBIDDEN: intent("Webhook URL refused", "Use a public HTTPS endpoint on port 443 or 8443; private, loopback and metadata hosts are refused."),
  WEBHOOK_URL_UNRESOLVABLE: intent("Webhook host does not resolve", "Use a host name with public DNS records."),
  JUPITER_SIMULATION_FAILED: intent("Swap simulation failed", "The swap would fail on-chain. Check the balance or try a smaller amount."),
  SOLANA_MINT_DECIMALS_MISMATCH: intent("Mint decimals changed", "Plan the intent again."),
  SOLANA_MINT_NOT_FOUND: intent("Mint not found", "Use a mint that exists on this network."),
  SOLANA_PRICE_IMPACT_TOO_HIGH: intent("Price impact too high", "Move a smaller amount; routes above 5% price impact are refused."),
  SOLANA_RECIPIENT_NOT_WALLET: intent("Recipient is not a wallet", "Send to a wallet address, not a program or token account."),
  SOLANA_TOKEN_UNKNOWN: intent("Unknown Solana token", "Use a listed symbol or the token's mint address."),
  IDEMPOTENCY_KEY_REUSED: intent("Idempotency-Key reused", "This key was used for a different request. Use a new key for a new request."),
  CONTRACT_UNKNOWN: intent("Unknown contract", "Use a registration id or alias that the intent's API key registered (or a project-visible one). Intents created without a key cannot call registered contracts."),
  CONTRACT_FUNCTION_FORBIDDEN: intent("Function not allowed", "Approvals, permits, transfers, ownership, upgrades, multicall, execute and read-only functions cannot be registered. Register the function that performs the action."),
  CONTRACT_ARGUMENT_FORBIDDEN: intent("Argument type not allowed", "bytes arguments accept only the empty literal 0x; bytes[] and function arguments cannot be registered (no arbitrary calldata)."),
  CONTRACT_BINDING_INVALID: intent("Invalid argument binding", "Bind every argument to a compatible source or literal; receiver-like addresses must bind to $account or $recipient. See error.issues."),
  CONTRACT_NOT_DEPLOYED: intent("No contract at this address", "Register an address that holds deployed code on this network."),
  CONTRACT_DELEGATED_EOA: intent("Delegated account (EIP-7702)", "EIP-7702 delegated accounts can swap their code at any time and cannot be registered."),
  CONTRACT_PROXY_UNSUPPORTED: intent("Proxy pattern not supported", "Only EIP-1967, beacon, EIP-1822, ZeppelinOS and EIP-1167 proxies can be pinned; diamonds and unrecognised proxies are refused."),
  CONTRACT_ACTION_UNKNOWN: intent("Unknown contract action", "Use an entry id listed in the registration's actions."),
  CONTRACT_PARAM_INVALID: intent("Invalid contract parameter", "Send only the parameters the action declares, within their types and bounds."),
  CONTRACT_AMOUNT_LIMIT: intent("Amount outside the contract's limits", "Use an amount within the action's minAmount and maxAmount and the per-step USD cap (lower while the integrator's domain is unverified)."),
  CONTRACT_SPEND_LIMIT: intent("Daily contract volume reached", "This key reached its 24-hour notional cap for custom contract steps. Retry when the window moves on, or ask the operator for a higher cap.", { retryable: true }),
  CONTRACT_HANDOFF_UNSUPPORTED: intent("Signing link not available", "Intents with custom contract steps cannot become signing links. Create a session from your backend with POST /v1/sessions instead."),
  SIMULATION_ASSET_CHANGE_REFUSED: intent("Simulated asset changes refused", "The simulation moves the user's assets differently than declared (extra debit or approval, leftover allowance, missing output). Fix the registration or the amount."),
  ACTION_RESPONSE_UNSUPPORTED: intent("Action response not supported", "Kletia executes Solana Actions that return a transaction. Sign-message, post, external-link and chained responses are refused."),
  ACTION_TRANSACTION_REJECTED: intent("Action transaction refused", "The action server's transaction broke Kletia's rules (signers, programs, instructions or simulated effects); see error.message. The integrator must fix the server."),
  PROGRAM_NOT_ALLOWED: intent("Program not allowed", "Allowlist the action's top-level programs in the registration. Built-in, native and deny-listed programs cannot be allowlisted."),
  LINK_INPUT_OUT_OF_BOUNDS: intent("Amount outside the link's bounds", "Choose an amount within the link's min and max for this asset (unverified publishers are limited to $1,000); deliver links take no amount."),
  LINK_SOURCE_NOT_ALLOWED: intent("Funding source not allowed", "Fund the link from one of its networks and assets (error.issues lists them). On the destination network a deliver link takes only the delivered asset."),
  LINK_ACCOUNTS_REQUIRED: intent("Accounts missing for this link", "Send one account per virtual machine the route signs on (error.issues names them)."),
  LINK_PUBLISHER_MISMATCH: intent("Publisher does not match the contract", "The publisher name and website must match the integrator of every contract registration the link calls."),
  LINK_NOT_BLINK_ELIGIBLE: intent("Link cannot be a blink", "Blinks need a Solana-only visitor flow of at most 3 steps and a verified publisher domain; error.message gives the reason."),

  /* -------------------------------------------------------- verification */
  REFERENCE_ALREADY_USED: verification("Transaction already used", "This transaction already completed another step. " + RESUBMIT),
  REFERENCE_MISMATCH: verification("Not the prepared transaction", "The transaction does not match the payload prepared for this step. " + RESUBMIT),
  REFERENCE_STALE: verification("Transaction predates the payload", "The transaction landed before this step was prepared. " + RESUBMIT),
  REFERENCE_WRONG_CHAIN: verification("Transaction on another chain", "Send the prepared transaction on the step's network."),
  REFERENCE_WRONG_SENDER: verification("Transaction from another account", "The step account must send (or fee-pay) the prepared transaction."),
  STEP_NOT_PREPARED: verification("Step not prepared", "Prepare the step, sign the payload, then submit.", null),
  VENUE_INVALID: { status: 500, category: "internal", retryable: false, title: "Venue does not match its adapter", remedy: "The step's registry venue does not fit the adapter executing it. Create a new intent." },
  STEP_INVALID: { status: 500, category: "internal", retryable: false, step: true, title: "Step invalid", remedy: "The stored step cannot be executed. Create a new intent." },
  TRANSACTION_EXPIRED: verification("Transaction expired", "The transaction never landed before its blockhash expired. Prepare the step again.", null),
  TRANSACTION_FAILED: verification("Transaction failed", "The transaction landed but failed on-chain. Inspect it in the explorer; prepare again if appropriate.", null),
  TRANSACTION_REVERTED: verification("Transaction reverted", "The transaction reverted on-chain. Inspect it in the explorer; prepare again if appropriate.", null),
  SUPPLY_REPAID_DEBT: verification("Supply repaid a borrow", "The deposit repaid an open Compound borrow instead of opening a supply position. Inspect the account's position.", null),
  VENUE_REJECTED: verification("Venue rejected the operation", "The transaction succeeded but the venue returned an error code instead of acting. Funds stayed in the account; plan again.", null),
  OUTCOME_NOT_PROVEN: verification("Outcome not proven", "The transactions landed, but their on-chain effect does not match the plan. Inspect them; contact support with the intent id.", null),
  CONTRACT_CHANGED_DURING_EXECUTION: verification("Contract changed during execution", "The contract's code or implementation differed at the receipt block. The step is indeterminate and the registration suspended; inspect the transaction.", null),

  /* ---------------------------------------------------------- settlement */
  SETTLEMENT_FAILED: { status: null, category: "settlement", retryable: false, step: true, title: "Settlement failed", remedy: "The cross-network fill failed. Check the source transaction for a refund." },
  SETTLEMENT_MISMATCH: { status: null, category: "settlement", retryable: false, step: true, title: "Fill does not match the quote", remedy: "The destination fill differs from the quoted route. Contact support with the intent id." },
  SETTLEMENT_REFUNDED: { status: null, category: "settlement", retryable: false, step: true, title: "Settlement refunded", remedy: "The bridge refunded the deposit on the source network. Plan a new intent." },

  /* ---------------------------------------------------------- rate limit */
  RATE_LIMITED: { status: 429, category: "rate_limit", retryable: true, title: "Rate limited", remedy: "Wait for Retry-After seconds. Use an API key for higher limits." },
  TOO_MANY_STREAMS: { status: 429, category: "rate_limit", retryable: true, title: "Too many event streams", remedy: "Close an open event stream; at most 10 per key and per IP." },

  /* ------------------------------------------------------------ upstream */
  PROVIDER_UNAVAILABLE: upstream("Provider unavailable", "A routing or data provider is temporarily unavailable. Retry shortly. Also returned as <PROVIDER>_UNAVAILABLE, e.g. RELAY_UNAVAILABLE."),
  PROVIDER_REJECTED: upstream("Provider rejected the request", "The provider refused this request (422) or failed (502). Also returned as <PROVIDER>_REJECTED, e.g. JUPITER_REJECTED.", 422, {
    otherStatuses: [502],
    retryable: false,
  }),
  PROVIDER_INVALID_JSON: upstream("Invalid provider response", "Retry shortly."),
  PROVIDER_RESPONSE_TOO_LARGE: upstream("Provider response too large", "Retry shortly."),
  PROVIDER_TRANSACTION_INVALID: upstream("Provider transaction refused", "The provider's transaction failed Kletia's safety checks and was not returned. Retry, or try another route.", 502, { retryable: false }),
  PROVIDER_TRANSACTION_REJECTED: upstream("Provider transaction rejected", "The provider's transaction failed simulation or safety checks. Retry shortly or move a different amount."),
  RELAY_QUOTE_INVALID: upstream("Relay quote refused", "Relay returned a quote that failed Kletia's checks. Retry shortly.", 502),
  PAYLOAD_INVALID: upstream("Prepared payload refused", "The prepared transactions failed Kletia's safety checks and were not returned. Retry shortly."),
  RPC_UNAVAILABLE: upstream("Network read failed", "A network RPC is temporarily unavailable. Retry shortly."),
  SOLANA_RPC_UNAVAILABLE: upstream("Solana RPC unavailable", "Retry shortly."),
  JUPITER_QUOTE_INVALID: upstream("Jupiter quote refused", "Retry shortly."),
  JUPITER_QUOTE_MISMATCH: upstream("Jupiter quote mismatch", "Jupiter returned a quote for another request. Retry shortly."),
  JUPITER_SWAP_INVALID: upstream("Jupiter swap refused", "Retry shortly."),
  SOLANA_FOREIGN_SIGNER: upstream("Unexpected signer", "The provider's instructions required another signer and were refused. Retry, or try another route.", 502, { retryable: false }),
  SOLANA_INSTRUCTION_INVALID: upstream("Provider instruction refused", "The provider's instructions failed Kletia's checks. Retry shortly."),
  UPSTREAM_TIMEOUT: upstream("Provider timed out", "Retry shortly.", 504),
  RPC_TIMEOUT: upstream("Network read timed out", "Retry shortly.", 504),
  VENUE_TIMEOUT: upstream("Venue timed out", "A venue did not quote in time. Retry shortly.", 504),
  ACTION_ENDPOINT_UNAVAILABLE: upstream("Action server unavailable", "The integrator's Solana Action server did not answer in time, failed, or sent too much. Retry shortly."),
  ACTION_RESPONSE_INVALID: upstream("Invalid action response", "The integrator's Solana Action server returned malformed JSON or an error. Retry shortly; the integrator may need to fix it."),
  LINK_DELIVERY_UNQUOTABLE: upstream("Delivery could not be sized", "No quote delivered at least the fixed amount within three tries. Retry shortly, or start from another network."),

  /* --------------------------------------------------------- unavailable */
  STORE_UNAVAILABLE: { status: 503, category: "unavailable", retryable: true, title: "Storage unavailable", remedy: "Retry shortly. Presented API keys cannot be verified meanwhile." },
  WEBHOOKS_NOT_CONFIGURED: { status: 503, category: "unavailable", retryable: false, title: "Webhooks not configured", remedy: "The operator must set KLETIA_PLATFORM_SECRET (at least 32 characters)." },
  NAME_RESOLUTION_UNAVAILABLE: { status: 503, category: "unavailable", retryable: true, title: "Name records unavailable", remedy: "The name's records could not be read. Retry shortly, or use an address." },
  CONTRACTS_DISABLED: { status: 503, category: "unavailable", retryable: true, title: "Custom contracts unavailable", remedy: "Custom contract and Solana Action steps are disabled on this deployment, or need an API key. Retry later, use a key, or plan without them." },
  SIMULATION_UNAVAILABLE: { status: 503, category: "unavailable", retryable: true, title: "Simulation unavailable", remedy: "No configured endpoint can simulate on this network now, and Kletia never prepares a custom contract step unsimulated. Retry shortly." },
  POLICY_PRICE_UNAVAILABLE: { status: 503, category: "unavailable", retryable: true, title: "Price unavailable for a USD rule", remedy: "A USD rule of the rule book needs an amount no fresh price source covers, so it fails closed. Retry shortly, or use a listed asset." },
  RECEIPTS_DISABLED: { status: 503, category: "unavailable", retryable: true, title: "Receipts unavailable", remedy: "Receipts are switched off or no signing key is configured on this deployment. Retry later; reads of existing receipts keep working." },
  LINKS_DISABLED: { status: 503, category: "unavailable", retryable: true, title: "Links unavailable", remedy: "Intent links are switched off on this deployment. Retry later." },
  LINK_PAGE_UNAVAILABLE: { status: 503, category: "unavailable", retryable: true, title: "Link page unavailable", remedy: "The page shell could not be loaded. Retry shortly; the link itself is unaffected." },

  /* ------------------------------------------------------------ internal */
  INTERNAL_ERROR: internal("Internal error"),
  PLATFORM_ERROR: internal("Unclassified platform error"),
  ADAPTERS_INVALID: internal("Adapter configuration invalid", "The operator configured an invalid adapter set."),
  PROTOCOL_UNSUPPORTED: internal("Protocol adapter missing", "Plan the intent again."),
  RELAY_REQUEST_INVALID: internal("Relay request invalid"),
  TRANSFER_BUILD_FAILED: internal("Transfer could not be built"),
  NAME_RESOLVER_INVALID: internal("Name resolver misconfigured", "The operator registered an invalid name resolver."),
  LINK_PLAN_OUT_OF_BOUNDS: { status: 500, category: "internal", retryable: false, title: "Plan left the link's envelope", remedy: "The planned intent did not match the link's fixed networks, recipients, contracts or input, so nothing was stored. Report it with the requestId." },
} as const satisfies Record<string, ErrorCatalogEntry>;

export type KletiaErrorCode = keyof typeof ERROR_CATALOG;

/** Dynamic provider codes (`<PROVIDER>_<SUFFIX>`) and the catalog entry describing them. */
export const ERROR_CODE_FAMILIES: readonly { readonly suffix: string; readonly code: KletiaErrorCode }[] = Object.freeze([
  { suffix: "_UNAVAILABLE", code: "PROVIDER_UNAVAILABLE" },
  { suffix: "_REJECTED", code: "PROVIDER_REJECTED" },
]);

export const ERROR_DOCS_ORIGIN = "https://kletiaai.xyz";

const CODE_SHAPE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/u;

export function isKletiaErrorCode(code: unknown): code is KletiaErrorCode {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(ERROR_CATALOG, code);
}

/** The catalog code describing `code`: itself when listed, its provider family otherwise, null when unknown. */
export function resolveErrorCode(code: string): KletiaErrorCode | null {
  if (isKletiaErrorCode(code)) return code;
  if (!CODE_SHAPE.test(code)) return null;
  for (const family of ERROR_CODE_FAMILIES) {
    if (code.endsWith(family.suffix) && code.length > family.suffix.length) return family.code;
  }
  return null;
}

/** Catalog entry for a code (exact or by provider family), or null. */
export function describeError(code: string): (ErrorCatalogEntry & { readonly code: KletiaErrorCode }) | null {
  const resolved = resolveErrorCode(code);
  return resolved ? { code: resolved, ...ERROR_CATALOG[resolved] } : null;
}

/** Documentation link for an error code: `<origin>/developers#error-<CODE>`. */
export function errorDocsUrl(code: string, origin: string = ERROR_DOCS_ORIGIN): string {
  const resolved = resolveErrorCode(code) ?? "INTERNAL_ERROR";
  return `${origin.replace(/\/+$/u, "")}/developers#error-${resolved}`;
}

/** True when repeating the same request later can succeed (unknown codes: by status, 429 and 5xx). */
export function isRetryableError(code: string, status?: number): boolean {
  const entry = describeError(code);
  if (entry) return entry.retryable;
  return status === 429 || (status !== undefined && status >= 500);
}

export interface ErrorCatalogRow extends ErrorCatalogEntry {
  readonly code: KletiaErrorCode;
}

/** The catalog as rows sorted by code. */
export function errorCatalogRows(): ErrorCatalogRow[] {
  return (Object.keys(ERROR_CATALOG) as KletiaErrorCode[])
    .sort()
    .map((code) => ({ code, ...ERROR_CATALOG[code] }));
}
