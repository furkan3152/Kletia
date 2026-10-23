/**
 * Route shapes of a crossing leg X on A -> Y on B (design C.2):
 *
 * | Shape            | Legs                                   | Signed legs | Needs gas on B |
 * |------------------|----------------------------------------|-------------|----------------|
 * | bridge (Y = X)   | bridge X A->B                          | 1           | no             |
 * | one-shot         | cross-network swap X@A -> Y@B          | 1           | no (DLN: cancel)|
 * | bridge-swap      | bridge X A->B + swap X->Y on B         | 2           | yes            |
 * | swap-bridge      | swap X->Y on A + bridge Y A->B         | 2           | no             |
 * | swap-bridge-swap | swap X->C on A + bridge C + swap C->Y  | 3           | yes            |
 *
 * Composites exist only behind `KLETIA_ROUTE_SHAPES=compare` (default
 * `single`), never when the request restricts to single-signature shapes
 * (`constraints.routeShapes: "single"`, `routePreference:
 * "fewest-signatures"`), and are built from carriers chosen by exact token
 * address (routing/carriers.ts).
 */
import type { IntentConstraints, RouteShape } from "@kletia/core";
import { sameAsset, type ResolvedAsset } from "../assets.js";
import { carriersFor, isCarrierToken, type Carrier, type CarrierId } from "./carriers.js";

/** `KLETIA_ROUTE_SHAPES`: "single" (default) plans one leg per crossing; "compare" also compares composites. */
export type RouteShapesMode = "single" | "compare";

let modeOverride: RouteShapesMode | null = null;

/** Overrides `KLETIA_ROUTE_SHAPES` (tests); `null` reads the environment again. */
export function configureRouteShapes(mode: RouteShapesMode | null): void {
  modeOverride = mode;
}

/** The deployment's route-shape mode; anything but "compare" is the safe default "single". */
export function routeShapesMode(): RouteShapesMode {
  if (modeOverride) return modeOverride;
  return process.env.KLETIA_ROUTE_SHAPES?.trim().toLowerCase() === "compare" ? "compare" : "single";
}

/** True when this request may be planned with composite (multi-signature) shapes. */
export function compositesAllowed(constraints: IntentConstraints | undefined): boolean {
  if (routeShapesMode() !== "compare") return false;
  if (constraints?.routeShapes === "single") return false;
  if (constraints?.routePreference === "fewest-signatures") return false;
  return true;
}

/** One leg of a shape, before venues are chosen. */
export interface LegSpec {
  readonly kind: "swap" | "bridge";
  readonly input: ResolvedAsset;
  readonly output: ResolvedAsset;
}

export type CompositeShape = Exclude<RouteShape, "single" | "wrap">;

export interface ShapeCandidate {
  readonly shape: CompositeShape;
  /** The token carried across (composites); absent for single-leg shapes. */
  readonly carrier?: CarrierId | "input";
  readonly legs: readonly LegSpec[];
  /** The legs as the person wrote them ("bridge, then swap"): kept as written when chosen. */
  readonly asWritten?: true;
  /** Short label for comparisons ("Via USDC, 3 steps"). */
  readonly label: string;
}

/** A leg's network and destination. */
export function legNetworks(leg: LegSpec): { readonly network: ResolvedAsset["network"]; readonly destinationNetwork: ResolvedAsset["network"] } {
  return { network: leg.input.network, destinationNetwork: leg.output.network };
}

/** Wallet-signed legs of a shape (approvals are not legs). */
export function signedLegs(candidate: Pick<ShapeCandidate, "legs">): number {
  return candidate.legs.length;
}

/** True when a leg of the shape swaps on the destination after the crossing (it needs gas there). */
export function swapsOnArrival(candidate: Pick<ShapeCandidate, "legs">): boolean {
  let crossed = false;
  for (const leg of candidate.legs) {
    if (crossed) return true;
    if (leg.input.network !== leg.output.network) crossed = true;
  }
  return false;
}

/** Same token family (a plain bridge carries it): the same registry group. */
export function sameFamily(a: ResolvedAsset, b: ResolvedAsset): boolean {
  return a.group !== undefined && a.group === b.group;
}

function plural(legs: number): string {
  return legs === 1 ? "1 step" : `${legs} steps`;
}

function carrierLabel(carrier: Carrier): string {
  return carrier.id === "ETH" ? "ETH" : carrier.id;
}

/**
 * Shapes for a crossing `input`@A -> `output`@B. A same-family crossing is a
 * plain bridge (one leg). A token-changing crossing is the one-shot, plus,
 * when composites are allowed, the carrier composites (USDC first, ETH when
 * eligible, USDT0 only without USDC); `asWritten` adds the person's own
 * "bridge, then swap" legs (merge case, rule C.1.5) when it is not one of them.
 */
export function enumerateShapes(
  input: ResolvedAsset,
  output: ResolvedAsset,
  options: { readonly composites: boolean; readonly asWritten?: readonly LegSpec[] } = { composites: false },
): ShapeCandidate[] {
  if (input.network === output.network) return [];
  if (sameFamily(input, output)) return [{ shape: "bridge", legs: [{ kind: "bridge", input, output }], label: "Bridge, 1 step" }];
  const shapes: ShapeCandidate[] = [{ shape: "one-shot", legs: [{ kind: "bridge", input, output }], label: "One cross-network swap, 1 step" }];
  if (!options.composites) return shapes;
  const seen = new Set<string>([legKey(shapes[0]?.legs ?? [])]);
  const add = (candidate: ShapeCandidate) => {
    const key = legKey(candidate.legs);
    if (seen.has(key)) return;
    seen.add(key);
    shapes.push(candidate);
  };
  if (options.asWritten && options.asWritten.length > 0) {
    add({
      shape: shapeOfLegs(options.asWritten),
      carrier: "input",
      legs: options.asWritten,
      asWritten: true,
      label: `As written, ${plural(options.asWritten.length)}`,
    });
  }
  for (const carrier of carriersFor(input, output)) {
    const legs: LegSpec[] = [];
    const startsAsCarrier = isCarrierToken(input, carrier.source);
    const endsAsCarrier = isCarrierToken(output, carrier.destination);
    if (!startsAsCarrier) legs.push({ kind: "swap", input, output: carrier.source });
    legs.push({ kind: "bridge", input: carrier.source, output: carrier.destination });
    if (!endsAsCarrier) legs.push({ kind: "swap", input: carrier.destination, output });
    if (legs.length < 2) continue;
    // A leg that would swap a token into itself is no shape (the carrier is the input's own family).
    if (legs.some((leg) => leg.kind === "swap" && sameAsset(leg.input, leg.output))) continue;
    add({ shape: shapeOfLegs(legs), carrier: carrier.id, legs, label: `Via ${carrierLabel(carrier)}, ${plural(legs.length)}` });
  }
  return shapes;
}

/** The shape name of a leg list. */
export function shapeOfLegs(legs: readonly LegSpec[]): CompositeShape {
  const kinds = legs.map((leg) => (leg.input.network === leg.output.network ? "swap" : "bridge")).join("-");
  switch (kinds) {
    case "bridge":
      return sameFamily(legs[0]?.input as ResolvedAsset, legs[0]?.output as ResolvedAsset) ? "bridge" : "one-shot";
    case "bridge-swap":
      return "bridge-swap";
    case "swap-bridge":
      return "swap-bridge";
    default:
      return "swap-bridge-swap";
  }
}

function legKey(legs: readonly LegSpec[]): string {
  return legs.map((leg) => `${leg.kind}:${leg.input.id.toLowerCase()}>${leg.output.id.toLowerCase()}`).join("|");
}
