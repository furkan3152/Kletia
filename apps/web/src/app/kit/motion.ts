/**
 * Kit motion engine: the Card machine's motion spec on the Web Animations API, with
 * no animation library. The prototype used GSAP; its eases are reproduced exactly as CSS
 * `linear()` curves sampled from the same functions (back.out, elastic.out, power*, the `mech`
 * and `slam` custom eases), so a WAAPI animation here moves like the GSAP tween it replaces.
 *
 * Reduced motion: when `reducedMotion()` is true (the OS setting or the site's own switch,
 * html[data-motion="off"]) every duration collapses to 1 ms (`D()`), keyframes jump to their end
 * and the timeline runs as a sequence of state changes. Nothing here loops: CSS owns the loops.
 *
 *   import { animate, EASE, D, timeline } from "../kit/motion";
 *   animate(el, [{ transform: "translateY(28px) scale(.94)", opacity: 0 }, {}], { duration: 500, easing: EASE.back(1.8) });
 *   const tl = timeline(); tl.add(a, frames, opts, 0).call(() => sound.play("boot"), 0).add(b, frames, opts, 120); tl.play();
 */

/* ---------- durations (ms) ---------- */
export const DUR = Object.freeze({
  press: 60,
  micro: 120,
  small: 220,
  medium: 360,
  mediumLong: 550,
  route: 600,
  rideBridge: 3000,
  rideSwap: 800,
});

/** True when motion should not play: the OS reduce-motion setting or the site's Animations switch. */
export function reducedMotion(): boolean {
  if (typeof window === "undefined") return true;
  if (document.documentElement.getAttribute("data-motion") === "off") return true;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** A duration under the reduced-motion rule (1 ms when motion is off). */
export function D(ms: number): number {
  return reducedMotion() ? 1 : ms;
}

/* ---------- eases ---------- */
export type EaseFn = (t: number) => number;

/** GSAP back.out(s): arrivals with an overshoot. */
export const backOut =
  (s = 1.70158): EaseFn =>
  (t) => {
    const u = t - 1;
    return 1 + (s + 1) * u * u * u + s * u * u;
  };

/** GSAP elastic.out(amplitude, period): springs. */
export const elasticOut = (amplitude = 1, period = 0.3): EaseFn => {
  const a = Math.max(1, amplitude);
  const p = period / (2 * Math.PI);
  const s = p * Math.asin(1 / a);
  return (t) => (t === 0 || t === 1 ? t : a * 2 ** (-10 * t) * Math.sin((t - s) / p) + 1);
};

/** GSAP powerN: power1 = quad, power2 = cubic, power3 = quart. */
export const powerIn =
  (n: 1 | 2 | 3 | 4): EaseFn =>
  (t) =>
    t ** (n + 1);
export const powerOut =
  (n: 1 | 2 | 3 | 4): EaseFn =>
  (t) =>
    1 - (1 - t) ** (n + 1);
export const powerInOut =
  (n: 1 | 2 | 3 | 4): EaseFn =>
  (t) =>
    t < 0.5 ? (2 * t) ** (n + 1) / 2 : 1 - (2 * (1 - t)) ** (n + 1) / 2;

/** A cubic-bezier path (one or more segments, as GSAP CustomEase writes them) as an ease. */
export function bezierPathEase(points: readonly (readonly [number, number])[]): EaseFn {
  // points: P0, then 3 per segment (c1, c2, end).
  const samples: [number, number][] = [];
  for (let i = 0; i + 3 < points.length; i += 3) {
    const [p0, p1, p2, p3] = [points[i]!, points[i + 1]!, points[i + 2]!, points[i + 3]!];
    for (let k = 0; k <= 40; k += 1) {
      const t = k / 40;
      const m = 1 - t;
      const x = m * m * m * p0[0] + 3 * m * m * t * p1[0] + 3 * m * t * t * p2[0] + t * t * t * p3[0];
      const y = m * m * m * p0[1] + 3 * m * m * t * p1[1] + 3 * m * t * t * p2[1] + t * t * t * p3[1];
      samples.push([x, y]);
    }
  }
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    for (let i = 1; i < samples.length; i += 1) {
      const [x1, y1] = samples[i]!;
      if (x1 >= x) {
        const [x0, y0] = samples[i - 1]!;
        return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
      }
    }
    return 1;
  };
}

