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
 * `kind: "admin"` is the operator panel at /admin: no site shell, never
 * indexed, never pre-rendered or listed in the sitemap. Its page is
 * wallet-free; wallet code arrives only through its lazily loaded console.
 *
 * Public pages for one object (`/r/<receiptId>`, `/go/<linkId>`, `/approve`)
 * are `site` routes matched by pattern. They carry user content, so they are
 * never indexed (`robots`), never listed in the sitemap, and their canonical
 * URL is their own path (the receipt key and the approval id live in the
 * fragment, which never reaches a server and is never part of a canonical).
 *
 * The developer portal is one `developers` route matched by prefix: every
 * `/developers/*` path renders the portal shell, which keeps its sidebar and
 * the in-memory key mounted between pages; `metaFor` gives each path its own
 * title, description and robots (see the portal section at the end).
 *
 * This file imports nothing at run time: scripts/write-route-pages.mjs
 * transpiles it on its own to pre-render the fixed paths, and the node tests
 * load it directly. Its page imports are lazy and never run there.
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
  | "changelog"
  | "admin"
  | "notFound";

type PageModule = { default: ComponentType };

/** Document metadata for one visited path of a prefix route. */
export interface RouteMeta {
  readonly title: string;
  readonly description: string;
  readonly robots: string;
  /** Canonical path when the visited path is an alias of another one. */
  readonly canonical?: string;
}

export interface RouteDefinition {
  readonly id: RouteId;
  /** Canonical path (used for sitemap, canonical URL and active-link state). */
  readonly path: string;
  readonly kind: "site" | "console" | "embed" | "admin";
  readonly title: string;
  readonly description: string;
  /** Robots directive; default "index,follow" (embed and 404 pages set their own in the router). */
  readonly robots?: string;
  /** The canonical URL is the visited path (pattern routes), not `path`. */
  readonly canonicalFromPath?: boolean;
  /** Per-path title, description, robots and canonical for prefix routes (the developer portal). */
  readonly metaFor?: (pathname: string) => RouteMeta;
  /**
   * The page moves focus itself after a client-side navigation (the portal
   * shell focuses its page H1), so the router does not focus the main region.
   */
  readonly ownsFocus?: boolean;
  readonly load: () => Promise<PageModule>;
}

/** User content and capabilities: never indexed, never followed. */
const PRIVATE_PAGE_ROBOTS = "noindex,nofollow";

/** Neutral nine-network positioning: no network is presented as the main one (index.html carries the same copy). */
const SITE_TITLE = "Kletia: intent routing across nine networks";
const SITE_DESCRIPTION =
  "Kletia turns one sentence, like “bridge 100 USDC from Ethereum to Base”, into planned, quoted transactions on nine networks that your users sign in their own wallets. REST API, TypeScript SDK, React widget and iframe embed. MIT licensed.";

const PORTAL_OVERVIEW_TITLE = "Developers: the Kletia API, SDK and widget";
const PORTAL_OVERVIEW_DESCRIPTION =
  "Get a key, plan your first intent as a dry run, and find the API explorer, recipes, webhooks, contracts, links and receipts of the Kletia developer portal.";

/** The desk at /app: one title and description for every view. */
const CONSOLE_TITLE = "Kletia Console";
const CONSOLE_DESCRIPTION =
  "Plan and sign intents on all nine Kletia networks from one sentence, with your own EVM and Solana wallets signing every step.";

