import React, { useEffect } from "react";

import { seededRandom } from "./tokens";
import { prefersReducedMotion } from "./useReducedMotion";

export interface CelebrateOptions {
  /** Number of particles (default 90). */
  readonly count?: number;
  /** Lifetime in ms (default 1600). */
  readonly duration?: number;
  /** Fill colours (default the brand palette). */
  readonly colors?: readonly string[];
  /** PRNG seed: the same seed gives the same burst. */
  readonly seed?: number;
}

export interface ConfettiParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  spin: number;
  width: number;
  height: number;
  color: string;
}

export const CONFETTI_COLORS = ["#0052FF", "#FFD60A", "#9945FF", "#14F195", "#FF5A5F"] as const;

const GRAVITY = 1500; // px/s²
const DRAG = 1.6; // 1/s

/**
 * Builds a deterministic burst: squares (6–10px) and 4×12 bars fired upward
 * within ±60° of vertical. Pure, so it can be verified in Node.
 */
export function confettiParticles(
  origin: { readonly x: number; readonly y: number },
  options: { readonly count?: number; readonly colors?: readonly string[]; readonly seed?: number } = {},
): ConfettiParticle[] {
  const count = Math.max(0, Math.min(400, Math.floor(options.count ?? 90)));
  const colors = options.colors && options.colors.length > 0 ? options.colors : CONFETTI_COLORS;
  const random = seededRandom(options.seed ?? 0x6b6c);
  const particles: ConfettiParticle[] = [];
  for (let index = 0; index < count; index += 1) {
    const direction = ((random() * 120 - 60) * Math.PI) / 180;
    const speed = 520 + random() * 620;
    const bar = random() < 0.35;
    const side = 6 + random() * 4;
    particles.push({
      x: origin.x + (random() - 0.5) * 24,
      y: origin.y,
      vx: Math.sin(direction) * speed,
      vy: -Math.cos(direction) * speed,
      angle: random() * Math.PI * 2,
      spin: (random() - 0.5) * 14,
      width: bar ? 4 : side,
      height: bar ? 12 : side,
      color: colors[index % colors.length]!,
    });
  }
  return particles;
}

/** Advances one particle by `dt` seconds (gravity, drag, spin). Mutates and returns it. */
export function stepParticle(particle: ConfettiParticle, dt: number): ConfettiParticle {
  const damping = Math.exp(-DRAG * dt);
  particle.vx *= damping;
  particle.vy = particle.vy * damping + GRAVITY * dt;
  particle.x += particle.vx * dt;
  particle.y += particle.vy * dt;
  particle.angle += particle.spin * dt;
  return particle;
}

interface Burst {
  readonly particles: ConfettiParticle[];
  readonly startedAt: number;
  readonly duration: number;
}

let canvas: HTMLCanvasElement | null = null;
let bursts: Burst[] = [];
let frame = 0;
let lastTime = 0;
let seedCounter = 0;

function teardown() {
  if (frame) window.cancelAnimationFrame(frame);
  frame = 0;
  bursts = [];
  canvas?.remove();
  canvas = null;
  document.removeEventListener("visibilitychange", onVisibility);
}

function onVisibility() {
  if (document.visibilityState === "hidden") teardown();
}

function ensureCanvas(): CanvasRenderingContext2D | null {
  if (!canvas) {
    const element = document.createElement("canvas");
    element.setAttribute("aria-hidden", "true");
    element.style.cssText = "position:fixed;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:90";
    document.body.appendChild(element);
    canvas = element;
    document.addEventListener("visibilitychange", onVisibility);
  }
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.round(document.documentElement.clientWidth * ratio);
  const height = Math.round(document.documentElement.clientHeight * ratio);
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const context = canvas.getContext("2d");
  context?.setTransform(ratio, 0, 0, ratio, 0, 0);
  return context;
}

