import React from "react";
import { flushSync } from "react-dom";

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
import { RouteEnter } from "./site/motion/RouteEnter";
import { prefersReducedMotion } from "./site/motion/useReducedMotion";
import { runViewTransition, supportsViewTransitions } from "./site/motion/viewTransition";
import { getToasts, subscribeToasts } from "./site/ui/toast";
import { LazyBoundary } from "../shared/components/LazyBoundary";

installHistoryListener();

// Loops pause in hidden tabs: styles.css keys off html[data-kl-hidden].
if (typeof document !== "undefined") {
  const syncHidden = () => document.documentElement.toggleAttribute("data-kl-hidden", document.visibilityState === "hidden");
  syncHidden();
  document.addEventListener("visibilitychange", syncHidden);
}

const loadSiteLayout = () => import("./site/SiteLayout");
const SiteLayout = React.lazy(loadSiteLayout);
const loadToaster = () => import("./site/ui/Toaster");
/** The motion system's stylesheet (site/motion/motion.css), out of the entry CSS. Shared by every route that needs it. */
let motionStyles: Promise<unknown> | null = null;
function loadMotionStyles(): Promise<unknown> {
  motionStyles ??= import("./site/motion/motion.css").catch((error: unknown) => {
    motionStyles = null;
    throw error;
  });
  return motionStyles;
}
const Toaster = React.lazy(loadToaster);

/*
 * Route pages. Unlike React.lazy (which suspends on its first render even when
 * the chunk is already loaded), `RoutePage` renders a loaded page at once, so
 * a View Transition can commit the next page synchronously. Until the chunk
 * arrives it suspends like React.lazy; a failed chunk throws to LazyBoundary.
 */
const resolved = new Map<RouteId, React.ComponentType>();
const failed = new Map<RouteId, unknown>();
const inflight = new Map<RouteId, Promise<void>>();

function loadRoute(id: RouteId): Promise<void> {
  if (resolved.has(id)) return Promise.resolve();
  const existing = inflight.get(id);
  if (existing) return existing;
  // Site and console pages use the motion system's classes, so its stylesheet arrives with them (before the
  // page renders); /embed never needs it.
  const page = ROUTES[id].kind === "embed" ? ROUTES[id].load() : Promise.all([ROUTES[id].load(), loadMotionStyles()]).then(([module]) => module);
  const promise = page.then(
    (module) => {
      inflight.delete(id);
      if (typeof module.default !== "function" && typeof module.default !== "object") {
        const error = new Error(`The ${id} page module has no default export.`);
        failed.set(id, error);
        throw error;
      }
      resolved.set(id, module.default);
    },
    (error: unknown) => {
      failed.set(id, error ?? new Error(`The ${id} page failed to load.`));
      inflight.delete(id);
      throw error;
    },
  );
  inflight.set(id, promise);
  return promise;
}

function RoutePage({ id }: { readonly id: RouteId }) {
  const Page = resolved.get(id);
  if (Page) {
    // Module-level component, stable for the route: never recreated per render.
    // eslint-disable-next-line react-hooks/static-components
    return <Page />;
  }
  if (failed.has(id)) throw failed.get(id);
  throw loadRoute(id);
}