export const ROUTES: Readonly<Record<RouteId, RouteDefinition>> = Object.freeze({
  home: {
    id: "home",
    path: "/",
    kind: "site",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    load: () => import("../pages/home/HomePage"),
  },
  developers: {
    id: "developers",
    path: "/developers",
    kind: "site",
    title: PORTAL_OVERVIEW_TITLE,
    description: PORTAL_OVERVIEW_DESCRIPTION,
    canonicalFromPath: true,
    metaFor: (pathname) => portalMetaFor(pathname),
    ownsFocus: true,
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
      "Every venue Kletia can plan with on its nine networks, which ones Platform API v1 executes, and your own contracts listed apart. Counted live from the public API.",
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
    title: CONSOLE_TITLE,
    description: CONSOLE_DESCRIPTION,
    metaFor: (pathname) => consoleMetaFor(pathname),
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
  changelog: {
    id: "changelog",
    path: "/changelog",
    kind: "site",
    title: "Changelog: Kletia",
    description:
      "Every Kletia release, newest first: what was added, changed, fixed and secured in the API, SDK, widget, console and site, from CHANGELOG.md.",
    load: () => import("../pages/changelog/ChangelogPage"),
  },
  admin: {
    id: "admin",
    path: "/admin",
    kind: "admin",
    title: "Kletia admin",
    description: "Kletia operator panel.",
    robots: PRIVATE_PAGE_ROBOTS,
    load: () => import("../pages/admin/AdminPage"),
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
  "/changelog": "changelog",
  "/admin": "admin",
});

/** `/r/<receiptId>` (receipt ids: `rcpt_` + 32 hex). */
export const RECEIPT_PATH_PATTERN = /^\/r\/(rcpt_[0-9a-f]{32})$/u;
/** `/go/<linkId>` (link ids: `lk_` + 24 hex). */
export const LINK_PATH_PATTERN = /^\/go\/(lk_[0-9a-f]{24})$/u;

export function matchRoute(pathname: string): RouteDefinition {
  const exact = EXACT[pathname];
  if (exact) return ROUTES[exact];
  if (pathname.startsWith("/app/")) return ROUTES.console;
  // One HTML entry for the operator panel: its sections live in `?section=`, never in sub-paths.
  if (pathname.startsWith("/admin/")) return ROUTES.admin;
  // Every portal page, known or not: the shell renders its own "No page here" state.
  if (pathname.startsWith("/developers/")) return ROUTES.developers;
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

/* ---------------------------------------------------------------------------
 * Developer portal (portal design 4.2). Paths, titles, descriptions and which
 * paths are indexed: what the router, the pre-rendered HTML and the sitemap
 * need. The shell (pages/developers/shell/portalRoutes.ts) adds the sidebar
 * label, group and lazy page of each id. Titles never carry anything read
 * from the URL or written by a user: object pages share one title per kind.
 * ------------------------------------------------------------------------ */

export type PortalPageId =
  | "overview"
  | "api"
  | "embed"
  | "recipes"
  | "keys"
  | "project"
  | "webhooks"
  | "contracts"
  | "rule-book"
  | "links"
  | "receipts"
  | "events"
  | "errors"
  | "venues"
  | "agents"
  | "missing";

/** What may follow a page's own path: an object id or `new`, an operationId, or a recipe id. */
export type PortalSubPath = "object" | "operation" | "recipe";

export type PortalRobots = "index,follow" | "noindex,nofollow" | "noindex,follow";

export interface PortalRouteMeta {
  readonly id: Exclude<PortalPageId, "missing">;
  readonly path: string;
  readonly title: string;
  readonly description: string;
  /** The page's own path is indexed, listed in the sitemap and pre-rendered. */
  readonly indexed: boolean;
  readonly sub?: PortalSubPath;
  /** Title of `<path>/new` (object pages). */
  readonly newTitle?: string;
  /** Title of one object or operation; detail paths are never indexed. */
  readonly detailTitle?: string;
}

const portalTitle = (name: string) => `${name}: Kletia developers`;

export const PORTAL_ROUTES: readonly PortalRouteMeta[] = [
  { id: "overview", path: "/developers", title: PORTAL_OVERVIEW_TITLE, description: PORTAL_OVERVIEW_DESCRIPTION, indexed: true },
  {
    id: "api",
    path: "/developers/api",
    title: portalTitle("API explorer"),
    description: "Try every Platform API v1 operation from your browser, generated from the OpenAPI document the API serves, with copy-ready snippets.",
    indexed: true,
    sub: "operation",
    detailTitle: portalTitle("API operation"),
  },
  {
    id: "embed",
    path: "/developers/embed",
    title: portalTitle("Embed builder"),
    description: "Set up the Kletia widget for your site: networks, actions and appearance, a live preview and the embed code to copy.",
    indexed: true,
  },
  {
    id: "recipes",
    path: "/developers/recipes",
    title: portalTitle("Recipes"),
    description: "Copy-ready integrations: the React widget and hooks, the web component, Next.js, Express and Hono servers, MCP agents, the CLI and platform features.",
    indexed: true,
    sub: "recipe",
  },
  {
    id: "keys",
    path: "/developers/keys",
    title: portalTitle("Keys and usage"),
    description: "Issue, rotate and revoke the keys of your project, read their usage, and see what each authentication tier can do.",
    indexed: true,
  },
  {
    id: "project",
    path: "/developers/project",
    title: portalTitle("Project settings"),
    description: "Your project's brand and domain, allowed origins, widget defaults, stored flows and browser-safe publishable keys.",
    indexed: true,
  },
  {
    id: "webhooks",
    path: "/developers/webhooks",
    title: portalTitle("Webhooks"),
    description: "Signed POSTs to your server when intents, keys, contracts, links and rule books change, with test events and a delivery log.",
    indexed: true,
    sub: "object",
    newTitle: portalTitle("New webhook"),
    detailTitle: portalTitle("Webhook"),
  },
  {
    id: "contracts",
    path: "/developers/contracts",
    title: portalTitle("Contracts"),
    description: "Register your own EVM contract functions and Solana Actions; Kletia pins and simulates every call before your users sign.",
    indexed: true,
    sub: "object",
    newTitle: portalTitle("Register a contract"),
    detailTitle: portalTitle("Contract"),
  },
  {
    id: "rule-book",
    path: "/developers/rule-book",
    title: portalTitle("Rule Book"),
    description: "Bound what Kletia plans for each key: networks, assets, recipients, caps, a timetable and approvals, with a simulator and a decision log.",
    indexed: true,
  },
  {
    id: "links",
    path: "/developers/links",
    title: portalTitle("Intent links"),
    description: "Publish pages that do one fixed thing in the visitor's own wallet, then pause, tighten or withdraw them and read their counters.",
    indexed: true,
    sub: "object",
    newTitle: portalTitle("New intent link"),
    detailTitle: portalTitle("Intent link"),
  },
  {
    id: "receipts",
    path: "/developers/receipts",
    title: portalTitle("Receipts"),
    description: "Every finished intent gets a receipt Kletia signs. Check one in your browser, offline with the CLI or SDK, and against the transparency log.",
    indexed: true,
  },
  {
    id: "events",
    path: "/developers/events",
    title: portalTitle("Events"),
    description: "Intent, Rule Book, key, contract and link events, the headers every webhook delivery carries, retries and signature checks.",
    indexed: true,
  },
  {
    id: "errors",
    path: "/developers/errors",
    title: portalTitle("Errors"),
    description: "Every error code the Kletia API returns, with its HTTP status, whether a retry can help and what to do.",
    indexed: true,
  },
  {
    id: "venues",
    path: "/developers/venues",
    title: portalTitle("Venues and auction"),
    description: "The lending venues you can pick by id, and how the planner auctions every cross-network step between bridges.",
    indexed: true,
  },
  {
    id: "agents",
    path: "/developers/agents",
    title: portalTitle("Agents and MCP"),
    description: "Agents plan through the same API or the MCP server, under a rule book, and hand every value-moving step to a wallet they do not control.",
    indexed: true,
  },
];

/** Recipe pages (`/developers/recipes/<id>`): the ids and labels of RECIPES in site/snippets.ts (a test keeps them in step). */
export const PORTAL_RECIPES: readonly { readonly id: string; readonly label: string }[] = [
  { id: "react-widget", label: "React widget" },
  { id: "react-hooks", label: "React hooks" },
  { id: "nextjs", label: "Next.js" },
  { id: "express", label: "Express" },
  { id: "hono", label: "Hono" },
  { id: "web-component", label: "Web component" },
  { id: "iframe", label: "Iframe" },
  { id: "mcp", label: "MCP" },
  { id: "cli", label: "CLI" },
  { id: "mcp-agent", label: "Agent with a rule book" },
  { id: "fare-preview", label: "Fare preview" },
  { id: "rule-book", label: "Rule Book" },
  { id: "contracts", label: "Custom contracts" },
  { id: "links", label: "Intent links" },
  { id: "receipts", label: "Receipts" },
];

/** `/developers/embed-builder` is an alias: the shell moves to `/developers/embed`. */
export const PORTAL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "/developers/embed-builder": "/developers/embed",
});

export interface PortalPathMatch {
  readonly id: PortalPageId;
  /** Object id, `new`, operationId or recipe id that follows the page's path. */
  readonly param: string | null;
  readonly robots: PortalRobots;
  /** Set for an alias: the canonical path the shell replaces the URL with. */
  readonly redirect?: string;
}

const OBJECT_PARAM = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u;
const OPERATION_PARAM = /^[A-Za-z][A-Za-z0-9_]{0,79}$/u;
const RECIPE_PARAM = /^[a-z0-9][a-z0-9-]{0,47}$/u;
const SUB_PATTERNS: Readonly<Record<PortalSubPath, RegExp>> = { object: OBJECT_PARAM, operation: OPERATION_PARAM, recipe: RECIPE_PARAM };
const PORTAL_PREFIX = "/developers";
const MISSING: PortalPathMatch = { id: "missing", param: null, robots: "noindex,follow" };

const portalPage = (id: PortalPageId): PortalRouteMeta | undefined => PORTAL_ROUTES.find((page) => page.id === id);

/**
 * The portal page for a pathname: `null` outside `/developers`, the "missing"
 * page for any path the portal does not know. Paths are matched as the
 * browser gives them (still percent-encoded), so an encoded or oddly shaped
 * segment never reaches a page as an id.
 */
export function matchPortalPath(pathname: string): PortalPathMatch | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/u, "") : pathname;
  if (path !== PORTAL_PREFIX && !path.startsWith(`${PORTAL_PREFIX}/`)) return null;
  const alias = PORTAL_ALIASES[path];
  if (alias) {
    const target = PORTAL_ROUTES.find((page) => page.path === alias);
    return target ? { id: target.id, param: null, robots: "noindex,follow", redirect: alias } : MISSING;
  }
  if (path === PORTAL_PREFIX) return { id: "overview", param: null, robots: "index,follow" };
  const segments = path.slice(PORTAL_PREFIX.length + 1).split("/");
  const page = PORTAL_ROUTES.find((item) => item.id !== "overview" && item.path === `${PORTAL_PREFIX}/${segments[0]}`);
  if (!page || segments.length > 2) return MISSING;
  if (segments.length === 1) return { id: page.id, param: null, robots: page.indexed ? "index,follow" : "noindex,follow" };
  const param = segments[1]!;
  if (!page.sub || !SUB_PATTERNS[page.sub].test(param)) return MISSING;
  if (page.sub === "recipe") {
    // Recipes are documentation pages: indexed when known, like the index itself.
    return { id: page.id, param, robots: PORTAL_RECIPES.some((recipe) => recipe.id === param) ? "index,follow" : "noindex,follow" };
  }
  return { id: page.id, param, robots: "noindex,nofollow" };
}

