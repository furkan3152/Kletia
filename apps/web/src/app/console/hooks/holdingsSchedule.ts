/**
 * When the desk reads holdings again, as a small scheduler with injectable
 * timers (node --test drives it):
 *
 * - a wallet connecting or changing and a lane change read at once;
 * - `portfolio.invalidated` events (every settled step emits one, a bridge
 *   two) are coalesced into exactly one read after a short quiet period;
 * - while a task holds the signing lock nothing is read automatically: the
 *   reads wait and run once when the lock is released, so the public tier's
 *   request budget goes to the execution;
 * - the refresh button always reads at once.
 *
 * At most one read runs at a time; a request that arrives during a read runs
 * once after it.
 */

export type RefreshReason = "accounts" | "lane" | "invalidated" | "manual";

export interface HoldingsScheduleOptions {
  readonly read: (reason: RefreshReason) => Promise<void>;
  /** Quiet period that coalesces invalidations (default 1500 ms). */
  readonly debounceMs?: number;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export const INVALIDATION_QUIET_MS = 1500;

export class HoldingsSchedule {
  private readonly read: HoldingsScheduleOptions["read"];
  private readonly debounceMs: number;
  private readonly setTimer: NonNullable<HoldingsScheduleOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<HoldingsScheduleOptions["clearTimer"]>;
  private signing = false;
  private disposed = false;
  private reading = false;
  /** A read that waits for the lock, the quiet period or the running read. */
  private pending: RefreshReason | null = null;
  private timer: unknown = null;

  constructor(options: HoldingsScheduleOptions) {
    this.read = options.read;
    this.debounceMs = options.debounceMs ?? INVALIDATION_QUIET_MS;
    this.setTimer = options.setTimer ?? ((callback, ms) => globalThis.setTimeout(callback, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Something asks for fresh holdings. */
  request(reason: RefreshReason): void {
    if (this.disposed) return;
    if (reason === "manual") {
      this.cancelTimer();
      this.pending = null;
      this.run(reason);
      return;
    }
    // Keep the strongest reason: anything but an invalidation reads without the quiet period.
    this.pending = this.pending && this.pending !== "invalidated" ? this.pending : reason;
    if (this.signing || this.reading) return;
    if (reason === "invalidated" && this.pending === "invalidated") {
      this.cancelTimer();
      this.timer = this.setTimer(() => {
        this.timer = null;
        this.flush();
      }, this.debounceMs);
      return;
    }
    this.cancelTimer();
    this.flush();
  }

  /** The desk's signing lock changed: nothing reads while it is held; what waited reads once after. */
  setSigning(signing: boolean): void {
    if (this.signing === signing) return;
    this.signing = signing;
    if (signing) {
      this.cancelTimer();
      return;
    }
    if (this.pending && !this.reading) this.flush();
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
    this.pending = null;
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private flush(): void {
    if (this.disposed || this.signing || this.reading || this.pending === null) return;
    const reason = this.pending;
    this.pending = null;
    this.run(reason);
  }

  private run(reason: RefreshReason): void {
    if (this.reading) {
      this.pending = reason;
      return;
    }
    this.reading = true;
    void this.read(reason)
      .catch(() => undefined)
      .finally(() => {
        this.reading = false;
        if (this.pending !== null && !this.signing) {
          if (this.pending === "invalidated") {
            const waiting = this.pending;
            this.pending = null;
            this.request(waiting);
          } else {
            this.flush();
          }
        }
      });
  }
}