// Start the initial route's chunks in parallel with the shell instead of in sequence.
{
  const initial = matchRoute(getLocation().pathname);
  loadRoute(initial.id).catch(() => undefined);
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

/** Title, description, robots and canonical path of a visited path (prefix routes such as the portal give their own). */
function documentMeta(route: RouteDefinition, pathname: string) {
  const meta = route.metaFor?.(pathname);
  const canonicalPath =
    meta?.canonical ??
    (route.id === "console" ? "/app" : route.id === "notFound" || route.canonicalFromPath ? pathname : route.path);
  return {
    title: meta?.title ?? route.title,
    description: meta?.description ?? route.description,
    robots:
      meta?.robots ??
      route.robots ??
      (route.id === "notFound" ? "noindex,follow" : route.kind === "embed" ? "noindex,nofollow" : "index,follow"),
    url: `${SITE_ORIGIN}${canonicalPath}`,
  };
}

function applyDocumentMeta(route: RouteDefinition, pathname: string) {
  const { title, description, robots, url } = documentMeta(route, pathname);
  document.title = title;
  setMeta("name", "description", description);
  setMeta("name", "robots", robots);
  setMeta("property", "og:title", title);
  setMeta("property", "og:description", description);
  setMeta("property", "og:url", url);
  setMeta("name", "twitter:title", title);
  setMeta("name", "twitter:description", description);
  const canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (canonical) canonical.href = url;
}

/** How long a link to an anchor waits for a lazily loaded page to render its target. */
const HASH_WAIT_MS = 6_000;
/** How long an anchor reached on load is held in place while content above it arrives. */
const HASH_SETTLE_MS = 2_500;

/**
 * Scrolls to `#hash` and focuses it, retrying while lazily loaded pages mount
 * (a portal page chunk after a redirect). The visitor scrolling, clicking or
 * typing first cancels it, so a late target never yanks the page.
 *
 * A non-interactive target gets tabindex -1 and `data-kl-arrival`: no focus
 * box (it is not in the tab order) but a short signal-yellow underline
 * (styles.css) until it loses focus.
 */
function scrollToHash(hash: string, smooth: boolean): () => void {
  let id: string;
  try {
    id = decodeURIComponent(hash.slice(1));
  } catch {
    return () => undefined;
  }
  const started = performance.now();
  let handle = 0;
  let done = false;
  const userEvents = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
  const stop = () => {
    done = true;
    window.cancelAnimationFrame(handle);
    for (const type of userEvents) window.removeEventListener(type, stop, true);
  };
  const attempt = () => {
    if (done) return;
    const target = id ? document.getElementById(id) : null;
    if (target) {
      const instant = !smooth || prefersReducedMotion();
      target.scrollIntoView({ behavior: instant ? "auto" : "smooth", block: "start" });
      if (instant) {
        // Content above the target may still arrive (a page loading its lower sections after the first paint):
        // keep the target at the top for a moment, until the visitor scrolls, clicks or types.
        const settleUntil = performance.now() + HASH_SETTLE_MS;
        let expected = target.getBoundingClientRect().top;
        const settle = () => {
          if (done) return;
          const top = target.getBoundingClientRect().top;
          if (Math.abs(top - expected) > 4) {
            target.scrollIntoView({ behavior: "auto", block: "start" });
            expected = target.getBoundingClientRect().top;
          }
          if (performance.now() < settleUntil && target.isConnected) handle = window.requestAnimationFrame(settle);
          else stop();
        };
        handle = window.requestAnimationFrame(settle);
      } else {
        stop();
      }
      const interactive = /^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/u.test(target.tagName);
      if (!target.hasAttribute("tabindex") && !interactive) target.setAttribute("tabindex", "-1");
      if (!interactive && target.getAttribute("tabindex") === "-1") {
        target.setAttribute("data-kl-arrival", "");
        target.addEventListener("blur", () => target.removeAttribute("data-kl-arrival"), { once: true });
      }
      target.focus({ preventScroll: true });
      return;
    }
    if (performance.now() - started < HASH_WAIT_MS) handle = window.requestAnimationFrame(attempt);
    else stop();
  };
  for (const type of userEvents) window.addEventListener(type, stop, { capture: true, passive: true });
  attempt();
  return stop;
}

/**
 * The site's boot frame: the same paper and header frame index.html paints
 * before any script runs (its inline styles, `.kl-boot`), so the first paint,
 * this fallback and the real header line up with no flash and no shift.
 */
function SiteBootFallback() {
  return (
    <div className="kl-boot" role="status">
      <span className="sr-only">Loading Kletia</span>
      <div className="kl-boot__bar" aria-hidden="true">
        <div className="kl-boot__in">
          <span className="kl-boot__mark" />
          <span className="kl-boot__word" />
        </div>
      </div>
    </div>
  );
}

/** The desk's loading plate: the site's paper and theme (the entry entered desk mode before the first paint), never a dark flash. */
function ConsoleBootFallback() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-[#F4F1EA] dark:bg-[#0B1120]" role="status">
      <span className="border-[3px] border-[#1A1A1A] bg-[#FFD60A] px-4 py-2 text-xs font-black uppercase tracking-[0.3em] text-[#1A1A1A] shadow-[4px_4px_0_#1A1A1A] dark:border-[#4B5563] dark:shadow-[4px_4px_0_#475569]">
        Loading Kletia
      </span>
    </div>
  );
}