const recipeDescription = (label: string) =>
  `Kletia integration recipe: ${label}. Copy-ready code, the packages it needs and the rules that matter in production.`;

/** Title, description, robots and canonical for any `/developers` path (the router's `metaFor`). */
export function portalMetaFor(pathname: string): RouteMeta {
  const match = matchPortalPath(pathname) ?? MISSING;
  const page = match.id === "missing" ? undefined : portalPage(match.id);
  if (!page) {
    return {
      title: portalTitle("No page here"),
      description: "This developer portal page does not exist. Pick a section from the portal sidebar.",
      robots: MISSING.robots,
    };
  }
  if (match.redirect) return { title: page.title, description: page.description, robots: match.robots, canonical: match.redirect };
  if (match.param === null) return { title: page.title, description: page.description, robots: match.robots };
  if (page.sub === "recipe") {
    const recipe = PORTAL_RECIPES.find((item) => item.id === match.param);
    return recipe
      ? { title: portalTitle(`${recipe.label} recipe`), description: recipeDescription(recipe.label), robots: match.robots }
      : { title: portalTitle("Recipe"), description: page.description, robots: match.robots };
  }
  const title = match.param === "new" && page.newTitle ? page.newTitle : (page.detailTitle ?? page.title);
  return { title, description: page.description, robots: match.robots };
}

