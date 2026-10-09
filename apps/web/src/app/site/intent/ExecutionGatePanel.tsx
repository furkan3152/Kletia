import type { IntentGraph } from "@kletia/core";
import { contractReviewModel } from "@kletia/widget/review";
import { OctagonX, PenLine } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ContractReviewCard } from "../../../shared/platform/ContractReviewCard";
import type { ExecutionGate } from "../../../shared/platform/useIntentExecution";
import { Button } from "../ui/Button";
import { cx, HARD_SHADOW, INK_BORDER, LABEL, SURFACE } from "../ui/styles";
import { FareTable } from "./FareTable";

const FARE_COPY: Readonly<Record<Extract<ExecutionGate, { kind: "fare" }>["reason"], string>> = {
  "before-prepare": "Check the fare before Kletia prepares this step for your wallet.",
  prepared: "This is the fare of exactly what your wallet will sign, and it differs from the one you approved.",
  changed: "The fare changed since you approved it. Kletia handed nothing to your wallet.",
  unacknowledged: "Kletia no longer had the fare you approved, so here is the fare of exactly what your wallet will sign.",
};

/**
 * A decision before the next wallet prompt: a fare that changed (the old
 * one struck through) or the prepared review of a custom-contract step.
 * Only "Approve" continues; "Stop" signs nothing. Focus moves here when it
 * opens so keyboard and screen-reader users meet it first. Render it with
 * `key={gateKey(gate)}`.
 */
export function ExecutionGatePanel({
  gate,
  intent,
  onResolve,
}: {
  readonly gate: ExecutionGate;
  readonly intent: IntentGraph | null;
  readonly onResolve: (approved: boolean) => void;
}) {
  // Keyed by the caller per gate, so the acknowledgement never carries over to another review.
  const [acknowledged, setAcknowledged] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: false });
  }, []);

  const needsAck = gate.kind === "review" && contractReviewModel(gate.review).needsAcknowledgement;
  const changed = gate.kind === "fare" && (gate.reason === "changed" || gate.changes.length > 0);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="group"
      aria-label={gate.kind === "fare" ? "Approve the fare again before signing" : "Confirm the custom contract before signing"}
      className={cx("kl-rise flex flex-col gap-4 p-4 focus:outline-none focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#0052FF] sm:p-5", INK_BORDER, HARD_SHADOW, SURFACE)}
    >
      <div>
        <p className={cx(LABEL, "text-[#0052FF] dark:text-[#7EA6FF]")}>Before your wallet asks</p>
        <p className="mt-1 font-display text-xl font-bold leading-tight">{gate.stepTitle}</p>
        <p className="mt-1.5 text-sm font-semibold leading-relaxed" role="status">
          {gate.kind === "fare"
            ? changed
              ? "The fare changed since you approved it. Nothing is signed until you approve the new one."
              : FARE_COPY[gate.reason]
            : "Kletia prepared this step and simulated it again. Check the contract before your wallet asks you to sign."}
        </p>
      </div>
      {gate.kind === "fare" ? (
        <FareTable preview={gate.preview} intent={intent} previous={changed ? gate.previous : null} changes={gate.changes} />
      ) : (
        <ContractReviewCard
          review={gate.review}
          planned={gate.planned}
          title={gate.stepTitle}
          acknowledged={acknowledged}
          onAcknowledge={setAcknowledged}
        />
      )}
      <div className="flex flex-wrap gap-3">
        <Button onClick={() => onResolve(true)} disabled={needsAck && !acknowledged} className="disabled:shadow-none">
          <PenLine className="h-4 w-4" aria-hidden="true" />
          {gate.kind === "fare" ? "Approve this fare" : "Sign this step"}
        </Button>
        <Button variant="secondary" onClick={() => onResolve(false)}>
          <OctagonX className="h-4 w-4" aria-hidden="true" />
          Stop, sign nothing
        </Button>
      </div>
    </div>
  );
}
