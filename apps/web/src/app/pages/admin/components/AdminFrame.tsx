import "@fontsource-variable/space-grotesk";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "../admin.css";

import React, { useLayoutEffect } from "react";

import { PaperDefs } from "../../../site/art/PaperDefs";
import { KletiaMark } from "../../../site/KletiaMark";
import { enterSiteMode, leaveSiteMode } from "../../../site/theme";
import { ThemeToggle } from "../../../site/ThemeToggle";
import { useSiteTheme } from "../../../site/useSiteTheme";
import { CONTAINER, cx, FOCUS_RING } from "../../../site/ui/styles";

/**
 * The admin panel's own frame (no site header or footer): the mark with an
 * "Admin" plate, whatever the caller puts at the end of the bar (session
 * facts, sign out), the theme switch and the page. Wallet-free, so the gate
 * states render before any wallet code loads.
 */
export function AdminFrame({ barEnd, children, wide = false }: { readonly barEnd?: React.ReactNode; readonly children: React.ReactNode; readonly wide?: boolean }) {
  useLayoutEffect(() => {
    enterSiteMode();
    return () => leaveSiteMode();
  }, []);
  const { theme, toggle } = useSiteTheme();
  return (
    <div className="kl-admin relative flex min-h-[100dvh] flex-col overflow-x-clip font-body text-fg antialiased selection:bg-[#FFD60A] selection:text-[#1A1A1A]">
      <a
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main-content")?.focus({ preventScroll: false });
        }}
        className={cx(
          "sr-only z-[200] border-[3px] border-[#1A1A1A] bg-[#FFD60A] px-4 py-3 text-xs font-black uppercase tracking-[0.14em] text-[#1A1A1A] focus:not-sr-only focus:fixed focus:left-4 focus:top-4",
          FOCUS_RING,
        )}
      >
        Skip to content
      </a>
      <PaperDefs />
      <header className="kl-admin__bar">
        <div className={cx(wide ? "mx-auto w-full max-w-[96rem] px-4 sm:px-6 lg:px-8" : CONTAINER, "flex min-h-[4.5rem] flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3")}>
          <div className="flex min-w-0 items-center gap-3">
            <a href="/" className={cx("group flex items-center gap-3", FOCUS_RING)} aria-label="Kletia home">
              <KletiaMark size="sm" />
              <span className="hidden font-display text-xl font-bold sm:inline">Kletia</span>
            </a>
            <span className="kl-admin__plate" aria-label="Admin panel">
              Admin
            </span>
          </div>
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
            {barEnd}
            <ThemeToggle theme={theme} onToggle={toggle} />
          </div>
        </div>
      </header>
      <main id="main-content" tabIndex={-1} className="flex-1 focus:outline-none">
        {children}
      </main>
    </div>
  );
}
