import { CircleAlert, RefreshCw } from "lucide-react";

import { describePlatformError, type PlatformError } from "../../../shared/platform/kletiaClient";
import { Button } from "./Button";
import { cx, LABEL } from "./styles";

export interface ApiErrorPanelProps {
  readonly error: PlatformError;
  readonly title?: string;
  /** Replaces the default explanation (e.g. when the caller knows more context). */
  readonly message?: string;
  readonly onRetry?: () => void;
  readonly className?: string;
}

/** Renders a Kletia API error: code, status, explanation, validation issues and request id. */
export function ApiErrorPanel({ error, title = "Request failed", message, onRetry, className }: ApiErrorPanelProps) {
  return (
    <div
      role="alert"
      className={cx(
        "border-[3px] border-[#1A1A1A] bg-[#FFE4E4] p-4 text-[#1A1A1A] shadow-[4px_4px_0_#1A1A1A] dark:border-[#7F1D1D] dark:bg-[#2A1215] dark:text-[#FEE2E2] dark:shadow-[4px_4px_0_#7F1D1D]",
        className,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-[#B91C1C] dark:text-[#FCA5A5]" aria-hidden="true" />
          <div className="min-w-0">
            <p className="font-display text-lg font-bold leading-tight">{title}</p>
            <p className="mt-1 text-sm">{message ?? describePlatformError(error)}</p>
          </div>
        </div>
        <p className="flex flex-wrap gap-1.5 font-code text-[11px]">
          <span className="border-2 border-current px-1.5 py-0.5">{error.code}</span>
          {error.status > 0 ? <span className="border-2 border-current px-1.5 py-0.5">HTTP {error.status}</span> : null}
        </p>
      </div>
      {error.issues.length > 0 ? (
        <div className="mt-4">
          <p className={LABEL}>Issues</p>
          <ul className="mt-2 space-y-1.5">
            {error.issues.map((issue, index) => (
              <li key={`${issue.path}-${index}`} className="flex flex-col gap-0.5 border-l-[3px] border-[#B91C1C] pl-3 text-sm sm:flex-row sm:gap-3 dark:border-[#FCA5A5]">
                <code className="shrink-0 font-code text-xs font-bold">{issue.path || "request"}</code>
                <span>{issue.message}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        {error.requestId ? (
          <p className="font-code text-[11px] opacity-80">request id: {error.requestId}</p>
        ) : (
          <span />
        )}
        {onRetry && error.retryable ? (
          <Button size="sm" variant="secondary" onClick={onRetry}>
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Retry
          </Button>
        ) : null}
      </div>
    </div>
  );
}
