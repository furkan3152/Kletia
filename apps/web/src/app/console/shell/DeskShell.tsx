/**
 * The desk's frame, the Card machine: skip links, the
 * shared print filters, the chassis rail on the left (from 1024 px), the sticky topbar, the main
 * column and, on the desk view, the machine panel on the right. The document scrolls; the rail,
 * the topbar and the panel are sticky. Under 1024 px the topbar is the mini plate bar and the
 * mode bar, and the panel is hidden (its readings live in Portfolio).
 */
import "../../kit/kit.css";
import "../desk.css";

import { forwardRef, type ReactNode } from "react";

import { PaperDefs } from "../../site/art/PaperDefs";
import { cx, FOCUS_RING } from "../../site/ui/styles";
import { DESK_COPY } from "../content/copy";
import { DESK_MORE_COPY } from "./deskCopy";

const copy = DESK_COPY.header;

const SKIP = cx(
  "sr-only z-[200] rounded-[10px] border border-[#88B514] bg-[#C6FF3A] px-4 py-3 text-sm font-semibold text-[#121212] focus:not-sr-only focus:fixed focus:left-4 focus:top-4",
  FOCUS_RING,
);

export interface DeskShellProps {
  readonly topbar: ReactNode;
  readonly rail: ReactNode;
  /** The machine panel; null outside the desk view. */
  readonly panel: ReactNode | null;
  /** Data views (Portfolio, Trade, More...) get a wider main column than the conversation. */
  readonly wide?: boolean;
  readonly children: ReactNode;
}

export const DeskShell = forwardRef<HTMLDivElement, DeskShellProps>(function DeskShell({ topbar, rail, panel, wide = false, children }, ref) {
  return (
    <div ref={ref} className="kd-shell antialiased selection:bg-[#C6FF3A] selection:text-[#121212]">
      <a
        href="#desk-composer-input"
        className={SKIP}
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("desk-composer-input")?.focus();
        }}
      >
        {copy.skipToComposer}
      </a>
      <a
        href="#main-content"
        className={SKIP}
        onClick={(event) => {
          event.preventDefault();
          const main = document.getElementById("main-content");
          main?.focus({ preventScroll: true });
          main?.scrollIntoView();
        }}
      >
        {copy.skipToContent}
      </a>
      <PaperDefs />
      <div className="kd-machine-rail" role="group" aria-label={DESK_MORE_COPY.machine.controls}>
        {rail}
      </div>
      <div className="kd-body">
        {topbar}
        <div className="kd-grid" data-panel={panel ? "" : undefined}>
          <main id="main-content" tabIndex={-1} className="kd-main focus:outline-none" data-wide={wide ? "" : undefined}>
            <div className="kd-main-in">{children}</div>
          </main>
          {panel ? (
            <aside aria-label={DESK_MORE_COPY.machine.machine} className="kd-mpanel">
              {panel}
            </aside>
          ) : null}
        </div>
      </div>
    </div>
  );
});
