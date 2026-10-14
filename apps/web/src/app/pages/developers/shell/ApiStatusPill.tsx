import { Link } from "../../../routes/Link";
import { StatusPill } from "../../../site/ui/StatusPill";
import { cx, FOCUS_RING } from "../../../site/ui/styles";
import type { PortalHealth } from "./usePortalHealth";

/**
 * The API status in the portal bar (GET /v1/health, shared by the shell):
 * checking, ok with networks up, slow, some networks down, or unreachable.
 * It links the network status board.
 */
export function ApiStatusPill({ health, className }: { readonly health: PortalHealth | null; readonly className?: string }) {
  const tone = health?.tone ?? "neutral";
  const label = health?.label ?? "Checking API";
  const detail = health?.detail ?? "Checking whether the Kletia API answers.";
  return (
    <Link
      to="/networks"
      title={detail}
      aria-label={`API status: ${label}. ${detail} Open the network status board.`}
      className={cx("inline-flex min-h-11 items-center", FOCUS_RING, className)}
    >
      <StatusPill tone={tone}>{label}</StatusPill>
    </Link>
  );
}
