/**
 * Studio's exit into the desk (console design 2 and WP-G): "Run in the
 * console" opens `/app?q=<sentence>&from=<departure>`, where the desk plans
 * the sentence again with the user's own accounts and signs it. Studio
 * itself never loads wallet code.
 *
 * `from` is added only when the desk's Auto departure might start somewhere
 * else than the plan Studio printed: when the planner chose the departure by
 * balance (`auto`) or the sentence named it (`text`), the desk reaches the
 * same network on its own; otherwise (`request`, `inferred`, or an API that
 * does not report a departure) the plan's first network is pinned so the
 * desk plans the route the user just read.
 *
 * Lives with the desk's modules but imports only @kletia/core, so the site
 * route that uses it stays wallet-free (pure; node --test loads it).
 */
import { isNetworkKey, type IntentGraph, type NetworkKey } from "@kletia/core";

export const DESK_ENTRY = "/app";
/** The desk ignores longer `?q=` sentences (hooks/deskUrl.ts). */
export const MAX_HANDOFF_SENTENCE = 500;

type HandoffIntent = Pick<IntentGraph, "steps" | "interpretation"> & { readonly request: Pick<IntentGraph["request"], "text"> };

/** The departure to pin for a Studio plan, or null when Auto reaches the same network. */
export function handoffDeparture(intent: HandoffIntent): NetworkKey | null {
  const first = intent.steps[0]?.network;
  if (!first || !isNetworkKey(first)) return null;
  const departure = intent.interpretation?.departure;
  if (departure && (departure.chosen === "auto" || departure.chosen === "text") && departure.network === first) return null;
  return first;
}

/** The desk link for a Studio plan; the bare desk when the plan has no sentence to carry. */
export function deskHandoffHref(intent: HandoffIntent): string {
  const text = intent.request.text?.trim() ?? "";
  if (!text || text.length > MAX_HANDOFF_SENTENCE) return DESK_ENTRY;
  const params = new URLSearchParams({ q: text });
  const from = handoffDeparture(intent);
  if (from) params.set("from", from);
  return `${DESK_ENTRY}?${params.toString()}`;
}
