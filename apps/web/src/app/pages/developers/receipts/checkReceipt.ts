/**
 * "Check a receipt" on the Receipts page (portal design 4.4.7): what the
 * pasted text is.
 *
 * - A receipt link (or a bare `rcpt_` id) becomes this site's route path
 *   `/r/<receiptId>` only: the origin, the query and anything else are
 *   dropped, so a link from any host opens Kletia's own receipt page. A
 *   share fragment (`#s=…&k=…`) is kept apart, validated, and only handed to
 *   the in-tab router: browsers never send a fragment to a server, and
 *   nothing here sends anything anywhere.
 * - Receipt JSON (`payload`, `digest`, `signature`) is verified in the
 *   browser, with the key set both Kletia origins publish.
 * - Anything else gets a message.
 *
 * Pure, so the node tests load it directly.
 */
import { parseReceiptFragment, receiptIdFromPath, RECEIPT_ID_PATTERN } from "../../receipt/receiptLink.ts";

/** Receipt JSON larger than this is refused before parsing (a receipt is a few KB). */
export const MAX_RECEIPT_JSON = 256 * 1024;

export interface ReceiptJson {
  readonly payload: Record<string, unknown>;
  readonly digest: string;
  readonly signature: Record<string, unknown>;
  readonly [field: string]: unknown;
}

export type ReceiptInput =
  | { readonly kind: "empty" }
  | {
      readonly kind: "link";
      /** `/r/rcpt_…`: the route path only, never an origin, query or fragment. */
      readonly path: string;
      /** `#s=…&k=…` when the link carried a valid share key, else "" (kept in this tab, for the router only). */
      readonly fragment: string;
      /** Set when the link's share part was malformed and was dropped. */
      readonly note: string | null;
    }
  | { readonly kind: "json"; readonly document: ReceiptJson; readonly receiptId: string | null }
  | { readonly kind: "junk"; readonly message: string };

const HINT = "Paste a receipt link (/r/rcpt_…, with its #s=…&k=… share part if it has one), a receipt id, or the receipt JSON.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function classifyJson(text: string): ReceiptInput {
  if (text.length > MAX_RECEIPT_JSON) return { kind: "junk", message: "That is larger than any receipt (256 KB at most)." };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: "junk", message: "That looks like JSON but does not parse. Paste the whole receipt document." };
  }
  if (!isRecord(value) || !isRecord(value.payload) || typeof value.digest !== "string" || !isRecord(value.signature)) {
    return { kind: "junk", message: "That JSON is not a Kletia receipt: a receipt has payload, digest and signature." };
  }
  const receiptId = typeof value.payload.receiptId === "string" && RECEIPT_ID_PATTERN.test(value.payload.receiptId) ? value.payload.receiptId : null;
  return { kind: "json", document: value as ReceiptJson, receiptId };
}

/** What the pasted text is; never throws, never fetches. */
export function classifyReceiptInput(raw: string): ReceiptInput {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { kind: "empty" };
  if (text.startsWith("{")) return classifyJson(text);
  if (RECEIPT_ID_PATTERN.test(text)) return { kind: "link", path: `/r/${text}`, fragment: "", note: null };
  if (/\s/u.test(text) || text.length > 4_096) return { kind: "junk", message: HINT };

  let url: URL;
  try {
    // Absolute links keep their own host only long enough to be dropped; a bare "/r/…" path parses against a placeholder.
    url = new URL(text, "https://receipt.invalid");
  } catch {
    return { kind: "junk", message: HINT };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { kind: "junk", message: HINT };
  const receiptId = receiptIdFromPath(url.pathname);
  if (!receiptId) return { kind: "junk", message: `That link is not a receipt page. ${HINT}` };
  const share = parseReceiptFragment(url.hash);
  if (share.kind === "share") return { kind: "link", path: `/r/${receiptId}`, fragment: `#s=${share.shareId}&k=${share.key}`, note: null };
  return {
    kind: "link",
    path: `/r/${receiptId}`,
    fragment: "",
    note: share.kind === "invalid" ? "The link's share part is malformed, so only the signed public part opens." : null,
  };
}
