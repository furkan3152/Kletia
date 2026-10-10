/**
 * Reads an approval for the gate page: the public view
 * (`GET /v1/policy/approvals/{id}`) and, to show the reader that the digest
 * a wallet would sign belongs to the steps printed here, the intent it names
 * (`approvalDigest` from `@kletia/core`, recomputed in this browser).
 *
 * Reading never approves. While the approval is pending the view is read
 * again every 20 seconds (only while the tab is visible), so a decision made
 * elsewhere (a project key in the portal, another approver) shows up.
 */
import { approvalDigest } from "@kletia/core";
import { KletiaApiError, type PolicyApprovalView } from "@kletia/sdk";
import { useCallback, useEffect, useRef, useState } from "react";

import { getKletiaClient, sdkSignal, toPlatformError, type PlatformError } from "../../../shared/platform/kletiaClient";

/** Whether the digest shown is the digest of the intent's steps. */
export type DigestCheck = "match" | "mismatch" | "unavailable";

export type ApprovalLoad =
  | { readonly phase: "loading" }
  | { readonly phase: "missing" }
  | { readonly phase: "error"; readonly error: PlatformError }
  | { readonly phase: "ready"; readonly view: PolicyApprovalView; readonly digest: DigestCheck };

const POLL_MS = 20_000;

function options(signal: AbortSignal): { signal?: AbortSignal } {
  const usable = sdkSignal(signal);
  return usable ? { signal: usable } : {};
}

async function checkDigest(view: PolicyApprovalView, signal: AbortSignal): Promise<DigestCheck> {
  try {
    const intent = await getKletiaClient().intents.get(view.intentId, options(signal));
    return intent.id === view.intentId && approvalDigest(intent, view.keyId) === view.digest ? "match" : "mismatch";
  } catch {
    return "unavailable";
  }
}

export function useApproval(id: string): {
  readonly state: ApprovalLoad;
  readonly reload: () => void;
  /** Replaces the view after a decision answered with the new one. */
  readonly settle: (view: PolicyApprovalView) => void;
} {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ readonly key: string; readonly load: ApprovalLoad } | null>(null);
  const key = `${id}|${attempt}`;
  const digestRef = useRef<{ readonly digest: string; readonly check: DigestCheck } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let timer = 0;
    const read = async (first: boolean) => {
      try {
        const view = await getKletiaClient().approvals.get(id, options(controller.signal));
        const known = digestRef.current;
        const digest = known && known.digest === view.digest ? known.check : await checkDigest(view, controller.signal);
        digestRef.current = { digest: view.digest, check: digest };
        if (!active) return;
        setState({ key, load: { phase: "ready", view, digest } });
        if (view.status === "pending") timer = window.setTimeout(poll, POLL_MS);
      } catch (error) {
        if (!active) return;
        if (error instanceof KletiaApiError && error.code === "APPROVAL_NOT_FOUND") {
          setState({ key, load: { phase: "missing" } });
          return;
        }
        // A failed background read keeps the page as it is and tries again later.
        if (first) setState({ key, load: { phase: "error", error: toPlatformError(error) } });
        else timer = window.setTimeout(poll, POLL_MS);
      }
    };
    const poll = () => {
      if (!active) return;
      if (document.visibilityState === "hidden") {
        timer = window.setTimeout(poll, POLL_MS);
        return;
      }
      void read(false);
    };
    void read(true);
    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [id, key]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  const settle = useCallback(
    (view: PolicyApprovalView) =>
      setState((current) =>
        current && current.load.phase === "ready" ? { key: current.key, load: { phase: "ready", view, digest: current.load.digest } } : current,
      ),
    [],
  );
  return { state: state && state.key === key ? state.load : { phase: "loading" }, reload, settle };
}
