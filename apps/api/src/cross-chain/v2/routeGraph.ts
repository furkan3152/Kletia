/**
 * RouteGraphV1 — the aggregator core.
 *
 * Before this module the route surface was two hand-written literals inside
 * `compiler.ts`. Both carried `disclosurePenalty: 0` and `disclosureCost: 100`,
 * which meant the one axis Kletia claims to optimise — how much a route reveals
 * and to whom — had *zero* effect on ranking. The comparison table was real, but
 * the privacy term in it was decorative.
 *
 * The graph replaces that with a model:
 *
 *  - A **node** is a `(network, asset)` position. `arc_testnet:USDC` and
 *    `arbitrum_sepolia:aUSDC` are different nodes because holding the Aave
 *    receipt token is a different position from holding the underlying.
 *  - An **edge** is a protocol operation that moves value between two nodes, and
 *    it declares what that operation discloses, to which observer class, at what
 *    latency and failure weight, and how many signable steps it costs.
 *  - A **route** is a simple path through the graph. Adding a protocol is adding
 *    an edge; it is no longer a compiler edit.
 *
 * Two properties are deliberate:
 *
 *  1. **Disclosure is priced per (field, observer) pair, deduplicated across the
 *     whole path.** Ledger observers are per-network, so a route that touches
 *     three ledgers genuinely pays more than one that touches two. Nothing here
 *     rewards Stellar for being Stellar.
 *  2. **Public hops receive no unlinkability credit.** A new sending account on
 *     Stellar does not hide the common workflow, Circle messages, amount or
 *     timing. Without a reviewed mixer, private pool or hidden-amount primitive,
 *     the complete corridor remains correlatable.
 *
 * Stated plainly, because it is the honest result rather than the flattering
 * one: Circle and Kletia observe every CCTP leg, and a multi-ledger observer can
 * correlate the public amount and timing. A Stellar-routed corridor therefore
 * pays for an extra disclosure domain, bridge leg, latency and failure surface;
 * it is selected only for explicit settlement/policy value, never for invented
 * privacy.
 *
 * Not modelled, and therefore not claimed: onchain confidentiality (the
 * official unaudited reference is not a pinned Kletia execution surface), MEV
 * or ordering exposure, and any credit for a user-signed
 * onchain disclosure policy. The last one is deliberately absent until the
 * policy registry exists onchain; there is no placeholder credit for it.
 */

import type {
  PrivacyDisclosure,
  WorkflowRouteCandidateV2,
  WorkflowV2Network,
  WorkflowV2RouteKind,
} from "./types.js";

/** Assets the graph can hold. `aUSDC` is the Aave V3 supply receipt position. */
export type RouteGraphAsset = "USDC" | "XLM" | "aUSDC";

export type RouteGraphNodeId = `${WorkflowV2Network}:${RouteGraphAsset}`;

export type RouteEdgeKind =
  | "cctp_bridge"
  | "aave_supply"
  | "stellar_path_payment";

/**
 * Whether an edge can carry a signable step today.
 *
 *  - `executable` — the runtime can build, verify and seal steps for it.
 *  - `quote_only` — a reviewed read path exists, but no signable execution.
 *  - `integration_incomplete` — an upstream reference may exist, but Kletia has
 *                               no signable implementation; never traversed.
 */
export type RouteEdgeReadiness =
  | "executable"
  | "quote_only"
  | "integration_incomplete";
export type RouteSemanticPlannerV1 =
  | "openrouter_constrained"
  | "deterministic_registry";

/**
 * Observer classes as declared on an edge. `ledger_source` and
 * `ledger_destination` are resolved to concrete per-network ledger observers
 * during scoring, which is what makes an extra hop cost extra disclosure.
 */
export type RouteObserverClass =
  | "kletia_ai"
  | "kletia_api"
  | "circle"
  | "ledger_source"
  | "ledger_destination";

/** A concrete observer after edge expansion. Ledgers are per-network. */
export type RouteObserverId =
  | "kletia_ai"
  | "kletia_api"
  | "circle"
  | `public_ledger:${WorkflowV2Network}`;

export interface RouteEdgeDisclosureV1 {
  readonly field: PrivacyDisclosure["field"];
  readonly observers: readonly RouteObserverClass[];
}

