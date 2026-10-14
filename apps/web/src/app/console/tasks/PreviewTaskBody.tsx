/**
 * A task planned without wallets (console design 3.7): the dry-run fare with
 * the preview accounts, and connect buttons for exactly the wallets the plan
 * needs. When they connect the task plans again with the user's accounts;
 * nothing can be signed from a preview.
 */
import type { ReactNode } from "react";
import type { IntentGraph, IntentPreview } from "@kletia/core";
import { Wallet } from "lucide-react";

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
}

export function PreviewTaskBody({ intent, preview, missing, replanning, journey }: PreviewTaskBodyProps) {
  const { openWallet } = useDeskActions();
  return (
    <div className="flex flex-col gap-4">
      {journey}
      <div className={cx("flex flex-col gap-3 p-4", INK_BORDER, SURFACE)} role="status">
        <p className={LABEL}>{intent.summary.title}</p>
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
      </div>
      {preview ? <FareTable preview={preview} intent={intent} /> : null}
    </div>
  );
}
