import { normalizeBaseProtocolId } from "./protocols.js";

export interface ProtocolIdentifiedRoute {
  readonly protocolId?: unknown;
}

export interface ProtocolExclusionEvidence {
  readonly excludedProtocolIds: readonly string[];
  readonly candidateRouteCount: number;
  readonly excludedRouteCount: number;
  readonly eligibleRouteCount: number;
}

const PROTOCOL_EXCLUSION_FAMILIES: Readonly<
  Record<string, ReadonlySet<string>>
> = Object.freeze({
  moonwell: new Set(["moonwell", "moonwell-vault", "moonwell-safety-module"]),
  "seamless-staking": new Set(["seamless-staking", "seamless-vault"]),
  "morpho-blue": new Set([
    "morpho-blue",
    "moonwell-vault",
    "seamless-vault",
    "spark-vault",
    "fluid-vault",
  ]),
});

function protocolConstraintError(code: string, message: string): Error {
  return Object.assign(new Error(message), {
    code,
    statusCode: 400,
  });
}

export function normalizeExcludedBaseProtocols(
  values: readonly string[] | undefined,
): string[] {
  if (!values || values.length === 0) return [];
  const normalized = values.map((value) => {
    if (typeof value !== "string") {
      throw protocolConstraintError(
        "INVALID_PROTOCOL_EXCLUSION",
        "Excluded protocol list contains an invalid value.",
      );
    }
    const protocolId = normalizeBaseProtocolId(value.trim());
    if (!protocolId) {
      throw protocolConstraintError(
        "INVALID_PROTOCOL_EXCLUSION",
        "Excluded protocol must be explicit and verifiable.",
      );
    }
    return protocolId;
  });
  return [...new Set(normalized)].sort();
}

export function isBaseProtocolExcluded(
  protocolId: string,
  excludedProtocolIds: readonly string[],
): boolean {
  const normalizedProtocol = normalizeBaseProtocolId(protocolId);
  if (!normalizedProtocol) return false;
  return excludedProtocolIds.some((excluded) => {
    if (excluded === normalizedProtocol) return true;
    return (
      PROTOCOL_EXCLUSION_FAMILIES[excluded]?.has(normalizedProtocol) === true
    );
  });
}

export function assertBaseProtocolConstraintCompatibility(
  requestedProtocol: string | undefined,
  excludedProtocols: readonly string[] | undefined,
): string[] {
  const excludedProtocolIds = normalizeExcludedBaseProtocols(excludedProtocols);
  const normalizedRequested = normalizeBaseProtocolId(requestedProtocol);
  if (
    normalizedRequested &&
    isBaseProtocolExcluded(normalizedRequested, excludedProtocolIds)
  ) {
    throw protocolConstraintError(
      "PROTOCOL_CONSTRAINT_CONFLICT",
      `The requested ${normalizedRequested} protocol is excluded in the same intent; no transaction route was prepared.`,
    );
  }
  return excludedProtocolIds;
}

export function applyBaseProtocolExclusions<T extends ProtocolIdentifiedRoute>(
  routes: readonly T[],
  excludedProtocolIds: readonly string[],
): {
  readonly routes: T[];
  readonly evidence: ProtocolExclusionEvidence;
} {
  if (excludedProtocolIds.length === 0) {
    return {
      routes: [...routes],
      evidence: {
        excludedProtocolIds: [],
        candidateRouteCount: routes.length,
        excludedRouteCount: 0,
        eligibleRouteCount: routes.length,
      },
    };
  }

  const eligible: T[] = [];
  let excludedRouteCount = 0;
  for (const route of routes) {
    if (
      typeof route.protocolId !== "string" ||
      !normalizeBaseProtocolId(route.protocolId)
    ) {
      throw protocolConstraintError(
        "ROUTE_PROTOCOL_EVIDENCE_REQUIRED",
        "A route does not carry a verified protocolId while applying the protocol exclusion rule.",
      );
    }
    if (isBaseProtocolExcluded(route.protocolId, excludedProtocolIds)) {
      excludedRouteCount += 1;
    } else {
      eligible.push(route);
    }
  }

  return {
    routes: eligible,
    evidence: {
      excludedProtocolIds: [...excludedProtocolIds],
      candidateRouteCount: routes.length,
      excludedRouteCount,
      eligibleRouteCount: eligible.length,
    },
  };
}

export function assertProtocolExclusionsLeaveEligibleRoutes(
  evidence: ProtocolExclusionEvidence,
  routeKind: string,
): void {
  if (evidence.candidateRouteCount > 0 && evidence.eligibleRouteCount === 0) {
    throw protocolConstraintError(
      "NO_ROUTE_AFTER_PROTOCOL_EXCLUSIONS",
      `All routes found for ${routeKind} were eliminated by the open protocol exclusion rule; no transaction was prepared.`,
    );
  }
}