function tick(now: number) {
  frame = 0;
  const context = canvas?.getContext("2d");
  if (!canvas || !context) {
    teardown();
    return;
  }
  const dt = Math.min(0.05, Math.max(0, (now - lastTime) / 1000));
  lastTime = now;
  bursts = bursts.filter((burst) => now - burst.startedAt < burst.duration);
  if (bursts.length === 0) {
    teardown();
    return;
  }
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, canvas.width / ratio, canvas.height / ratio);
  const stroke = document.documentElement.classList.contains("dark") ? "#0B1120" : "#1A1A1A";
  context.lineWidth = 1.5;
  context.strokeStyle = stroke;
  for (const burst of bursts) {
    const age = (now - burst.startedAt) / burst.duration;
    context.globalAlpha = age > 0.75 ? Math.max(0, (1 - age) / 0.25) : 1;
    for (const particle of burst.particles) {
      stepParticle(particle, dt);
      context.save();
      context.translate(particle.x, particle.y);
      context.rotate(particle.angle);
      context.fillStyle = particle.color;
      context.fillRect(-particle.width / 2, -particle.height / 2, particle.width, particle.height);
      context.strokeRect(-particle.width / 2, -particle.height / 2, particle.width, particle.height);
      context.restore();
    }
  }
  context.globalAlpha = 1;
  frame = window.requestAnimationFrame(tick);
}

/**
 * Brutalist confetti burst from an element's top edge (or a viewport point).
 * Lazily creates one fixed, `aria-hidden`, pointer-events-none canvas that is
 * removed when the last burst ends; stops at once when the tab hides.
 * Reduced motion (or a hidden tab) makes it a no-op: show a static
 * `kl-stamp` state instead. Returns a function that stops every burst.
 */
export function celebrate(anchor: HTMLElement | { x: number; y: number }, opts: CelebrateOptions = {}): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => undefined;
  if (prefersReducedMotion() || document.visibilityState === "hidden") return () => undefined;
  let origin: { x: number; y: number };
  if ("getBoundingClientRect" in anchor) {
    const rect = anchor.getBoundingClientRect();
    origin = { x: rect.left + rect.width / 2, y: Math.max(0, rect.top) };
  } else {
    origin = anchor;
  }
  let context: CanvasRenderingContext2D | null;
  try {
    context = ensureCanvas();
  } catch {
    context = null;
  }
  if (!context) {
    teardown();
    return () => undefined;
  }
  seedCounter += 1;
  const burst: Burst = {
    particles: confettiParticles(origin, { count: opts.count, colors: opts.colors, seed: opts.seed ?? 0x6b6c + seedCounter }),
    startedAt: performance.now(),
    duration: Math.max(200, opts.duration ?? 1600),
  };
  bursts.push(burst);
  if (!frame) {
    lastTime = performance.now();
    frame = window.requestAnimationFrame(tick);
  }
  return teardown;
}

const celebrated = new Set<string>();
const STORAGE_PREFIX = "kletia-celebrated:";

/** True (and remembered for this tab) the first time `key` is claimed. */
export function claimCelebration(key: string): boolean {
  if (celebrated.has(key)) return false;
  celebrated.add(key);
  try {
    const storageKey = `${STORAGE_PREFIX}${key}`;
    if (window.sessionStorage.getItem(storageKey)) return false;
    window.sessionStorage.setItem(storageKey, "1");
  } catch {
    // Storage can be blocked; the in-memory set still prevents repeats in this page view.
  }
  return true;
}

/**
 * Fires `celebrate` once per `key` per tab when `when` becomes true (module
 * set plus a sessionStorage key), so reloading or resuming a completed intent
 * never celebrates again. Pass `when` only for transitions this page
 * observed (e.g. executing → completed), never for already-completed state.
 */
export function useCelebrateOnce(
  key: string | null,
  when: boolean,
  anchorRef: React.RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!key || !when) return;
    if (!claimCelebration(key)) return;
    const anchor = anchorRef.current;
    celebrate(anchor ?? { x: window.innerWidth / 2, y: window.innerHeight / 3 });
    // The burst is fire-and-forget: it removes its own canvas.
  }, [key, when, anchorRef]);
}
