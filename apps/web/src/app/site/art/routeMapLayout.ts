/**
 * Layout of the hero route map (viewBox 760 x 540). Positions are drawn by
 * hand on an octilinear grid; everything named on the map (networks, venues,
 * the bridges at the interchange, the test yard) is read from @kletia/core,
 * so a venue that leaves a network also leaves the map.
 *
 * Label positions were checked for collisions in light and dark at 1440 and
 * 390 px (see art/__tests__ for the geometry checks). Pure module: imports use
 * explicit `.ts` extensions so `node --test` can load it.
 */
import type { NetworkKey, ProtocolId } from "@kletia/core";

import { DOWN, DOWN_LEFT, DOWN_RIGHT, RIGHT, UP, UP_LEFT, UP_RIGHT, type Pt } from "./geometry.ts";
import { INTERCHANGE_VENUES, LINES, venueOn, YARD_LINES, type Line } from "./tokens.ts";

export const MAP_WIDTH = 760;
export const MAP_HEIGHT = 540;

export type Anchor = "start" | "middle" | "end";

export interface StationSpec {
  readonly venue: ProtocolId;
  /** Point on the line. */
  readonly at: Pt;
  /** Unit normal: the side of the line the tick and the label go to. */
  readonly n: Pt;
}

export interface Station {
  readonly venue: ProtocolId;
  readonly label: string;
  readonly at: Pt;
  readonly n: Pt;
}

export interface TrackSpec {
  readonly network: NetworkKey;
  readonly points: readonly Pt[];
  readonly stations: readonly StationSpec[];
  /** Centre of the line bullet. */
  readonly bullet: Pt;
  /** Where the network name is printed. */
  readonly name: { readonly at: Pt; readonly anchor: Anchor };
}

export interface Track {
  readonly line: Line;
  readonly points: readonly Pt[];
  readonly stations: readonly Station[];
  readonly bullet: Pt;
  readonly name: { readonly at: Pt; readonly anchor: Anchor };
}

export const BULLET_WIDTH = 46;
export const BULLET_HEIGHT = 22;

/** The interchange capsule: every production line ends at its left edge, Solana leaves from its right edge. */
export const INTERCHANGE = { x: 372, y: 180, width: 64, height: 188, rx: 26 } as const;
/** Kletia's yellow name plate, hung above the interchange. */
export const KLETIA_PLATE = { x: 368, y: 144, width: 72, height: 25 } as const;

const TRACK_SPECS: readonly TrackSpec[] = [
  {
    network: "optimism",
    points: [
      [392, 200],
      [336, 200],
      [336, 36],
    ],
    stations: [
      { venue: "moonwell", at: [336, 124], n: RIGHT },
      { venue: "compound-v3", at: [336, 76], n: RIGHT },
    ],
    bullet: [336, 24],
    name: { at: [376, 29], anchor: "start" },
  },
  {
    network: "ethereum",
    points: [
      [392, 236],
      [290, 236],
      [170, 116],
      [56, 116],
    ],
    stations: [
      { venue: "ens", at: [104, 116], n: UP },
      { venue: "morpho", at: [200, 146], n: UP_RIGHT },
      { venue: "compound-v3", at: [252, 198], n: DOWN_LEFT },
    ],
    bullet: [32, 116],
    name: { at: [10, 94], anchor: "start" },
  },
  {
    network: "base",
    points: [
      [392, 272],
      [56, 272],
    ],
    stations: [
      { venue: "aerodrome", at: [240, 272], n: UP },
      { venue: "uniswap-v3", at: [160, 272], n: UP },
    ],
    bullet: [32, 272],
    name: { at: [10, 250], anchor: "start" },
  },
  {
    network: "arbitrum",
    points: [
      [392, 308],
      [290, 308],
      [170, 428],
      [56, 428],
    ],
    stations: [
      { venue: "compound-v3", at: [240, 358], n: UP_LEFT },
      { venue: "uniswap-v3", at: [196, 402], n: DOWN_RIGHT },
      { venue: "aave-v3", at: [112, 428], n: UP },
    ],
    bullet: [32, 428],
    name: { at: [10, 462], anchor: "start" },
  },
  {
    network: "polygon",
    points: [
      [392, 344],
      [336, 344],
      [336, 500],
    ],
    stations: [
      { venue: "aave-v3", at: [336, 402], n: RIGHT },
      { venue: "ens", at: [336, 450], n: RIGHT },
    ],
    bullet: [336, 512],
    name: { at: [304, 517], anchor: "end" },
  },
  {
    network: "solana",
    points: [
      [416, 272],
      [516, 272],
      [596, 192],
      [708, 192],
    ],
    stations: [
      { venue: "jupiter", at: [474, 272], n: DOWN },
      { venue: "kamino", at: [556, 232], n: DOWN_RIGHT },
      { venue: "jito", at: [630, 192], n: UP },
      { venue: "marinade", at: [680, 192], n: UP },
    ],
    bullet: [730, 192],
    name: { at: [730, 224], anchor: "middle" },
  },
];