const linearCache = new Map<string, string>();

/** An ease function as a CSS `linear()` timing function (sampled; cached by key). */
export function toLinear(fn: EaseFn, key?: string, steps = 48): string {
  if (key && linearCache.has(key)) return linearCache.get(key)!;
  const stops: string[] = [];
  for (let i = 0; i <= steps; i += 1) stops.push(String(Math.round(fn(i / steps) * 10000) / 10000));
  const value = `linear(${stops.join(", ")})`;
  if (key) linearCache.set(key, value);
  return value;
}

/** Named eases of the motion spec, as WAAPI/CSS timing functions. */
export const EASE = Object.freeze({
  /** Motors and steps: hard start, damped stop. */
  mech: "cubic-bezier(.7,0,.2,1)",
  /** Latch and stamp: fast in, ~6 % overshoot (CustomEase "slam"). */
  get slam() {
    return toLinear(bezierPathEase([[0, 0], [0.3, 0], [0.55, 1.12], [0.7, 1.06], [0.82, 1], [0.9, 0.99], [1, 1]]), "slam");
  },
  out: "cubic-bezier(.16,1,.3,1)",
  /** back.out(s) for arrivals (1.3 view swap, 1.5 card release, 1.8 bubble, 2-3 pops). */
  back: (s = 1.70158) => toLinear(backOut(s), `back${s}`),
  /** elastic.out(a, p) for springs (send key, sliding key, tilt release). */
  elastic: (amplitude = 1, period = 0.3) => toLinear(elasticOut(amplitude, period), `el${amplitude}/${period}`, 64),
  in: (n: 1 | 2 | 3 | 4 = 2) => toLinear(powerIn(n), `in${n}`, 24),
  outPow: (n: 1 | 2 | 3 | 4 = 3) => toLinear(powerOut(n), `out${n}`, 24),
  inOut: (n: 1 | 2 | 3 | 4 = 2) => toLinear(powerInOut(n), `io${n}`, 24),
});

/* ---------- animate ---------- */
export interface AnimateOptions {
  readonly duration?: number;
  readonly delay?: number;
  readonly easing?: string;
  /**
   * "backwards" (default): the start frame holds through the delay and nothing lingers after.
   * "persist": the end frame is committed to the element's inline style, then the animation is
   * cancelled (no fill left behind).
   */
  readonly fill?: FillMode | "persist";
  readonly iterations?: number;
  readonly direction?: PlaybackDirection;
}

/** One WAAPI animation under the reduced-motion rule. Returns null when the element is missing. */
export function animate(element: Element | null | undefined, keyframes: Keyframe[] | PropertyIndexedKeyframes, options: AnimateOptions = {}): Animation | null {
  if (!element || typeof (element as HTMLElement).animate !== "function") return null;
  const { duration = DUR.small, delay = 0, easing = EASE.out, fill = "backwards", iterations = 1, direction = "normal" } = options;
  const reduce = reducedMotion();
  const animation = (element as HTMLElement).animate(keyframes, {
    duration: reduce ? 1 : duration,
    delay: reduce ? 0 : delay,
    easing,
    fill: fill === "persist" ? "both" : fill,
    iterations: reduce ? 1 : iterations,
    direction,
  });
  if (fill === "persist") {
    animation.finished
      .then(() => {
        try {
          animation.commitStyles();
        } catch {
          /* detached element */
        }
        animation.cancel();
      })
      .catch(() => undefined);
  }
  return animation;
}

/** A promise that settles when an animation ends or is cancelled (null resolves at once). */
export function settled(animation: Animation | null): Promise<void> {
  return animation ? animation.finished.then(() => undefined, () => undefined) : Promise.resolve();
}