function EmbedBootFallback() {
  return (
    <div className="flex min-h-[12rem] items-center justify-center" role="status">
      <span className="border-[3px] border-[#1A1A1A] bg-[#FFD60A] px-3 py-1.5 text-[11px] font-black uppercase tracking-[0.24em] text-[#1A1A1A]">
        Loading Kletia
      </span>
    </div>
  );
}

/**
 * True when this document is framed by another origin. Only `/embed` may be
 * framed there; hosting headers enforce that on the first request, but a
 * client-side navigation (pushState) inside the frame never re-checks them.
 */
function isCrossOriginFramed(): boolean {
  try {
    if (window.self === window.top) return false;
  } catch {
    return true;
  }
  try {
    return window.top?.location.origin !== window.location.origin;
  } catch {
    return true;
  }
}

const CROSS_ORIGIN_FRAMED = typeof window !== "undefined" && isCrossOriginFramed();

function FramedRouteNotice({ href }: { href: string }) {
  return (
    <main id="main-content" className="flex min-h-[100dvh] items-center justify-center bg-[#F4F1EA] p-4">
      <div className="flex max-w-md flex-col items-start gap-3 border-[3px] border-[#1A1A1A] bg-white p-5 text-[#1A1A1A] shadow-[4px_4px_0_#1A1A1A]">
        <h1 className="font-display text-xl font-bold">Kletia opens in its own tab</h1>
        <p className="text-sm font-semibold">
          For your safety this page cannot run inside another website. Open it directly to continue.
        </p>
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 items-center justify-center border-[3px] border-[#1A1A1A] bg-[#0052FF] px-4 py-2 text-xs font-black uppercase tracking-wider text-white shadow-[3px_3px_0_#1A1A1A] focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#FFD60A]"
        >
          Open Kletia
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      </div>
    </main>
  );
}

function RouteLoadFailed({ reload }: { reload: () => void }) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6" role="alert">
      <div className="flex max-w-md flex-col items-start gap-4 border-[3px] border-[#1A1A1A] bg-white p-6 text-[#1A1A1A] shadow-[6px_6px_0_#1A1A1A] dark:border-[#4B5563] dark:bg-[#111827] dark:text-white dark:shadow-[6px_6px_0_#475569]">
        <p className="font-display text-2xl font-bold">This page could not load</p>
        <p className="text-sm font-semibold">
          Part of Kletia failed to download, usually because of a lost connection or a new release. Reload to try again.
        </p>
        <button type="button" onClick={reload} className="inline-flex min-h-11 items-center justify-center border-[3px] border-[#1A1A1A] bg-[#FFD60A] px-4 py-2 text-xs font-black uppercase tracking-wider text-[#1A1A1A] shadow-[3px_3px_0_#1A1A1A] focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#0052FF] active:translate-y-0.5 active:shadow-none">
          Reload
        </button>
      </div>
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

/** Mounts the toast stack once the browser is idle, or at once when a toast is queued. */
function useToasterReady(enabled: boolean): boolean {
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    if (!enabled || ready) return undefined;
    const mount = () => setReady(true);
    if (getToasts().length > 0) {
      const timer = window.setTimeout(mount, 0);
      return () => window.clearTimeout(timer);
    }
    const unsubscribe = subscribeToasts(mount);
    const prefetch = () => {
      loadToaster().then(mount, () => undefined);
    };
    if (typeof window.requestIdleCallback === "function") {
      const idle = window.requestIdleCallback(prefetch, { timeout: 4000 });
      return () => {
        unsubscribe();
        window.cancelIdleCallback(idle);
      };
    }
    const timer = window.setTimeout(prefetch, 1500);
    return () => {
      unsubscribe();
      window.clearTimeout(timer);
    };
  }, [enabled, ready]);
  return ready;
}

