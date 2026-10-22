/**
 * Developer account rules the portal applies on its side. The API builds and
 * verifies the sign-in message; the portal only refuses to ask a wallet to
 * sign text that names another site, address, chain, purpose or a past
 * expiry (a defence against a tampered response), reusing the admin panel's
 * message reader. Pure, so `node --test` loads it.
 */
import { parseSignInMessage, signInProblems } from "../../admin/model/signIn.ts";

/** `Request ID` and URI path of a developer portal sign-in (packages/core accounts.ts). */
export const ACCOUNT_SIGN_IN_REQUEST_ID = "dev_login";
export const ACCOUNT_SIGN_IN_PATH = "/developers/keys";
/** Base: the chain an EVM sign-in names when the wallet sits on a chain the API does not list. */
export const DEFAULT_ACCOUNT_CHAIN_ID = 8453;
/** Chains an EVM sign-in may name: Ethereum, Optimism, Polygon, Base, Arbitrum One. */
export const ACCOUNT_CHAIN_IDS: readonly number[] = [1, 10, 137, 8453, 42161];

export interface AccountMessageExpectation {
  readonly kind: "evm" | "solana";
  /** `window.location.host` and `window.location.origin` of the portal. */
  readonly host: string;
  readonly origin: string;
  readonly address: string;
  readonly chainId?: number;
  readonly now: number;
}

/** Problems that stop the portal from asking the wallet to sign (empty when the text is what was asked for). */
export function accountMessageProblems(message: string, expected: AccountMessageExpectation): string[] {
  const fields = parseSignInMessage(message);
  const problems = signInProblems(fields, expected).map((problem) => problem.replace("The API sent a sign-in message the panel cannot read.", "The API sent a sign-in message the portal cannot read."));
  if (!fields) return problems;
  if (fields.requestId !== ACCOUNT_SIGN_IN_REQUEST_ID) problems.push("The message is not a developer portal sign-in.");
  if (fields.uri !== `${expected.origin}${ACCOUNT_SIGN_IN_PATH}`) problems.push("The message names another page than this portal.");
  return problems;
}

/** The chain id an EVM sign-in should name for a wallet on `chainId`. */
export function accountChainId(chainId: number | undefined): number {
  return chainId !== undefined && ACCOUNT_CHAIN_IDS.includes(chainId) ? chainId : DEFAULT_ACCOUNT_CHAIN_ID;
}

export interface AccountKeyLike {
  readonly id: string;
  readonly kind: "project" | "agent" | "publishable";
  readonly revokedAt: string | null;
  readonly expiresAt: string | null;
  readonly previousExpiresAt: string | null;
  readonly createdAt: string;
}

export type AccountKeyStatus = "active" | "grace" | "revoked" | "expired";

export function accountKeyStatus(key: AccountKeyLike, now: number): AccountKeyStatus {
  if (key.revokedAt) return "revoked";
  if (key.expiresAt && Date.parse(key.expiresAt) <= now) return "expired";
  if (key.previousExpiresAt && Date.parse(key.previousExpiresAt) > now) return "grace";
  return "active";
}

/** Active keys first (project keys before their children), then the rest, newest first within each group. */
export function sortAccountKeys<T extends AccountKeyLike>(keys: readonly T[], now: number): T[] {
  const rank = (key: T) => {
    const status = accountKeyStatus(key, now);
    const live = status === "active" || status === "grace";
    return (live ? 0 : 2) + (key.kind === "project" ? 0 : 1);
  };
  return [...keys].sort((a, b) => rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

/** The raw project id of a `prj_key_…` id (what the key list's ids use), or null. */
export function projectKeyId(projectId: string): string | null {
  const match = /^prj_(key_[0-9a-f]{24})$/u.exec(projectId);
  return match ? (match[1] as string) : null;
}

/** What the portal says about an API error code of the account routes. */
export function accountErrorText(code: string, fallback: string): string {
  switch (code) {
    case "ACCOUNT_SESSION_REQUIRED":
      return "Your sign-in ended. Sign in with your wallet again: your projects stay yours.";
    case "ACCOUNT_NONCE_INVALID":
      return "The sign-in message expired or was already used. Start the sign-in again.";
    case "ACCOUNT_SIGNATURE_INVALID":
      return "The signature does not match the message and wallet. Start the sign-in again.";
    case "ACCOUNT_ORIGIN_FORBIDDEN":
      return "Developer accounts work only on the Kletia developer portal.";
    case "PROJECT_ALREADY_OWNED":
      return "Another wallet owns this project. Sign in with that wallet to manage it.";
    case "PROJECT_LIMIT_REACHED":
      return "This wallet already owns the most projects allowed (20).";
    case "PROJECT_NOT_FOUND":
      return "This wallet does not own that project.";
    default:
      return fallback;
  }
}
