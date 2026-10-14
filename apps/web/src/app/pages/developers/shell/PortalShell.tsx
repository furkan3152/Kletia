import { RefreshCw } from "lucide-react";
import React, { Suspense, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import { LazyBoundary } from "../../../../shared/components/LazyBoundary";
import { navigate, type RouteLocation } from "../../../routes/history";
import { useRoute } from "../../../routes/useRoute";
import { Button } from "../../../site/ui/Button";
import { Skeleton, SkeletonGroup } from "../../../site/ui/Skeleton";
import { cx, FOCUS_RING } from "../../../site/ui/styles";
import { PortalBar } from "./PortalBar";
import { PortalContext, type PortalShellApi } from "./portalContext";
import { PortalDrawer } from "./PortalDrawer";
import { legacyHashTarget, matchPortal, type PortalGroup, type PortalMatch, type PortalPageDef, type PortalPageId, type PortalPageProps } from "./portalRoutes";
import { PortalRail, PortalSidebar } from "./PortalSidebar";
import { usePortalHealth } from "./usePortalHealth";

/**
 * Where the URL has to go before the shell shows a page: an alias
 * (/developers/embed-builder) or an anchor of the old single-page portal
 * (/developers#error-POLICY_VIOLATION). Null when the URL is right.
 */
function redirectFor(location: RouteLocation, match: PortalMatch): string | null {
  if (match.redirect) return `${match.redirect}${location.search}${location.hash}`;
  if (match.page.id !== "overview" || !location.hash) return null;
  const target = legacyHashTarget(location.hash);
  if (!target) return null;
  const cut = target.indexOf("#");
  const next = cut < 0 ? `${target}${location.search}` : `${target.slice(0, cut)}${location.search}${target.slice(cut)}`;
  return next === `${location.pathname}${location.search}${location.hash}` ? null : next;
}

/*
 * Page chunks. Like the router's route pages: a page whose chunk is loaded
 * renders at once (so moving between loaded pages never flashes a
 * fallback); until then it suspends, and a failed chunk throws to the
 * boundary.
 */
const resolvedPages = new Map<PortalPageId, React.ComponentType<PortalPageProps>>();
const failedPages = new Map<PortalPageId, unknown>();
const loadingPages = new Map<PortalPageId, Promise<void>>();

function loadPage(page: PortalPageDef): Promise<void> {
  if (resolvedPages.has(page.id)) return Promise.resolve();
  const existing = loadingPages.get(page.id);
  if (existing) return existing;
  const promise = page.load().then(
    (module) => {
      loadingPages.delete(page.id);
      if (typeof module.default !== "function" && typeof module.default !== "object") {
        const error = new Error(`The ${page.id} portal page has no default export.`);
        failedPages.set(page.id, error);
        throw error;
      }
      resolvedPages.set(page.id, module.default);
    },
    (error: unknown) => {
      loadingPages.delete(page.id);
      failedPages.set(page.id, error ?? new Error(`The ${page.id} portal page failed to load.`));
      throw error;
    },
  );
  loadingPages.set(page.id, promise);
  return promise;
}

function PageOutlet({ page, param, search }: { readonly page: PortalPageDef; readonly param: string | null; readonly search: URLSearchParams }) {
  const Page = resolvedPages.get(page.id);
  if (Page) {
    // Module-level component, stable for the page id: never recreated per render.
    // eslint-disable-next-line react-hooks/static-components
    return <Page param={param} search={search} />;
  }
  if (failedPages.has(page.id)) throw failedPages.get(page.id);
  throw loadPage(page);
}

function OutletSkeleton() {
  return (
    <SkeletonGroup label="Loading the page" className="flex flex-col gap-4 pt-10" wrapperClassName="min-h-[60vh]">
      <Skeleton className="h-11 w-2/3 max-w-xl" />
      <Skeleton className="h-5 w-full max-w-2xl" />
      <Skeleton surface="card" className="mt-4 h-64" />
    </SkeletonGroup>
  );
}

function PageLoadFailed({ reload }: { readonly reload: () => void }) {
  return (
    <div role="alert" className="mt-10 flex max-w-xl flex-col items-start gap-3 border-[3px] border-[#1A1A1A] bg-surface p-5 dark:border-[#4B5563]">
      <p className="font-display text-title font-bold">This page could not load</p>
      <p className="text-sm">Part of the portal failed to download, usually because of a lost connection or a new release. Reload to try again.</p>
      <Button onClick={reload}>Reload</Button>
    </div>
  );
}

/** One announcement under the portal bar when the API stops answering; panels keep their own errors. */
function ApiDownBanner({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <div role="status" className="border-b-[3px] border-[#1A1A1A] bg-warning-bg text-fg dark:border-[#4B5563]">
      <div className="mx-auto flex max-w-[1680px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 sm:px-6 lg:px-8">
        <p className="min-w-0 flex-1 text-sm font-semibold">
          The Kletia API is not answering from this browser. Reference pages work; tools retry when it is back.
        </p>
        <Button size="sm" variant="secondary" onClick={onRetry}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          Retry
        </Button>
      </div>
    </div>
  );
}

const SKIP_LINK = cx(
  "sr-only z-[200] border-[3px] border-[#1A1A1A] bg-[#FFD60A] px-4 py-3 text-xs font-black uppercase tracking-[0.08em] text-[#1A1A1A] focus:not-sr-only focus:fixed focus:left-4 focus:top-4",
  FOCUS_RING,
);

/**
 * The developer portal (portal design 4.3): one `developers` route whose
 * shell stays mounted while the visitor moves between pages, so the bar, the
 * sidebar and the key in memory never reload and only the page outlet swaps.
 * It redirects aliases and the old single-page anchors with replaceState,
 * gives the page H1 focus after each portal navigation, polls the API status
 * once for every page and never clears the key (sessionKeyStore keeps it for
 * the tab until a reload or Forget key).
 */
export default function PortalShell() {
  const { location } = useRoute();
  const match = useMemo(() => matchPortal(location.pathname), [location.pathname]);
  const redirect = redirectFor(location, match);
  const search = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const health = usePortalHealth();

  const locationKeyRef = useRef(location.key);
  useLayoutEffect(() => {
    locationKeyRef.current = location.key;
  });

  // Fix the URL before the page paints (an alias or an old anchor).
  useLayoutEffect(() => {
    if (redirect) navigate(redirect, { replace: true });
  }, [redirect, location.key]);

  // Anchors land below the sticky portal bar (styles.css).
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-kl-portal", "");
    return () => root.removeAttribute("data-kl-portal");
  }, []);

  // Menus stay open only for the navigation they were opened on.
  const [drawer, setDrawer] = useState<{ readonly at: number | null; readonly group: PortalGroup | null }>({ at: null, group: null });
  const [keyMenuAt, setKeyMenuAt] = useState<number | null>(null);
  const drawerOpen = drawer.at === location.key;
  const keyMenuOpen = keyMenuAt === location.key;
  const openSections = useCallback((group: PortalGroup | null = null) => setDrawer({ at: locationKeyRef.current, group }), []);
  const closeSections = useCallback(() => setDrawer({ at: null, group: null }), []);
  const openKeyMenu = useCallback(() => setKeyMenuAt(locationKeyRef.current), []);
  const closeKeyMenu = useCallback(() => setKeyMenuAt(null), []);

  // After a client-side navigation to a page (not the first load, not an anchor) the page H1 takes focus.
  const headingFocusKey = location.action === "initial" || location.hash ? null : location.key;
  const api = useMemo<PortalShellApi>(
    () => ({ openKeyMenu, openSections: () => openSections(null), headingFocusKey, health }),
    [openKeyMenu, openSections, headingFocusKey, health],
  );

  const skipToContent = (event: React.MouseEvent) => {
    event.preventDefault();
    const target = document.querySelector<HTMLElement>("#portal-content h1") ?? document.getElementById("portal-content");
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "start" });
  };
  const skipToSections = (event: React.MouseEvent) => {
    event.preventDefault();
    const link = document.querySelector<HTMLElement>("#portal-sections a[href]");
    if (link && link.offsetParent !== null) link.focus();
    else openSections(null);
  };

  return (
    <PortalContext.Provider value={api}>
      <div className="relative min-w-0">
        <a href="#portal-content" onClick={skipToContent} className={SKIP_LINK}>
          Skip to page content
        </a>
        <a href="#portal-sections" onClick={skipToSections} className={SKIP_LINK}>
          Skip to portal sections
        </a>
        <PortalBar
          match={match}
          health={health}
          sectionsOpen={drawerOpen}
          onOpenSections={() => openSections(null)}
          keyMenuOpen={keyMenuOpen}
          onOpenKeyMenu={openKeyMenu}
          onCloseKeyMenu={closeKeyMenu}
        />
        {health.state === "unreachable" ? <ApiDownBanner onRetry={health.retry} /> : null}
        <div className="mx-auto flex w-full min-w-0 max-w-[1680px]">
          <div id="portal-sections" className="hidden w-60 shrink-0 border-r-[3px] border-[#1A1A1A]/15 dark:border-white/10 xl:block">
            <div className="sticky top-[130px] max-h-[calc(100dvh-130px)] overflow-y-auto overscroll-contain">
              <PortalSidebar current={match.page.id} />
            </div>
          </div>
          <div className="hidden w-14 shrink-0 border-r-[3px] border-[#1A1A1A]/15 dark:border-white/10 md:block xl:hidden">
            <div className="sticky top-[130px]">
              <PortalRail current={match.page.id} onOpenGroup={(group) => openSections(group)} />
            </div>
          </div>
          <div id="portal-content" tabIndex={-1} className="min-w-0 flex-1 px-4 pb-20 outline-none sm:px-6 lg:px-10">
            <div className={cx("mx-auto w-full min-w-0", match.page.wide ? "max-w-none" : "max-w-[1040px]")}>
              <LazyBoundary resetKey={match.page.id} fallback={(reload) => <PageLoadFailed reload={reload} />}>
                <Suspense fallback={<OutletSkeleton />}>
                  {redirect ? (
                    <OutletSkeleton />
                  ) : (
                    <PageOutlet key={match.page.id} page={match.page} param={match.param} search={search} />
                  )}
                </Suspense>
              </LazyBoundary>
            </div>
          </div>
        </div>
        <PortalDrawer open={drawerOpen} onClose={closeSections} current={match.page.id} group={drawer.group} />
      </div>
    </PortalContext.Provider>
  );
}