export interface RouteEdgeDefinitionV1 {
  readonly id: string;
  readonly kind: RouteEdgeKind;
  readonly protocol: "cctp_v2" | "aave_v3" | "stellar_classic_dex";
  readonly from: RouteGraphNodeId;
  readonly to: RouteGraphNodeId;
  readonly readiness: RouteEdgeReadiness;
  /** Signable steps this edge contributes, used only for reporting. */
  readonly stepCount: number;
  readonly latencyPenalty: number;
  /** Relative policy weight, not an observed failure probability. */
  readonly failureRiskScore: number;
  readonly failureRiskFactors: readonly string[];
  readonly discloses: readonly RouteEdgeDisclosureV1[];
  /** True when the next public leg uses a different sender identity. */
  readonly reOriginatesIdentity: boolean;
  /**
   * Observers that keep visibility across a re-origination. This is evidence
   * that the route remains linkable, not a source of privacy credit.
   */
  readonly correlatingObservers: readonly RouteObserverId[];
  readonly cctpLeg?: {
    readonly sourceDomain: 26 | 27;
    readonly destinationDomain: 3 | 27;
  };
  readonly rationale: string;
  readonly limitations: readonly string[];
}

/** Weight of learning a field at all. Recipient outranks amount deliberately. */
const FIELD_WEIGHT: Readonly<Record<PrivacyDisclosure["field"], number>> = {
  recipient: 4,
  amount: 3,
  balance: 2,
  timing: 1,
  route: 1,
  wallet_identity: 4,
  workflow_linkage: 4,
  policy_commitment: 2,
  privacy_budget_commitment: 2,
  receipt_hash: 2,
};

/**
 * Weight of a specific observer learning something. The model treats a language
 * model as the most costly observer because that disclosure is the one Kletia
 * claims to prevent, and a public ledger as cheaper per-network because ledger
 * data is already assumed public.
 */
const OBSERVER_WEIGHT: Readonly<Record<string, number>> = {
  kletia_ai: 5,
  kletia_api: 3,
  circle: 3,
  public_ledger: 2,
};

/**
 * Divisor that maps raw disclosure weight onto the same order of magnitude as
 * bridge fees in basis points and the APY credit, so no single term silently
 * dominates the total.
 */
const DISCLOSURE_SCALE = 12;
// Public re-origination is not privacy. This remains zero until a reviewed
// hidden-amount, pool or mixing primitive gives a defensible unlinkability
// guarantee that can be verified by the route engine.
const LEDGER_LINKAGE_CREDIT_RAW = 0;

/**
 * Disclosure that happens during planning regardless of the route, so it is
 * priced once instead of being attributed to an edge.
 */
function planningDisclosureFor(
  semanticPlanner: RouteSemanticPlannerV1,
): readonly {
  readonly field: PrivacyDisclosure["field"];
  readonly observers: readonly RouteObserverId[];
}[] {
  return [{
    field: "route",
    observers:
      semanticPlanner === "deterministic_registry"
        ? ["kletia_api"]
        : ["kletia_ai", "kletia_api"],
  }];
}

export const ROUTE_GRAPH_NODES: readonly {
  readonly id: RouteGraphNodeId;
  readonly network: WorkflowV2Network;
  readonly asset: RouteGraphAsset;
  readonly label: string;
}[] = [
  { id: "arc_testnet:USDC", network: "arc_testnet", asset: "USDC", label: "Arc Testnet USDC" },
  {
    id: "stellar_testnet:USDC",
    network: "stellar_testnet",
    asset: "USDC",
    label: "Stellar Testnet USDC (Circle issuer)",
  },
  { id: "stellar_testnet:XLM", network: "stellar_testnet", asset: "XLM", label: "Stellar Testnet XLM" },
  {
    id: "arbitrum_sepolia:USDC",
    network: "arbitrum_sepolia",
    asset: "USDC",
    label: "Arbitrum Sepolia USDC",
  },
  {
    id: "arbitrum_sepolia:aUSDC",
    network: "arbitrum_sepolia",
    asset: "aUSDC",
    label: "Aave V3 Arbitrum Sepolia USDC supply position",
  },
] as const;

const PUBLIC_CCTP_DISCLOSURE: readonly RouteEdgeDisclosureV1[] = [
  {
    field: "amount",
    observers: ["kletia_api", "circle", "ledger_source", "ledger_destination"],
  },
  { field: "recipient", observers: ["kletia_api", "circle", "ledger_destination"] },
  {
    field: "timing",
    observers: ["kletia_api", "circle", "ledger_source", "ledger_destination"],
  },
];

