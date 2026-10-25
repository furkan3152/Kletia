/**
 * What the desk's machine shell shows (the Card machine): the binder stack, the status
 * LCD, the printer window state, the "Now" legs, live balances and today on chain. Pure
 * functions over the desk's real state (tasks, holdings, `GET /v1/health`); anything unknown is
 * null and prints "—". Nothing here invents a number. No React: node --test loads it.
 */
import { CHAINS, isNetworkKey, NETWORK_KEYS, type NetworkKey } from "@kletia/core";

import type { TaskRecord, TaskStatus } from "../../state/deskStore.ts";

/* ---------- binder ---------- */
export interface BinderCard {
  readonly id: string;
  /** Band label ("Swap", "Bridge"). */
  readonly kind: string;
  /** Four characters of the task serial ("C21E"). */
  readonly serial: string;
  readonly title: string;
  readonly sub: string;
}

const KINDS: readonly (readonly [RegExp, string])[] = [
  [/\bbridge|\bmove\b/iu, "Bridge"],
  [/\bswap|\bconvert|\bbuy\b|\bsell\b/iu, "Swap"],
  [/\bsend|\bpay\b|\btransfer/iu, "Send"],
  [/\bstake|\bunstake/iu, "Stake"],
  [/\bdeposit|\blend|\bsupply|\bearn/iu, "Deposit"],
  [/\bwithdraw/iu, "Withdraw"],
  [/\blong\b|\bshort\b|\bperp/iu, "Perp"],
  [/\bbet\b|\bpredict/iu, "Predict"],
];

/** The card's band label from its title (what the plan does); "Card" when nothing matches. */
export function cardKind(title: string): string {
  for (const [pattern, kind] of KINDS) if (pattern.test(title)) return kind;
  return "Card";
}

/** The last four letters and digits of a task id, as printed on its card ("#C21E"). */
export function shortSerial(id: string): string {
  return id.replace(/[^a-z0-9]/giu, "").toUpperCase().slice(-4).padStart(4, "0");
}

export function networkName(network: string): string {
  return isNetworkKey(network) ? CHAINS[network].shortName : network;
}

/** Settled tasks are the binder: newest first. */
export function settledTasks(tasks: readonly TaskRecord[]): readonly TaskRecord[] {
  return tasks.filter((task) => task.status === "completed").sort((a, b) => b.createdAt - a.createdAt);
}

/** The stack's thumbnails: the last three settled tasks, oldest at the back (index 0) and newest on top. */
export function binderStack(tasks: readonly TaskRecord[], limit = 3): readonly BinderCard[] {
  return settledTasks(tasks)
    .slice(0, limit)
    .reverse()
    .map((task) => ({
      id: task.id,
      kind: cardKind(task.title || task.sentence),
      serial: shortSerial(task.id),
      title: task.title || task.sentence || "Settled task",
      sub: task.ends ? (task.ends.from === task.ends.to ? networkName(task.ends.from) : `${networkName(task.ends.from)} → ${networkName(task.ends.to)}`) : "Settled",
    }));
}

/* ---------- LCD ---------- */
export interface LcdInput {
  readonly tasks: readonly TaskRecord[];
  /** Latest block (EVM) or slot (Solana) per network, from `GET /v1/health`. */
  readonly heights: Readonly<Partial<Record<NetworkKey, string>>>;
  /** The API process uptime from `GET /v1/health`; null until read. */
  readonly uptimeSeconds: number | null;
  /** The network whose block the LCD shows (default Base). */
  readonly blockNetwork?: NetworkKey;
}

/** Quotes this tab asked for: tasks that got a planned intent (each plan is a quote). */
export function quoteCount(tasks: readonly TaskRecord[]): number {
  return tasks.filter((task) => task.intentId !== null).length;
}

export function formatHeight(height: string | null | undefined): string | null {
  if (!height || !/^\d+$/u.test(height)) return null;
  return BigInt(height).toLocaleString("en-US");
}

/** "41D 06H" (days and hours), "06H 12M" under a day; null when unknown. */
export function formatUptime(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null;
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const two = (value: number) => String(value).padStart(2, "0");
  return days > 0 ? `${days}D ${two(hours)}H` : `${two(hours)}H ${two(minutes)}M`;
}

