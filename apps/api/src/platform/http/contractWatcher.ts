/**
 * Background watcher for contract registrations (started by
 * `startPlatformBackground` on long-running hosts):
 *
 * - activates pending revisions whose activation delay has passed (reads
 *   activate them lazily too, so serverless hosts still activate);
 * - every 10 minutes re-reads the pins of up to 200 active or pending
 *   registrations, least recently checked first, and suspends any whose code,
 *   proxy implementation or program deployment changed (`contract.suspended`);
 * - re-checks each registration's `/.well-known/kletia.json` once a day
 *   (a registration whose integrator name is a reserved brand is suspended
 *   when its domain stops verifying).
 *
 * The engine re-reads pins at every prepare and at the receipt block anyway;
 * the watcher only makes a change visible (and the registration suspended)
 * before someone tries to use it. Every check is read-only.
 */
import { activateDueContracts, contractNow, contractsToWatch, watchContract, watchDomain, type WatchOutcome } from "./contracts.js";

export const CONTRACT_WATCH_INTERVAL_MS = 10 * 60_000;
export const CONTRACT_WATCH_BATCH = 200;
export const DOMAIN_RECHECK_MS = 24 * 60 * 60_000;
/** Pin reads in flight at once (each is a handful of RPC calls). */
const CONCURRENCY = 4;

export interface ContractWatchReport {
  readonly activated: number;
  readonly checked: number;
  readonly suspended: number;
  readonly errors: number;
  readonly domainsChecked: number;
}

async function inBatches<T, R>(items: readonly T[], size: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let start = 0; start < items.length; start += size) {
    out.push(...(await Promise.all(items.slice(start, start + size).map(task))));
  }
  return out;
}

/** One watcher pass (exported for tests and manual runs). Never throws. */
export async function runContractWatch(batch = CONTRACT_WATCH_BATCH): Promise<ContractWatchReport> {
  let activated = 0;
  try {
    activated = await activateDueContracts(batch);
  } catch (error) {
    console.warn("[platform] contract activation pass failed:", error instanceof Error ? error.message : error);
  }
  let entries: Awaited<ReturnType<typeof contractsToWatch>> = [];
  try {
    entries = await contractsToWatch(batch);
  } catch (error) {
    console.warn("[platform] contract watch listing failed:", error instanceof Error ? error.message : error);
  }
  const outcomes: WatchOutcome[] = await inBatches(entries, CONCURRENCY, watchContract);
  const now = contractNow();
  const dueForDomain = entries.filter((entry) => {
    const outcome = outcomes.find((item) => item.id === entry.record.id);
    if (outcome?.result === "suspended") return false;
    const checkedAt = entry.record.verification.domain.checkedAt;
    return checkedAt === null || now - Date.parse(checkedAt) >= DOMAIN_RECHECK_MS;
  });
  const domains = await inBatches(dueForDomain, CONCURRENCY, watchDomain);
  return {
    activated,
    checked: outcomes.filter((outcome) => outcome.result !== "error").length,
    suspended: outcomes.filter((outcome) => outcome.result === "suspended").length,
    errors: outcomes.filter((outcome) => outcome.result === "error").length,
    domainsChecked: domains.filter((verified) => verified !== null).length,
  };
}

let timer: NodeJS.Timeout | null = null;
let running: Promise<ContractWatchReport> | null = null;

/** Starts the watcher (idempotent): a first pass shortly after start, then every 10 minutes. Returns a stop function. */
export function startContractWatcher(intervalMs = CONTRACT_WATCH_INTERVAL_MS): () => void {
  if (timer) clearInterval(timer);
  const tick = () => {
    if (running) return;
    running = runContractWatch().finally(() => {
      running = null;
    });
  };
  const current = setInterval(tick, intervalMs);
  current.unref?.();
  timer = current;
  const first = setTimeout(tick, Math.min(30_000, intervalMs));
  first.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(current);
    if (timer === current) timer = null;
  };
}