/**
 * The declared edges.
 *
 * Only operations that exist in this repository are listed. Protocols Kletia has
 * not integrated are absent on purpose: an edge with no runtime behind it would
 * make the graph a marketing surface instead of an execution model.
 */
export const ROUTE_GRAPH_EDGES: readonly RouteEdgeDefinitionV1[] = [
  {
    id: "cctp_arc_usdc_to_arbitrum_sepolia_usdc",
    kind: "cctp_bridge",
    protocol: "cctp_v2",
    from: "arc_testnet:USDC",
    to: "arbitrum_sepolia:USDC",
    readiness: "executable",
    stepCount: 4,
    latencyPenalty: 2,
    failureRiskScore: 22,
    failureRiskFactors: [
      "Circle attestation availability and finality",
      "Two public-chain confirmations",
      "Indeterminate burn recovery",
    ],
    discloses: PUBLIC_CCTP_DISCLOSURE,
    reOriginatesIdentity: false,
    correlatingObservers: ["circle", "kletia_api"],
    cctpLeg: { sourceDomain: 26, destinationDomain: 3 },
    rationale:
      "One Circle burn and mint pair moves the balance with the fewest signable steps.",
    limitations: [
      "A single CCTP message binds the Arc sender to the Arbitrum recipient, so a ledger-only observer can link both sides without correlating a second domain.",
    ],
  },
  {
    id: "cctp_arc_usdc_to_stellar_usdc",
    kind: "cctp_bridge",
    protocol: "cctp_v2",
    from: "arc_testnet:USDC",
    to: "stellar_testnet:USDC",
    readiness: "executable",
    stepCount: 4,
    latencyPenalty: 3,
    failureRiskScore: 24,
    failureRiskFactors: [
      "Circle attestation availability and finality",
      "Stellar Forwarder event verification",
      "Six-to-seven decimal conversion boundary",
    ],
    discloses: PUBLIC_CCTP_DISCLOSURE,
    reOriginatesIdentity: false,
    correlatingObservers: ["circle", "kletia_api"],
    cctpLeg: { sourceDomain: 26, destinationDomain: 27 },
    rationale:
      "Mints through the pinned official Stellar Forwarder identity so settlement lands on the policy ledger before it continues.",
    limitations: [
      "The Stellar mint and the forward are public ledger events; only the planning value stays on the device.",
      "The seventh Stellar decimal is dust-sensitive, so the canonical amount is bound at a ten-times conversion.",
    ],
  },
  {
    id: "cctp_stellar_usdc_to_arbitrum_sepolia_usdc",
    kind: "cctp_bridge",
    protocol: "cctp_v2",
    from: "stellar_testnet:USDC",
    to: "arbitrum_sepolia:USDC",
    readiness: "executable",
    stepCount: 4,
    latencyPenalty: 3,
    failureRiskScore: 14,
    failureRiskFactors: [
      "Circle attestation availability and finality",
      "Stellar authorization and event-archive availability",
      "Seven-to-six decimal conversion boundary",
    ],
    discloses: PUBLIC_CCTP_DISCLOSURE,
    // The burn originates from the Stellar account, but the two public Circle
    // legs remain linkable by workflow identity, amount and timing.
    reOriginatesIdentity: true,
    correlatingObservers: ["circle", "kletia_api"],
    cctpLeg: { sourceDomain: 27, destinationDomain: 3 },
    rationale:
      "Re-originates the transfer from the Stellar account, so the Arbitrum message no longer names the Arc sender.",
    limitations: [
      "Circle and Kletia observe both legs, so re-origination does not unlink the transfer.",
      "Amount and timing correlation across the public ledgers remains possible; this hop earns no privacy credit.",
    ],
  },
  {
    id: "aave_supply_arbitrum_sepolia_usdc",
    kind: "aave_supply",
    protocol: "aave_v3",
    from: "arbitrum_sepolia:USDC",
    to: "arbitrum_sepolia:aUSDC",
    readiness: "executable",
    stepCount: 2,
    latencyPenalty: 0,
    failureRiskScore: 12,
    failureRiskFactors: [
      "Aave reserve, oracle and liquidity state can change before signature",
      "Approval and supply are separate user-authorized checkpoints",
      "Testnet protocol deployments can drift or become unavailable",
    ],
    discloses: [
      { field: "amount", observers: ["kletia_api", "ledger_destination"] },
      { field: "balance", observers: ["kletia_api", "ledger_destination"] },
      { field: "timing", observers: ["kletia_api", "ledger_destination"] },
    ],
    reOriginatesIdentity: false,
    correlatingObservers: ["kletia_api"],
    rationale:
      "Supplies the received USDC into the reviewed Aave V3 reserve and earns the live supply rate.",
    limitations: [
      "The supply position and its balance are public and attributable to the supplying wallet.",
      "Borrow capacity is reported as a read-only theoretical figure; borrowing is not part of this edge.",
    ],
  },
  {
    id: "stellar_path_payment_usdc_to_xlm",
    kind: "stellar_path_payment",
    protocol: "stellar_classic_dex",
    from: "stellar_testnet:USDC",
    to: "stellar_testnet:XLM",
    readiness: "quote_only",
    stepCount: 1,
    latencyPenalty: 1,
    failureRiskScore: 18,
    failureRiskFactors: [
      "Order-book path and destination amount can change before signature",
      "Quote-only execution surface is intentionally unavailable",
    ],
    discloses: [
      { field: "amount", observers: ["kletia_api", "ledger_source"] },
      { field: "recipient", observers: ["kletia_api", "ledger_source"] },
      { field: "route", observers: ["kletia_api", "ledger_source"] },
      { field: "timing", observers: ["kletia_api", "ledger_source"] },
    ],
    reOriginatesIdentity: false,
    correlatingObservers: ["kletia_api"],
    rationale:
      "Strict-send path payment across Stellar Classic order books, currently exposed as a reviewed quote only.",
    limitations: [
      "Quotes are bound to exact intermediate asset identities, but there is no signable execution path in this release.",
      "A router quote comparison is advisory and is not a best-execution guarantee.",
    ],
  },
  {
    id: "stellar_path_payment_xlm_to_usdc",
    kind: "stellar_path_payment",
    protocol: "stellar_classic_dex",
    from: "stellar_testnet:XLM",
    to: "stellar_testnet:USDC",
    readiness: "quote_only",
    stepCount: 1,
    latencyPenalty: 1,
    failureRiskScore: 18,
    failureRiskFactors: [
      "Order-book path and destination amount can change before signature",
      "Quote-only execution surface is intentionally unavailable",
    ],
    discloses: [
      { field: "amount", observers: ["kletia_api", "ledger_source"] },
      { field: "recipient", observers: ["kletia_api", "ledger_source"] },
      { field: "route", observers: ["kletia_api", "ledger_source"] },
      { field: "timing", observers: ["kletia_api", "ledger_source"] },
    ],
    reOriginatesIdentity: false,
    correlatingObservers: ["kletia_api"],
    rationale:
      "Reverse direction of the same reviewed Stellar Classic quote surface.",
    limitations: [
      "Quote only; no signable execution path exists in this release.",
    ],
  },
] as const;

