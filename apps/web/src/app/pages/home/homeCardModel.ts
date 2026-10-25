/** Geometry and data of the home page's printed cards and binder stacks (shared by the hero and the story). */
import type { HeroIntent } from "./homeData";

export const X0 = 34;
export const X1 = 266;
export const RAIL_Y = 48;

/** x of every node of an intent's route (the coin rides between them). */
export function nodeXs(intent: HeroIntent): number[] {
  const count = intent.nodes.length;
  const step = (X1 - X0) / Math.max(1, count - 1);
  return intent.nodes.map((_, index) => X0 + index * step);
}

export const serialOf = (serial: number): string => String(serial).padStart(4, "0");

export interface ThumbData {
  readonly id: string;
  readonly kind: string;
  readonly serial: number;
  readonly title: string;
  readonly sub: string;
}

/** Seed thumbnails ending at `last` (three cards). */
export function seedThumbs(seeds: readonly (readonly [string, string, string])[], last: number): ThumbData[] {
  return seeds.map(([kind, title, sub], index) => ({ id: `seed-${last - 2 + index}`, kind, serial: last - 2 + index, title, sub }));
}

export type CardPhase = "printed" | "sealed" | "signing" | "settled";
