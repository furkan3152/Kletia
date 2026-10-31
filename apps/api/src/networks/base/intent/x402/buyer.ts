/**
 * Explicit GET preflights, buyer challenges and pinned paid requests.
 */
import { request as httpsRequest } from "node:https";
import { getAddress } from "viem";
import { z } from "zod";
import {
  BASE_CAIP_NETWORK,
  MAX_PAID_RESPONSE_BYTES,
  MAX_PREFLIGHT_HEADER_BYTES,
  PAID_REQUEST_TIMEOUT_MS,
  type paymentRequirementSchema,
  x402ChallengeSchema,
} from "./constants.js";
import {
  type BaseX402BuyerPaymentRequirement,
  type BaseX402BuyerUpstreamResponse,
  type BaseX402ChallengeEvidence,
  BaseX402IntentError,
  type PreparedBaseX402BuyerChallenge,
} from "./types.js";
import {
  decodePaymentRequiredHeader,
  paymentCap,
  publicHttpsUrl,
  requestPinnedX402Challenge,
  requiredQueryParams,
  resolvePinnedPublicDestination,
  scalarHeader,
} from "./preflight.js";
import { validateBaseX402Challenge } from "./challenge.js";
import { promptPaymentCaps } from "./promptBinding.js";

export function boundedJsonBody(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new BaseX402IntentError(
      "X402_BODY_INVALID",
      "x402 POST body must be a JSON object.",
    );
  }
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > 4_096) {
    throw new BaseX402IntentError(
      "X402_BODY_TOO_LARGE",
      "x402 POST body cannot exceed 4096 bytes.",
    );
  }
  return JSON.parse(serialized) as unknown;
}

