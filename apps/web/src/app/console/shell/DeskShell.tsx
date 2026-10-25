/**
 * The desk's frame: site fonts and paper, the shared print filters, skip
 * links, the sticky header, the view nav under 1024 px and the grid (task
 * rail, main column, holdings and activity rail).
 */
import "@fontsource-variable/space-grotesk";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "../desk.css";

import type { ReactNode } from "react";

import { PaperDefs } from "../../site/art/PaperDefs";
import { cx, FOCUS_RING } from "../../site/ui/styles";
import { DESK_COPY } from "../content/copy";

const copy = DESK_COPY.header;

const SKIP = cx(
  "sr-only z-[200] border-[3px] border-[#121212] bg-[#C6FF3A] px-4 py-3 text-xs font-black uppercase tracking-[0.14em] text-[#121212] focus:not-sr-only focus:fixed focus:left-4 focus:top-4",
  FOCUS_RING,
);

export interface DeskShellProps {
  readonly header: ReactNode;
  readonly viewNav: ReactNode;
  readonly leftRail: ReactNode;
  readonly rightRail: ReactNode;
  readonly children: ReactNode;
}

export function DeskShell({ header, viewNav, leftRail, rightRail, children }: DeskShellProps) {
  return (
    <div className="kd-shell font-body antialiased selection:bg-[#C6FF3A] selection:text-[#121212]">
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
      {header}
      {viewNav}
      <div className="kd-grid">
        <div className="kd-rail-left">{leftRail}</div>
        <main id="main-content" tabIndex={-1} className="kd-main focus:outline-none">
          {children}
        </main>
        <aside aria-label={DESK_COPY.holdings.asideLabel} className="kd-rail-right">
          <div className="kd-rail flex flex-col gap-8">{rightRail}</div>
        </aside>
      </div>
    </div>
  );
}
