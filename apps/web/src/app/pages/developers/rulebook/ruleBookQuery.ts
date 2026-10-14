/**
 * The Rule Book page's address:
 * `/developers/rule-book?key=<keyId|project>&view=rules|simulate|decisions|agents`.
 * The key and the view the reader picks are written back, so a link opens
 * the same book on the same tab. Anything else in the query is ignored, an
 * invalid value reads as absent (the default), and only the defaults are
 * left out when writing. Pure, so the node tests load it directly.
 */
import { API_KEY_ID_PATTERN } from "@kletia/core";

export type RuleBookView = "rules" | "simulate" | "decisions" | "agents";

export const RULE_BOOK_VIEWS: readonly RuleBookView[] = ["rules", "simulate", "decisions", "agents"];

/** Plain labels: what each tab holds, not the metaphor. */
export const RULE_BOOK_VIEW_LABELS: Readonly<Record<RuleBookView, string>> = {
  rules: "Rules",
  simulate: "Simulate",
  decisions: "Decision log",
  agents: "Agent keys",
};

export interface RuleBookQuery {
  /** A key id (`key_` + 24 hex), `project` for the project's own rule book, or null for the default (the loaded key). */
  readonly key: string | null;
  readonly view: RuleBookView;
}

export function isRuleBookKey(value: unknown): value is string {
  return value === "project" || (typeof value === "string" && API_KEY_ID_PATTERN.test(value));
}

/** Reads `?key=&view=`; invalid or repeated values are ignored (the first valid one wins). */
export function parseRuleBookQuery(search: URLSearchParams | string): RuleBookQuery {
  const params = typeof search === "string" ? new URLSearchParams(search.startsWith("?") ? search.slice(1) : search) : search;
  const key = params.getAll("key").find(isRuleBookKey) ?? null;
  const view = (params.getAll("view").find((value) => RULE_BOOK_VIEWS.includes(value as RuleBookView)) as RuleBookView | undefined) ?? "rules";
  return { key, view };
}

/** `?key=key_…&view=simulate`, or "" for the defaults; values are validated again before they are written. */
export function serializeRuleBookQuery(query: Partial<RuleBookQuery>): string {
  const params = new URLSearchParams();
  if (query.key && isRuleBookKey(query.key)) params.set("key", query.key);
  if (query.view && query.view !== "rules" && RULE_BOOK_VIEWS.includes(query.view)) params.set("view", query.view);
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** The page link for a key and a view. */
export function ruleBookHref(query: Partial<RuleBookQuery> = {}): string {
  return `/developers/rule-book${serializeRuleBookQuery(query)}`;
}

/**
 * The key a page shows: the query's key when the reader can see it (a live
 * key of the list, or the project), otherwise the loaded key, otherwise the
 * first key, otherwise the project.
 */
export function selectedRuleBookKey(queryKey: string | null, keys: readonly { readonly id: string; readonly current?: boolean }[]): string {
  if (queryKey === "project") return "project";
  if (queryKey && keys.some((key) => key.id === queryKey)) return queryKey;
  return keys.find((key) => key.current)?.id ?? keys[0]?.id ?? "project";
}