/**
 * Views of the desk at /app (tasks, holdings, activity, tools): the same
 * console route with their own HTML entry, so a static host without a
 * rewrite rule serves them. Their canonical URL stays /app.
 */
export const CONSOLE_VIEW_PATHS: readonly string[] = Object.freeze(["/app/tasks", "/app/holdings", "/app/activity", "/app/tools"]);

/** Every /app path is the desk: one title, canonical /app, and only /app itself is indexed. */
export function consoleMetaFor(pathname: string): RouteMeta {
  return {
    title: CONSOLE_TITLE,
    description: CONSOLE_DESCRIPTION,
    robots: pathname === "/app" ? "index,follow" : "noindex,follow",
    canonical: "/app",
  };
}

export interface PrerenderPath {
  readonly path: string;
  readonly title: string;
  readonly description: string;
  readonly robots?: string;
}

/**
 * Fixed portal paths that write-route-pages.mjs writes as HTML next to
 * index.html (the developers route itself has no fixed path of its own
 * there, because its canonical URL is the visited path): every indexed page,
 * each recipe, the `new` pages and the builder's alias.
 */
export const PRERENDER_PATHS: readonly PrerenderPath[] = [
  ...CONSOLE_VIEW_PATHS.map((path) => ({ path, title: CONSOLE_TITLE, description: CONSOLE_DESCRIPTION, robots: consoleMetaFor(path).robots })),
  ...PORTAL_ROUTES.filter((page) => page.indexed).map((page) => ({ path: page.path, title: page.title, description: page.description })),
  ...PORTAL_RECIPES.map((recipe) => ({
    path: `${PORTAL_PREFIX}/recipes/${recipe.id}`,
    title: portalTitle(`${recipe.label} recipe`),
    description: recipeDescription(recipe.label),
  })),
  ...PORTAL_ROUTES.filter((page) => page.newTitle).map((page) => ({
    path: `${page.path}/new`,
    title: page.newTitle!,
    description: page.description,
    robots: "noindex,nofollow",
  })),
  ...Object.entries(PORTAL_ALIASES).map(([path, canonical]) => {
    const page = PORTAL_ROUTES.find((item) => item.path === canonical)!;
    return { path, title: page.title, description: page.description, robots: "noindex,follow" };
  }),
];