function controlled(code: string, message: string, statusCode = 409): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

function nodeNetwork(id: RouteGraphNodeId): WorkflowV2Network {
  const network = id.split(":")[0] as WorkflowV2Network;
  return network;
}

function expandObserver(
  observer: RouteObserverClass,
  edge: RouteEdgeDefinitionV1,
): RouteObserverId {
  if (observer === "ledger_source") {
    return `public_ledger:${nodeNetwork(edge.from)}`;
  }
  if (observer === "ledger_destination") {
    return `public_ledger:${nodeNetwork(edge.to)}`;
  }
  return observer;
}

function observerWeight(observer: RouteObserverId): number {
  const base = observer.startsWith("public_ledger:") ? "public_ledger" : observer;
  const weight = OBSERVER_WEIGHT[base];
  if (weight === undefined) {
    throw controlled(
      "ROUTE_GRAPH_OBSERVER_UNPRICED",
      `Route graph observer ${observer} has no disclosure weight, so the route cannot be scored.`,
      500,
    );
  }
  return weight;
}

export interface RouteGraphPathV1 {
  readonly edges: readonly RouteEdgeDefinitionV1[];
  readonly nodes: readonly RouteGraphNodeId[];
  readonly networks: readonly WorkflowV2Network[];
  readonly stepCount: number;
}

/**
 * Enumerates simple paths between two nodes.
 *
 * Simple, bounded and exhaustive on purpose: the search space is a reviewed
 * registry of a handful of edges, so there is nothing to gain from a heuristic
 * that could silently drop a cheaper or less disclosing route.
 */