/* ---------- timeline ---------- */
export interface Timeline {
  /** Adds an animation starting `at` ms after play. */
  add(element: Element | null | undefined, keyframes: Keyframe[] | PropertyIndexedKeyframes, options?: AnimateOptions, at?: number): Timeline;
  /** Calls `fn` at `at` ms (sounds, state changes). Under reduced motion every call still runs, in order. */
  call(fn: () => void, at?: number): Timeline;
  play(): Promise<void>;
  /** Stops pending calls and cancels running animations (jumping to the end state is up to the caller). */
  cancel(): void;
  /** Runs everything at once to its end (skip). */
  finish(): void;
}

/** A tiny sequencer for choreographies (boot, print, settle). Times are in ms from play(). */
export function timeline(): Timeline {
  type Entry = { at: number; run: () => Animation | null | void };
  const entries: Entry[] = [];
  const running: Animation[] = [];
  const timers: number[] = [];
  let done: (() => void) | null = null;
  let playing = false;
  const api: Timeline = {
    add(element, keyframes, options = {}, at = 0) {
      entries.push({ at, run: () => animate(element, keyframes, { ...options, fill: options.fill ?? "backwards" }) });
      return api;
    },
    call(fn, at = 0) {
      entries.push({ at, run: fn });
      return api;
    },
    play() {
      if (playing) return Promise.resolve();
      playing = true;
      const reduce = reducedMotion();
      const sorted = [...entries].sort((a, b) => a.at - b.at);
      return new Promise<void>((resolve) => {
        done = resolve;
        if (reduce) {
          for (const entry of sorted) entry.run();
          resolve();
          return;
        }
        let last = 0;
        for (const entry of sorted) {
          last = Math.max(last, entry.at);
          if (entry.at <= 0) {
            // Start frames apply before the next paint (no flash of the end state).
            const animation = entry.run();
            if (animation) running.push(animation);
            continue;
          }
          timers.push(
            window.setTimeout(() => {
              const animation = entry.run();
              if (animation) running.push(animation);
            }, entry.at),
          );
        }
        timers.push(
          window.setTimeout(() => {
            void Promise.all(running.map(settled)).then(() => done?.());
          }, last + 1),
        );
      });
    },
    cancel() {
      for (const timer of timers.splice(0)) window.clearTimeout(timer);
      for (const animation of running.splice(0)) animation.cancel();
      done?.();
    },
    finish() {
      const pending = timers.splice(0);
      for (const timer of pending) window.clearTimeout(timer);
      for (const animation of running.splice(0)) {
        try {
          animation.finish();
        } catch {
          animation.cancel();
        }
      }
      done?.();
    },
  };
  return api;
}

/* ---------- presets from the motion spec ---------- */

/** Arrival: rises from `y` px at `scale` with back.out (bubble 28/.94/1.8, module 12/1/2). */
export function popIn(element: Element | null | undefined, { y = 16, scale = 1, duration = 500, back = 1.8, delay = 0 } = {}): Animation | null {
  return animate(element, [{ transform: `translateY(${y}px) scale(${scale})`, opacity: 0 }, { transform: "none", opacity: 1 }], { duration, delay, easing: EASE.back(back) });
}

/** Cartridge swap, old view out: drops 24 px and fades (220 ms, power2.in). */
export function swapOut(element: Element | null | undefined): Animation | null {
  return animate(element, [{ transform: "none", opacity: 1 }, { transform: "translateY(24px)", opacity: 0 }], { duration: DUR.small, easing: EASE.in(2), fill: "forwards" });
}

