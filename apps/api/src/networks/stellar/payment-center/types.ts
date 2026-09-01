import type {
  StellarLastMileCandidate,
  StellarLastMileQuoteRequest,
} from "../lastMile.js";

export const PAYMENT_CENTER_SESSION_STATES = [
  "created",
  "challenge_requesting",
  "challenge_ready",
  "authenticating",
  "authenticated",
  "authentication_rejected",
  "authentication_indeterminate",
  "firm_quote_requesting",
  "firm_quote_ready",
  "firm_quote_indeterminate",
  "sep24_session_requesting",
  "sep24_session_ready",
  "sep24_session_indeterminate",
  "awaiting_user_transfer",
  "settlement_pending",
  "settled",
  "failed",
  "refunded",
  "canceled",
  "expired",
] as const;

export type PaymentCenterSessionState =
  (typeof PAYMENT_CENTER_SESSION_STATES)[number];

export type Sep45ChallengeSnapshot = {
  authorizationEntries: string;
  clientEntryIndex: number;
  serverEntryIndex: number;
  networkPassphrase: string;
  webAuthEndpoint: string;
  webAuthContractId: string;
  signingKey: string;
  homeDomain: string;
  challengeSha256: string;
  nonceSha256: string;
  expiresAt: number;
};

export type Sep38FirmQuoteSnapshot = {
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
  fee: {
    total: string;
    asset: string;
  } | null;
  obtainedAt: number;
};

export const SEP24_TRANSACTION_STATUSES = [
  "incomplete",
  "pending_user_transfer_start",
  "pending_user_transfer_complete",
  "pending_external",
  "pending_anchor",
  "on_hold",
  "pending_stellar",
  "pending_trust",
  "pending_user",
  "completed",
  "refunded",
  "expired",
  "no_market",
  "too_small",
  "too_large",
  "error",
] as const;

export type Sep24TransactionStatus =
  (typeof SEP24_TRANSACTION_STATUSES)[number];

export type Sep24TransferInstruction = {
  assetCode: "USDC";
  assetContract: string;
  amount: string;
  anchorAccount: string;
  destination: string;
  memo: null | {
    type: "id";
    value: string;
  };
  quoteId: string;
};

export type Sep24TransactionStatusSnapshot = {
  status: Sep24TransactionStatus;
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
  transferInstruction: Sep24TransferInstruction | null;
  transferBlockedReason: string | null;
  observedAt: number;
};

export type Sep24TransactionSnapshot = {
  transactionId: string;
  responseType: "interactive_customer_info_needed";
  interactiveUrlCiphertext: string;
  createdAt: number;
  status: Sep24TransactionStatusSnapshot | null;
};

export type Sep24SubmittedTransferEvidence = {
  transactionHash: string;
  submittedAt: number;
  chainVerifiedAt: number | null;
  ledgerSequence: number | null;
};

export type PaymentCenterSessionRecord = {
  schemaVersion: "kletia_stellar_payment_session_v1";
  sessionId: string;
  state: PaymentCenterSessionState;
  version: number;
  passkeyAccount: string;
  provider: string;
  quoteRequest: StellarLastMileQuoteRequest;
  indicativeQuote: StellarLastMileCandidate;
  challenge: Sep45ChallengeSnapshot | null;
  anchorAccessTokenCiphertext: string | null;
  anchorAccessTokenExpiresAt: number | null;
  firmQuote: Sep38FirmQuoteSnapshot | null;
  sep24Transaction: Sep24TransactionSnapshot | null;
  submittedTransfer: Sep24SubmittedTransferEvidence | null;
  lastErrorCode: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
};

export type PaymentCenterSessionView = Omit<
  PaymentCenterSessionRecord,
  "anchorAccessTokenCiphertext" | "challenge" | "sep24Transaction"
> & {
  challenge: null | {
    ready: true;
    expiresAt: number;
  };
  authenticated: boolean;
  sep24Transaction: null | {
    transactionId: string;
    responseType: "interactive_customer_info_needed";
    interactiveUrlReady: true;
    createdAt: number;
    status: Sep24TransactionStatusSnapshot | null;
  };
};

export function toPaymentCenterSessionView(
  session: PaymentCenterSessionRecord,
): PaymentCenterSessionView {
  const {
    anchorAccessTokenCiphertext: _anchorAccessTokenCiphertext,
    challenge,
    sep24Transaction,
    submittedTransfer,
    ...publicSession
  } = session;
  return {
    ...publicSession,
    submittedTransfer: submittedTransfer ?? null,
    challenge: challenge
      ? { ready: true, expiresAt: challenge.expiresAt }
      : null,
    authenticated: Boolean(
      _anchorAccessTokenCiphertext &&
        session.anchorAccessTokenExpiresAt &&
        session.anchorAccessTokenExpiresAt > Date.now(),
    ),
    anchorAccessTokenExpiresAt: session.anchorAccessTokenExpiresAt,
    sep24Transaction: sep24Transaction
      ? {
          transactionId: sep24Transaction.transactionId,
          responseType: sep24Transaction.responseType,
          interactiveUrlReady: true,
          createdAt: sep24Transaction.createdAt,
          status: sep24Transaction.status ?? null,
        }
      : null,
  };
}