export function findRoutePaths(input: {
  readonly from: RouteGraphNodeId;
  readonly to: RouteGraphNodeId;
  readonly maxEdges?: number;
  readonly readiness?: readonly RouteEdgeReadiness[];
}): readonly RouteGraphPathV1[] {
  const maxEdges = input.maxEdges ?? 4;
  const allowed = new Set(input.readiness ?? ["executable"]);
  const edges = ROUTE_GRAPH_EDGES.filter((edge) => allowed.has(edge.readiness));
  const found: RouteGraphPathV1[] = [];

  const walk = (
    current: RouteGraphNodeId,
    visited: readonly RouteGraphNodeId[],
    used: readonly RouteEdgeDefinitionV1[],
  ) => {
    if (current === input.to && used.length > 0) {
      const networks: WorkflowV2Network[] = [];
      for (const node of visited) {
        const network = nodeNetwork(node);
        if (!networks.includes(network)) networks.push(network);
      }
      found.push({
        edges: used,
        nodes: visited,
        networks,
        stepCount: used.reduce((total, edge) => total + edge.stepCount, 0),
      });
      return;
    }
    if (used.length >= maxEdges) return;
    for (const edge of edges) {
      if (edge.from !== current) continue;
      if (visited.includes(edge.to)) continue;
      walk(edge.to, [...visited, edge.to], [...used, edge]);
    }
  };

  walk(input.from, [input.from], []);
  return found;
}

export interface RouteDisclosureProfileV1 {
  readonly schemaVersion: "kletia_route_disclosure_profile_v1";
  readonly rawWeight: number;
  readonly scale: number;
  readonly pairs: readonly {
    readonly field: PrivacyDisclosure["field"];
    readonly observer: RouteObserverId;
    readonly weight: number;
  }[];
  readonly ledgerObservers: readonly RouteObserverId[];
  readonly correlationDomainsRequired: number;
  readonly ledgerLinkageCredit: number;
  readonly netPenalty: number;
  readonly reasoning: string;
  readonly limitations: readonly string[];
}

/**
 * Prices a path's disclosure.
 *
 * Every (field, observer) pair is counted once for the whole path, so a route is
 * not punished twice for revealing the same thing to the same observer, and is
 * not rewarded for revealing it in fewer transactions.
 */
export function priceRouteDisclosure(
  path: RouteGraphPathV1,
  semanticPlanner: RouteSemanticPlannerV1 = "openrouter_constrained",
): RouteDisclosureProfileV1 {
  const seen = new Map<string, { field: PrivacyDisclosure["field"]; observer: RouteObserverId; weight: number }>();
  const record = (field: PrivacyDisclosure["field"], observer: RouteObserverId) => {
    const key = `${field}|${observer}`;
    if (seen.has(key)) return;
    seen.set(key, {
      field,
      observer,
      weight: FIELD_WEIGHT[field] * observerWeight(observer),
    });
  };
  for (const entry of planningDisclosureFor(semanticPlanner)) {
    for (const observer of entry.observers) record(entry.field, observer);
  }
  for (const edge of path.edges) {
    for (const entry of edge.discloses) {
      for (const observer of entry.observers) {
        record(entry.field, expandObserver(observer, edge));
      }
    }
  }
  const pairs = [...seen.values()].sort((left, right) =>
    left.field === right.field
      ? left.observer < right.observer
        ? -1
        : left.observer > right.observer
          ? 1
          : 0
      : left.field < right.field
        ? -1
        : 1,
  );
  const rawWeight = pairs.reduce((total, pair) => total + pair.weight, 0);
  const ledgerObservers = [
    ...new Set(
      pairs
        .map((pair) => pair.observer)
        .filter((observer): observer is `public_ledger:${WorkflowV2Network}` =>
          observer.startsWith("public_ledger:"),
        ),
    ),
  ].sort();
  // Every currently executable edge is public and bound to one Kletia workflow.
  // A different public sending account is not a cryptographic unlinkability
  // primitive, so it cannot increase this number or reduce disclosure cost.
  const correlationDomainsRequired = 1;
  const ledgerLinkageCredit = LEDGER_LINKAGE_CREDIT_RAW;
  const netPenalty = Number(
    ((rawWeight - ledgerLinkageCredit) / DISCLOSURE_SCALE).toFixed(4),
  );
  const reOriginatesPublicIdentity = path.edges.some(
    (edge) => edge.reOriginatesIdentity,
  );
  return {
    schemaVersion: "kletia_route_disclosure_profile_v1",
    rawWeight,
    scale: DISCLOSURE_SCALE,
    pairs,
    ledgerObservers,
    correlationDomainsRequired,
    ledgerLinkageCredit,
    netPenalty,
    reasoning: reOriginatesPublicIdentity
      ? "The route changes its public sending identity on Stellar, but the common workflow, Circle messages, amount and timing remain correlatable. No unlinkability credit is granted."
      : "The public settlement messages expose a directly correlatable route, so no unlinkability credit is granted.",
    limitations: [
      "Disclosure weights are reviewed policy weights, not measured information leakage.",
      "Every current route keeps amounts and timing public on each ledger it touches.",
      "Only a reviewed hidden-amount, mixer or private-pool primitive may earn future unlinkability credit.",
      "No credit is granted for a user-signed onchain disclosure policy, because no policy registry is deployed in this release.",
    ],
  };
}

