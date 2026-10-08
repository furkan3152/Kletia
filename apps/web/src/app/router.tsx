import React from "react";

import {
  getLocation,
  installHistoryListener,
  subscribeLocation,
  type RouteLocation,
} from "./routes/history";
import {
  matchRoute,
  ROUTES,
  SITE_ORIGIN,
  type RouteDefinition,
  type RouteId,
} from "./routes/routeTable";
import { RouterContext, type RouterState } from "./routes/routerContext";

installHistoryListener();

const loadSiteLayout = () => import("./site/SiteLayout");
const SiteLayout = React.lazy(loadSiteLayout);

const PAGES = Object.fromEntries(
  (Object.keys(ROUTES) as RouteId[]).map((id) => [id, React.lazy(ROUTES[id].load)]),
) as Record<RouteId, React.LazyExoticComponent<React.ComponentType>>;

// Start the initial route's chunks in parallel with the shell instead of in sequence.
{
  const initial = matchRoute(getLocation().pathname);
  initial.load().catch(() => undefined);
  if (initial.kind === "site") loadSiteLayout().catch(() => undefined);
}

function setMeta(attribute: "name" | "property", key: string, content: string) {
  let element = document.head.querySelector<HTMLMetaElement>(`meta[${attribute}="${key}"]`);
  if (!element) {
    element = document.createElement("meta");
    element.setAttribute(attribute, key);
    document.head.appendChild(element);
  }
  element.setAttribute("content", content);
}

function applyDocumentMeta(route: RouteDefinition, pathname: string) {
  const canonicalPath = route.id === "console" ? "/app" : route.id === "notFound" ? pathname : route.path;
  const url = `${SITE_ORIGIN}${canonicalPath}`;
  document.title = route.title;
  setMeta("name", "description", route.description);
  setMeta("name", "robots", route.id === "notFound" ? "noindex,follow" : "index,follow");
  setMeta("property", "og:title", route.title);
  setMeta("property", "og:description", route.description);
  setMeta("property", "og:url", url);
  setMeta("name", "twitter:title", route.title);
  setMeta("name", "twitter:description", route.description);
  const canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (canonical) canonical.href = url;
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** Scrolls to `#hash`, retrying for a short while so lazily rendered sections can mount. */
function scrollToHash(hash: string, smooth: boolean): () => void {
  let id: string;
  try {
    id = decodeURIComponent(hash.slice(1));
  } catch {
    return () => undefined;
  }
  let frame = 0;
  let handle = 0;
  const attempt = () => {
    const target = id ? document.getElementById(id) : null;
    if (target) {
      target.scrollIntoView({
        behavior: smooth && !prefersReducedMotion() ? "smooth" : "auto",
        block: "start",
      });
      if (!target.hasAttribute("tabindex") && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/u.test(target.tagName)) {
        target.setAttribute("tabindex", "-1");
      }
      target.focus({ preventScroll: true });
      return;
    }
    frame += 1;
    if (frame < 90) handle = window.requestAnimationFrame(attempt);
  };
  attempt();
  return () => window.cancelAnimationFrame(handle);
}

function SiteBootFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#F4F1EA] dark:bg-[#0B1120]" role="status">
      <span className="border-[3px] border-[#1A1A1A] bg-[#FFD60A] px-4 py-2 text-xs font-black uppercase tracking-[0.3em] text-[#1A1A1A] shadow-[4px_4px_0_#1A1A1A] dark:border-[#4B5563] dark:shadow-[4px_4px_0_#475569]">
        Loading Kletia
      </span>
    </div>
  );
}

function ConsoleBootFallback() {
  return (
    <div
      className="flex h-full items-center justify-center bg-[#0B1120] font-black uppercase tracking-widest text-white"
      role="status"
    >
      Loading Kletia
    </div>
  );
}

function PendingBar({ pending }: { pending: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={`kl-pending-bar pointer-events-none fixed inset-x-0 top-0 z-[100] h-1 origin-left bg-[#0052FF] ${
        pending ? "kl-pending-bar--active" : ""
      }`}
    />
  );
}

/** Top-level router. Every route is code-split; navigation renders in a transition. */
export function AppRouter() {
  const [location, setLocation] = React.useState<RouteLocation>(getLocation);
  const [pending, startTransition] = React.useTransition();
  const [announcement, setAnnouncement] = React.useState("");
  const previousPathRef = React.useRef(location.pathname);

  React.useEffect(
    () =>
      subscribeLocation((next) => {
        startTransition(() => setLocation(next));
      }),
    [],
  );

  const route = matchRoute(location.pathname);

  React.useEffect(() => {
    applyDocumentMeta(route, location.pathname);
  }, [route, location.pathname]);

  React.useLayoutEffect(() => {
    const pathChanged = previousPathRef.current !== location.pathname;
    previousPathRef.current = location.pathname;
    let cancel: () => void = () => undefined;
    if (location.action === "pop") {
      window.scrollTo(0, location.restoreScrollY ?? 0);
    } else if (location.hash) {
      cancel = scrollToHash(location.hash, location.action !== "initial" && !pathChanged);
    } else if (location.action !== "initial") {
      window.scrollTo(0, 0);
    }
    if (pathChanged && location.action !== "initial" && !location.hash) {
      document.getElementById("main-content")?.focus({ preventScroll: true });
    }
    return cancel;
  }, [location]);

  React.useEffect(() => {
    if (location.action === "initial") return;
    const timer = window.setTimeout(() => setAnnouncement(route.title), 60);
    return () => window.clearTimeout(timer);
  }, [location, route.title]);

  const state = React.useMemo<RouterState>(
    () => ({ location, route, pending }),
    [location, route, pending],
  );

  const Page = PAGES[route.id];
  const content =
    route.kind === "console" ? (
      <Page />
    ) : (
      <SiteLayout>
        <Page />
      </SiteLayout>
    );

  return (
    <RouterContext.Provider value={state}>
      <PendingBar pending={pending} />
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {pending ? "Loading page" : announcement}
      </div>
      <React.Suspense
        fallback={route.kind === "console" ? <ConsoleBootFallback /> : <SiteBootFallback />}
      >
        {content}
      </React.Suspense>
    </RouterContext.Provider>
  );
}
