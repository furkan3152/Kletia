import "@fontsource-variable/space-grotesk";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";

import React, { useLayoutEffect } from "react";

import { PaperDefs } from "./art/PaperDefs";
import { SiteFooter } from "./SiteFooter";
import { SiteHeader } from "./SiteHeader";
import { enterSiteMode, leaveSiteMode } from "./theme";
import { useSiteTheme } from "./useSiteTheme";
import { cx, FOCUS_RING } from "./ui/styles";

function PageFallback() {
  return (
    // Fills the first screen so the footer never paints above the fold and then jumps down when the page arrives.
    <div className="flex min-h-[calc(100vh-4.5rem)] items-center justify-center" role="status">
      <span className="border-[3px] border-[#1A1A1A] bg-[#FFD60A] px-4 py-2 text-xs font-black uppercase tracking-[0.3em] text-[#1A1A1A] shadow-[4px_4px_0_#1A1A1A] dark:border-[#4B5563] dark:shadow-[4px_4px_0_#475569]">
        Loading
      </span>
    </div>
  );
}

/**
 * Shell for every marketing and documentation route: fonts, theme, header,
 * footer and a document-scrolling layout. Never imports wallet code.
 */
export default function SiteLayout({ children }: { children: React.ReactNode }) {
  useLayoutEffect(() => {
    enterSiteMode();
    return () => leaveSiteMode();
  }, []);
  const { theme, toggle } = useSiteTheme();

  return (
    <div className="relative flex min-h-screen flex-col overflow-x-clip bg-[#F4F1EA] font-body text-[#1A1A1A] antialiased selection:bg-[#FFD60A] selection:text-[#1A1A1A] dark:bg-[#0B1120] dark:text-[#F1F5F9]">
      <a
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          const main = document.getElementById("main-content");
          main?.focus({ preventScroll: true });
          main?.scrollIntoView();
        }}
        className={cx(
          "sr-only z-[200] border-[3px] border-[#1A1A1A] bg-[#FFD60A] px-4 py-3 text-xs font-black uppercase tracking-[0.14em] text-[#1A1A1A] focus:not-sr-only focus:fixed focus:left-4 focus:top-4",
          FOCUS_RING,
        )}
      >
        Skip to content
      </a>
      {/* Shared print filters (stamp ink, rough edge), mounted once for every page. */}
      <PaperDefs />
      <SiteHeader theme={theme} onToggleTheme={toggle} />
      <main id="main-content" tabIndex={-1} className="flex-1 focus:outline-none">
        <React.Suspense fallback={<PageFallback />}>{children}</React.Suspense>
      </main>
      <SiteFooter />
    </div>
  );
}