export interface RouteScoreInputV1 {
  readonly bridgeFeeBps: number;
  readonly apyBps: number;
}

/**
 * The normalized comparison score. Lower is better.
 *
 * `total = bridgeFeeBps + latencyPenalty + failurePenalty + disclosurePenalty
 *          - apyCredit`
 *
 * `disclosurePenalty` is the net figure. Public routes currently receive zero
 * unlinkability credit, so an extra public ledger can only add disclosure cost.
 */
export function scoreRoutePath(
  path: RouteGraphPathV1,
  input: RouteScoreInputV1,
  semanticPlanner: RouteSemanticPlannerV1 = "openrouter_constrained",
): WorkflowRouteCandidateV2["score"] {
  if (
    !Number.isFinite(input.bridgeFeeBps) ||
    input.bridgeFeeBps < 0 ||
    input.bridgeFeeBps > 10_000 ||
    !Number.isFinite(input.apyBps) ||
    input.apyBps < 0 ||
    input.apyBps > 1_000_000
  ) {
    throw controlled(
      "WORKFLOW_ROUTE_METRIC_INVALID",
      "A route fee or APY metric was outside the reviewed numeric boundary.",
      503,
    );
  }
  if (
    path.edges.some(
      (edge) =>
        !Number.isFinite(edge.failureRiskScore) ||
        edge.failureRiskScore <= 0 ||
        edge.failureRiskScore > 100 ||
        edge.failureRiskFactors.length === 0,
    )
  ) {
    throw controlled(
      "WORKFLOW_ROUTE_RISK_UNPRICED",
      "Every route edge must carry a positive, explained policy risk weight.",
      500,
    );
  }
  const disclosure = priceRouteDisclosure(path, semanticPlanner);
  const failureRiskScore = path.edges.reduce(
    (total, edge) => total + edge.failureRiskScore,
    0,
  );
  const latencyPenalty = path.edges.reduce(
    (total, edge) => total + edge.latencyPenalty,
    0,
  );
  const failurePenalty = failureRiskScore / 10;
  const apyCredit = Math.min(input.apyBps / 1_000, 10);
  const total = Number(
    (
      input.bridgeFeeBps +
      latencyPenalty +
      failurePenalty +
      disclosure.netPenalty -
      apyCredit
    ).toFixed(4),
  );
  return {
    methodology: "kletia_normalized_route_score_v2",
    lowerIsBetter: true,
    bridgeFeeBps: input.bridgeFeeBps,
    latencyPenalty,
    failurePenalty,
    disclosurePenalty: disclosure.netPenalty,
    disclosureRawWeight: disclosure.rawWeight,
    ledgerLinkageCredit: disclosure.ledgerLinkageCredit,
    correlationDomainsRequired: disclosure.correlationDomainsRequired,
    disclosureScale: disclosure.scale,
    apyCredit,
    total,
    limitations: [
      "The exact private amount is not available to the server, so fixed gas costs are not amount-normalized here.",
      "This is a normalized policy comparison, not a currency-denominated net-return estimate.",
      "The capped APY credit has no holding-period assumption; every current executable candidate ends at the same Aave reserve, so APY does not distinguish those two corridors.",
      "Testnet duration and failure penalties are policy weights, not guaranteed execution outcomes.",
      "Failure weights are amount-independent route heuristics, not protocol audit scores or failure probabilities.",
      "Disclosure weights are reviewed policy weights, not measured information leakage.",
      "Public Stellar re-origination earns zero unlinkability credit; Circle, Kletia and multi-ledger observers can correlate the legs.",
      "The browser must refresh executable fee and gas evidence before every signature.",
    ],
  };
}

