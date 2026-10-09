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
 *
 * Public pages for one object (`/r/<receiptId>`, `/go/<linkId>`, `/approve`)
 * are `site` routes matched by pattern. They carry user content, so they are
 * never indexed (`robots`), never listed in the sitemap, and their canonical
 * URL is their own path (the receipt key and the approval id live in the
 * fragment, which never reaches a server and is never part of a canonical).
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
  | "receipt"
  | "link"
  | "approve"
  | "notFound";

type PageModule = { default: ComponentType };

export interface RouteDefinition {
  readonly id: RouteId;
  /** Canonical path (used for sitemap, canonical URL and active-link state). */
  readonly path: string;
  readonly kind: "site" | "console" | "embed";
  readonly title: string;
  readonly description: string;
  /** Robots directive; default "index,follow" (embed and 404 pages set their own in the router). */
  readonly robots?: string;
  /** The canonical URL is the visited path (pattern routes), not `path`. */
  readonly canonicalFromPath?: boolean;
  readonly load: () => Promise<PageModule>;
}

/** User content and capabilities: never indexed, never followed. */
const PRIVATE_PAGE_ROBOTS = "noindex,nofollow";

const SITE_DESCRIPTION =
  "Kletia turns a sentence like “bridge 50 USDC from Base to Solana” into planned, quoted transactions that your users sign in their own wallets. REST API, TypeScript SDK, React widget and iframe embed. MIT licensed.";

export const ROUTES: Readonly<Record<RouteId, RouteDefinition>> = Object.freeze({
  home: {
    id: "home",
    path: "/",
    kind: "site",
    title: "Kletia: intent routing for EVM networks and Solana",
    description: SITE_DESCRIPTION,
    load: () => import("../pages/home/HomePage"),
  },
  developers: {
    id: "developers",
    path: "/developers",
    kind: "site",
    title: "Developers: the Kletia API, SDK and widget",
    description:
      "Install the SDK, get a key, try every Platform API v1 operation in the explorer, and wire up events, webhooks, recipes and agents.",
    load: () => import("../pages/developers/DevelopersPage"),
  },
  networks: {
    id: "networks",
    path: "/networks",
    kind: "site",
    title: "Networks and status: Kletia",
    description:
      "A departure board of RPC status for every network Kletia plans on, what the planner accepts on each one and the venues it can call there.",
    load: () => import("../pages/networks/NetworksPage"),
  },
  protocols: {
    id: "protocols",
    path: "/protocols",
    kind: "site",
    title: "Protocols: venues Kletia can route through",
    description:
      "Every venue Kletia can plan with on EVM networks and Solana, and whether it executes, quotes or only reads data there. Live from the public API.",
    load: () => import("../pages/protocols/ProtocolsPage"),
  },
  studio: {
    id: "studio",
    path: "/studio",
    kind: "site",
    title: "Intent Studio: Kletia",
    description:
      "Write a route in plain English and see its legs, venues, quotes and minimum outputs as a dry run. Run it with your own wallets when it looks right.",
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
  receipt: {
    id: "receipt",
    path: "/r",
    kind: "site",
    title: "Kletia receipt",
    description:
      "A receipt Kletia signed for a finished intent. Check the signature in your browser and re-read the transactions from public nodes yourself.",
    robots: PRIVATE_PAGE_ROBOTS,
    canonicalFromPath: true,
    load: () => import("../pages/receipt/ReceiptPage"),
  },
  link: {
    id: "link",
    path: "/go",
    kind: "site",
    title: "Kletia intent link",
    description:
      "An intent link: the publisher fixed where the money goes, you choose where it comes from, and you sign every step in your own wallet.",
    robots: PRIVATE_PAGE_ROBOTS,
    canonicalFromPath: true,
    load: () => import("../pages/link/LinkPage"),
  },
  approve: {
    id: "approve",
    path: "/approve",
    kind: "site",
    title: "Approval requested: Kletia Rule Book",
    description:
      "A Rule Book held an intent for a second look. Read what it would do, then approve or reject it with the wallet the rule book names.",
    robots: PRIVATE_PAGE_ROBOTS,
    load: () => import("../pages/approve/ApprovePage"),
  },
  notFound: {
    id: "notFound",
    path: "/404",
    kind: "site",
    title: "Page not found: Kletia",
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
  "/approve": "approve",
});

/** `/r/<receiptId>` (receipt ids: `rcpt_` + 32 hex). */
export const RECEIPT_PATH_PATTERN = /^\/r\/(rcpt_[0-9a-f]{32})$/u;
/** `/go/<linkId>` (link ids: `lk_` + 24 hex). */
export const LINK_PATH_PATTERN = /^\/go\/(lk_[0-9a-f]{24})$/u;

export function matchRoute(pathname: string): RouteDefinition {
  const exact = EXACT[pathname];
  if (exact) return ROUTES[exact];
  if (pathname.startsWith("/app/")) return ROUTES.console;
  if (RECEIPT_PATH_PATTERN.test(pathname)) return ROUTES.receipt;
  if (LINK_PATH_PATTERN.test(pathname)) return ROUTES.link;
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
