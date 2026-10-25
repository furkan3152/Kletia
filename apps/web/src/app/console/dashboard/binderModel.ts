/**
 * The Portfolio binder: every task this browser saw settle, as a card you can read, filter and
 * share. Real history only: a card is a task whose status is "completed"; its route is the task's
 * own ends; its foil is earned by a fact (cross-chain = holo), never random. Pure functions
 * (node --test loads this file).
 */
import { CHAINS, isNetworkKey } from "@kletia/core";

import { cardKind, settledTasks, shortSerial } from "../shell/machine/machineModel.ts";
import type { TaskRecord } from "../state/deskStore.ts";

export type BinderFilter = "all" | "swaps" | "moves" | "trades" | "earn";

export const BINDER_FILTERS: readonly { readonly id: BinderFilter; readonly label: string }[] = Object.freeze([
  { id: "all", label: "All" },
  { id: "swaps", label: "Swaps" },
  { id: "moves", label: "Moves" },
  { id: "trades", label: "Trades" },
  { id: "earn", label: "Earn" },
]);

const GROUP: Readonly<Record<string, BinderFilter>> = {
  Swap: "swaps",
  Bridge: "moves",
  Send: "moves",
  Perp: "trades",
  Predict: "trades",
  Stake: "earn",
  Deposit: "earn",
  Withdraw: "earn",
};

export interface BinderEntry {
  readonly id: string;
  readonly kind: string;
  readonly group: BinderFilter | null;
  readonly serial: string;
  readonly title: string;
  /** "Arbitrum to Base", "Solana"; null when the task never named its networks. */
  readonly sub: string | null;
  readonly route: readonly string[];
  /** "Oct 23" in the reader's locale-independent English format. */
  readonly date: string;
  readonly tag: string;
  readonly foil: "holo" | null;
  readonly createdAt: number;
}

function networkLabel(key: string): string {
  return isNetworkKey(key) ? CHAINS[key].shortName : key;
}

/** One settled task as a binder card. */
export function binderEntry(task: TaskRecord): BinderEntry {
  const title = task.title || task.sentence || "Settled task";
  const kind = cardKind(title);
  const ends = task.ends;
  const crossChain = ends !== null && ends.from !== ends.to;
  return {
    id: task.id,
    kind,
    group: GROUP[kind] ?? null,
    serial: shortSerial(task.id),
    title,
    sub: ends ? (crossChain ? `${networkLabel(ends.from)} to ${networkLabel(ends.to)}` : networkLabel(ends.from)) : null,
    route: ends ? (crossChain ? [ends.from, ends.to] : [ends.from]) : [],
    date: new Date(task.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    tag: crossChain ? "cross-chain" : "settled",
    foil: crossChain ? "holo" : null,
    createdAt: task.createdAt,
  };
}

/** The binder: settled tasks newest first, as cards. */
export function binderEntries(tasks: readonly TaskRecord[]): BinderEntry[] {
  return settledTasks(tasks).map(binderEntry);
}

/** The cards a filter shows ("all" shows every card, including kinds outside the four groups). */
export function filterBinder(entries: readonly BinderEntry[], filter: BinderFilter): BinderEntry[] {
  return filter === "all" ? [...entries] : entries.filter((entry) => entry.group === filter);
}

/** How many cards each filter would show (the counts on the filter keys). */
export function binderCounts(entries: readonly BinderEntry[]): Readonly<Record<BinderFilter, number>> {
  const counts: Record<BinderFilter, number> = { all: entries.length, swaps: 0, moves: 0, trades: 0, earn: 0 };
  for (const entry of entries) if (entry.group) counts[entry.group] += 1;
  return counts;
}

/** The share export's file name ("kletia-card-C21E.png"). */
export function shareFileName(entry: Pick<BinderEntry, "serial">): string {
  return `kletia-card-${entry.serial}.png`;
}