/**
 * Maps a path onto the sealed route kind.
 *
 * The mapping is intentionally structural rather than nominal: a path that
 * settles through the Stellar ledger *is* the Stellar-centred route. If the
 * graph ever produces a shape that does not map, the caller must refuse it
 * rather than invent a kind.
 */
export function routeKindForPath(
  path: RouteGraphPathV1,
): WorkflowV2RouteKind | null {
  const usesStellar = path.networks.includes("stellar_testnet");
  if (usesStellar) return "stellar_centered_public";
  if (path.networks.includes("arc_testnet") && path.networks.includes("arbitrum_sepolia")) {
    return "direct_cctp";
  }
  return null;
}

const ROUTE_LABEL: Readonly<Record<WorkflowV2RouteKind, string>> = {
  direct_cctp: "Direct CCTP",
  stellar_centered_public: "Stellar Settlement Checkpoint",
};

function matchLiveEvidence(
  path: RouteGraphPathV1,
  metrics: {
    readonly direct: WorkflowRouteCandidateV2["liveEvidence"];
    readonly stellar?: WorkflowRouteCandidateV2["liveEvidence"];
  },
): WorkflowRouteCandidateV2["liveEvidence"] {
  const legs = path.edges
    .map((edge) => edge.cctpLeg)
    .filter((leg): leg is NonNullable<RouteEdgeDefinitionV1["cctpLeg"]> => Boolean(leg));
  const signature = legs
    .map((leg) => `${leg.sourceDomain}->${leg.destinationDomain}`)
    .join("|");
  for (const evidence of [metrics.direct, metrics.stellar].filter(
    (candidate): candidate is WorkflowRouteCandidateV2["liveEvidence"] =>
      candidate !== undefined,
  )) {
    const evidenceSignature = evidence.cctpLegs
      .map((leg) => `${leg.sourceDomain}->${leg.destinationDomain}`)
      .join("|");
    if (evidenceSignature === signature) return evidence;
  }
  // Fail closed. A route whose fee legs cannot be bound to observed Circle
  // evidence must never be offered, because its score would be unfounded.
  throw controlled(
    "WORKFLOW_ROUTE_EVIDENCE_MISSING",
    "No observed Circle fee evidence matches the CCTP legs of this graph route.",
    503,
  );
}

/**
 * Derives the offered route candidates from the graph.
 *
 * This replaces the two hand-written literals the compiler used to carry. The
 * candidate set is asserted to be exactly the reviewed kinds, so a future edge
 * cannot quietly widen what a sealed plan may contain.
 */
