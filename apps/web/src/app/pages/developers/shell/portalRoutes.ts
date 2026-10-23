/**
 * The developer portal's pages (portal design 4.2 and 4.7): sidebar labels and
 * groups, which pages need a key, and the lazy page module of each id. Paths,
 * titles and robots come from the route table, so the router, the
 * pre-rendered HTML and the shell read one source.
 *
 * Also the legacy redirect map: the portal used to be one page of `#`
 * sections, and every API error body still links `/developers#error-<CODE>`
 * (`errorDocsUrl` in @kletia/core stays as it is), so old anchors move to
 * their page with history.replaceState.
 *
 * Pure apart from the lazy imports, which the node tests never call.
 */
import type { ComponentType } from "react";

import type { IconName } from "../../../site/art/icons.ts";
import {
  matchPortalPath,
  PORTAL_RECIPES,
  PORTAL_ROUTES,
  type PortalPageId,
  type PortalRobots,
  type PortalRouteMeta,
} from "../../../routes/routeTable.ts";

export type { PortalPageId } from "../../../routes/routeTable.ts";

export type PortalGroup = "start" | "build" | "project" | "verify" | "reference";

export interface PortalPageProps {
  /** Object id, `new`, operationId or recipe id from the path, or null. */
  readonly param: string | null;
  readonly search: URLSearchParams;
}

type PageModule = { default: ComponentType<PortalPageProps> };

export interface PortalPageDef {
  readonly id: PortalPageId;
  readonly path: string;
  /** Sidebar label. */
  readonly label: string;
  readonly group: PortalGroup | null;
  /** Document title and meta description of the page's own path. */
  readonly title: string;
  readonly description: string;
  /** The page shows the caller's own objects: without a usable key it explains itself (KeyGate). */
  readonly needsKey: boolean;
  /** Agent keys may read this page (their own subtree only). */
  readonly agentKeys: boolean;
  /** Indexed: sitemap, pre-rendered, robots index,follow on the page's own path. */
  readonly indexable: boolean;
  /** Full-width content (API explorer, Rule Book, embed builder); other pages keep a 1040 px column. */
  readonly wide: boolean;
  readonly load: () => Promise<PageModule>;
}

export interface PortalMatch {
  readonly page: PortalPageDef;
  readonly param: string | null;
  readonly robots: PortalRobots;
  /** Alias paths: where the shell replaces the URL. */
  readonly redirect?: string;
}

export const PORTAL_GROUPS: readonly { readonly id: PortalGroup; readonly label: string; readonly icon: IconName }[] = [
  { id: "start", label: "Start", icon: "route" },
  { id: "build", label: "Build", icon: "sdk" },
  { id: "project", label: "Your project", icon: "key" },
  { id: "verify", label: "Verify", icon: "verify" },
  { id: "reference", label: "Reference", icon: "board" },
];

interface PageUi {
  readonly label: string;
  readonly group: PortalGroup;
  readonly needsKey?: boolean;
  readonly agentKeys?: boolean;
  readonly wide?: boolean;
  readonly load: () => Promise<PageModule>;
}

/** Sidebar order is the order of this table. */
const PAGE_UI: Readonly<Record<Exclude<PortalPageId, "missing">, PageUi>> = {
  overview: { label: "Overview", group: "start", load: () => import("../views/OverviewPage") },
  api: { label: "API explorer", group: "build", wide: true, load: () => import("../views/ExplorerPage") },
  embed: { label: "Embed builder", group: "build", wide: true, load: () => import("../views/EmbedBuilderView") },
  recipes: { label: "Recipes", group: "build", load: () => import("../views/RecipesPage") },
  keys: { label: "Keys and usage", group: "project", needsKey: true, load: () => import("../views/KeysPage") },
  project: { label: "Project settings", group: "project", needsKey: true, load: () => import("../views/ProjectPage") },
  webhooks: { label: "Webhooks", group: "project", needsKey: true, agentKeys: true, load: () => import("../views/WebhooksPage") },
  contracts: { label: "Contracts", group: "project", needsKey: true, agentKeys: true, load: () => import("../views/ContractsPage") },
  "rule-book": { label: "Rule Book", group: "project", needsKey: true, agentKeys: true, wide: true, load: () => import("../views/RuleBookPage") },
  "agent-tree": { label: "Agents", group: "project", needsKey: true, agentKeys: true, load: () => import("../views/AgentTreePage") },
  links: { label: "Links", group: "project", needsKey: true, agentKeys: true, load: () => import("../views/LinksPage") },
  receipts: { label: "Receipts", group: "verify", load: () => import("../views/ReceiptsPage") },
  events: { label: "Events", group: "reference", load: () => import("../views/EventsPage") },
  errors: { label: "Errors", group: "reference", load: () => import("../views/ErrorsPage") },
  venues: { label: "Venues and auction", group: "reference", load: () => import("../views/VenuesPage") },
  agents: { label: "Agents and MCP", group: "reference", load: () => import("../views/AgentsPage") },
  data: { label: "Data API", group: "reference", load: () => import("../views/DataApiPage") },
};

