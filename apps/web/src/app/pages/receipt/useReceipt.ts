/**
 * Loads a shared receipt for the page: the public payload from the API, the
 * share's ciphertext when the link carries a key, the key set confirmed by
 * two origins (the API and this site's /.well-known mirror), then decrypts
 * and verifies everything here, in the browser.
 *
 * The key from the fragment is used only by Web Crypto in this tab: it is
 * never sent anywhere, logged or stored. Only the share id (which opens
 * nothing by itself) goes to the API.
 */
import { verifyReceipt, type ReceiptDocument, type ReceiptKey, type ReceiptVerification } from "@kletia/core";
import { KletiaApiError } from "@kletia/sdk";
import { decryptShareDisclosures, fetchReceiptKeys } from "@kletia/sdk/receipts";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { getKletiaClient, PLATFORM_ORIGIN, sdkSignal, toPlatformError, type PlatformError } from "../../../shared/platform/kletiaClient";
import type { ReceiptFragment } from "./receiptLink";

export type ShareState =
  /** No key in the link: only the signed public part. */
  | { readonly kind: "none" }
  /** The fragment is not a valid share link. */
  | { readonly kind: "invalid" }
  | { readonly kind: "open"; readonly groups: readonly string[]; readonly expiresAt: string | null }
  /** The owner revoked this share (other shares may still exist). */
  | { readonly kind: "revoked" }
  | { readonly kind: "expired" }
  /** The key does not open the stored details. */
  | { readonly kind: "locked" }
  /** The details could not be read (API error); the signed part still shows. */
  | { readonly kind: "unavailable"; readonly error: PlatformError };

export type KeyProvenance = "pinned" | "two-origins" | "none";

export interface LoadedReceipt {
  readonly document: ReceiptDocument;
  readonly verification: ReceiptVerification;
  /** Keys trusted for this page (both origins agree), reused by the recheck. */
  readonly keys: readonly ReceiptKey[];
  readonly provenance: KeyProvenance;
  /** Key discovery notes (an origin that did not answer, a key only one origin lists). */
  readonly keyNotes: readonly string[];
  readonly share: ShareState;
  /** From GET /v1/receipts/{id}/status; null when it could not be read. */
  readonly status: { readonly sequence: number; readonly terminal: boolean; readonly supersededBy: string | null } | null;
}

export type ReceiptState =
  | { readonly phase: "loading" }
  /** Unknown, never shared, or every share revoked or expired (the API cannot tell them apart, by design). */
  | { readonly phase: "missing" }
  | { readonly phase: "error"; readonly error: PlatformError }
  | { readonly phase: "ready"; readonly receipt: LoadedReceipt };

function isApiError(error: unknown, ...codes: string[]): boolean {
  return error instanceof KletiaApiError && codes.includes(error.code);
}

/** The caller's signal when the runtime can combine it with the SDK's timeout (older Safari cannot). */
function requestOptions(signal: AbortSignal): { signal?: AbortSignal } {
  const usable = sdkSignal(signal);
  return usable ? { signal: usable } : {};
}

async function loadShare(receiptId: string, fragment: ReceiptFragment, signal: AbortSignal): Promise<{ share: ShareState; disclosures: ReceiptDocument["disclosures"] | null }> {
  if (fragment.kind === "none") return { share: { kind: "none" }, disclosures: null };
  if (fragment.kind === "invalid") return { share: { kind: "invalid" }, disclosures: null };
  try {
    const sealed = await getKletiaClient().receipts.shareCiphertext(receiptId, fragment.shareId, requestOptions(signal));
    const disclosures = sealed.alg === "A256GCM" ? await decryptShareDisclosures(receiptId, fragment.shareId, sealed.ciphertext, fragment.key) : null;
    if (!disclosures) return { share: { kind: "locked" }, disclosures: null };
    return { share: { kind: "open", groups: sealed.groups, expiresAt: sealed.expiresAt }, disclosures };
  } catch (error) {
    if (isApiError(error, "RECEIPT_SHARE_NOT_FOUND", "RECEIPT_NOT_FOUND")) return { share: { kind: "revoked" }, disclosures: null };
    if (isApiError(error, "RECEIPT_SHARE_EXPIRED")) return { share: { kind: "expired" }, disclosures: null };
    if (signal.aborted) throw error;
    return { share: { kind: "unavailable", error: toPlatformError(error) }, disclosures: null };
  }
}

export async function loadReceipt(receiptId: string, fragment: ReceiptFragment, webOrigin: string, signal: AbortSignal): Promise<ReceiptState> {
  const client = getKletiaClient();
  let shared;
  try {
    shared = await client.receipts.shared(receiptId, requestOptions(signal));
  } catch (error) {
    if (isApiError(error, "RECEIPT_NOT_FOUND")) return { phase: "missing" };
    throw error;
  }
  const [share, keySet, status] = await Promise.all([
    loadShare(receiptId, fragment, signal),
    fetchReceiptKeys({ baseUrl: PLATFORM_ORIGIN, webOrigin, ...requestOptions(signal) }).catch(() => ({ keys: [] as ReceiptKey[], dropped: [] as string[], errors: ["The key set could not be read."] })),
    client.receipts.status(receiptId, requestOptions(signal)).catch(() => null),
  ]);
  const base = {
    payload: shared.payload,
    digest: shared.digest,
    signature: shared.signature,
    ...(shared.inclusion ? { inclusion: shared.inclusion } : {}),
  } as ReceiptDocument;
  const document = share.disclosures ? ({ ...base, disclosures: share.disclosures } as ReceiptDocument) : base;
  const verification = await verifyReceipt(document, { keys: keySet.keys });
  const keyNotes = [
    ...keySet.errors,
    ...(keySet.dropped.length > 0 ? [`Not confirmed by both origins, so not trusted: ${keySet.dropped.join(", ")}.`] : []),
  ];
  return {
    phase: "ready",
    receipt: {
      document,
      verification,
      keys: keySet.keys,
      provenance: verification.key.provenance === "pinned" ? "pinned" : verification.key.provenance === "supplied" ? "two-origins" : "none",
      keyNotes,
      share: share.share,
      status: status ? { sequence: status.sequence, terminal: status.terminal, supersededBy: status.supersededBy } : null,
    },
  };
}

/** The page's receipt state for `receiptId` and the link's fragment; `reload` refetches. */
export function useReceipt(receiptId: string, fragment: ReceiptFragment): { readonly state: ReceiptState; readonly reload: () => void } {
  const [attempt, setAttempt] = useState(0);
  // The fragment's content (never logged; only compared in memory).
  const fragmentKey = fragment.kind === "share" ? `share:${fragment.shareId}:${fragment.key}` : fragment.kind;
  const requestKey = `${receiptId}|${fragmentKey}|${attempt}`;
  const [result, setResult] = useState<{ readonly key: string; readonly state: ReceiptState } | null>(null);
  const fragmentRef = useRef(fragment);
  useLayoutEffect(() => {
    fragmentRef.current = fragment;
  });

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    loadReceipt(receiptId, fragmentRef.current, window.location.origin, controller.signal).then(
      (next) => {
        if (active) setResult({ key: requestKey, state: next });
      },
      (error: unknown) => {
        if (active) setResult({ key: requestKey, state: { phase: "error", error: toPlatformError(error) } });
      },
    );
    return () => {
      active = false;
      controller.abort();
    };
  }, [receiptId, requestKey]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  return { state: result && result.key === requestKey ? result.state : { phase: "loading" }, reload };
}
