/**
 * The portal search index (portal design 4.6, PD-5): portal pages, API
 * operations, error codes, recipes, event types and MCP tools, plus venues
 * and the caller's own objects when a page already loaded them. Everything
 * comes from bundled data or data already in memory: building or searching
 * the index never makes a network call. Pure: the node tests load it.
 */
import { errorCatalogRows } from "@kletia/core";

import { MCP_TOOLS, RECIPES } from "../../../site/snippets.ts";
import { EVENT_FAMILIES, EVENT_TYPES } from "../devContent.ts";
import type { ExplorerOperation } from "../explorer/operations.ts";
import { PORTAL_GROUPS, PORTAL_PAGES } from "../shell/portalRoutes.ts";
import { normalizeQuery, scoreEntry } from "./fuzzy.ts";

export type SearchKind = "page" | "operation" | "error" | "recipe" | "event" | "tool" | "venue" | "object";

export interface SearchEntry {
  readonly kind: SearchKind;
  /** "POLICY_VIOLATION", "POST /v1/intents", "Webhooks". */
  readonly title: string;
  /** One line. */
  readonly detail: string;
  /** A portal path, with a hash when the target is a row on its page. */
  readonly href: string;
  /** Lower-case extra terms, space separated. */
  readonly keywords: string;
}

export interface SearchGroup {
  readonly group: SearchKind;
  readonly label: string;
  readonly entries: readonly SearchEntry[];
}

/** Kind order for ties and for groups with equal best scores. */
export const SEARCH_KINDS: readonly SearchKind[] = ["page", "operation", "error", "recipe", "event", "tool", "venue", "object"];

export const SEARCH_KIND_LABELS: Readonly<Record<SearchKind, string>> = {
  page: "Pages",
  operation: "Operations",
  error: "Errors",
  recipe: "Recipes",
  event: "Events",
  tool: "MCP tools",
  venue: "Venues",
  object: "Your objects",
};

export const PER_GROUP = 8;
export const MAX_RESULTS = 40;

const lower = (...parts: readonly (string | number | null | undefined)[]) =>
  parts
    .filter((part) => part !== null && part !== undefined && part !== "")
    .join(" ")
    .toLowerCase();

function pageEntries(): SearchEntry[] {
  const groupLabel = new Map(PORTAL_GROUPS.map((group) => [group.id, group.label]));
  return PORTAL_PAGES.map((page) => ({
    kind: "page" as const,
    title: page.label,
    detail: page.group ? (groupLabel.get(page.group) ?? "") : "",
    href: page.path,
    keywords: lower(page.id, page.description),
  }));
}

function operationEntries(operations: readonly ExplorerOperation[]): SearchEntry[] {
  return operations.map((operation) => ({
    kind: "operation" as const,
    title: `${operation.method} ${operation.path}`,
    detail: operation.summary,
    href: `/developers/api/${operation.id}`,
    keywords: lower(operation.id, operation.path, operation.tag, operation.auth === "key" ? "key" : "public"),
  }));
}

function errorEntries(): SearchEntry[] {
  return errorCatalogRows().map((row) => ({
    kind: "error" as const,
    title: row.code,
    detail: [row.status ?? "step", row.category.replace(/_/gu, " "), row.title].join(" · "),
    href: `/developers/errors#error-${row.code}`,
    keywords: lower(row.status ?? "step", row.category, row.retryable ? "retryable" : null),
  }));
}

function recipeEntries(): SearchEntry[] {
  return RECIPES.map((recipe) => ({
    kind: "recipe" as const,
    title: recipe.label,
    detail: `${recipe.group} · ${recipe.title}`,
    href: `/developers/recipes/${recipe.id}`,
    keywords: lower(recipe.id, recipe.install, ...recipe.files.map((file) => file.filename)),
  }));
}

function eventEntries(): SearchEntry[] {
  const intents = EVENT_TYPES.map((event) => ({
    kind: "event" as const,
    title: event.type,
    detail: `Intents · ${event.description}`,
    href: "/developers/events",
    keywords: lower(event.fields),
  }));
  const families = EVENT_FAMILIES.flatMap((family) =>
    family.types.map((type) => ({
      kind: "event" as const,
      title: type,
      detail: `${family.title} · ${family.note}`,
      href: "/developers/events",
      keywords: lower(family.fields),
    })),
  );
  return [...intents, ...families];
}

function toolEntries(): SearchEntry[] {
  return MCP_TOOLS.map((tool) => ({
    kind: "tool" as const,
    title: tool.name,
    detail: tool.output,
    href: "/developers/agents",
    keywords: lower("mcp", tool.input, tool.key ? "key" : null, tool.writes ? "stores" : "read-only"),
  }));
}

export interface SearchIndexInput {
  /** The live spec's operations when the explorer loaded them, else the bundled reference. */
  readonly operations: readonly ExplorerOperation[];
  readonly venues?: readonly { readonly id: string; readonly name: string }[];
  /** Names of the caller's contracts, links or webhooks already loaded by a page; nothing is fetched for search. */
  readonly objects?: readonly SearchEntry[];
}

export function buildSearchIndex(input: SearchIndexInput): readonly SearchEntry[] {
  const venues = (input.venues ?? []).map((venue) => ({
    kind: "venue" as const,
    title: venue.name,
    detail: venue.id,
    href: "/developers/venues",
    keywords: lower(venue.id),
  }));
  return [
    ...pageEntries(),
    ...operationEntries(input.operations),
    ...errorEntries(),
    ...recipeEntries(),
    ...eventEntries(),
    ...toolEntries(),
    ...venues,
    ...(input.objects ?? []).map((entry) => ({ ...entry, kind: "object" as const })),
  ];
}

/**
 * Matching entries grouped by kind: groups ordered by their best score (kind
 * order on ties), entries by score, at most PER_GROUP per group and
 * MAX_RESULTS in all. An empty query returns nothing.
 */
export function searchEntries(index: readonly SearchEntry[], query: string, limit = MAX_RESULTS): readonly SearchGroup[] {
  if (!normalizeQuery(query)) return [];
  const kindRank = (kind: SearchKind) => SEARCH_KINDS.indexOf(kind);
  const scored = index
    .map((entry, position) => ({ entry, position, score: scoreEntry(entry, query) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || kindRank(a.entry.kind) - kindRank(b.entry.kind) || a.position - b.position);
  const groups = new Map<SearchKind, { best: number; entries: SearchEntry[] }>();
  let total = 0;
  for (const item of scored) {
    if (total >= limit) break;
    const group = groups.get(item.entry.kind) ?? { best: item.score, entries: [] };
    if (group.entries.length >= PER_GROUP) continue;
    group.entries.push(item.entry);
    groups.set(item.entry.kind, group);
    total += 1;
  }
  return [...groups.entries()]
    .sort(([kindA, a], [kindB, b]) => b.best - a.best || kindRank(kindA) - kindRank(kindB))
    .map(([group, { entries }]) => ({ group, label: SEARCH_KIND_LABELS[group], entries }));
}

/** Results in display order, for keyboard movement and the announced count. */
export function flattenGroups(groups: readonly SearchGroup[]): readonly SearchEntry[] {
  return groups.flatMap((group) => group.entries);
}

/** "5 results", "1 result", "No results". */
export function resultCount(count: number): string {
  if (count === 0) return "No results";
  return `${count} ${count === 1 ? "result" : "results"}`;
}
