import { BACKEND_URL } from "../../../shared/config/runtime";
import type {
  StellarLastMileCandidate,
  StellarLastMileQuoteInput,
} from "./lastMile";
import type { StellarSep45Challenge } from "./sep45";

export type PaymentCenterSessionState =
  | "created"
  | "challenge_requesting"
  | "challenge_ready"
  | "authenticating"
  | "authenticated"
  | "authentication_rejected"
  | "authentication_indeterminate"
  | "firm_quote_requesting"
  | "firm_quote_ready"
  | "firm_quote_indeterminate"
  | "sep24_session_requesting"
  | "sep24_session_ready"
  | "sep24_session_indeterminate"
  | "awaiting_user_transfer"
  | "settlement_pending"
  | "settled"
  | "failed"
  | "refunded"
  | "canceled"
  | "expired";

export type PaymentCenterSession = {
  schemaVersion: "kletia_stellar_payment_session_v1";
  sessionId: string;
  state: PaymentCenterSessionState;
  version: number;
  passkeyAccount: string;
  provider: string;
  quoteRequest: StellarLastMileQuoteInput;
  indicativeQuote: StellarLastMileCandidate;
  challenge: null | { ready: true; expiresAt: number };
  anchorAccessTokenExpiresAt: number | null;
  firmQuote: null | {
    quoteType: "firm";
    quoteId: string;
    expiresAt: number;
    totalPrice: string;
    price: string;
    sellAsset: string;
    sellAmount: string;
    buyAsset: string;
    buyAmount: string;
    buyDeliveryMethod: string | null;
    fee: null | { total: string; asset: string };
    obtainedAt: number;
  };
  sep24Transaction: null | {
    transactionId: string;
    responseType: "interactive_customer_info_needed";
    interactiveUrlReady: true;
    createdAt: number;
    status: null | {
      status:
        | "incomplete"
        | "pending_user_transfer_start"
        | "pending_user_transfer_complete"
        | "pending_external"
        | "pending_anchor"
        | "on_hold"
        | "pending_stellar"
        | "pending_trust"
        | "pending_user"
        | "completed"
        | "refunded"
        | "expired"
        | "no_market"
        | "too_small"
        | "too_large"
        | "error";
      amountIn: string | null;
      amountInAsset: string | null;
      quoteId: string | null;
      withdrawAnchorAccount: string | null;
      withdrawMemo: string | null;
      withdrawMemoType: string | null;
      userActionRequiredBy: number | null;
      stellarTransactionId: string | null;
      externalTransactionId: string | null;
      message: string | null;
      transferInstruction: null | {
        assetCode: "USDC";
        assetContract: string;
        amount: string;
        anchorAccount: string;
        destination: string;
        memo: null | { type: "id"; value: string };
        quoteId: string;
      };
      transferBlockedReason: string | null;
      observedAt: number;
    };
  };
  submittedTransfer: null | {
    transactionHash: string;
    submittedAt: number;
    chainVerifiedAt: number | null;
    ledgerSequence: number | null;
  };
  lastErrorCode: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  authenticated: boolean;
};

export type PaymentCenterSessionHandle = {
  session: PaymentCenterSession;
  sessionToken: string;
};

async function objectBody(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json().catch(() => null)) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("The Stellar Payment Center returned an invalid response.");
  }
  const record = body as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(
      typeof record.message === "string"
        ? record.message
        : "The Stellar Payment Center could not continue this session.",
    );
  }
  return record;
}

function sessionFrom(body: Record<string, unknown>): PaymentCenterSession {
  const session = body.session;
  if (
    !session ||
    typeof session !== "object" ||
    Array.isArray(session) ||
    (session as Record<string, unknown>).schemaVersion !==
      "kletia_stellar_payment_session_v1"
  ) {
    throw new Error("The Payment Center session failed its browser boundary.");
  }
  return session as PaymentCenterSession;
}