export async function preflightExplicitBaseX402GetPrompt(
  sourcePrompt: string,
  activeUserAddress?: unknown,
): Promise<BaseX402ChallengeEvidence | null> {
  if (
    !/\bx402\b/iu.test(sourcePrompt) ||
    !/\bGET\b/iu.test(sourcePrompt) ||
    /\bPOST\b/iu.test(sourcePrompt)
  ) {
    return null;
  }
  const urlCandidates = (
    sourcePrompt.match(/https:\/\/[^\s<>"']+/giu) || []
  ).map((candidate) => candidate.replace(/[),.;!?]+$/gu, ""));
  const uniqueUrls = [
    ...new Set(
      urlCandidates.flatMap((candidate) => {
        try {
          return [publicHttpsUrl(candidate).toString()];
        } catch {
          return [];
        }
      }),
    ),
  ];
  const caps = promptPaymentCaps(sourcePrompt);
  if (uniqueUrls.length !== 1 || caps.length !== 1) return null;
  const cap = paymentCap(caps[0].decimal);
  const sourceRequestUrl = publicHttpsUrl(uniqueUrls[0]);
  let requestUrl = new URL(sourceRequestUrl);
  let response = await requestPinnedX402Challenge(requestUrl);
  const missingParams = requiredQueryParams(response.body).filter(
    (key) => !requestUrl.searchParams.get(key)?.trim(),
  );
  let walletInputBinding:
    BaseX402ChallengeEvidence["walletInputBinding"] | undefined;
  if (missingParams.length > 0) {
    const parameter =
      missingParams.length === 1 ? missingParams[0].toLowerCase() : "";
    let walletAddress: string;
    try {
      walletAddress = getAddress(String(activeUserAddress || ""));
      if (walletAddress === "0x0000000000000000000000000000000000000000") {
        throw new Error("zero_address");
      }
    } catch {
      walletAddress = "";
    }
    if ((parameter !== "address" && parameter !== "wallet") || !walletAddress) {
      throw new BaseX402IntentError(
        "X402_REQUIRED_INPUT_MISSING",
        `The x402 call requires the following mandatory URL parameters before payment: ${missingParams.join(", ")}. Resend the intent specifying the parameters explicitly.`,
      );
    }
    requestUrl = new URL(sourceRequestUrl);
    requestUrl.searchParams.set(parameter, walletAddress);
    walletInputBinding = {
      parameter,
      value: walletAddress,
      source: "active_user_address",
    };

    response = await requestPinnedX402Challenge(requestUrl);
  }
  const evidence = validateBaseX402Challenge({
    requestUrl: requestUrl.toString(),
    maxPayment: cap.decimal,
    statusCode: response.statusCode,
    paymentRequired:
      scalarHeader(response.headers, "payment-required") ||
      scalarHeader(response.headers, "x-payment-required"),
    body: response.body,
  });
  return {
    ...evidence,
    sourceRequestUrl: sourceRequestUrl.toString(),
    ...(walletInputBinding ? { walletInputBinding } : {}),
  };
}

function exactBuyerRequirement(
  candidate: z.infer<typeof paymentRequirementSchema>,
  evidence: BaseX402ChallengeEvidence,
): BaseX402BuyerPaymentRequirement | null {
  const extra = candidate.extra;
  if (
    candidate.scheme !== "exact" ||
    candidate.network !== BASE_CAIP_NETWORK ||
    candidate.amount !== evidence.amountAtomic ||
    candidate.maxTimeoutSeconds === undefined ||
    candidate.maxTimeoutSeconds !== evidence.maxTimeoutSeconds ||
    !extra ||
    extra.name !== "USD Coin" ||
    extra.version !== "2" ||
    (extra.assetTransferMethod !== undefined &&
      extra.assetTransferMethod !== "eip3009")
  ) {
    return null;
  }
  try {
    if (
      getAddress(candidate.asset) !== getAddress(evidence.asset) ||
      getAddress(candidate.payTo) !== getAddress(evidence.payTo)
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return {
    ...candidate,
    scheme: "exact",
    network: BASE_CAIP_NETWORK,
    amount: evidence.amountAtomic,
    asset: getAddress(candidate.asset),
    payTo: getAddress(candidate.payTo),
    maxTimeoutSeconds: candidate.maxTimeoutSeconds,
    extra: {
      ...extra,
      name: "USD Coin",
      version: "2",
      ...(extra.assetTransferMethod === undefined
        ? {}
        : { assetTransferMethod: "eip3009" as const }),
    },
  };
}

export async function prepareBaseX402BuyerChallenge(input: {
  readonly url: unknown;
  readonly maxPayment: unknown;
  readonly wallet: unknown;
}): Promise<PreparedBaseX402BuyerChallenge> {
  const requestUrl = publicHttpsUrl(input.url);
  const cap = paymentCap(input.maxPayment);
  let wallet: string;
  try {
    wallet = getAddress(String(input.wallet || ""));
    if (wallet === "0x0000000000000000000000000000000000000000") {
      throw new Error("zero_address");
    }
  } catch {
    throw new BaseX402IntentError(
      "X402_BUYER_WALLET_INVALID",
      "x402 buyer wallet must be a valid, non-zero EVM address.",
    );
  }

  const response = await requestPinnedX402Challenge(requestUrl);
  const paymentRequiredHeader =
    scalarHeader(response.headers, "payment-required") ||
    scalarHeader(response.headers, "x-payment-required");
  const decoded = decodePaymentRequiredHeader(paymentRequiredHeader);
  const parsed = x402ChallengeSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new BaseX402IntentError(
      "X402_CHALLENGE_INVALID",
      "x402 PAYMENT-REQUIRED v2 envelope is invalid.",
      502,
    );
  }
  const evidence = validateBaseX402Challenge({
    requestUrl: requestUrl.toString(),
    maxPayment: cap.decimal,
    statusCode: response.statusCode,
    paymentRequired: paymentRequiredHeader,
    body: response.body,
  });
  if (evidence.maxTimeoutSeconds === undefined) {
    throw new BaseX402IntentError(
      "X402_CHALLENGE_POLICY_MISMATCH",
      "x402 payment requirement does not specify a limited authorization duration.",
      502,
    );
  }

  const walletParams = [...requestUrl.searchParams.entries()].filter(
    ([parameter]) => {
      const normalized = parameter.toLowerCase();
      return normalized === "address" || normalized === "wallet";
    },
  );
  if (walletParams.length > 1) {
    throw new BaseX402IntentError(
      "X402_BUYER_WALLET_URL_AMBIGUOUS",
      "x402 URL cannot contain multiple address/wallet entries simultaneously.",
    );
  }
  for (const [, supplied] of walletParams) {
    try {
      if (getAddress(supplied) !== wallet) {
        throw new Error("wallet_mismatch");
      }
    } catch {
      throw new BaseX402IntentError(
        "X402_BUYER_WALLET_URL_MISMATCH",
        "x402 address/wallet entry must match the active buyer wallet.",
      );
    }
  }

  for (const parameter of evidence.requiredParams) {
    const normalized = parameter.toLowerCase();
    if (normalized !== "address" && normalized !== "wallet") continue;
    const matches = [...requestUrl.searchParams.entries()].filter(
      ([candidate]) => candidate.toLowerCase() === normalized,
    );
    if (matches.length !== 1) {
      throw new BaseX402IntentError(
        "X402_BUYER_WALLET_URL_AMBIGUOUS",
        `The x402 ${parameter} parameter must be given exactly once.`,
      );
    }
    const supplied = matches[0]?.[1];
    try {
      if (!supplied || getAddress(supplied) !== wallet) {
        throw new Error("wallet_mismatch");
      }
    } catch {
      throw new BaseX402IntentError(
        "X402_BUYER_WALLET_URL_MISMATCH",
        `The x402 ${parameter} input must match the active recipient wallet.`,
      );
    }
  }

  const eligible = parsed.data.accepts.flatMap((candidate) => {
    const normalized = exactBuyerRequirement(candidate, evidence);
    return normalized ? [normalized] : [];
  });
  if (parsed.data.accepts.length !== 1 || eligible.length !== 1) {
    throw new BaseX402IntentError(
      eligible.length === 0
        ? "X402_BUYER_EIP3009_REQUIRED"
        : "X402_BUYER_REQUIREMENT_AMBIGUOUS",
      eligible.length === 0
        ? "x402 buyer relay only accepts Base USDC EIP-3009 exact requirement."
        : "x402 buyer relay cannot sign multiple matching payment requirements.",
    );
  }

  return {
    paymentRequiredHeader: paymentRequiredHeader!,
    paymentRequired: JSON.parse(
      JSON.stringify(parsed.data),
    ) as PreparedBaseX402BuyerChallenge["paymentRequired"],
    accepted: eligible[0],
    evidence,
  };
}

export async function forwardPinnedBaseX402BuyerPayment(input: {
  readonly url: unknown;
  readonly paymentSignature: string;
}): Promise<BaseX402BuyerUpstreamResponse> {
  const url = publicHttpsUrl(input.url);
  if (
    typeof input.paymentSignature !== "string" ||
    input.paymentSignature.length < 4 ||
    input.paymentSignature.length > MAX_PREFLIGHT_HEADER_BYTES ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(input.paymentSignature)
  ) {
    throw new BaseX402IntentError(
      "X402_PAYMENT_SIGNATURE_INVALID",
      "PAYMENT-SIGNATURE header is invalid or exceeds safe size limits.",
    );
  }
  const destination = await resolvePinnedPublicDestination(url.hostname);
  return new Promise<BaseX402BuyerUpstreamResponse>((resolve, reject) => {
    let settled = false;
    let absoluteTimeout: ReturnType<typeof setTimeout> | undefined;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      if (absoluteTimeout) clearTimeout(absoluteTimeout);
      reject(error);
    };
    const request = httpsRequest(
      url,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          "Payment-Signature": input.paymentSignature,
          "User-Agent": "Kletia-x402-buyer-relay/1.0",
        },
        maxHeaderSize: MAX_PREFLIGHT_HEADER_BYTES,
        lookup: ((_hostname, options, callback) => {
          if (options?.all) {
            callback(null, [destination]);
            return;
          }
          callback(null, destination.address, destination.family);
        }) as NonNullable<Parameters<typeof httpsRequest>[1]>["lookup"],
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.byteLength;
          if (bytes > MAX_PAID_RESPONSE_BYTES) {
            response.destroy();
            fail(
              new BaseX402IntentError(
                "X402_PAID_RESPONSE_TOO_LARGE",
                "Paid x402 response exceeded safe size limits.",
                502,
              ),
            );
            return;
          }
          chunks.push(buffer);
        });
        response.on("end", () => {
          if (settled) return;
          settled = true;
          if (absoluteTimeout) clearTimeout(absoluteTimeout);
          resolve({
            statusCode: response.statusCode || 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        response.on("error", (error) => fail(error));
      },
    );
    request.setTimeout(PAID_REQUEST_TIMEOUT_MS, () => {
      request.destroy(
        new BaseX402IntentError(
          "X402_PAID_REQUEST_TIMEOUT",
          "The result of the paid x402 relay request could not be verified in time.",
          504,
        ),
      );
    });
    absoluteTimeout = setTimeout(() => {
      request.destroy(
        new BaseX402IntentError(
          "X402_PAID_REQUEST_TIMEOUT",
          "The result of the paid x402 relay request could not be verified in time.",
          504,
        ),
      );
    }, PAID_REQUEST_TIMEOUT_MS);
    request.on("error", (error) => {
      if (error instanceof BaseX402IntentError) return fail(error);
      return fail(
        new BaseX402IntentError(
          "X402_PAID_REQUEST_INDETERMINATE",
          "The result of the paid x402 relay request could not be verified; no automatic retry will be performed.",
          502,
        ),
      );
    });
    request.end();
  });
}
