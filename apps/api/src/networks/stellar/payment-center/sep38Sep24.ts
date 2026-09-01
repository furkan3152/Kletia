import { Account, MuxedAccount, StrKey } from "stellar-sdk-16";

import { STELLAR_TESTNET } from "../config.js";
import {
  assertAllowedAnchorInteractiveUrl,
  readConfiguredPaymentCenterEndpointHosts,
  STELLAR_USDC_ASSET,
  type AnchorDiscovery,
} from "../lastMile.js";
import type {
  PaymentCenterSessionRecord,
  Sep24TransactionStatusSnapshot,
  Sep24TransactionSnapshot,
  Sep38FirmQuoteSnapshot,
} from "./types.js";
import { SEP24_TRANSACTION_STATUSES } from "./types.js";

const MAX_ANCHOR_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 12_000;
const DECIMAL_PATTERN = /^\d{1,30}(?:\.\d{1,18})?$/u;
const UINT64_MAX = 18_446_744_073_709_551_615n;

function controlled(
  code: string,
  message: string,
  statusCode = 502,
  cause?: unknown,
): Error {
  return Object.assign(new Error(message, { cause }), { code, statusCode });
}

function objectValue(value: unknown, code: string, message: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw controlled(code, message);
  }
  return value as Record<string, unknown>;
}

function boundedString(
  value: unknown,
  field: string,
  maximum = 512,
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw controlled(
      "SEP38_FIRM_QUOTE_INVALID",
      `Anchor firm quote field ${field} is invalid.`,
    );
  }
  return value;
}

function decimalValue(
  value: unknown,
  field: string,
  options: { allowZero?: boolean; maximumDecimals?: number } = {},
): string {
  if (typeof value !== "string" || !DECIMAL_PATTERN.test(value)) {
    throw controlled(
      "SEP38_FIRM_QUOTE_INVALID",
      `Anchor firm quote field ${field} is invalid.`,
    );
  }
  const decimalPlaces = value.includes(".") ? value.length - value.indexOf(".") - 1 : 0;
  const numeric = Number(value);
  if (
    !Number.isFinite(numeric) ||
    numeric < 0 ||
    (!options.allowZero && numeric === 0) ||
    numeric > 1_000_000_000_000_000 ||
    (options.maximumDecimals !== undefined &&
      decimalPlaces > options.maximumDecimals)
  ) {
    throw controlled(
      "SEP38_FIRM_QUOTE_INVALID",
      `Anchor firm quote field ${field} is outside Kletia's numeric boundary.`,
    );
  }
  return value;
}

function optionalBoundedString(
  value: unknown,
  field: string,
  maximum = 512,
): string | null {
  return value === undefined || value === null
    ? null
    : boundedString(value, field, maximum);
}

function decimalAtomic(value: string, decimals = 7): bigint {
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) {
    throw controlled(
      "SEP24_TRANSACTION_INVALID",
      "Anchor withdrawal amount exceeds Stellar asset precision.",
    );
  }
  return BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0") || "0");
}

function parseOptionalTimestamp(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  const timestamp = Date.parse(boundedString(value, field, 64));
  if (!Number.isFinite(timestamp)) {
    throw controlled(
      "SEP24_TRANSACTION_INVALID",
      `Anchor withdrawal field ${field} is not a valid timestamp.`,
    );
  }
  return timestamp;
}

function muxedDestination(anchorAccount: string, memo: string): string {
  if (!/^\d{1,20}$/u.test(memo)) {
    throw controlled(
      "SEP24_TRANSFER_INSTRUCTION_INVALID",
      "Anchor withdrawal ID memo is not an unsigned integer.",
    );
  }
  const memoId = BigInt(memo);
  if (memoId > UINT64_MAX) {
    throw controlled(
      "SEP24_TRANSFER_INSTRUCTION_INVALID",
      "Anchor withdrawal ID memo exceeds Stellar's unsigned 64-bit boundary.",
    );
  }
  return new MuxedAccount(new Account(anchorAccount, "0"), memo).accountId();
}

function assertTotalPriceFormula(input: {
  sellAmount: string;
  buyAmount: string;
  totalPrice: string;
}): void {
  const sell = Number(input.sellAmount);
  const calculated = Number(input.totalPrice) * Number(input.buyAmount);
  const sellDecimals = input.sellAmount.includes(".")
    ? input.sellAmount.length - input.sellAmount.indexOf(".") - 1
    : 0;
  const atomicTolerance = 10 ** -Math.min(7, sellDecimals);
  const tolerance = Math.max(atomicTolerance, Math.abs(sell) * 1e-9);
  if (!Number.isFinite(calculated) || Math.abs(calculated - sell) > tolerance) {
    throw controlled(
      "SEP38_FIRM_QUOTE_FORMULA_INVALID",
      "Anchor firm quote amounts do not match its total price.",
    );
  }
}

