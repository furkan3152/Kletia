/**
 * A plan that did not come back: the source question for
 * SOURCE_REQUIRED, the "not supported" panel for INTENT_UNSUPPORTED,
 * and the API's own words for every other refusal (a safety or input
 * check: never tried anywhere else). Transport failures offer a retry.
 */
import type { ReactNode } from "react";

import type { PlatformError } from "../../../shared/platform/kletiaClient";
import { ApiErrorPanel } from "../../site/ui/ApiErrorPanel";
import { DESK_COPY } from "../content/copy";
import { DESK_MORE_COPY } from "../shell/deskCopy";
import type { DeskPlanFailure } from "../hooks/planPreview";
import type { LegacyNetwork } from "../state/deskModel";
import type { PlanFailureRoute, WalletNamespace } from "./taskModel";
import { UnsupportedTaskBody } from "./UnsupportedTaskBody";

export interface PlanFailurePanelProps {
  readonly failure: DeskPlanFailure;
  readonly route: PlanFailureRoute;
  readonly sourceChips: ReactNode;
  readonly onRetry: () => void;
  readonly onAskEngine: (network: LegacyNetwork) => void;
  readonly onHint: (sentence: string) => void;
  /** Wallets to connect when a plan made from holdings found no route and none is connected. */
  readonly connect?: readonly WalletNamespace[];
  readonly onConnect?: (namespace: WalletNamespace) => void;
}

function platformErrorOf(failure: DeskPlanFailure): PlatformError {
  return {
    code: failure.code,
    message: failure.message,
    status: failure.status,
    issues: failure.issues,
    requestId: failure.requestId,
    retryable: failure.retryable,
    unreachable: failure.status === 0,
  };
}

export function PlanFailurePanel({ failure, route, sourceChips, onRetry, onAskEngine, onHint, connect = [], onConnect }: PlanFailurePanelProps) {
  if (route.kind === "source") {
    return (
      <div className="flex flex-col gap-3">
        <p role="alert" className="border-l-4 border-[var(--kl-warning)] bg-[var(--kl-warning-bg)] px-3 py-2 text-sm font-bold text-fg">
          {failure.message}
        </p>
        {sourceChips}
      </div>
    );
  }
  if (route.kind === "unsupported") {
    return <UnsupportedTaskBody message={failure.message} hints={failure.hints} route={route.route} onHint={onHint} onAskEngine={onAskEngine} />;
  }
  if (route.kind === "understood") {
    return (
      <UnsupportedTaskBody
        message={failure.message}
        hints={failure.hints}
        route={null}
        onHint={onHint}
        onAskEngine={onAskEngine}
        connect={connect}
        {...(onConnect ? { onConnect } : {})}
      />
    );
  }
  const title =
    route.kind === "unreachable" ? DESK_COPY.source.unreachable : route.kind === "retry" ? DESK_COPY.errors.generic : DESK_MORE_COPY.failure.refusedTitle;
  return (
    <ApiErrorPanel
      error={platformErrorOf(failure)}
      title={title}
      message={route.kind === "refused" ? `${failure.message} ${DESK_MORE_COPY.failure.refusedLead}` : failure.message}
      {...(route.kind === "retry" ? { onRetry } : {})}
    />
  );
}