export interface LcdRow {
  readonly label: string;
  readonly spoken: string;
  readonly value: string | null;
}

export function lcdRows({ tasks, heights, uptimeSeconds, blockNetwork = "base" }: LcdInput): readonly LcdRow[] {
  const short = CHAINS[blockNetwork].shortName.toUpperCase();
  return [
    { label: "QUOTES", spoken: "Quotes this session", value: quoteCount(tasks).toLocaleString("en-US") },
    { label: `${short} BLK`, spoken: `${CHAINS[blockNetwork].shortName} block height`, value: formatHeight(heights[blockNetwork]) },
    { label: "UPTIME", spoken: "Kletia API uptime", value: formatUptime(uptimeSeconds) },
  ];
}

/** Block heights by network from a health report (unknown keys and missing heights are dropped). */
export function healthHeights(networks: readonly { readonly network: string; readonly height?: string }[] | null | undefined): Partial<Record<NetworkKey, string>> {
  const heights: Partial<Record<NetworkKey, string>> = {};
  for (const entry of networks ?? []) {
    if (isNetworkKey(entry.network) && typeof entry.height === "string" && /^\d+$/u.test(entry.height)) heights[entry.network] = entry.height;
  }
  return heights;
}

/* ---------- printer window + status ---------- */
export type PrinterState = "idle" | "working" | "jam";

const WORKING: ReadonlySet<TaskStatus> = new Set(["planning", "executing"]);

/** The task the machine is about: the signing one, else the focused one, else the newest. */
export function activeTask(tasks: readonly TaskRecord[], signingTaskId: string | null, focusedTaskId: string | null): TaskRecord | null {
  const byId = (id: string | null) => (id ? (tasks.find((task) => task.id === id) ?? null) : null);
  return byId(signingTaskId) ?? byId(focusedTaskId) ?? tasks[tasks.length - 1] ?? null;
}

export function printerState(tasks: readonly TaskRecord[], active: TaskRecord | null): PrinterState {
  if (tasks.some((task) => WORKING.has(task.status))) return "working";
  if (active?.status === "failed") return "jam";
  return "idle";
}

/** The LED next to the machine and the title: on (ready/done), blue (working), magenta (needs attention). */
export function statusTone(task: TaskRecord | null): "on" | "blue" | "magenta" | "off" {
  if (!task) return "on";
  if (task.status === "failed" || task.status === "question" || task.status === "paused") return "magenta";
  if (WORKING.has(task.status) || task.status === "review") return "blue";
  return "on";
}

/* ---------- Now: the active task's legs ---------- */
export type LegState = "queued" | "active" | "done" | "failed";

export interface MachineLeg {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly state: LegState;
  /** Short state word on the right ("queued", "signing", "done"). */
  readonly word: string;
}

/** The fields of a plan step the panel reads (an IntentStep, structurally). */
export interface StepLike {
  readonly id: string;
  readonly index: number;
  readonly title: string;
  readonly network: string;
  readonly status: string;
  readonly input?: { readonly symbol: string; readonly formatted: string };
  readonly expectedOutput?: { readonly symbol: string; readonly formatted: string };
  readonly settlement?: { readonly destinationNetwork?: string } | null;
}

const DONE_STEPS = new Set(["settled", "confirmed", "skipped"]);
const FAILED_STEPS = new Set(["failed", "indeterminate"]);
const LIVE_STEPS: Readonly<Record<string, string>> = { awaiting_signature: "in wallet", submitted: "sent", settling: "settling" };

/**
 * A plan's steps as the "Now" legs, in order: done only when the API settled or confirmed the
 * step, active while the executor prepares, signs or confirms it (or the API says it is in
 * flight), queued otherwise.
 */