export function buildRouteCandidatesFromGraph(metrics: {
  readonly direct: WorkflowRouteCandidateV2["liveEvidence"];
  readonly stellar?: WorkflowRouteCandidateV2["liveEvidence"];
}, scope: "all" | "direct_only" = "all",
semanticPlanner: RouteSemanticPlannerV1 = "openrouter_constrained",
): readonly WorkflowRouteCandidateV2[] {
  const paths = findRoutePaths({
    from: "arc_testnet:USDC",
    to: "arbitrum_sepolia:aUSDC",
    maxEdges: 4,
    readiness: ["executable"],
  });
  const candidates: WorkflowRouteCandidateV2[] = [];
  for (const path of paths) {
    const kind = routeKindForPath(path);
    if (!kind) {
      throw controlled(
        "WORKFLOW_ROUTE_GRAPH_UNMAPPED",
        "The route graph produced a path that does not map onto a reviewed route kind.",
        500,
      );
    }
    if (candidates.some((candidate) => candidate.kind === kind)) {
      throw controlled(
        "WORKFLOW_ROUTE_GRAPH_AMBIGUOUS",
        `The route graph produced more than one path for route kind ${kind}.`,
        500,
      );
    }
    if (scope === "direct_only" && kind !== "direct_cctp") continue;
    const liveEvidence = matchLiveEvidence(path, metrics);
    const disclosure = priceRouteDisclosure(path, semanticPlanner);
    const failureRiskScore = path.edges.reduce(
      (total, edge) => total + edge.failureRiskScore,
      0,
    );
    const score = scoreRoutePath(path, {
      bridgeFeeBps: liveEvidence.cctpStandardFeeBps,
      apyBps: liveEvidence.aaveSupplyApyBps,
    }, semanticPlanner);
    candidates.push({
      kind,
      label: ROUTE_LABEL[kind],
      available: true,
      networks: path.networks,
      estimatedDurationSeconds:
        kind === "direct_cctp"
          ? { minimum: 20, maximum: 1_200 }
          : { minimum: 40, maximum: 2_400 },
      privacyGain: "private_intent_only",
      disclosureCost: disclosure.rawWeight,
      failureRiskScore,
      rankingReason:
        kind === "stellar_centered_public"
          ? "Adds an explicit public Stellar settlement/policy checkpoint and a second bridge leg. It does not add unlinkability or confidential settlement."
          : "Fewest signable steps and lowest bridge fee, but one public Circle corridor links the sender to the final recipient.",
      score,
      disclosureProfile: disclosure,
      routeGraph: {
        schemaVersion: "kletia_route_graph_v1",
        edgeIds: path.edges.map((edge) => edge.id),
        traversedNodes: path.nodes,
        stepCount: path.stepCount,
      },
      liveEvidence,
    });
  }
  const kinds = candidates.map((candidate) => candidate.kind).sort();
  const expected = scope === "direct_only"
    ? "direct_cctp"
    : ["direct_cctp", "stellar_centered_public"].join(",");
  if (kinds.join(",") !== expected) {
    throw controlled(
      "WORKFLOW_ROUTE_GRAPH_UNEXPECTED",
      "The route graph did not produce the reviewed route candidate set.",
      500,
    );
  }
  // Presentation order is stable and independent of live quotes so that two
  // plans compiled seconds apart are diffable by a human reviewer.
  return [...candidates].sort((left, right) =>
    left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0,
  );
}

/**
 * The public description of the graph.
 *
 * Exposed so a reviewer can read what Kletia believes it can route, and what it
 * only quotes, without inspecting the source. Readiness is reported per edge
 * precisely so that "aggregator" cannot be read as "executes everything".
 */
export function readRouteGraphManifest() {
  return {
    schemaVersion: "kletia_route_graph_v1" as const,
    scoringMethodology: "kletia_normalized_route_score_v2" as const,
    lowerIsBetter: true as const,
    disclosureScale: DISCLOSURE_SCALE,
    ledgerLinkageCreditRawWeight: 0,
    fieldWeights: FIELD_WEIGHT,
    observerWeights: OBSERVER_WEIGHT,
    nodes: ROUTE_GRAPH_NODES,
    edges: ROUTE_GRAPH_EDGES.map((edge) => ({
      id: edge.id,
      kind: edge.kind,
      protocol: edge.protocol,
      from: edge.from,
      to: edge.to,
      readiness: edge.readiness,
      stepCount: edge.stepCount,
      latencyPenalty: edge.latencyPenalty,
      failureRiskScore: edge.failureRiskScore,
      failureRiskFactors: edge.failureRiskFactors,
      reOriginatesIdentity: edge.reOriginatesIdentity,
      correlatingObservers: edge.correlatingObservers,
      discloses: edge.discloses,
      rationale: edge.rationale,
      limitations: edge.limitations,
    })),
    executablePathCount: findRoutePaths({
      from: "arc_testnet:USDC",
      to: "arbitrum_sepolia:aUSDC",
      maxEdges: 4,
      readiness: ["executable"],
    }).length,
    limitations: [
      "An edge describes a reviewed operation, not a guarantee: only edges marked executable can carry a signable step.",
      "Quote-only edges are readable comparison surfaces with no execution path in this release.",
      "Disclosure and failure weights are reviewed policy weights, not measurements.",
      "Failure weights are positive, explained and amount-independent; they are not protocol audit scores or observed failure probabilities.",
      "The current executable routes share one Aave destination, so the live APY term is identical and does not distinguish them.",
      "Fixed gas and holding-period-adjusted yield are excluded until the browser opens the private amount for pre-signature hydration.",
      "Public Stellar hops receive no unlinkability credit; amount, timing and workflow correlation remain public.",
      "The graph models value movement and disclosure; it does not model ordering or MEV exposure.",
      "Onchain confidentiality is not modelled in this public cross-chain graph. Kletia's separate pinned XLM Testnet privacy-pool surface hides in-pool value and recipient-output links, but it has no USDC pool, private bridge or hidden destination-DeFi execution.",
    ],
  };
}