export function buildSep38FirmQuoteRequest(
  session: PaymentCenterSessionRecord,
): Record<string, string> {
  const request: Record<string, string> = {
    sell_asset: STELLAR_USDC_ASSET,
    buy_asset: `iso4217:${session.quoteRequest.destinationCurrency}`,
    country_code: session.quoteRequest.destinationCountry,
    buy_delivery_method: session.quoteRequest.deliveryMethod,
    context: "sep24",
  };
  request[
    session.quoteRequest.amountMode === "send_exact"
      ? "sell_amount"
      : "buy_amount"
  ] = session.quoteRequest.amount;
  return request;
}

export function validateSep38FirmQuoteResponse(input: {
  value: unknown;
  session: PaymentCenterSessionRecord;
  now?: number;
}): Sep38FirmQuoteSnapshot {
  const body = objectValue(
    input.value,
    "SEP38_FIRM_QUOTE_INVALID",
    "Anchor returned an invalid firm quote.",
  );
  const expectedBuyAsset = `iso4217:${input.session.quoteRequest.destinationCurrency}`;
  if (body.sell_asset !== STELLAR_USDC_ASSET || body.buy_asset !== expectedBuyAsset) {
    throw controlled(
      "SEP38_FIRM_QUOTE_IDENTITY_MISMATCH",
      "Anchor firm quote changed the requested Stellar or payout asset.",
    );
  }
  if (
    body.buy_delivery_method !== undefined &&
    body.buy_delivery_method !== input.session.quoteRequest.deliveryMethod
  ) {
    throw controlled(
      "SEP38_FIRM_QUOTE_IDENTITY_MISMATCH",
      "Anchor firm quote changed the selected payout rail.",
    );
  }
  const expiresAt = Date.parse(boundedString(body.expires_at, "expires_at", 64));
  const now = input.now ?? Date.now();
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    throw controlled(
      "SEP38_FIRM_QUOTE_EXPIRED",
      "Anchor returned a firm quote that is already expired.",
      409,
    );
  }
  const sellAmount = decimalValue(body.sell_amount, "sell_amount", {
    maximumDecimals: 7,
  });
  const buyAmount = decimalValue(body.buy_amount, "buy_amount");
  const totalPrice = decimalValue(body.total_price, "total_price");
  const price = decimalValue(body.price, "price");
  assertTotalPriceFormula({ sellAmount, buyAmount, totalPrice });

  let fee: Sep38FirmQuoteSnapshot["fee"] = null;
  if (body.fee !== undefined && body.fee !== null) {
    const feeBody = objectValue(
      body.fee,
      "SEP38_FIRM_QUOTE_INVALID",
      "Anchor returned an invalid firm quote fee.",
    );
    const feeAsset = boundedString(feeBody.asset, "fee.asset");
    if (feeAsset !== STELLAR_USDC_ASSET && feeAsset !== expectedBuyAsset) {
      throw controlled(
        "SEP38_FIRM_QUOTE_IDENTITY_MISMATCH",
        "Anchor firm quote fee uses an unrelated asset.",
      );
    }
    fee = {
      total: decimalValue(feeBody.total, "fee.total", { allowZero: true }),
      asset: feeAsset,
    };
  }

  return {
    quoteType: "firm",
    quoteId: boundedString(body.id, "id"),
    expiresAt,
    totalPrice,
    price,
    sellAsset: STELLAR_USDC_ASSET,
    sellAmount,
    buyAsset: expectedBuyAsset,
    buyAmount,
    buyDeliveryMethod:
      typeof body.buy_delivery_method === "string"
        ? body.buy_delivery_method
        : null,
    fee,
    obtainedAt: now,
  };
}

