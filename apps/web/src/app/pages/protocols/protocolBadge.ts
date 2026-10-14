/**
 * The execution badge on a protocol card: what this deployment does with the
 * venue, read from GET /v1/protocols. Executable (planned and run by Platform
 * API v1), Executable named (a named venue whose transactions run through
 * another protocol, e.g. Raydium through the Jupiter program), Data feed
 * (read for limits and guards), Console only (the Kletia console's own
 * engines, not the API), plus Read only (names, risk screens), Kletia service
 * (a separate service) and Listed (no adapter here). Without live flags (the
 * registry view) no execution badge is printed: the registry cannot know
 * which adapters a deployment runs.
 */
import { isExecutableThroughApi, isOwnContractEntry, surfaceOf } from "../../site/protocolCount.ts";

export type ProtocolBadgeKind = "executable" | "named" | "data" | "read" | "console" | "service" | "listed";

export interface ProtocolBadge {
  readonly kind: ProtocolBadgeKind;
  readonly label: string;
  /** Tooltip and screen-reader text. */
  readonly help: string;
}

interface BadgeInput {
  readonly category?: unknown;
  readonly capabilities?: readonly string[];
  readonly executable?: unknown;
  readonly surface?: unknown;
  readonly execution?: unknown;
  readonly routedVia?: readonly string[];
}

const BADGES: Readonly<Record<ProtocolBadgeKind, ProtocolBadge>> = {
  executable: { kind: "executable", label: "Executable", help: "Planned and built by Platform API v1 on this deployment." },
  named: {
    kind: "named",
    label: "Executable · named",
    help: "Name it in a sentence (\"via raydium\"); its transactions run through the protocol it is routed via.",
  },
  data: { kind: "data", label: "Data feed", help: "Read for prices, Rule Book limits and swap guards. Nothing is executed here." },
  read: { kind: "read", label: "Read only", help: "Kletia reads data here (names, risk screens). Nothing is executed." },
  console: { kind: "console", label: "Console only", help: "Executed by the Kletia console's own engines, not by Platform API v1." },
  service: { kind: "service", label: "Kletia service", help: "Executed by a separate Kletia service, not by Platform API v1." },
  listed: { kind: "listed", label: "Listed", help: "In the registry, but this deployment has no execution adapter for it." },
};

/** Protocol ids this one also runs through (`routedVia`), [] when none or malformed. */
export function routedViaOf(entry: { readonly routedVia?: unknown }): string[] {
  return Array.isArray(entry.routedVia) ? entry.routedVia.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
}

/** The badge for one entry, or null for your own contracts and for the registry view. */
export function protocolBadge(entry: BadgeInput): ProtocolBadge | null {
  if (isOwnContractEntry(entry)) return null;
  const surface = surfaceOf(entry);
  if (surface === "console") return BADGES.console;
  if (surface === "service") return BADGES.service;
  const capabilities = Array.isArray(entry.capabilities) ? entry.capabilities : [];
  const readOnly = capabilities.length > 0 && capabilities.every((capability) => capability === "discover");
  if (entry.category === "data") return BADGES.data;
  if (readOnly) return BADGES.read;
  if (typeof entry.executable !== "boolean" || surface !== "platform") return null;
  if (isExecutableThroughApi(entry)) return routedViaOf(entry).length > 0 ? BADGES.named : BADGES.executable;
  return BADGES.listed;
}

/** "via Jupiter": the names of the protocols an entry is routed through (ids fall back to themselves). */
export function routedViaLabel(entry: { readonly routedVia?: unknown }, nameOf: (id: string) => string | undefined): string | null {
  const names = routedViaOf(entry).map((id) => nameOf(id) ?? id);
  return names.length > 0 ? `via ${names.join(" and ")}` : null;
}