/** Top-level router. Every route is code-split; navigation renders in a transition. */
export function AppRouter() {
  const [location, setLocation] = React.useState<RouteLocation>(getLocation);
  const [pending, startTransition] = React.useTransition();
  const [preloading, setPreloading] = React.useState(false);
  const [announcement, setAnnouncement] = React.useState("");
  const previousPathRef = React.useRef(location.pathname);
  const renderedLocationRef = React.useRef(location);

  React.useLayoutEffect(() => {
    renderedLocationRef.current = location;
  }, [location]);

  React.useEffect(
    () =>
      subscribeLocation((next) => {
        const previous = renderedLocationRef.current;
        const previousRoute = matchRoute(previous.pathname);
        const nextRoute = matchRoute(next.pathname);
        // Only a change of route cross-fades the page: moving inside one route
        // (between developer portal pages) swaps that route's own outlet.
        const animate =
          !CROSS_ORIGIN_FRAMED &&
          next.pathname !== previous.pathname &&
          previousRoute.id !== nextRoute.id &&
          previousRoute.kind === "site" &&
          nextRoute.kind === "site" &&
          supportsViewTransitions() &&
          !prefersReducedMotion();
        if (!animate) {
          setPreloading(false);
          startTransition(() => setLocation(next));
          return;
        }
        // View Transition path: preload the page so the swap never suspends,
        // then commit synchronously inside the transition.
        const commit = () => {
          if (getLocation().key !== next.key) return;
          void runViewTransition("route", () => {
            // A newer navigation may have started while this one waited to swap.
            if (getLocation().key !== next.key) return;
            flushSync(() => {
              setPreloading(false);
              setLocation(next);
            });
          });
        };
        if (resolved.has(nextRoute.id)) {
          commit();
          return;
        }
        setPreloading(true);
        loadRoute(nextRoute.id).then(commit, () => {
          if (getLocation().key !== next.key) return;
          setPreloading(false);
          // LazyBoundary shows its error UI, as on the regular path.
          startTransition(() => setLocation(next));
        });
      }),
    [],
  );

  const route = matchRoute(location.pathname);
  const toasterReady = useToasterReady(route.kind !== "embed");

  React.useEffect(() => {
    applyDocumentMeta(route, location.pathname);
  }, [route, location.pathname]);

  React.useLayoutEffect(() => {
    const pathChanged = previousPathRef.current !== location.pathname;
    previousPathRef.current = location.pathname;
    let cancel: () => void = () => undefined;
    if (location.action === "pop" && location.restoreScrollY !== null) {
      window.scrollTo(0, location.restoreScrollY);
    } else if (location.hash) {
      cancel = scrollToHash(location.hash, location.action !== "initial" && !pathChanged);
    } else if (location.action !== "initial") {
      window.scrollTo(0, 0);
    }
    // Routes that move focus themselves (the portal shell focuses its page H1) keep it.
    if (pathChanged && location.action !== "initial" && !location.hash && !matchRoute(location.pathname).ownsFocus) {
      document.getElementById("main-content")?.focus({ preventScroll: true });
    }
    return cancel;
  }, [location]);

  // The announcement names the page that was opened: a portal page's own title, not the portal's.
  const pageTitle = documentMeta(route, location.pathname).title;
  React.useEffect(() => {
    if (location.action === "initial") return;
    const timer = window.setTimeout(() => setAnnouncement(pageTitle), 60);
    return () => window.clearTimeout(timer);
  }, [location, pageTitle]);

  const busy = pending || preloading;
  const state = React.useMemo<RouterState>(
    () => ({ location, route, pending: busy }),
    [location, route, busy],
  );

  // Admin pages render like the console: no site header or footer; the page draws its own shell.
  const content =
    CROSS_ORIGIN_FRAMED && route.kind !== "embed" ? (
      <FramedRouteNotice href={`${window.location.origin}${location.pathname}${location.search}`} />
    ) : route.kind === "site" ? (
      <SiteLayout>
        <RouteEnter routeKey={route.id} animate={location.action !== "initial"}>
          <RoutePage key={route.id} id={route.id} />
        </RouteEnter>
      </SiteLayout>
    ) : (
      <RoutePage key={route.id} id={route.id} />
    );

  return (
    <RouterContext.Provider value={state}>
      {route.kind === "embed" ? null : <PendingBar pending={busy} />}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {busy ? "Loading page" : announcement}
      </div>
      {route.kind !== "embed" && toasterReady ? (
        <React.Suspense fallback={null}>
          <Toaster placement={route.kind === "console" ? "console" : "site"} />
        </React.Suspense>
      ) : null}
      <React.Suspense
        fallback={
          route.kind === "console" || route.kind === "admin" ? (
            <ConsoleBootFallback />
          ) : route.kind === "embed" ? (
            <EmbedBootFallback />
          ) : (
            <SiteBootFallback />
          )
        }
      >
        <LazyBoundary resetKey={location.pathname} fallback={(reload) => <RouteLoadFailed reload={reload} />}>
          {content}
        </LazyBoundary>
      </React.Suspense>
    </RouterContext.Provider>
  );
}
