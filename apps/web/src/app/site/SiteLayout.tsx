import "./chrome.css";
import "./finish.css";

import React, { useLayoutEffect, useMemo } from "react";

import { useRoute } from "../routes/useRoute";
import { PaperDefs } from "./art/PaperDefs";
import { OWN_CHROME_ROUTES, SiteThemeContext } from "./siteChrome";
import { SiteFooter } from "./SiteFooter";
import { SiteHeader } from "./SiteHeader";
import { enterSiteMode, leaveSiteMode } from "./theme";
import { useSiteTheme } from "./useSiteTheme";
import { cx, FOCUS_RING } from "./ui/styles";

function PageFallback() {
  return (
    // Fills the first screen so the footer never paints above the fold and then jumps down when the page arrives.
    <div className="flex min-h-[calc(100vh-4.5rem)] items-center justify-center" role="status">
      <span className="ks-loading">Loading</span>
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
  const themeState = useMemo(() => ({ theme, toggle }), [theme, toggle]);
  const { location, route } = useRoute();
  // The home page draws its own tape, header and base plate.
  const ownChrome = OWN_CHROME_ROUTES.has(route.id);
  // The machine finish (finish.css) on every page but home, which is drawn in the new language from scratch.
  const finish = location.pathname !== "/";

  if (ownChrome) {
    return (
      <SiteThemeContext.Provider value={themeState}>
        <div className="relative flex min-h-screen flex-col overflow-x-clip bg-[#D6D2C8] font-body text-[#121212] antialiased selection:bg-[#C6FF3A] selection:text-[#121212] dark:bg-[#0E0E10] dark:text-[#F2F0EA]">
          <PaperDefs />
          <React.Suspense fallback={<PageFallback />}>{children}</React.Suspense>
        </div>
      </SiteThemeContext.Provider>
    );
  }

  return (
    <div className="relative flex min-h-screen flex-col overflow-x-clip bg-[#D6D2C8] font-body text-[#121212] antialiased selection:bg-[#C6FF3A] selection:text-[#121212] dark:bg-[#0E0E10] dark:text-[#F2F0EA]">
      <a
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          const main = document.getElementById("main-content");
          main?.focus({ preventScroll: true });
          main?.scrollIntoView();
        }}
        className={cx("sr-only z-[200] focus:not-sr-only focus:fixed focus:left-4 focus:top-4 ks-skip", FOCUS_RING)}
      >
        Skip to content
      </a>
      {/* Shared print filters (stamp ink, rough edge), mounted once for every page. */}
      <PaperDefs />
      <SiteHeader theme={theme} onToggleTheme={toggle} />
      {/* At least the first screen: pages that load their data after mount (receipts, links, approvals)
          grow inside it, so the footer never shifts while it is in view (CLS). */}
      <main id="main-content" tabIndex={-1} className={cx("min-h-[calc(100vh-4.5rem)] flex-1 focus:outline-none", finish && "ks-finish")}>
        <React.Suspense fallback={<PageFallback />}>{children}</React.Suspense>
      </main>
      <SiteFooter />
    </div>
  );
}
