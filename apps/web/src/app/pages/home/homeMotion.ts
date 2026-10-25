/**
 * Small runtime helpers of the home page: a pausable clock for the hero loop, the dither
 * frame loop, magnetic keys, reveal-on-scroll, and "is it on screen". WAAPI and CSS only.
 */
import { useEffect, useRef, type RefObject } from "react";

import { observeIntersection } from "../../site/motion/useInView";
import { prefersReducedMotion } from "../../site/motion/useReducedMotion";
import { createDither, type DitherOptions } from "./dither";

export const isPhone = (): boolean => {
  try {
    return window.matchMedia("(max-width: 760px)").matches;
  } catch {
    return false;
  }
};

export const canHover = (): boolean => {
  try {
    return !window.matchMedia("(hover: none)").matches;
  } catch {
    return false;
  }
};

/** Linear interpolation of `t` between [a, b] mapped to [0, 1] (clamped). */
export const progress = (t: number, a: number, b: number): number => (b <= a ? (t >= b ? 1 : 0) : Math.max(0, Math.min(1, (t - a) / (b - a))));

/** Runs `start` once the browser is idle after the first paint; returns a cancel. */
export function afterPaint(start: () => void, timeout = 1200): () => void {
  let idle = 0;
  let timer = 0;
  const frame = window.requestAnimationFrame(() => {
    if (typeof window.requestIdleCallback === "function") idle = window.requestIdleCallback(start, { timeout });
    else timer = window.setTimeout(start, 200);
  });
  return () => {
    window.cancelAnimationFrame(frame);
    if (idle && typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(idle);
    window.clearTimeout(timer);
  };
}

/**
 * A clock that only runs while `isRunning()` is true (the machine is on screen and the tab is
 * visible). `sleep(ms)` resolves after that much running time; `stop()` rejects every sleeper.
 */
export function pausableClock(isRunning: () => boolean) {
  let stopped = false;
  const timers = new Set<number>();
  const sleep = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      let left = ms;
      let last = performance.now();
      const tick = () => {
        if (stopped) return reject(new Error("stopped"));
        const now = performance.now();
        if (isRunning()) left -= now - last;
        last = now;
        if (left <= 0) return resolve();
        const id = window.setTimeout(() => {
          timers.delete(id);
          tick();
        }, Math.min(Math.max(left, 0), 120));
        timers.add(id);
      };
      tick();
    });
  return {
    sleep,
    stop() {
      stopped = true;
      timers.forEach((id) => window.clearTimeout(id));
      timers.clear();
    },
    get stopped() {
      return stopped;
    },
  };
}

/** Tracks whether an element is on screen (true without IntersectionObserver). */
export function useOnScreen(ref: RefObject<Element | null>, threshold = 0): RefObject<boolean> {
  const visible = useRef(true);
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    return observeIntersection(element, (entry) => {
      visible.current = entry.isIntersecting;
    }, { threshold });
  }, [ref, threshold]);
  return visible;
}

/**
 * Mounts a dither on a canvas after the first paint. It animates (every second frame) only while
 * on screen, the tab is visible and motion is allowed; reduced motion draws it once. Follows the
 * theme (html.dark) and the canvas size.
 */
export function useDither(ref: RefObject<HTMLCanvasElement | null>, options: DitherOptions, speed = 0.0045): void {
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return undefined;
    let raf = 0;
    let frame = 0;
    let visible = true;
    let resizeTimer = 0;
    let dither: ReturnType<typeof createDither> = null;
    const loop = () => {
      raf = window.requestAnimationFrame(loop);
      frame += 1;
      if (frame % 2 || !dither || !visible || document.hidden || prefersReducedMotion()) return;
      dither.step(speed);
    };
    const cancelStart = afterPaint(() => {
      dither = createDither(canvas, options);
      raf = window.requestAnimationFrame(loop);
    }, 600);
    const stopObserving = observeIntersection(canvas, (entry) => {
      visible = entry.isIntersecting;
    });
    const theme = new MutationObserver(() => dither?.palette());
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    const onResize = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => dither?.setup(), 150);
    };
    window.addEventListener("resize", onResize);
    return () => {
      cancelStart();
      stopObserving();
      theme.disconnect();
      window.cancelAnimationFrame(raf);
      window.clearTimeout(resizeTimer);
      window.removeEventListener("resize", onResize);
    };
  }, [ref, options, speed]);
}

/**
 * Magnetic keys: every `.mag` inside `root` follows the pointer (22 % x, 30 % y) and springs
 * back on leave (CSS transition). Pointer devices only; never under reduced motion.
 */
export function useMagnetic(root: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const element = root.current;
    if (!element || !canHover()) return undefined;
    const move = (event: PointerEvent) => {
      if (prefersReducedMotion()) return;
      const mag = (event.target as Element | null)?.closest<HTMLElement>(".mag");
      if (!mag || !element.contains(mag)) return;
      const rect = mag.getBoundingClientRect();
      mag.style.transition = "transform 500ms cubic-bezier(.16,1,.3,1)";
      mag.style.transform = `translate(${(event.clientX - (rect.left + rect.width / 2)) * 0.22}px, ${(event.clientY - (rect.top + rect.height / 2)) * 0.3}px)`;
    };
    const leave = (event: PointerEvent) => {
      const mag = (event.target as Element | null)?.closest<HTMLElement>(".mag");
      if (!mag || (event.relatedTarget instanceof Node && mag.contains(event.relatedTarget))) return;
      mag.style.transition = "transform 800ms linear(0, 0.31 4%, 1.08 13%, 1.16 18%, 1.03 27%, 0.97 34%, 1.01 46%, 1)";
      mag.style.transform = "";
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerout", leave);
    return () => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerout", leave);
    };
  }, [root]);
}

/**
 * Reveal-on-scroll: `.rv` elements inside `root` rise in (26 px, 700 ms) the first time they
 * reach 88 % of the viewport. Without IntersectionObserver or under reduced motion they are
 * simply shown (the CSS only hides them under `.hm-js`, set here).
 */
export function useReveal(root: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const element = root.current;
    if (!element || prefersReducedMotion() || typeof window.IntersectionObserver !== "function") return undefined;
    element.classList.add("hm-js");
    const observer = new IntersectionObserver(
      (entries) => {
        let index = 0;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const target = entry.target as HTMLElement;
          observer.unobserve(target);
          target.style.transitionDelay = `${index * 100}ms`;
          target.classList.add("is-in");
          index += 1;
        }
      },
      { rootMargin: "0px 0px -12% 0px" },
    );
    const watch = () => element.querySelectorAll(".rv:not(.is-in)").forEach((node) => observer.observe(node));
    watch();
    const mutations = new MutationObserver(watch);
    mutations.observe(element, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      mutations.disconnect();
      element.classList.remove("hm-js");
      element.querySelectorAll(".rv").forEach((node) => node.classList.add("is-in"));
    };
  }, [root]);
}