/** Cartridge swap, new view in: falls in from -24 px (500 ms, back.out(1.3)). */
export function swapIn(element: Element | null | undefined, delay = 0): Animation | null {
  return animate(element, [{ transform: "translateY(-24px)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 500, delay, easing: EASE.back(1.3) });
}

/** Error shake (420 ms): x 0, -8, 7, -5, 4, -2, 0. */
export function shake(element: Element | null | undefined, amplitude = 8): Animation | null {
  const k = amplitude / 8;
  return animate(element, [0, -8, 7, -5, 4, -2, 0].map((x) => ({ transform: `translateX(${x * k}px)` })), { duration: 420, easing: "linear" });
}

/** Seal shake: the latch and the stamp shake rail and main by 2 px (220-240 ms). */
export function sealShake(element: Element | null | undefined): Animation | null {
  return animate(element, [0, -2, 2, -1, 1, 0].map((x) => ({ transform: `translate(${x}px, ${x === 0 ? 0 : -x / 2}px)` })), { duration: 230, easing: "linear" });
}

/** Paper jam: a 0.5 s shake of ±4 px. */
export function jamShake(element: Element | null | undefined): Animation | null {
  return animate(element, [0, -4, 4, -4, 3, -3, 2, 0].map((x) => ({ transform: `translateX(${x}px)` })), { duration: 500, easing: "linear" });
}

/** The key squash on send: 1.14/0.82 back to 1 (elastic, 500 ms). */
export function squash(element: Element | null | undefined): Animation | null {
  return animate(element, [{ transform: "scale(1.14, 0.82)" }, { transform: "none" }], { duration: 500, easing: EASE.elastic(1, 0.4) });
}

/** Check pop: 1.35 back to 1 (back.out(3), 450-500 ms). */
export function checkPop(element: Element | null | undefined): Animation | null {
  return animate(element, [{ transform: "scale(1.35)" }, { transform: "none" }], { duration: 480, easing: EASE.back(3) });
}

/** Riffle: a new thumbnail drops from -60 px; the ones below bounce -10, 4, 0 (call with the stack). */
export function riffle(newest: Element | null | undefined, below: readonly Element[]): void {
  animate(newest, [{ translate: "0 -60px", opacity: 0 }, { translate: "0 0", opacity: 1 }], { duration: 550, easing: EASE.back(1.8) });
  below.forEach((element, index) =>
    animate(element, [{ translate: "0 0" }, { translate: "0 -10px" }, { translate: "0 4px" }, { translate: "0 0" }], { duration: 500, delay: 200 + index * 60, easing: "ease-out" }),
  );
}

/**
 * Counts a number up (the reply amounts after settle: 1.1 s, power3.out). `onUpdate` receives
 * the value each frame; under reduced motion it receives `to` once.
 */
export function countUp(from: number, to: number, onUpdate: (value: number) => void, { duration = 1100 } = {}): () => void {
  if (reducedMotion() || duration <= 1) {
    onUpdate(to);
    return () => undefined;
  }
  const ease = powerOut(3);
  const start = performance.now();
  let frame = 0;
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / duration);
    onUpdate(from + (to - from) * ease(t));
    if (t < 1) frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
  return () => cancelAnimationFrame(frame);
}

/**
 * Pointer tilt for printed cards (up to `max` degrees, foil follows the pointer, elastic spring
 * back). Sets --tilt-x, --tilt-y, --mx, --my, --sx on the element. No-op under reduced motion or
 * on touch-only devices. Returns a cleanup.
 */
export function tilt(element: HTMLElement | null, max = 9): () => void {
  if (!element || reducedMotion()) return () => undefined;
  try {
    if (window.matchMedia("(hover: none)").matches) return () => undefined;
  } catch {
    /* ignore */
  }
  const set = (x: number, y: number) => {
    element.style.setProperty("--tilt-x", `${-y * max}deg`);
    element.style.setProperty("--tilt-y", `${x * max}deg`);
    element.style.setProperty("--mx", `${50 + x * 60}%`);
    element.style.setProperty("--my", `${50 + y * 60}%`);
    element.style.setProperty("--sx", `${50 - x * 90}%`);
  };
  const move = (event: PointerEvent) => {
    const rect = element.getBoundingClientRect();
    element.style.transition = "transform 120ms linear";
    set((event.clientX - rect.left) / rect.width - 0.5, (event.clientY - rect.top) / rect.height - 0.5);
  };
  const leave = () => {
    element.style.transition = `transform 1100ms ${EASE.elastic(1, 0.45)}`;
    set(0, 0);
    element.style.setProperty("--my", "30%");
    element.style.setProperty("--sx", "120%");
  };
  element.addEventListener("pointermove", move);
  element.addEventListener("pointerleave", leave);
  return () => {
    element.removeEventListener("pointermove", move);
    element.removeEventListener("pointerleave", leave);
  };
}
