/**
 * Route table. Every page is a lazy chunk; `load` is shared by React.lazy and
 * hover/focus prefetching, so a prefetched chunk is never fetched twice.
 *
 * Marketing routes (`kind: "site"`) must never pull wallet SDKs: they render
 * inside the site shell and import only @kletia/core, @kletia/sdk and UI code.
 * Wallet code reaches a site page only through a lazily loaded panel.
 *
 * `kind: "embed"` renders without the site shell so it can live in a
 * third-party iframe (see EmbedPage for the parameters it accepts).
 */
import type { ComponentType } from "react";

export type RouteId =
  | "home"
  | "developers"
  | "networks"
  | "protocols"
  | "studio"
  | "embed"
  | "console"
  | "notFound";

type PageModule = { default: ComponentType };

export interface RouteDefinition {
  readonly id: RouteId;
  /** Canonical path (used for sitemap, canonical URL and active-link state). */
  readonly path: string;
  readonly kind: "site" | "console" | "embed";
  readonly title: string;
  readonly description: string;
  readonly load: () => Promise<PageModule>;
}

const SITE_DESCRIPTION =
  "Kletia compiles financial intents into verified, wallet-signed steps across Base, Arbitrum, Arc and Solana — as a console for users and an API, SDK and widget for teams.";

export const ROUTES: Readonly<Record<RouteId, RouteDefinition>> = Object.freeze({
  home: {
    id: "home",
    path: "/",
    kind: "site",
    title: "Kletia — Intent infrastructure for EVM and Solana",
    description: SITE_DESCRIPTION,
    load: () => import("../pages/home/HomePage"),
  },
  developers: {
    id: "developers",
    path: "/developers",
    kind: "site",
    title: "Developers — Kletia Platform API, SDK and widget",
    description:
      "Quickstart, authentication tiers, developer keys, an interactive API explorer, events, webhooks and agent integrations for the Kletia intent platform.",
    load: () => import("../pages/developers/DevelopersPage"),
  },
  networks: {
    id: "networks",
    path: "/networks",
    kind: "site",
    title: "Networks & status — Kletia",
    description:
      "Live API and RPC health, latency history, per-network intent capabilities and the venues Kletia can plan with on every network.",
    load: () => import("../pages/networks/NetworksPage"),
  },
  protocols: {
    id: "protocols",
    path: "/protocols",
    kind: "site",
    title: "Protocols — Kletia intent venues",
    description:
      "Every venue Kletia can plan with across its EVM networks and Solana: what each protocol can execute, quote or discover, live from the public API.",
    load: () => import("../pages/protocols/ProtocolsPage"),
  },
  studio: {
    id: "studio",
    path: "/studio",
    kind: "site",
    title: "Intent Studio — Kletia",
    description:
      "Type an outcome, preview the intent graph Kletia compiles (network-bound steps, protocols, quotes, fees and warnings) and execute it with your own wallets.",
    load: () => import("../pages/studio/StudioPage"),
  },
  embed: {
    id: "embed",
    path: "/embed",
    kind: "embed",
    title: "Kletia intent widget",
    description:
      "Embeddable Kletia intent widget: plan cross-network intents and execute them with your own EVM and Solana wallets.",
    load: () => import("../pages/embed/EmbedPage"),
  },
  console: {
    id: "console",
    path: "/app",
    kind: "console",
    title: "Kletia Console",
    description:
      "Connect an EVM or Solana wallet and run cross-chain intents with every value-moving step signed in your own wallet.",
    load: () => import("./ConsoleRoute"),
  },
  notFound: {
    id: "notFound",
    path: "/404",
    kind: "site",
    title: "Page not found — Kletia",
    description: SITE_DESCRIPTION,
    load: () => import("../pages/notFound/NotFoundPage"),
  },
});

const EXACT: Readonly<Record<string, RouteId>> = Object.freeze({
  "/": "home",
  "/developers": "developers",
  "/networks": "networks",
  "/protocols": "protocols",
  "/studio": "studio",
  "/embed": "embed",
  "/app": "console",
});

export function matchRoute(pathname: string): RouteDefinition {
  const exact = EXACT[pathname];
  if (exact) return ROUTES[exact];
  if (pathname.startsWith("/app/")) return ROUTES.console;
  return ROUTES.notFound;
}

const prefetched = new Set<RouteId>();

/** Starts loading the chunk for `href` (same-origin paths only). Errors are ignored. */
export function prefetchHref(href: string) {
  let pathname: string;
  try {
    const url = new URL(href, window.location.href);
    if (url.origin !== window.location.origin) return;
    pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/u, "") : url.pathname;
  } catch {
    return;
  }
  const route = matchRoute(pathname);
  if (prefetched.has(route.id)) return;
  prefetched.add(route.id);
  route.load().catch(() => prefetched.delete(route.id));
}

export const SITE_ORIGIN = "https://kletiaai.xyz";
