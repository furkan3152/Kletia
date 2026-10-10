/**
 * Receipt share links: `https://kletiaai.xyz/r/<receiptId>#s=<shareId>&k=<key>`.
 *
 * The decryption key travels only in the fragment, which browsers never send
 * to a server. This module only parses it: it never logs the fragment, never
 * puts it in a request, and never stores it. The page removes it from the
 * address bar only when the reader asks. Pure, so `node --test` loads it.
 */

export const RECEIPT_ID_PATTERN = /^rcpt_[0-9a-f]{32}$/u;
export const SHARE_ID_PATTERN = /^rsh_[0-9a-f]{24}$/u;
/** base64url of 32 bytes, unpadded. */
export const SHARE_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export type ReceiptFragment =
  /** No share parameters: only the signed public part can be shown. */
  | { readonly kind: "none" }
  | { readonly kind: "share"; readonly shareId: string; readonly key: string }
  /** Share parameters that are malformed, repeated or incomplete. */
  | { readonly kind: "invalid" };

/**
 * Reads `#s=<shareId>&k=<key>` (either order). A fragment without `s` and `k`
 * (an anchor such as `#section`) counts as none. One with share parameters is
 * a share only when it holds exactly one `s`, one `k` and nothing else: extra
 * parameters (text someone appended to a genuine link) make it invalid.
 */
export function parseReceiptFragment(hash: string): ReceiptFragment {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return { kind: "none" };
  const params = new URLSearchParams(raw);
  const shareIds = params.getAll("s");
  const keys = params.getAll("k");
  if (shareIds.length === 0 && keys.length === 0) return { kind: "none" };
  if (shareIds.length !== 1 || keys.length !== 1) return { kind: "invalid" };
  for (const name of params.keys()) if (name !== "s" && name !== "k") return { kind: "invalid" };
  const shareId = shareIds[0] ?? "";
  const key = keys[0] ?? "";
  if (!SHARE_ID_PATTERN.test(shareId) || !SHARE_KEY_PATTERN.test(key)) return { kind: "invalid" };
  return { kind: "share", shareId, key };
}

/** The receipt id of `/r/<receiptId>`, or null. */
export function receiptIdFromPath(pathname: string): string | null {
  const match = /^\/r\/([^/]+)\/?$/u.exec(pathname);
  const id = match?.[1] ?? "";
  return RECEIPT_ID_PATTERN.test(id) ? id : null;
}

/** The page address without the fragment (and without a query): safe to show, copy or log. */
export function receiptPageUrl(origin: string, receiptId: string): string {
  return `${origin.replace(/\/+$/u, "")}/r/${receiptId}`;
}

/** Serial printed on the ticket: the first 8 hex digits of the receipt id, "3E7A·91C0". */
export function receiptSerial(receiptId: string): string {
  const hex = receiptId.replace(/^rcpt_/u, "").toUpperCase();
  return `${hex.slice(0, 4)}·${hex.slice(4, 8)}`;
}

/**
 * The CLI command that re-checks a receipt; the link itself is pasted by the
 * reader. Double quotes keep the link's `&` literal in bash, zsh, fish,
 * PowerShell and cmd.exe alike (single quotes do not quote in cmd.exe).
 */
export const REVERIFY_COMMAND = 'npx @kletia/cli receipt reverify "<this link>"';

/** Origins a copied command may name: https, or plain http on a loopback host (local development). */
const COMMAND_ORIGIN = /^(?:https:\/\/[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?|http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]))(?::\d{1,5})?$/u;
/** Every character a rebuilt link can hold; none is special inside double quotes in any common shell. */
const COMMAND_LINK = /^[A-Za-z0-9:/.#=&_\-[\]]+$/u;

/**
 * The share link rebuilt from its checked parts only (never from the address
 * bar, which may carry text someone appended): `<origin>/r/<receiptId>`, plus
 * `#s=<shareId>&k=<key>` when a share is given. Null when a part does not check out.
 */
export function receiptShareLink(origin: string, receiptId: string, share?: { readonly shareId: string; readonly key: string } | null): string | null {
  const base = origin.replace(/\/+$/u, "");
  if (!COMMAND_ORIGIN.test(base) || !RECEIPT_ID_PATTERN.test(receiptId)) return null;
  if (share && (!SHARE_ID_PATTERN.test(share.shareId) || !SHARE_KEY_PATTERN.test(share.key))) return null;
  const link = `${receiptPageUrl(base, receiptId)}${share ? `#s=${share.shareId}&k=${share.key}` : ""}`;
  return COMMAND_LINK.test(link) ? link : null;
}

/**
 * The command with a concrete link, for the reader's own clipboard: the link
 * is rebuilt from checked parts and double-quoted (see REVERIFY_COMMAND). Null
 * when a part does not check out; the page then copies the placeholder command.
 */
export function reverifyCommandFor(origin: string, receiptId: string, share?: { readonly shareId: string; readonly key: string } | null): string | null {
  const link = receiptShareLink(origin, receiptId, share);
  return link === null ? null : `npx @kletia/cli receipt reverify "${link}"`;
}