async function limitedJsonResponse(
  response: Response,
): Promise<Record<string, unknown> | null> {
  const length = Number(response.headers.get("content-length") || "0");
  if (length > MAX_ANCHOR_RESPONSE_BYTES) {
    throw controlled(
      "PAYMENT_CENTER_ANCHOR_RESPONSE_TOO_LARGE",
      "Anchor response exceeded Kletia's safety limit.",
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_ANCHOR_RESPONSE_BYTES) {
    throw controlled(
      "PAYMENT_CENTER_ANCHOR_RESPONSE_TOO_LARGE",
      "Anchor response exceeded Kletia's safety limit.",
    );
  }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function requestSep38FirmQuote(input: {
  discovery: AnchorDiscovery;
  session: PaymentCenterSessionRecord;
  anchorAccessToken: string;
}): Promise<Sep38FirmQuoteSnapshot> {
  const response = await fetch(`${input.discovery.anchorQuoteServer}/quote`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${input.anchorAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildSep38FirmQuoteRequest(input.session)),
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let body: Record<string, unknown> | null;
  try {
    body = await limitedJsonResponse(response);
  } catch (error) {
    if (response.status === 201) {
      throw controlled(
        "SEP38_FIRM_QUOTE_INDETERMINATE",
        "The provider may have reserved a quote but returned an unreadable result; Kletia will not retry this session.",
        502,
        error,
      );
    }
    throw error;
  }
  if (response.status !== 201) {
    throw controlled(
      response.status >= 500
        ? "SEP38_FIRM_QUOTE_INDETERMINATE"
        : "SEP38_FIRM_QUOTE_REJECTED",
      response.status >= 500
        ? "Firm quote result is uncertain; Kletia will not reserve the same quote again in this session."
        : "The provider could not issue this firm quote.",
      response.status >= 500 ? 502 : 409,
    );
  }
  if (!body) {
    throw controlled(
      "SEP38_FIRM_QUOTE_INDETERMINATE",
      "The provider may have reserved a quote but returned an invalid result; Kletia will not retry this session.",
    );
  }
  try {
    return validateSep38FirmQuoteResponse({
      value: body,
      session: input.session,
    });
  } catch (error) {
    throw controlled(
      "SEP38_FIRM_QUOTE_INDETERMINATE",
      "The provider may have reserved a quote with invalid identity or pricing fields; Kletia will not retry this session.",
      502,
      error,
    );
  }
}

export function validateSep24InteractiveResponse(input: {
  value: unknown;
  interactiveUrlCiphertext: (url: string) => string;
  now?: number;
}): { snapshot: Sep24TransactionSnapshot; interactiveUrl: string } {
  const body = objectValue(
    input.value,
    "SEP24_SESSION_INDETERMINATE",
    "The provider may have created a withdrawal but returned an invalid result.",
  );
  if (body.type !== "interactive_customer_info_needed") {
    throw controlled(
      "SEP24_SESSION_INDETERMINATE",
      "The provider returned an unsupported withdrawal state; Kletia will not create a duplicate session.",
    );
  }
  const transactionId = boundedString(body.id, "id");
  const interactiveUrl = assertAllowedAnchorInteractiveUrl(
    boundedString(body.url, "url", 8_192),
    readConfiguredPaymentCenterEndpointHosts(),
  );
  const createdAt = input.now ?? Date.now();
  return {
    snapshot: {
      transactionId,
      responseType: "interactive_customer_info_needed",
      interactiveUrlCiphertext: input.interactiveUrlCiphertext(interactiveUrl),
      createdAt,
      status: null,
    },
    interactiveUrl,
  };
}

export async function requestSep24HostedWithdrawal(input: {
  discovery: AnchorDiscovery;
  session: PaymentCenterSessionRecord;
  anchorAccessToken: string;
  interactiveUrlCiphertext: (url: string) => string;
}): Promise<{ snapshot: Sep24TransactionSnapshot; interactiveUrl: string }> {
  if (!input.session.firmQuote || input.session.firmQuote.expiresAt <= Date.now()) {
    throw controlled(
      "SEP38_FIRM_QUOTE_EXPIRED",
      "The firm quote expired before the hosted withdrawal was created.",
      409,
    );
  }
  const form = new FormData();
  form.set("asset_code", "USDC");
  form.set("asset_issuer", STELLAR_TESTNET.usdc.issuer);
  form.set("destination_asset", input.session.firmQuote.buyAsset);
  form.set("amount", input.session.firmQuote.sellAmount);
  form.set("quote_id", input.session.firmQuote.quoteId);
  form.set("account", input.session.passkeyAccount);
  const response = await fetch(
    `${input.discovery.transferServerSep24}/transactions/withdraw/interactive`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${input.anchorAccessToken}`,
      },
      body: form,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  let body: Record<string, unknown> | null;
  try {
    body = await limitedJsonResponse(response);
  } catch (error) {
    if (response.status === 200) {
      throw controlled(
        "SEP24_SESSION_INDETERMINATE",
        "The provider may have created a withdrawal but returned an unreadable result; Kletia will not retry this session.",
        502,
        error,
      );
    }
    throw error;
  }
  if (response.status !== 200) {
    throw controlled(
      response.status >= 500
        ? "SEP24_SESSION_INDETERMINATE"
        : "SEP24_SESSION_REJECTED",
      response.status >= 500
        ? "Hosted withdrawal result is uncertain; Kletia will not create a duplicate session."
        : "The provider rejected the hosted withdrawal request.",
      response.status >= 500 ? 502 : 409,
    );
  }
  if (!body) {
    throw controlled(
      "SEP24_SESSION_INDETERMINATE",
      "The provider may have created a withdrawal but returned an invalid result; Kletia will not retry this session.",
    );
  }
  try {
    return validateSep24InteractiveResponse({
      value: body,
      interactiveUrlCiphertext: input.interactiveUrlCiphertext,
    });
  } catch (error) {
    throw controlled(
      "SEP24_SESSION_INDETERMINATE",
      "The provider may have created a withdrawal with an invalid hosted URL or identity; Kletia will not retry this session.",
      502,
      error,
    );
  }
}

export function validateSep24TransactionResponse(input: {
  value: unknown;
  session: PaymentCenterSessionRecord;
  now?: number;
}): Sep24TransactionStatusSnapshot {
  if (!input.session.sep24Transaction || !input.session.firmQuote) {
    throw controlled(
      "SEP24_TRANSACTION_NOT_READY",
      "The hosted withdrawal and firm quote must exist before status can be checked.",
      409,
    );
  }
  const envelope = objectValue(
    input.value,
    "SEP24_TRANSACTION_INVALID",
    "Anchor returned an invalid withdrawal status envelope.",
  );
  const transaction = objectValue(
    envelope.transaction,
    "SEP24_TRANSACTION_INVALID",
    "Anchor returned an invalid withdrawal transaction.",
  );
  if (transaction.id !== input.session.sep24Transaction.transactionId) {
    throw controlled(
      "SEP24_TRANSACTION_IDENTITY_MISMATCH",
      "Anchor returned a different withdrawal transaction.",
    );
  }
  if (transaction.kind !== "withdrawal") {
    throw controlled(
      "SEP24_TRANSACTION_IDENTITY_MISMATCH",
      "Anchor changed the Payment Center transaction kind.",
    );
  }
  const status = boundedString(transaction.status, "status", 64);
  if (!(SEP24_TRANSACTION_STATUSES as readonly string[]).includes(status)) {
    throw controlled(
      "SEP24_TRANSACTION_STATUS_UNSUPPORTED",
      "Anchor returned an unsupported withdrawal status.",
    );
  }
  const quoteId = optionalBoundedString(transaction.quote_id, "quote_id");
  if (quoteId && quoteId !== input.session.firmQuote.quoteId) {
    throw controlled(
      "SEP24_TRANSACTION_IDENTITY_MISMATCH",
      "Anchor withdrawal no longer references the selected firm quote.",
    );
  }
  const amountIn = transaction.amount_in === undefined || transaction.amount_in === null
    ? null
    : decimalValue(transaction.amount_in, "amount_in", { maximumDecimals: 7 });
  const amountInAsset = optionalBoundedString(
    transaction.amount_in_asset,
    "amount_in_asset",
  );
  if (amountInAsset && amountInAsset !== STELLAR_USDC_ASSET) {
    throw controlled(
      "SEP24_TRANSACTION_IDENTITY_MISMATCH",
      "Anchor withdrawal changed the Stellar asset to be paid.",
    );
  }
  const withdrawAnchorAccount = optionalBoundedString(
    transaction.withdraw_anchor_account,
    "withdraw_anchor_account",
    128,
  );
  const withdrawMemo = optionalBoundedString(
    transaction.withdraw_memo,
    "withdraw_memo",
    128,
  );
  const withdrawMemoType = optionalBoundedString(
    transaction.withdraw_memo_type,
    "withdraw_memo_type",
    32,
  );
  const userActionRequiredBy = parseOptionalTimestamp(
    transaction.user_action_required_by,
    "user_action_required_by",
  );
  const stellarTransactionId = optionalBoundedString(
    transaction.stellar_transaction_id,
    "stellar_transaction_id",
    128,
  );
  const externalTransactionId = optionalBoundedString(
    transaction.external_transaction_id,
    "external_transaction_id",
    256,
  );
  if (
    stellarTransactionId &&
    input.session.submittedTransfer &&
    stellarTransactionId.toLowerCase() !==
      input.session.submittedTransfer.transactionHash
  ) {
    throw controlled(
      "SEP24_TRANSACTION_IDENTITY_MISMATCH",
      "Anchor associated the withdrawal with a different Stellar transaction.",
    );
  }
  if (status === "completed" && !stellarTransactionId) {
    throw controlled(
      "SEP24_TRANSACTION_EVIDENCE_MISSING",
      "Anchor reported completion without the Stellar transaction identifier required by SEP-24.",
    );
  }
  const message = optionalBoundedString(transaction.message, "message", 1_024);
  const now = input.now ?? Date.now();
  let transferInstruction: Sep24TransactionStatusSnapshot["transferInstruction"] = null;
  let transferBlockedReason: string | null = null;

  if (status === "pending_user_transfer_start") {
    if (!amountIn || !withdrawAnchorAccount) {
      transferBlockedReason =
        "The provider has not supplied a complete Stellar payment instruction.";
    } else if (!StrKey.isValidEd25519PublicKey(withdrawAnchorAccount)) {
      transferBlockedReason =
        "The provider supplied an unsupported withdrawal destination.";
    } else if (
      decimalAtomic(amountIn) !== decimalAtomic(input.session.firmQuote.sellAmount)
    ) {
      transferBlockedReason =
        "The provider's requested USDC amount no longer matches the firm quote.";
    } else if (Number(amountIn) > 10_000_000) {
      transferBlockedReason =
        "The provider's requested USDC amount exceeds Kletia's Testnet passkey limit.";
    } else if (input.session.firmQuote.expiresAt <= now) {
      transferBlockedReason =
        "The firm quote expired before the provider became ready for payment.";
    } else if (userActionRequiredBy !== null && userActionRequiredBy <= now) {
      transferBlockedReason =
        "The provider's payment deadline has expired.";
    } else if (!withdrawMemo && !withdrawMemoType) {
      transferInstruction = {
        assetCode: "USDC",
        assetContract: STELLAR_TESTNET.usdc.sac,
        amount: amountIn,
        anchorAccount: withdrawAnchorAccount,
        destination: withdrawAnchorAccount,
        memo: null,
        quoteId: input.session.firmQuote.quoteId,
      };
    } else if (withdrawMemo && withdrawMemoType === "id") {
      try {
        transferInstruction = {
          assetCode: "USDC",
          assetContract: STELLAR_TESTNET.usdc.sac,
          amount: amountIn,
          anchorAccount: withdrawAnchorAccount,
          destination: muxedDestination(withdrawAnchorAccount, withdrawMemo),
          memo: { type: "id", value: withdrawMemo },
          quoteId: input.session.firmQuote.quoteId,
        };
      } catch (error) {
        transferBlockedReason =
          error instanceof Error
            ? error.message
            : "The provider's withdrawal memo is invalid.";
      }
    } else {
      transferBlockedReason =
        "Passkey contract-account withdrawals support no memo or an ID memo converted to a muxed Stellar address; this provider requested a different memo type.";
    }
  }

  return {
    status: status as Sep24TransactionStatusSnapshot["status"],
    amountIn,
    amountInAsset,
    quoteId,
    withdrawAnchorAccount,
    withdrawMemo,
    withdrawMemoType,
    userActionRequiredBy,
    stellarTransactionId,
    externalTransactionId,
    message,
    transferInstruction,
    transferBlockedReason,
    observedAt: now,
  };
}

export async function requestSep24TransactionStatus(input: {
  discovery: AnchorDiscovery;
  session: PaymentCenterSessionRecord;
  anchorAccessToken: string;
}): Promise<Sep24TransactionStatusSnapshot> {
  if (!input.session.sep24Transaction) {
    throw controlled(
      "SEP24_TRANSACTION_NOT_READY",
      "Create the hosted withdrawal before checking its status.",
      409,
    );
  }
  const url = new URL(`${input.discovery.transferServerSep24}/transaction`);
  url.searchParams.set("id", input.session.sep24Transaction.transactionId);
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${input.anchorAccessToken}`,
    },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await limitedJsonResponse(response);
  if (response.status !== 200 || !body) {
    throw controlled(
      response.status === 404
        ? "SEP24_TRANSACTION_NOT_FOUND"
        : "SEP24_TRANSACTION_STATUS_UNAVAILABLE",
      response.status === 404
        ? "The provider cannot find this withdrawal transaction."
        : "The provider's withdrawal status is temporarily unavailable.",
      response.status === 404 ? 409 : 502,
    );
  }
  return validateSep24TransactionResponse({ value: body, session: input.session });
}