export function machineLegs(steps: readonly StepLike[], phases: Readonly<Record<string, string>> = {}): readonly MachineLeg[] {
  return [...steps]
    .sort((a, b) => a.index - b.index)
    .map((step) => {
      const destination = step.settlement?.destinationNetwork;
      const where = destination && destination !== step.network ? `${networkName(step.network)} → ${networkName(destination)}` : networkName(step.network);
      const amount = step.input ? `${step.input.formatted} ${step.input.symbol}` : step.expectedOutput ? `${step.expectedOutput.formatted} ${step.expectedOutput.symbol}` : null;
      const detail = amount ? `${where} · ${amount}` : where;
      const phase = phases[step.id];
      let state: LegState = "queued";
      let word = "queued";
      if (DONE_STEPS.has(step.status)) {
        state = "done";
        word = step.status === "skipped" ? "skipped" : "done";
      } else if (FAILED_STEPS.has(step.status)) {
        state = "failed";
        word = step.status === "failed" ? "failed" : "unknown";
      } else if (phase) {
        state = "active";
        word = phase;
      } else if (LIVE_STEPS[step.status]) {
        state = "active";
        word = LIVE_STEPS[step.status]!;
      }
      return { id: step.id, title: step.title, detail, state, word };
    });
}

/* ---------- balances ---------- */
export interface BalanceRow {
  readonly network: NetworkKey;
  readonly name: string;
  readonly usd: number;
  /** 0..1 against the largest row (the proportion bar). */
  readonly share: number;
  readonly stale: boolean;
}

export interface BalanceSummary {
  readonly total: number | null;
  readonly rows: readonly BalanceRow[];
  readonly networks: number;
}

/** Live balances per network from the holdings snapshot, largest first (at most `limit` rows). */
export function balanceSummary(
  byNetwork: Readonly<Partial<Record<NetworkKey, { readonly totalUsd: number; readonly stale: boolean }>>> | null,
  limit = 6,
): BalanceSummary {
  if (!byNetwork) return { total: null, rows: [], networks: 0 };
  const entries = NETWORK_KEYS.flatMap((network) => {
    const entry = byNetwork[network];
    return entry ? [{ network, usd: entry.totalUsd, stale: entry.stale }] : [];
  });
  const total = entries.reduce((sum, entry) => sum + entry.usd, 0);
  const sorted = entries.filter((entry) => entry.usd > 0).sort((a, b) => b.usd - a.usd);
  const max = sorted[0]?.usd ?? 0;
  return {
    total,
    networks: entries.length,
    rows: sorted.slice(0, limit).map((entry) => ({ ...entry, name: CHAINS[entry.network].shortName, share: max > 0 ? entry.usd / max : 0 })),
  };
}

export function formatUsdFixed(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/* ---------- today on chain ---------- */
export interface HealthLike {
  readonly ok: boolean;
  readonly latencyMs?: number | null;
}

export interface TodayRow {
  readonly id: "live" | "fastest" | "slowest";
  readonly label: string;
  readonly value: string | null;
}

/** Network status as three readings: networks answering, the fastest RPC, the slowest (or none down). */
export function todayRows(health: Readonly<Partial<Record<NetworkKey, HealthLike>>>, offered: readonly NetworkKey[] | null): readonly TodayRow[] {
  const keys = (offered ?? NETWORK_KEYS).filter((key) => health[key] !== undefined);
  if (keys.length === 0) {
    return [
      { id: "live", label: "Networks answering", value: null },
      { id: "fastest", label: "Fastest RPC", value: null },
      { id: "slowest", label: "Slowest RPC", value: null },
    ];
  }
  const ok = keys.filter((key) => health[key]?.ok);
  const timed = ok.filter((key) => typeof health[key]?.latencyMs === "number").sort((a, b) => health[a]!.latencyMs! - health[b]!.latencyMs!);
  const down = keys.filter((key) => !health[key]?.ok);
  const fastest = timed[0];
  const slowest = timed[timed.length - 1];
  return [
    { id: "live", label: "Networks answering", value: `${ok.length} of ${(offered ?? NETWORK_KEYS).length}` },
    { id: "fastest", label: "Fastest RPC", value: fastest ? `${CHAINS[fastest].shortName} · ${health[fastest]!.latencyMs} ms` : null },
    {
      id: "slowest",
      label: down.length > 0 ? "Not answering" : "Slowest RPC",
      value: down.length > 0 ? down.map((key) => CHAINS[key].shortName).join(", ") : slowest ? `${CHAINS[slowest].shortName} · ${health[slowest]!.latencyMs} ms` : null,
    },
  ];
}