/** Production networks that have a place on the map (a new registry network needs a track here). */
export const MAPPED_NETWORKS: readonly NetworkKey[] = TRACK_SPECS.map((spec) => spec.network);

/** Tracks with registry names; stations whose venue no longer serves that network are dropped. */
export const TRACKS: readonly Track[] = TRACK_SPECS.filter((spec) => LINES[spec.network] && !LINES[spec.network].yard).map(
  (spec) => ({
    line: LINES[spec.network],
    points: spec.points,
    bullet: spec.bullet,
    name: spec.name,
    stations: spec.stations.flatMap((station) => {
      const venue = venueOn(station.venue, spec.network);
      return venue ? [{ venue: station.venue, label: venue.name, at: station.at, n: station.n }] : [];
    }),
  }),
);

/** Where a station label goes: 20-22 units out along the normal, anchored away from the line. */
export function labelPlacement(station: Pick<Station, "at" | "n">): { x: number; y: number; anchor: Anchor } {
  const [x, y] = station.at;
  const [nx, ny] = station.n;
  const diagonal = Math.abs(nx) > 0.1 && Math.abs(ny) > 0.1;
  const reach = diagonal ? 20 : 22;
  const anchor: Anchor = nx > 0.3 ? "start" : nx < -0.3 ? "end" : "middle";
  const baseline = ny > 0.3 ? 9 : ny < -0.3 ? -1 : 4;
  return { x: Math.round((x + nx * reach) * 10) / 10, y: Math.round((y + ny * reach + baseline) * 10) / 10, anchor };
}

/* ---- The example trip ------------------------------------------------------ */

/** Wallet on Base, through the interchange, Jupiter, then Jito on Solana. */
export const TRIP_POINTS: readonly Pt[] = [
  [112, 272],
  [516, 272],
  [596, 192],
  [630, 192],
];
export const WALLET: Pt = [112, 272];
/** Leg markers: 1 is the crossing at the interchange, 2 the swap at Jupiter. */
export const LEG_MARKERS: readonly { readonly n: number; readonly at: Pt }[] = [
  { n: 1, at: [404, 272] },
  { n: 2, at: [474, 246] },
];
/** Where the still train waits when motion is off. */
export const TRAIN_REST: Pt = [300, 272];

/* ---- The "Change here for" sign ------------------------------------------ */

export const SIGN = { x: 452, y: 312, header: 20, row: 17, column: 96, padX: 10 } as const;

/** Interchange venues laid out in columns (down, then across), with the sign's size. */
export function signLayout(names: readonly string[] = INTERCHANGE_VENUES.map((venue) => venue.name)): {
  readonly width: number;
  readonly height: number;
  readonly items: readonly { readonly name: string; readonly x: number; readonly y: number }[];
} {
  const columns = names.length > 3 ? 2 : 1;
  const rows = Math.ceil(names.length / columns);
  const items = names.map((name, index) => ({
    name,
    x: SIGN.x + SIGN.padX + Math.floor(index / rows) * SIGN.column,
    y: SIGN.y + SIGN.header + 18 + (index % rows) * SIGN.row,
  }));
  return { width: SIGN.padX * 2 + columns * SIGN.column - 8, height: SIGN.header + 14 + rows * SIGN.row, items };
}

/* ---- Test yard --------------------------------------------------------------- */

export const YARD = { x: 452, y: 420, width: 300, rowTop: 464, row: 23 } as const;

/** Yard rows from the registry testnets, and the fence height that holds them. */
export function yardLayout(lines: readonly Line[] = YARD_LINES): {
  readonly height: number;
  readonly rows: readonly { readonly line: Line; readonly y: number }[];
} {
  const rows = lines.map((line, index) => ({ line, y: YARD.rowTop + index * YARD.row }));
  const last = rows.length ? rows[rows.length - 1]!.y : YARD.rowTop;
  return { height: last - YARD.y + 18, rows };
}

/* ---- Words ---------------------------------------------------------------------- */

/** "A, B and C". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The map's long description, written from the registry. */
export function mapDescription(): string {
  const production = TRACKS.map((track) => track.line.name);
  const venues = INTERCHANGE_VENUES.map((venue) => venue.name);
  const yard = YARD_LINES.map((line) => line.name);
  const parts = [
    `${joinNames(production)} meet at one interchange, the Kletia planner${
      venues.length ? `, where ${joinNames(venues)} handle the crossing between networks` : ""
    }.`,
  ];
  if (yard.length) {
    parts.push(`${joinNames(yard)} sit in a separate test yard with no connection to the production lines.`);
  }
  return parts.join(" ");
}
