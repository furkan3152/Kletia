/**
 * Pure helpers of the Rule Book panel: editing a policy document without
 * mutating it, the 7 x 24 timetable grid, the key tree, which article an
 * issue belongs to, and the simulator's outcome. Only `@kletia/core`
 * imports, so the node tests load this file directly.
 */
import {
  POLICY_RULES,
  scheduleState,
  POLICY_SCHEMA,
  WEEKDAYS,
  type PolicyDocument,
  type PolicyRuleId,
  type PolicyScheduleWindow,
  type Weekday,
} from "@kletia/core";

/* ------------------------------------------------------------------ editing */

type Json = unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `doc` with `path` set to `value`; `undefined` removes the field, and objects left empty are removed too. */
export function setIn(doc: PolicyDocument, path: readonly string[], value: Json): PolicyDocument {
  const write = (node: Record<string, unknown>, index: number): Record<string, unknown> | undefined => {
    const key = path[index]!;
    const next: Record<string, unknown> = { ...node };
    if (index === path.length - 1) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    } else {
      const child = isRecord(node[key]) ? (node[key] as Record<string, unknown>) : {};
      const written = write(child, index + 1);
      if (written === undefined) delete next[key];
      else next[key] = written;
    }
    return Object.keys(next).length === 0 ? undefined : next;
  };
  const result = write(doc as unknown as Record<string, unknown>, 0) ?? {};
  return { ...(result as object), schema: POLICY_SCHEMA } as PolicyDocument;
}

export function getIn(doc: PolicyDocument | null | undefined, path: readonly string[]): unknown {
  let node: unknown = doc;
  for (const key of path) {
    if (!isRecord(node)) return undefined;
    node = node[key];
  }
  return node;
}

/** A blank rule book (restricts nothing on a project key). */
export function emptyPolicy(): PolicyDocument {
  return { schema: POLICY_SCHEMA };
}

/** Stable text of a document, to tell whether the draft differs from what is in force. */
export function documentKey(doc: PolicyDocument | null | undefined): string {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])]));
    return value;
  };
  return JSON.stringify(sort(doc ?? emptyPolicy()));
}

/* ---------------------------------------------------------------- timetable */

/** 7 rows (Monday first) x 24 hour cells. */
export type HourGrid = readonly (readonly boolean[])[];

const DAY_INDEX: Readonly<Record<Weekday, number>> = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };

function minutes(value: string): number | null {
  if (value === "24:00") return 1_440;
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function emptyGrid(): boolean[][] {
  return Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => false));
}

/** Every hour open: what "no timetable" means. */
export function fullGrid(): boolean[][] {
  return Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => true));
}

/**
 * The hour grid of a schedule, or null when a window starts or ends off the
 * hour (the grid edits whole hours; such schedules are edited as JSON).
 */
export function scheduleToGrid(schedule: PolicyDocument["schedule"] | null | undefined): boolean[][] | null {
  const grid = emptyGrid();
  if (!schedule) return grid;
  for (const window of schedule.windows) {
    const from = minutes(window.from);
    const to = minutes(window.to);
    if (from === null || to === null || from % 60 !== 0 || to % 60 !== 0) return null;
    for (const day of window.days) {
      const row = grid[DAY_INDEX[day]];
      if (!row) continue;
      for (let hour = from / 60; hour < to / 60; hour += 1) row[hour] = true;
    }
  }
  return grid;
}

function hourText(hour: number): string {
  return hour === 24 ? "24:00" : `${String(hour).padStart(2, "0")}:00`;
}

/**
 * Windows of a grid: each day's runs of open hours, with days that share the
 * same run merged into one window ({ days: [mon..fri], from: 08:00, to: 18:00 }).
 */
export function gridToWindows(grid: HourGrid): PolicyScheduleWindow[] {
  const byRun = new Map<string, Weekday[]>();
  grid.forEach((row, dayIndex) => {
    let start: number | null = null;
    for (let hour = 0; hour <= 24; hour += 1) {
      const open = hour < 24 && row[hour] === true;
      if (open && start === null) start = hour;
      if (!open && start !== null) {
        const key = `${hourText(start)}-${hourText(hour)}`;
        const days = byRun.get(key) ?? [];
        days.push(WEEKDAYS[dayIndex]!);
        byRun.set(key, days);
        start = null;
      }
    }
  });
  return [...byRun.entries()]
    .map(([run, days]) => {
      const [from, to] = run.split("-") as [string, string];
      return { days, from, to };
    })
    .sort((a, b) => DAY_INDEX[a.days[0]!] - DAY_INDEX[b.days[0]!] || a.from.localeCompare(b.from));
}

