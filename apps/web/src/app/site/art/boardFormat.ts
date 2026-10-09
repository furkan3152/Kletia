/**
 * Pure helpers for the split-flap departure board: what each tile shows, how
 * the tiles riffle from one value to the next, and how a health reading maps
 * to a board status. Dependency-free so `node --test` can load it directly.
 */

export type BoardStatus = "running" | "delayed" | "suspended" | "checking" | "unknown";

/** Flap text per status (at most STATUS_WIDTH characters). */
export const STATUS_FLAPS: Readonly<Record<BoardStatus, string>> = {
  running: "RUNNING",
  delayed: "DELAYED",
  suspended: "NO SERVICE",
  checking: "CHECKING",
  unknown: "NO READING",
};

/** Status as read aloud (the flaps are hidden from assistive tech). */
export const STATUS_SPEECH: Readonly<Record<BoardStatus, string>> = {
  running: "running",
  delayed: "delayed",
  suspended: "no service",
  checking: "checking",
  unknown: "no reading",
};

export const NAME_WIDTH = 13;
export const LATENCY_WIDTH = 6;
export const STATUS_WIDTH = 10;

/** A healthy RPC slower than this is shown as delayed. */
export const DELAYED_ABOVE_MS = 1500;

/** Characters on each flap drum, in the order the flaps turn. */
export const DRUM = " ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-+:";

/**
 * Latency on six tiles or fewer, always: "96 MS", "212 MS", "1.84 S",
 * "12.3 S", "99+ S", and "--- MS" when there is no reading.
 */
export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "--- MS";
  const whole = Math.round(ms);
  if (whole < 1000) return `${whole} MS`;
  const twoPlaces = Math.round(ms / 10) / 100;
  if (twoPlaces < 10) return `${twoPlaces.toFixed(2)} S`;
  const onePlace = Math.round(ms / 100) / 10;
  if (onePlace < 100) return `${onePlace.toFixed(1)} S`;
  return "99+ S";
}

/** Latency as read aloud: "96 milliseconds", "1.84 seconds", "no reading". */
export function describeLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "no reading";
  const whole = Math.round(ms);
  if (whole < 1000) return `${whole} milliseconds`;
  return `${(Math.round(ms / 10) / 100).toString()} seconds`;
}

/** Upper-cases, then truncates or pads with spaces to exactly `width` tiles. */
export function padFlaps(text: string, width: number): string {
  const upper = text.toUpperCase();
  return upper.length >= width ? upper.slice(0, width) : upper + " ".repeat(width - upper.length);
}

/** The network name if it fits on the tiles, otherwise the registry short name. */
export function boardName(line: { readonly name: string; readonly shortName: string }, width = NAME_WIDTH): string {
  return line.name.length <= width ? line.name : line.shortName;
}

/** Board status for one health reading. `ok` undefined or null means no answer yet. */
export function boardStatus(
  reading: { readonly ok?: boolean | null; readonly latencyMs?: number | null } | null | undefined,
  options: { readonly loading?: boolean; readonly delayedAboveMs?: number } = {},
): BoardStatus {
  if (!reading || reading.ok === undefined || reading.ok === null) return options.loading ? "checking" : "unknown";
  if (!reading.ok) return "suspended";
  const limit = options.delayedAboveMs ?? DELAYED_ABOVE_MS;
  if (typeof reading.latencyMs === "number" && reading.latencyMs > limit) return "delayed";
  return "running";
}

/** "10:42 UTC" for the board clock. */
export function formatBoardClock(date: Date): string {
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} UTC`;
}

export interface RiffleTiming {
  /** Delay before tile i starts turning: i * stagger ms. */
  readonly stagger: number;
  /** Time per flap. */
  readonly flapMs: number;
  /** A tile shows at most this many flaps (it skips ahead on the drum). */
  readonly maxFlips: number;
}

export const RIFFLE: RiffleTiming = { stagger: 32, flapMs: 48, maxFlips: 12 };

/** How many flaps a tile turns to go from `from` to `to` (0 when unchanged). */
export function flipsBetween(from: string, to: string, maxFlips = RIFFLE.maxFlips): number {
  if (from === to) return 0;
  const a = DRUM.indexOf(from);
  const b = DRUM.indexOf(to);
  if (a < 0 || b < 0) return 1;
  return Math.max(1, Math.min((b - a + DRUM.length) % DRUM.length, maxFlips));
}

export interface RiffleFrame {
  readonly text: string;
  /** Per tile: true while it is between two characters. */
  readonly turning: readonly boolean[];
  readonly done: boolean;
}

/**
 * The tiles `elapsed` ms after the board started turning from `from` to `to`
 * (both padded to the same width). Unchanged tiles never move; changed tiles
 * start left to right and turn forward through the drum, like a real board.
 */
export function riffleFrame(from: string, to: string, elapsed: number, timing: RiffleTiming = RIFFLE): RiffleFrame {
  let done = true;
  let text = "";
  const turning: boolean[] = [];
  for (let i = 0; i < to.length; i += 1) {
    const target = to[i]!;
    const origin = from[i] ?? " ";
    const flips = flipsBetween(origin, target, timing.maxFlips);
    const local = elapsed - i * timing.stagger;
    const step = local < 0 ? 0 : Math.floor(local / timing.flapMs) + 1;
    if (flips === 0 || step >= flips) {
      text += target;
      turning.push(false);
      continue;
    }
    done = false;
    if (step === 0) {
      text += origin;
      turning.push(false);
      continue;
    }
    const b = DRUM.indexOf(target);
    text += b < 0 ? origin : DRUM[(b - flips + step + DRUM.length * 2) % DRUM.length]!;
    turning.push(true);
  }
  return { text, turning, done };
}

/** Milliseconds until `riffleFrame(from, to, t).done` is true. */
export function riffleDuration(from: string, to: string, timing: RiffleTiming = RIFFLE): number {
  let longest = 0;
  for (let i = 0; i < to.length; i += 1) {
    const flips = flipsBetween(from[i] ?? " ", to[i]!, timing.maxFlips);
    if (flips === 0) continue;
    longest = Math.max(longest, i * timing.stagger + (flips - 1) * timing.flapMs);
  }
  return longest;
}
