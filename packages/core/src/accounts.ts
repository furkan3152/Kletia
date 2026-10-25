/**
 * Developer accounts: a wallet signs in to the developer portal (EIP-4361 for
 * EVM wallets, the Sign In With Solana text for Solana wallets) and manages
 * the projects it owns: list them, issue, rotate and revoke their keys, and
 * get back in on a new device by signing in again. Shared by the API
 * (apps/api/src/platform/http/accounts) and the portal.
 *
 * The session is a bearer token sent in the `Kletia-Account-Session` header,
 * never an API key and never a cookie. It works only from the origin that
 * signed in.
 */
import type { NetworkKey } from "./chains.js";

export type AccountWalletKind = "evm" | "solana";

/** Header that carries the account session token. */
export const ACCOUNT_SESSION_HEADER = "Kletia-Account-Session";

/** Account session tokens: `kl_acs_` + 43 base64url characters (32 random bytes). */
export const ACCOUNT_SESSION_TOKEN_PATTERN = /^kl_acs_[A-Za-z0-9_-]{43}$/u;

/**
 * The statement of the sign-in message (both wallet families). One session
 * serves the developer portal and the desk's wallet tracking, so the text
 * names both.
 */
export const ACCOUNT_SIGN_IN_STATEMENT =
  "Sign in to Kletia with this wallet (developer projects and keys, and wallet tracking on the desk). This signature does not move funds or approve a transaction.";

/** `Request ID` of the sign-in message: tells it apart from an admin sign-in. */
export const ACCOUNT_SIGN_IN_REQUEST_ID = "dev_login";

/** Path of the sign-in message's `URI` under the signing origin (the site itself: the portal and the desk sign in alike). */
export const ACCOUNT_SIGN_IN_PATH = "/";

/**
 * EVM networks a sign-in message may name. Plain wallet (EOA) signatures are
 * checked offline; smart-contract wallets (ERC-1271 / ERC-6492) are checked on
 * the named network.
 */
export const ACCOUNT_EVM_NETWORKS: readonly NetworkKey[] = Object.freeze(["base", "ethereum", "arbitrum", "optimism", "polygon"] as NetworkKey[]);

export const ACCOUNT_LIMITS = Object.freeze({
  /** A sign-in message is valid this long, once. */
  nonceTtlSeconds: 300,
  /** A session ends this long after sign-in at the latest. */
  sessionTtlSeconds: 8 * 60 * 60,
  /** A session ends after this long without a request. */
  sessionIdleSeconds: 60 * 60,
  /** Projects one wallet may own. */
  projectsPerWallet: 20,
  /** Sign-in messages per minute from one address. */
  noncesPerMinutePerIp: 10,
  /** Sign-in attempts per minute from one address. */
  signInsPerMinutePerIp: 10,
  /** Reads per minute of one session. */
  readsPerMinutePerSession: 120,
  /** Changes (projects and keys) per minute of one session. */
  writesPerMinutePerSession: 20,
  /** New projects per hour of one wallet. */
  projectsPerHourPerWallet: 5,
  /** Activity rows returned by GET /v1/accounts/activity. */
  activityRows: 50,
});

/** Public project ids of owned projects: `prj_` + the id of the key that started the project. */
export const ACCOUNT_PROJECT_ID_PATTERN = /^prj_(key_[0-9a-f]{24})$/u;

export interface AccountNonceRequest {
  readonly walletKind: AccountWalletKind;
  readonly address: string;
  /** EVM only: the chain id the message names (one of ACCOUNT_EVM_NETWORKS). */
  readonly chainId?: number;
}

export interface AccountNonceResponse {
  /** The exact text to sign. */
  readonly message: string;
  readonly nonce: string;
  readonly expiresAt: string;
  readonly walletKind: AccountWalletKind;
}

export interface AccountSessionView {
  readonly walletKind: AccountWalletKind;
  /** Checksummed EVM address, or the base58 Solana address. */
  readonly address: string;
  readonly chainId: number | null;
  readonly expiresAt: string;
  readonly idleExpiresAt: string;
}

export interface AccountSignInResponse {
  /** Send it as `Kletia-Account-Session` from the same origin. Shown once. */
  readonly token: string;
  readonly session: AccountSessionView;
}

export type AccountProjectSource = "created" | "claimed";

export interface AccountProjectView {
  /** `prj_key_…`, the id the project's keys report. */
  readonly id: string;
  /** Brand name from the project settings, when set. */
  readonly name: string | null;
  readonly source: AccountProjectSource;
  readonly ownedSince: string;
  /** Active project keys (kl_dev_). */
  readonly activeKeys: number;
  /** Active agent and publishable keys. */
  readonly activeChildKeys: number;
}

export type AccountKeyKind = "project" | "agent" | "publishable";

export interface AccountKeyView {
  readonly id: string;
  readonly name: string;
  readonly kind: AccountKeyKind;
  readonly parentId: string | null;
  readonly last4: string | null;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly rotatedAt: string | null;
  readonly previousExpiresAt: string | null;
  readonly revokedAt: string | null;
  readonly expiresAt: string | null;
}

export type AccountActivityAction =
  | "account.sign_in"
  | "account.sign_out"
  | "account.project.create"
  | "account.project.claim"
  | "account.key.issue"
  | "account.key.rotate"
  | "account.key.revoke";

export interface AccountActivityView {
  readonly id: string;
  readonly at: string;
  readonly action: AccountActivityAction;
  readonly outcome: "ok" | "denied" | "error";
  readonly projectId: string | null;
  readonly keyId: string | null;
}

/** `prj_key_…` → `key_…` (the raw project id), or null when it is not an owned project's id. */
export function accountProjectRawId(value: string): string | null {
  const match = ACCOUNT_PROJECT_ID_PATTERN.exec(value);
  return match ? (match[1] as string) : null;
}
