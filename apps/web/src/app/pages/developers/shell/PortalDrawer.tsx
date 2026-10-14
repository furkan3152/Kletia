import { useLayoutEffect, useRef } from "react";

import { Sheet } from "../../../site/ui/Sheet";
import { PortalSidebar } from "./PortalSidebar";
import type { PortalGroup, PortalPageId } from "./portalRoutes";

export interface PortalDrawerProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly current: PortalPageId;
  /** Open at this group (from the rail); null: at the top. */
  readonly group: PortalGroup | null;
}

/**
 * The sidebar as a drawer under 1280 px: a full-height sheet from the
 * left, the whole screen on phones. Focus is trapped while it is open,
 * Esc and the backdrop close it, and focus returns to the button that
 * opened it (or moves to the next page's heading after a link).
 */
export function PortalDrawer({ open, onClose, current, group }: PortalDrawerProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!open || !group) return;
    const target = panelRef.current?.querySelector<HTMLElement>(`[data-portal-group="${group}"]`);
    target?.scrollIntoView({ block: "start" });
    target?.querySelector<HTMLElement>("a[href]")?.focus({ preventScroll: true });
  }, [open, group]);
  return (
    <Sheet open={open} onClose={onClose} title="Portal sections" side="left" phone="full" widthClassName="md:w-[20rem]">
      <div ref={panelRef}>
        <PortalSidebar current={current} variant="drawer" />
      </div>
    </Sheet>
  );
}
