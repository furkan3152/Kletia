/**
 * The desk's URL state, as pure functions:
 *
 *   /app                          desk
 *   /app/tasks, /app/holdings,
 *   /app/activity, /app/orders    views of the same desk (phones and tablets)
 *   /app/tools, /app/tools/<id>   Tools view, an open tool
 *   ?q=<sentence>                 plans it once; removed right after
 *   ?from=<auto or network key>   the departure; unknown keys are ignored
 *
 * Canonical stays /app. No React here: node --test loads it.
 */
import { parseDeparture, type Departure, type DeskView } from "../state/deskModel.ts";

export const DESK_PATH = "/app";

/** The views listed in PRERENDER_PATHS (their own HTML entry, same desk). */
export const DESK_VIEW_PATHS: Readonly<Record<Exclude<DeskView, "desk">, string>> = Object.freeze({
  tasks: "/app/tasks",
  holdings: "/app/holdings",
  activity: "/app/activity",
  tools: "/app/tools",
  orders: "/app/orders",
});

const TOOL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const MAX_SENTENCE = 500;

export interface DeskLocation {
  readonly view: DeskView;
  /** An open tool (`/app/tools/<id>`); null otherwise. */
  readonly toolId: string | null;
}

/** The view a path shows; anything unknown under /app is the desk itself. */
export function deskLocationOf(pathname: string): DeskLocation {
  const path = pathname.replace(/\/+$/u, "") || "/";
  for (const [view, viewPath] of Object.entries(DESK_VIEW_PATHS) as [Exclude<DeskView, "desk">, string][]) {
    if (path === viewPath) return { view, toolId: null };
  }
  if (path.startsWith(`${DESK_VIEW_PATHS.tools}/`)) {
    let id: string;
    try {
      id = decodeURIComponent(path.slice(DESK_VIEW_PATHS.tools.length + 1));
    } catch {
      return { view: "tools", toolId: null };
    }
    return { view: "tools", toolId: TOOL_ID.test(id) ? id : null };
  }
  return { view: "desk", toolId: null };
}

/** The path of a view (and an open tool). */
export function deskPathOf({ view, toolId }: DeskLocation): string {
  if (view === "desk") return DESK_PATH;
  if (view === "tools" && toolId && TOOL_ID.test(toolId)) return `${DESK_VIEW_PATHS.tools}/${encodeURIComponent(toolId)}`;
  return DESK_VIEW_PATHS[view];
}

export interface DeskSearch {
  /** A sentence to plan once; null when absent, blank or too long. */
  readonly q: string | null;
  /** A valid departure; null when absent or unknown. */
  readonly from: Departure | null;
}

export function readDeskSearch(search: string): DeskSearch {
  const params = new URLSearchParams(search);
  const raw = params.get("q");
  const q = raw && raw.trim() && raw.length <= MAX_SENTENCE ? raw.trim() : null;
  return { q, from: parseDeparture(params.get("from")) };
}

/** The search string without `q` (a reload never plans twice), keeping everything else. */
export function searchWithoutQuery(search: string): string {
  const params = new URLSearchParams(search);
  params.delete("q");
  const next = params.toString();
  return next ? `?${next}` : "";
}

/** The search string with `from` mirroring the departure; Auto drops it (the default). */
export function searchWithDeparture(search: string, departure: Departure): string {
  const params = new URLSearchParams(search);
  if (departure === "auto") params.delete("from");
  else params.set("from", departure);
  const next = params.toString();
  return next ? `?${next}` : "";
}
