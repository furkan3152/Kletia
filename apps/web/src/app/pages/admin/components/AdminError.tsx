import { ApiErrorPanel } from "../../../site/ui/ApiErrorPanel";
import { describeAdminError } from "../api/adminClient";
import { toPanelError } from "../api/errors";

/** An admin API error as the site's error panel: code, status, request id, issues and Retry. */
export function AdminError({ error, title, onRetry, className }: { readonly error: unknown; readonly title: string; readonly onRetry?: () => void; readonly className?: string }) {
  return <ApiErrorPanel error={toPanelError(error)} title={title} message={describeAdminError(error)} onRetry={onRetry} className={className} />;
}
