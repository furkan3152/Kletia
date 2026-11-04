import { useEffect, useRef, useState } from "react";

import { observeIntersection } from "../../site/motion/useInView";
import { usePageVisible } from "../../site/motion/usePageVisible";
import { useReducedMotion } from "../../site/motion/useReducedMotion";

/** Seconds after which a scene has built itself (reveal and assembly are shorter). */
const SETTLED_S = 2.5;

export interface ArtCanvasProps {
  /** Canvas size in canvas pixels (the art's grid times its tile). */
  readonly width: number;
  readonly height: number;
  /** Paints one frame. `still` means: the finished picture, no motion. */
  readonly paint: (ctx: CanvasRenderingContext2D, seconds: number, still: boolean) => void;
  /** Frames per second while animating (low on purpose: pixel art steps). */
  readonly fps?: number;
  /** Starts the clock (the ticket has finished printing). Before that, frame 0 is shown. */
  readonly play?: boolean;
  /** Pixel art scales with nearest-neighbour; mosaics scale smoothly. */
  readonly pixelated?: boolean;
  /** Accessible description of the picture. */
  readonly label: string;
  readonly className?: string;
}

/**
 * A drawing on a canvas that animates only while it is on screen, in a
 * visible tab and with motion allowed; otherwise it shows one finished frame.
 * One requestAnimationFrame loop per canvas, capped at `fps`.
 */
export function ArtCanvas({ width, height, paint, fps = 8, play = true, pixelated = false, label, className }: ArtCanvasProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();
  const visible = usePageVisible();
  const [inView, setInView] = useState(() => typeof IntersectionObserver !== "function");
  const clock = useRef<{ start: number | null; elapsed: number }>({ start: null, elapsed: 0 });
  const paintRef = useRef(paint);
  useEffect(() => {
    paintRef.current = paint;
  });

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver !== "function") return undefined;
    return observeIntersection(element, (entry) => setInView(entry.isIntersecting), { rootMargin: "60px" });
  }, []);

  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return undefined;
    ctx.imageSmoothingEnabled = false;
    if (reduced) {
      paintRef.current(ctx, 0, true);
      return undefined;
    }
    if (!play) {
      paintRef.current(ctx, 0, false);
      return undefined;
    }
    if (!inView || !visible) {
      // Off screen before the art had time to build: show the finished picture, never an empty frame.
      const elapsed = clock.current.elapsed;
      paintRef.current(ctx, elapsed, elapsed < SETTLED_S);
      return undefined;
    }
    let raf = 0;
    let last = -Infinity;
    const resumeAt = performance.now() - clock.current.elapsed * 1000;
    const step = (now: number) => {
      raf = requestAnimationFrame(step);
      if (now - last < 1000 / fps) return;
      last = now;
      const seconds = (now - resumeAt) / 1000;
      clock.current.elapsed = seconds;
      paintRef.current(ctx, seconds, false);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [reduced, play, inView, visible, fps]);

  return (
    <canvas
      ref={ref}
      width={width}
      height={height}
      role="img"
      aria-label={label}
      className={className}
      style={{ imageRendering: pixelated ? "pixelated" : "auto", aspectRatio: `${width} / ${height}` }}
    />
  );
}