export function gridIsEmpty(grid: HourGrid): boolean {
  return grid.every((row) => row.every((cell) => !cell));
}

export function gridIsFull(grid: HourGrid): boolean {
  return grid.every((row) => row.every((cell) => cell));
}

/** "Open now; closes Friday 18:00 (Europe/Paris)." / "Closed now; opens Monday 09:00 (UTC)." */
export function timetableStatus(schedule: PolicyDocument["schedule"] | undefined, now: number): string {
  if (!schedule) return "Always open: no timetable.";
  const state = scheduleState(schedule, now);
  if (state.error) return `The time zone ${schedule.timezone} cannot be read: treated as closed.`;
  const when = state.nextChange
    ? new Date(state.nextChange).toLocaleString("en-US", { timeZone: schedule.timezone, weekday: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    : null;
  if (state.open) return when ? `Open now; closes ${when} (${schedule.timezone}).` : "Open now, and it stays open.";
  return when ? `Closed now; opens ${when} (${schedule.timezone}).` : "Closed, and no window ever opens.";
}


export const DAY_NAMES: readonly string[] = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export const DAY_SHORT: readonly string[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/* ----------------------------------------------------------------- articles */

export interface ArticleInfo {
  readonly n: number;
  readonly name: string;
  readonly title: string;
}

/** The 13 articles of a rule book (policy design §12.4). */
export const ARTICLES: readonly ArticleInfo[] = [
  { n: 1, name: "Service", title: "How this key runs." },
  { n: 2, name: "Lines", title: "Networks this key may use." },
  { n: 3, name: "Carriers", title: "Kinds of step and the venues that may carry them." },
  { n: 4, name: "Private sidings", title: "Your registered contracts this key may call." },
  { n: 5, name: "Cargo", title: "Assets this key may move." },
  { n: 6, name: "Passengers", title: "Accounts this key may plan for." },
  { n: 7, name: "Destinations", title: "Where money may arrive." },
  { n: 8, name: "Fares", title: "Limits per step, per intent, per day and per week." },
  { n: 9, name: "Timetable", title: "When payloads may be prepared." },
  { n: 10, name: "Inspection", title: "What needs a second look before it runs." },
  { n: 11, name: "Staff", title: "What this agent key may do on the API." },
  { n: 12, name: "Execution", title: "How payloads are issued." },
  { n: 13, name: "Amendments", title: "How long loosening takes." },
];

const PATH_ARTICLE: readonly [string, number][] = [
  ["mode", 1],
  ["label", 1],
  ["networks", 2],
  ["kinds", 3],
  ["protocols", 3],
  ["contracts", 4],
  ["assets", 5],
  ["accounts", 6],
  ["recipients", 7],
  ["limits", 8],
  ["caps", 8],
  ["schedule", 9],
  ["confirm", 10],
  ["permissions", 11],
  ["execution", 12],
  ["amendments", 13],
];

/** The article a document path (an issue, a warning, a comparison entry) belongs to; 0 for the document itself. */
export function articleOf(path: string): number {
  const head = path.replace(/^\$\.?/u, "").split(/[.[]/u)[0] ?? "";
  return PATH_ARTICLE.find(([prefix]) => prefix === head)?.[1] ?? 0;
}

/** The article and plain title of a rule id (`caps.dailyUsd` → article 8). */
export function ruleInfo(rule: string): { readonly article: number; readonly title: string } {
  const info = POLICY_RULES[rule as PolicyRuleId];
  return info ? { article: info.article, title: info.title } : { article: articleOf(rule), title: rule };
}

/* ---------------------------------------------------------------- key tree */

export interface TreeKey {
  readonly id: string;
  readonly name: string;
  readonly kind?: "project" | "agent";
  readonly parentId?: string | null;
  readonly depth?: number;
  readonly expiresAt?: string | null;
  readonly revokedAt: string | null;
  readonly policyVersion?: number | null;
  readonly descendants?: number;
  readonly current: boolean;
}

export interface TreeNode<K extends TreeKey = TreeKey> {
  readonly key: K;
  readonly children: readonly TreeNode<K>[];
}

/**
 * Project keys as stations on the trunk, agent keys branching below their
 * parent. Revoked keys are left out. An agent whose parent is not listed (an
 * agent key looking at its own subtree) becomes a root.
 */
export function buildKeyTree<K extends TreeKey>(keys: readonly K[]): TreeNode<K>[] {
  const live = keys.filter((key) => !key.revokedAt);
  const ids = new Set(live.map((key) => key.id));
  const childrenOf = (parent: string): TreeNode<K>[] =>
    live
      .filter((key) => key.parentId === parent)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((key) => ({ key, children: childrenOf(key.id) }));
  return live
    .filter((key) => !key.parentId || !ids.has(key.parentId))
    .sort((a, b) => Number(a.kind === "agent") - Number(b.kind === "agent") || a.name.localeCompare(b.name))
    .map((key) => ({ key, children: childrenOf(key.id) }));
}

/** Every key under a node (for the cascade warning). */
export function subtreeKeys<K extends TreeKey>(node: TreeNode<K>): K[] {
  return node.children.flatMap((child) => [child.key, ...subtreeKeys(child)]);
}

export function findNode<K extends TreeKey>(nodes: readonly TreeNode<K>[], id: string): TreeNode<K> | null {
  for (const node of nodes) {
    if (node.key.id === id) return node;
    const found = findNode(node.children, id);
    if (found) return found;
  }
  return null;
}

/* ---------------------------------------------------------------- outcomes */

export type DeskOutcome = "cleared" | "held" | "refused";

export function deskOutcome(outcome: "allow" | "confirm" | "deny"): DeskOutcome {
  return outcome === "allow" ? "cleared" : outcome === "confirm" ? "held" : "refused";
}

/** Board flap words of a decision outcome. */
export const OUTCOME_FLAPS: Readonly<Record<string, string>> = {
  allow: "CLEARED",
  confirm: "HELD",
  deny: "REFUSED",
  approved: "APPROVED",
  rejected: "REJECTED",
  observed: "OBSERVED",
};

/* ---------------------------------------------------------------- options */

export const DELAY_OPTIONS: readonly { readonly value: string; readonly label: string }[] = [
  { value: "", label: "No delay (loosening applies at once)" },
  { value: "3600", label: "1 hour" },
  { value: "21600", label: "6 hours" },
  { value: "86400", label: "24 hours" },
  { value: "259200", label: "3 days" },
  { value: "604800", label: "7 days (the most)" },
];

export const CONFIRM_TTL_OPTIONS: readonly { readonly value: string; readonly label: string }[] = [
  { value: "", label: "1 hour (default)" },
  { value: "300", label: "5 minutes" },
  { value: "1800", label: "30 minutes" },
  { value: "21600", label: "6 hours" },
  { value: "86400", label: "24 hours (the most)" },
];

export const AGENT_EXPIRY_OPTIONS: readonly { readonly value: string; readonly label: string }[] = [
  { value: "3600", label: "1 hour" },
  { value: "86400", label: "1 day" },
  { value: "604800", label: "7 days" },
  { value: "2592000", label: "30 days (default)" },
  { value: "7776000", label: "90 days" },
  { value: "31536000", label: "1 year (the most)" },
];

/* ---------------------------------------------------------- article summaries */

function listText(values: readonly string[] | undefined, any: string, none = "nothing"): string {
  if (values === undefined) return any;
  if (values.length === 0) return none;
  return values.length <= 3 ? values.join(", ") : `${values.slice(0, 3).join(", ")} and ${values.length - 3} more`;
}

function usdText(value: string | undefined): string | null {
  if (value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return `$${value}`;
  return `$${number.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function delayWords(seconds: number): string {
  if (seconds <= 0) return "no delay";
  if (seconds % 86_400 === 0) return `${seconds / 86_400} ${seconds === 86_400 ? "day" : "days"}`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600} ${seconds === 3_600 ? "hour" : "hours"}`;
  return `${Math.round(seconds / 60)} min`;
}

/** One line of what an article currently says, printed on its closed tab. */
export function articleSummary(n: number, doc: PolicyDocument, defaults: "project" | "agent"): string {
  const agent = defaults === "agent";
  switch (n) {
    case 1:
      return `${doc.mode === "paused" ? "Paused" : doc.mode === "dry-run" ? "Dry run" : "Live"}${doc.label ? ` · ${doc.label}` : ""}`;
    case 2:
      return `${listText(doc.networks?.allow, "Any network", "No network")} · ${listText(doc.networks?.lanes, "both lanes", "no lane")}`;
    case 3: {
      const deny = doc.protocols?.deny?.length ?? 0;
      return `${listText(doc.kinds?.allow, "Any kind", "No kind")} · ${doc.protocols?.allow ? `${doc.protocols.allow.length} venues allowed` : "any venue"}${deny ? ` · ${deny} denied` : ""}`;
    }
    case 4: {
      const allow = doc.contracts?.allow;
      if (allow === undefined) return agent ? "None (agent default)" : "Any registration the key may use";
      return allow.length === 0 ? "None" : `${allow.length} ${allow.length === 1 ? "registration" : "registrations"}`;
    }
    case 5: {
      const unlisted = doc.assets?.unlisted ?? (agent ? "deny" : "allow");
      return `${listText(doc.assets?.allow, "Any asset")}${doc.assets?.categories ? ` · ${doc.assets.categories.join(", ")}` : ""} · unlisted ${unlisted === "deny" ? "denied" : "allowed"}`;
    }
    case 6:
      return doc.accounts?.allow ? `${doc.accounts.allow.length} pinned ${doc.accounts.allow.length === 1 ? "account" : "accounts"}` : "Any account";
    case 7: {
      const mode = doc.recipients?.mode ?? (agent ? "own" : "any");
      const words = mode === "own" ? "Own accounts only" : mode === "allowlist" ? `Own accounts and ${doc.recipients?.allow?.length ?? 0} listed` : "Anyone not denied";
      return `${words}${doc.recipients?.deny?.length ? ` · ${doc.recipients.deny.length} denied` : ""}`;
    }
    case 8: {
      const caps = [
        usdText(doc.caps?.perStepUsd) && `${usdText(doc.caps?.perStepUsd)} a step`,
        usdText(doc.caps?.perIntentUsd) && `${usdText(doc.caps?.perIntentUsd)} an intent`,
        usdText(doc.caps?.dailyUsd) && `${usdText(doc.caps?.dailyUsd)} a day`,
        usdText(doc.caps?.weeklyUsd) && `${usdText(doc.caps?.weeklyUsd)} a week`,
      ].filter(Boolean);
      const limits = Object.keys(doc.limits ?? {}).length;
      return `${caps.length > 0 ? caps.join(" · ") : "No caps"}${limits ? ` · ${limits} ${limits === 1 ? "limit" : "limits"}` : ""}`;
    }
    case 9: {
      if (!doc.schedule) return "Always open";
      const windows = doc.schedule.windows;
      const first = windows[0];
      if (!first) return `No window (${doc.schedule.timezone})`;
      const days = first.days.length === 5 && first.days.every((day, index) => day === ["mon", "tue", "wed", "thu", "fri"][index]) ? "Weekdays" : first.days.map((day) => day.charAt(0).toUpperCase() + day.slice(1)).join(", ");
      return `${days} ${first.from}-${first.to}${windows.length > 1 ? ` and ${windows.length - 1} more` : ""} (${doc.schedule.timezone})`;
    }
    case 10: {
      const above = usdText(doc.confirm?.aboveUsd);
      const when = doc.confirm?.when?.length ?? 0;
      if (!above && when === 0) return "Never holds";
      return `${above ? `Holds above ${above}` : "Holds"}${when ? ` · ${when} ${when === 1 ? "trigger" : "triggers"}` : ""}${doc.confirm?.approvers?.requireWallet ? " · wallets only" : ""}`;
    }
    case 11: {
      if (!agent) return "Not used on this rule book";
      const on = Object.entries(doc.permissions ?? {}).filter(([, value]) => value === true).map(([key]) => key);
      return on.length > 0 ? on.join(", ") : "Defaults (store intents only)";
    }
    case 12:
      return (doc.execution?.pinNonce ?? agent) ? "Nonce pinned" : "Nonce not pinned";
    case 13:
      return `Loosening waits ${delayWords(doc.amendments?.delaySeconds ?? 0)}`;
    default:
      return "";
  }
}
