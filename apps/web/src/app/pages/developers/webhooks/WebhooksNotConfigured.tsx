import { RefreshCw } from "lucide-react";

import { Link } from "../../../routes/Link";
import { Icon } from "../../../site/art/Icon";
import { Button } from "../../../site/ui/Button";
import { cx, FOCUS_RING, INK_BORDER, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { WEBHOOKS_NOT_CONFIGURED_COPY } from "./webhookModel";

/** The deployment cannot hold webhooks (503 WEBHOOKS_NOT_CONFIGURED): what that means and where events are instead. */
export function WebhooksNotConfigured({ onRetry }: { readonly onRetry?: () => void }) {
  return (
    <div role="status" className={cx("flex flex-col items-start gap-3 p-5 sm:p-6", INK_BORDER, SURFACE)}>
      <Icon name="webhook" size={32} />
      <p className="font-display text-title font-bold">{WEBHOOKS_NOT_CONFIGURED_COPY.title}.</p>
      <p className={cx("max-w-2xl text-sm", TEXT_MUTED)}>{WEBHOOKS_NOT_CONFIGURED_COPY.body}</p>
      <p className="max-w-2xl text-sm">
        {WEBHOOKS_NOT_CONFIGURED_COPY.alternative}{" "}
        <Link to="/developers/events" className={cx("font-bold underline decoration-2 underline-offset-2", FOCUS_RING)}>
          Events
        </Link>{" "}
        shows the code.
      </p>
      <p className={cx("max-w-2xl text-xs", TEXT_MUTED)}>{WEBHOOKS_NOT_CONFIGURED_COPY.operator}</p>
      {onRetry ? (
        <Button size="sm" variant="ghost" onClick={onRetry}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          Check again
        </Button>
      ) : null}
    </div>
  );
}
