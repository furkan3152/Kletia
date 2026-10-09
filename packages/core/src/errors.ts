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

  /* ------------------------------------------------------ authentication */
  API_KEY_REQUIRED: { status: 401, category: "authentication", retryable: false, title: "API key required", remedy: "Issue a key with POST /v1/keys and send it as Authorization: Bearer <key>." },
  INVALID_API_KEY: { status: 401, category: "authentication", retryable: false, title: "Invalid or revoked API key", remedy: "Check the key, or issue a new one. Revoked and expired rotated keys stop working within 15 seconds." },
  INVALID_AUTHORIZATION: { status: 401, category: "authentication", retryable: false, title: "Malformed credentials", remedy: "Send Authorization: Bearer <key> or X-Kletia-Key: <key>, not both with different keys." },
  KEY_SECRET_ROTATED: { status: 403, category: "permission", retryable: false, title: "Rotated key secret", remedy: "This secret still authenticates during its grace window but cannot manage keys. Use the current secret." },
  MCP_ORIGIN_FORBIDDEN: { status: 403, category: "permission", retryable: false, title: "Origin not allowed for MCP", remedy: "Call /v1/mcp without an Origin header (server-side agents) or from an allowed HTTPS origin." },

  /* ---------------------------------------------------------------- keys */
  KEY_NOT_FOUND: { status: 404, category: "not_found", retryable: false, title: "API key not found", remedy: "List your project's keys with GET /v1/keys; only active keys of your own project can be managed." },
  KEY_NOT_MANAGEABLE: conflict("Operator keys are immutable", "Operator keys come from server configuration; change KLETIA_OPERATOR_API_KEYS instead."),
  KEY_LIMIT_REACHED: conflict("Too many active keys", "A project holds at most 5 active keys. Revoke one with DELETE /v1/keys/{id} first."),
  KEY_COLLISION: conflict("Key generation collided", "Send the request again.", true),

  /* ----------------------------------------------------------- not found */
  INTENT_NOT_FOUND: { status: 404, category: "not_found", retryable: false, title: "Intent not found", remedy: "Check the intent id. Dry runs are never stored." },
  STEP_NOT_FOUND: { status: 404, category: "not_found", retryable: false, title: "Step not found", remedy: "Use a step id from intent.steps (s1, s2, ...)." },
  WEBHOOK_NOT_FOUND: { status: 404, category: "not_found", retryable: false, title: "Webhook not found", remedy: "List your webhooks with GET /v1/webhooks; each key sees only its own." },

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

  /* ------------------------------------------------------------- expired */
  INTENT_EXPIRED: { status: 410, category: "expired", retryable: false, title: "Intent expired", remedy: "The plan expired before execution started. Create a new intent to re-quote." },
  DEADLINE_PASSED: { status: 410, otherStatuses: [422], category: "expired", retryable: false, title: "Deadline passed", remedy: "constraints.deadline is in the past. Plan again with a later deadline." },

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

  /* --------------------------------------------------------- unavailable */
  STORE_UNAVAILABLE: { status: 503, category: "unavailable", retryable: true, title: "Storage unavailable", remedy: "Retry shortly. Presented API keys cannot be verified meanwhile." },
  WEBHOOKS_NOT_CONFIGURED: { status: 503, category: "unavailable", retryable: false, title: "Webhooks not configured", remedy: "The operator must set KLETIA_PLATFORM_SECRET (at least 32 characters)." },
  NAME_RESOLUTION_UNAVAILABLE: { status: 503, category: "unavailable", retryable: true, title: "Name records unavailable", remedy: "The name's records could not be read. Retry shortly, or use an address." },

  /* ------------------------------------------------------------ internal */
  INTERNAL_ERROR: internal("Internal error"),
  PLATFORM_ERROR: internal("Unclassified platform error"),
  ADAPTERS_INVALID: internal("Adapter configuration invalid", "The operator configured an invalid adapter set."),
  PROTOCOL_UNSUPPORTED: internal("Protocol adapter missing", "Plan the intent again."),
  RELAY_REQUEST_INVALID: internal("Relay request invalid"),
  TRANSFER_BUILD_FAILED: internal("Transfer could not be built"),
  NAME_RESOLVER_INVALID: internal("Name resolver misconfigured", "The operator registered an invalid name resolver."),
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
