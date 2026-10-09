/**
 * Signing hand-off for agents: a Studio link the user opens to plan the same
 * intent with their own wallet accounts, review it (external recipients are
 * flagged there) and sign it. No server state is created and nothing in the
 * link can move funds by itself.
 */
import { invalidRequest } from "../context.js";
import { kletiaWebOrigin } from "../webOrigin.js";

/** Studio reads at most this many characters of `?q=`. */
export const HANDOFF_MAX_TEXT = 500;

export interface SigningLink {
  readonly url: string;
  readonly text: string;
  readonly instructions: string;
}

export function signingLink(text: unknown): SigningLink {
  const value = typeof text === "string" ? text.replace(/\s+/gu, " ").trim() : "";
  if (!value || value.length > HANDOFF_MAX_TEXT || /[\p{Cc}\p{Cf}]/u.test(value)) {
    throw invalidRequest(`text must be 1-${HANDOFF_MAX_TEXT} printable characters describing the intent.`, [
      { path: "text", message: `Required, 1-${HANDOFF_MAX_TEXT} printable characters.` },
    ]);
  }
  const url = new URL("/studio", kletiaWebOrigin());
  url.searchParams.set("q", value);
  return {
    url: url.toString(),
    text: value,
    instructions:
      "Give this link to the user. Kletia Studio plans the intent again with the user's own connected wallets, shows every step, amount and recipient for review, and asks the wallet to sign. Agents never sign or receive transactions.",
  };
}