function pageOf(meta: PortalRouteMeta): PortalPageDef {
  const ui = PAGE_UI[meta.id];
  return {
    id: meta.id,
    path: meta.path,
    label: ui.label,
    group: ui.group,
    title: meta.title,
    description: meta.description,
    needsKey: ui.needsKey ?? false,
    agentKeys: ui.agentKeys ?? false,
    indexable: meta.indexed,
    wide: ui.wide ?? false,
    load: ui.load,
  };
}

/** Every portal page in sidebar order (groups in PORTAL_GROUPS order). */
export const PORTAL_PAGES: readonly PortalPageDef[] = PORTAL_GROUPS.flatMap((group) =>
  PORTAL_ROUTES.filter((meta) => PAGE_UI[meta.id].group === group.id).map(pageOf),
);

/** The "No page here" state for paths the portal does not know. */
export const MISSING_PAGE: PortalPageDef = {
  id: "missing",
  path: "/developers",
  label: "No page here",
  group: null,
  title: "No page here: Kletia developers",
  description: "This developer portal page does not exist.",
  needsKey: false,
  agentKeys: false,
  indexable: false,
  wide: false,
  load: () => import("./PortalMissing"),
};

export function portalPage(id: PortalPageId): PortalPageDef {
  return PORTAL_PAGES.find((page) => page.id === id) ?? MISSING_PAGE;
}

/** The page for a pathname; anything the portal does not know is the "missing" page. */
export function matchPortal(pathname: string): PortalMatch {
  const match = matchPortalPath(pathname);
  if (!match || match.id === "missing") return { page: MISSING_PAGE, param: null, robots: "noindex,follow" };
  return {
    page: portalPage(match.id),
    param: match.param,
    robots: match.robots,
    ...(match.redirect ? { redirect: match.redirect } : {}),
  };
}

/** Where the "Get a key" actions lead: the key form at the top of the Overview. */
export const GET_KEY_HREF = "/developers#start-key";

/** Old single-page sections, by anchor (portal design 4.2). */
const LEGACY_SECTIONS: Readonly<Record<string, string>> = {
  quickstart: "/developers#start",
  start: "/developers#start",
  keys: "/developers/keys",
  auth: "/developers/keys",
  rulebook: "/developers/rule-book",
  contracts: "/developers/contracts",
  links: "/developers/links",
  receipts: "/developers/receipts",
  explorer: "/developers/api",
  reference: "/developers/api",
  recipes: "/developers/recipes",
  embed: "/developers/embed",
  events: "/developers/events",
  venues: "/developers/venues",
  errors: "/developers/errors",
  agents: "/developers/agents",
};

/** Error codes travel verbatim; anything else lands on the errors page itself. */
const LEGACY_CODE = /^[A-Za-z0-9_]{1,80}$/u;
const LEGACY_OPERATION = /^[A-Za-z][A-Za-z0-9_]{0,79}$/u;

/**
 * Where an old `/developers#<anchor>` link goes now, or null to stay on the
 * Overview (unknown anchors are ignored). `#error-<CODE>` keeps the code so
 * the errors page can show it, even when the catalog does not know it.
 */
export function legacyHashTarget(hash: string): string | null {
  if (typeof hash !== "string") return null;
  const name = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!name) return null;
  if (name.startsWith("error-")) {
    const code = name.slice("error-".length);
    return LEGACY_CODE.test(code) ? `/developers/errors#error-${code}` : "/developers/errors";
  }
  if (name.startsWith("recipe-")) {
    const id = name.slice("recipe-".length);
    return PORTAL_RECIPES.some((recipe) => recipe.id === id) ? `/developers/recipes/${id}` : "/developers/recipes";
  }
  if (name.startsWith("op-")) {
    const operation = name.slice("op-".length);
    return LEGACY_OPERATION.test(operation) ? `/developers/api/${operation}` : "/developers/api";
  }
  return Object.prototype.hasOwnProperty.call(LEGACY_SECTIONS, name) ? LEGACY_SECTIONS[name]! : null;
}
