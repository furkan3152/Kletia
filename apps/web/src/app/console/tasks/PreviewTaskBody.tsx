/**
 * A dry-run plan of a desk task (console design 3.7, clarify design 5.4):
 * every turn plans without storing anything (`?clarify=true&dryRun=true&
 * preview=true`), so the fare, the itinerary and Kletia's assumptions show
 * here first. Without the wallets the plan needs, it shows the exact connect
 * buttons (the task plans again with the user's accounts once they
 * connect); with them, "Review and sign" stores the plan (the commit turn)
 * and the review takes over. Nothing can be signed from a dry run.
 */
import "../../site/art/journey.css";

import type { ReactNode } from "react";
import type { ClarifyAssumption, IntentGraph, IntentPreview } from "@kletia/core";
import { AssumptionChips } from "@kletia/widget";
import { ArrowRight, Wallet } from "lucide-react";

import { FareTable } from "../../site/intent/FareTable";
import { Button } from "../../site/ui/Button";
import { cx, INK_BORDER, LABEL, SURFACE } from "../../site/ui/styles";
import { DESK_COPY } from "../content/copy";
import { useDeskActions } from "../shell/deskContext";
import type { WalletNamespace } from "./taskModel";

const copy = DESK_COPY.preview;

export interface PreviewTaskBodyProps {
  readonly intent: IntentGraph;
  readonly preview: IntentPreview | null;
  readonly missing: readonly WalletNamespace[];
  readonly replanning: boolean;
  /** The journey slot (review phase). */
  readonly journey: ReactNode;
  /** "Kletia assumed" chips of the turn that planned it; another value plans the task again. */
  readonly assumptions?: readonly ClarifyAssumption[];
  readonly onAssumption?: (id: string, option: string) => void;
  /** Stores the plan with the user's accounts (the commit turn); absent while wallets are missing. */
  readonly onReview?: () => void;
  readonly reviewing?: boolean;
  /** Why "Review and sign" cannot start now (another task is signing). */
  readonly reviewBlocked?: string | null;
}

export function PreviewTaskBody({
  intent,
  preview,
  missing,
  replanning,
  journey,
  assumptions = [],
  onAssumption,
  onReview,
  reviewing = false,
  reviewBlocked = null,
}: PreviewTaskBodyProps) {
  const { openWallet } = useDeskActions();
  const ready = missing.length === 0 && Boolean(onReview);
  return (
    <div className="flex flex-col gap-4">
      {assumptions.length > 0 && onAssumption ? (
        <div className="kla-qcard">
          <AssumptionChips assumptions={assumptions} onChange={onAssumption} disabled={replanning || reviewing} />
        </div>
      ) : null}
      {journey}
      <div className={cx("flex flex-col gap-3 p-4", INK_BORDER, SURFACE)} role="status">
        <p className={LABEL}>{intent.summary.title}</p>
        {ready ? (
          <>
            <p className="text-sm font-semibold">
              {replanning
                ? copy.replanning
                : "A dry run with your accounts: nothing is stored or signed yet. Review it to store the plan, then confirm before your wallet signs."}
            </p>
            {reviewBlocked ? <p className="text-sm font-bold">{reviewBlocked}</p> : null}
            <div className="flex flex-wrap gap-3">
              <Button size="sm" onClick={onReview} loading={reviewing} disabled={replanning || reviewing || Boolean(reviewBlocked)}>
                Review and sign
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm font-semibold">{replanning ? copy.replanning : copy.notice}</p>
            {missing.length > 0 ? (
              <>
                <p className="text-sm">{copy.connectHint}</p>
                <div className="flex flex-wrap gap-3">
                  {missing.map((namespace) => (
                    <Button key={namespace} size="sm" onClick={() => openWallet(namespace)}>
                      <Wallet className="h-4 w-4" aria-hidden="true" />
                      {namespace === "eip155" ? copy.connectEvm : copy.connectSolana}
                    </Button>
                  ))}
                </div>
              </>
            ) : null}
          </>
        )}
      </div>
      {preview ? <FareTable preview={preview} intent={intent} /> : null}
    </div>
  );
}