export async function createPaymentCenterSession(input: {
  provider: string;
  quoteRequest: StellarLastMileQuoteInput;
}): Promise<PaymentCenterSessionHandle> {
  const response = await fetch(`${BACKEND_URL}/api/stellar/payment-center/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Kletia-Chain-Ref": "stellar:testnet",
    },
    body: JSON.stringify(input),
  });
  const body = await objectBody(response);
  const sessionToken = response.headers.get("X-Kletia-Payment-Session");
  if (!sessionToken) {
    throw new Error("The Payment Center did not return session authorization.");
  }
  return { session: sessionFrom(body), sessionToken };
}

export async function readPaymentCenterSession(
  handle: PaymentCenterSessionHandle,
): Promise<PaymentCenterSessionHandle> {
  const body = await objectBody(
    await fetch(
      `${BACKEND_URL}/api/stellar/payment-center/sessions/${encodeURIComponent(handle.session.sessionId)}`,
      {
        headers: {
          "X-Kletia-Chain-Ref": "stellar:testnet",
          "X-Kletia-Payment-Session": handle.sessionToken,
        },
      },
    ),
  );
  return { ...handle, session: sessionFrom(body) };
}

export async function preparePaymentCenterSep45Challenge(
  handle: PaymentCenterSessionHandle,
): Promise<{ handle: PaymentCenterSessionHandle; challenge: StellarSep45Challenge }> {
  const body = await objectBody(
    await fetch(
      `${BACKEND_URL}/api/stellar/payment-center/sessions/${encodeURIComponent(handle.session.sessionId)}/sep45/challenge`,
      {
        method: "POST",
        headers: {
          "X-Kletia-Chain-Ref": "stellar:testnet",
          "X-Kletia-Payment-Session": handle.sessionToken,
        },
      },
    ),
  );
  const challenge = body.challenge;
  if (
    !challenge ||
    typeof challenge !== "object" ||
    Array.isArray(challenge) ||
    typeof (challenge as Record<string, unknown>).authorizationEntries !== "string"
  ) {
    throw new Error("The Payment Center passkey challenge is missing.");
  }
  return {
    handle: { ...handle, session: sessionFrom(body) },
    challenge: challenge as StellarSep45Challenge,
  };
}

export async function completePaymentCenterSep45(input: {
  handle: PaymentCenterSessionHandle;
  signedAuthorizationEntries: string;
}): Promise<PaymentCenterSessionHandle> {
  const body = await objectBody(
    await fetch(
      `${BACKEND_URL}/api/stellar/payment-center/sessions/${encodeURIComponent(input.handle.session.sessionId)}/sep45/complete`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Kletia-Chain-Ref": "stellar:testnet",
          "X-Kletia-Payment-Session": input.handle.sessionToken,
        },
        body: JSON.stringify({
          authorizationEntries: input.signedAuthorizationEntries,
        }),
      },
    ),
  );
  return { ...input.handle, session: sessionFrom(body) };
}

export async function requestPaymentCenterFirmQuote(
  handle: PaymentCenterSessionHandle,
): Promise<PaymentCenterSessionHandle> {
  const body = await objectBody(
    await fetch(
      `${BACKEND_URL}/api/stellar/payment-center/sessions/${encodeURIComponent(handle.session.sessionId)}/quotes/firm`,
      {
        method: "POST",
        headers: {
          "X-Kletia-Chain-Ref": "stellar:testnet",
          "X-Kletia-Payment-Session": handle.sessionToken,
        },
      },
    ),
  );
  return { ...handle, session: sessionFrom(body) };
}

export async function createPaymentCenterHostedWithdrawal(
  handle: PaymentCenterSessionHandle,
): Promise<{
  handle: PaymentCenterSessionHandle;
  interactiveUrl: string;
}> {
  const body = await objectBody(
    await fetch(
      `${BACKEND_URL}/api/stellar/payment-center/sessions/${encodeURIComponent(handle.session.sessionId)}/sep24/withdrawal`,
      {
        method: "POST",
        headers: {
          "X-Kletia-Chain-Ref": "stellar:testnet",
          "X-Kletia-Payment-Session": handle.sessionToken,
        },
      },
    ),
  );
  if (typeof body.interactiveUrl !== "string") {
    throw new Error("The provider did not return a secure hosted-withdrawal page.");
  }
  const url = new URL(body.interactiveUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("The hosted-withdrawal page failed its browser boundary.");
  }
  return {
    handle: { ...handle, session: sessionFrom(body) },
    interactiveUrl: url.toString(),
  };
}

export async function refreshPaymentCenterWithdrawalStatus(
  handle: PaymentCenterSessionHandle,
): Promise<PaymentCenterSessionHandle> {
  const body = await objectBody(
    await fetch(
      `${BACKEND_URL}/api/stellar/payment-center/sessions/${encodeURIComponent(handle.session.sessionId)}/sep24/transaction`,
      {
        headers: {
          "X-Kletia-Chain-Ref": "stellar:testnet",
          "X-Kletia-Payment-Session": handle.sessionToken,
        },
      },
    ),
  );
  return { ...handle, session: sessionFrom(body) };
}

export async function submitPaymentCenterTransferEvidence(input: {
  handle: PaymentCenterSessionHandle;
  transactionHash: string;
}): Promise<PaymentCenterSessionHandle> {
  const body = await objectBody(
    await fetch(
      `${BACKEND_URL}/api/stellar/payment-center/sessions/${encodeURIComponent(input.handle.session.sessionId)}/sep24/transfer-evidence`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Kletia-Chain-Ref": "stellar:testnet",
          "X-Kletia-Payment-Session": input.handle.sessionToken,
        },
        body: JSON.stringify({ transactionHash: input.transactionHash }),
      },
    ),
  );
  return { ...input.handle, session: sessionFrom(body) };
}
