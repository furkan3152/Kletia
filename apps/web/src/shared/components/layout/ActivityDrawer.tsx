import React from "react";
import { ScrollText, Trash2, X } from "lucide-react";

import { ActivityFeed } from "../../sync/ActivityFeed";
import { useActivityStore } from "../../sync/activityStore";
import { playOnce } from "../../../app/site/intent/phaseMotion";

interface ActivityDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

/** Right-hand drawer with the shared activity feed across every network. */
export const ActivityDrawer: React.FC<ActivityDrawerProps> = ({ isOpen, onClose }) => {
  const hasEntries = useActivityStore((state) => state.entries.length > 0);
  const clear = useActivityStore((state) => state.clear);
  const titleId = React.useId();
  const closeRef = React.useRef<HTMLButtonElement>(null);
  const panelRef = React.useRef<HTMLElement>(null);

  // Presentation only: slide in from the right (from the bottom on phones).
  // Closing stays instant because the drawer unmounts.
  React.useLayoutEffect(() => {
    if (!isOpen) return;
    const wide = window.matchMedia?.("(min-width: 640px)").matches ?? true;
    playOnce(
      panelRef.current,
      [{ transform: wide ? "translateX(100%)" : "translateY(100%)" }, { transform: "translate(0, 0)" }],
      { duration: 240, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
    );
  }, [isOpen]);

  React.useEffect(() => {
    if (!isOpen) return;
    const restoreTarget =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      if (restoreTarget?.isConnected) restoreTarget.focus();
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <aside
      ref={panelRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      className="fixed inset-0 z-[60] flex h-[100dvh] w-full shrink-0 flex-col overflow-x-hidden overflow-y-auto border-l-[3px] border-[#1A1A1A] bg-[#FDFDFD] shadow-[-4px_0_0_#1A1A1A] dark:border-[#4B5563] dark:bg-[#0B1121] dark:shadow-[-4px_0_0_#475569] sm:left-auto sm:w-96 lg:relative lg:h-full"
    >
      <div className="sticky top-0 z-10 flex min-h-16 items-center justify-between gap-2 border-b-[3px] border-[#1A1A1A] bg-[#FFD60A] px-3 py-3 text-[#1A1A1A] dark:border-[#4B5563] sm:p-4">
        <h2
          id={titleId}
          className="flex min-w-0 items-center gap-2 text-base font-black uppercase tracking-wider sm:text-lg"
        >
          <ScrollText className="h-5 w-5 shrink-0" aria-hidden="true" />
          <span className="truncate">Activity</span>
        </h2>
        <div className="flex items-center gap-2">
          {hasEntries ? (
            <button
              type="button"
              onClick={() => clear()}
              className="flex min-h-11 items-center gap-1.5 border-[3px] border-[#1A1A1A] bg-white px-2.5 text-[10px] font-black uppercase text-[#1A1A1A] shadow-[2px_2px_0_#1A1A1A] focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#0052FF] active:translate-y-0.5 active:shadow-none"
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
              Clear
            </button>
          ) : null}
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close activity"
            className="flex h-11 w-11 shrink-0 items-center justify-center border-[3px] border-[#1A1A1A] bg-white text-[#1A1A1A] shadow-[2px_2px_0_#1A1A1A] transition-colors duration-100 hover:bg-[#1A1A1A] hover:text-[#FFD60A] focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#0052FF] active:translate-y-0.5 active:shadow-none"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-4 p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:p-4">
        <p className="text-xs font-bold text-gray-700 dark:text-slate-300">
          Transactions signed in this browser across EVM networks and Solana. Stored locally
          on this device only.
        </p>
        <ActivityFeed compact limit={100} title="All networks" />
      </div>
    </aside>
  );
};

export default ActivityDrawer;
