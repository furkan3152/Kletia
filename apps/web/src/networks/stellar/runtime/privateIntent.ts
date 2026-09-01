import {
  beginEgressGuardObservation,
  registerPrivateField,
  resetPrivateFields,
} from "../../../shared/privacy/egressGuard";
import {
  assertConfidentialSurfaceOpen,
  readConfidentialSurfaceReport,
  type ConfidentialSurfaceReportV1,
} from "../../../shared/privacy/confidentialSurfaceGate";
import {
  buildClientIntentEnvelope,
  CLIENT_INTENT_SCENARIOS,
  findClientIntentScenario,
  type ClientIntentScenarioV1,
} from "../../../shared/privacy/intentGrammarClient";
export { redactSemanticContext } from "../../../shared/privacy/semanticRedaction";

const ARC_TO_ARBITRUM_SCENARIO =
  "arc_testnet_usdc_to_arbitrum_sepolia_aave_supply";

export type PrivateIntentScenarioId =
  | "arc_testnet_usdc_to_arbitrum_sepolia_aave_supply"
  | "stellar_testnet_usdc_policy_anchored_transfer"
  | "stellar_testnet_usdc_path_payment"
  | "stellar_testnet_usdc_confidential_treasury";

export type PrivateIntentRoutePreference =
  | "auto"
  | "direct_cctp"
  | "stellar_centered_public";

export type PrivateIntentExecutionReadiness =
  | "executable"
  | "shadow_only"
  | "integration_incomplete";

export interface PrivateIntentClarificationOptionV1 {
  readonly id: string;
  readonly kind: "scenario" | "route";
  readonly scenarioId: PrivateIntentScenarioId;
  readonly routePreference?: PrivateIntentRoutePreference;
  readonly label: string;
  readonly selectable: boolean;
  readonly executionReadiness: PrivateIntentExecutionReadiness;
  readonly publicEffect: string;
  readonly confidentialEffect: string;
  readonly runtimeEffect: string;
  readonly keywordEvidence: readonly string[];
}

export interface PrivateIntentClarificationV1 {
  readonly schemaVersion: "kletia_private_intent_clarification_v1";
  readonly kind: "scenario" | "route";
  readonly question: string;
  readonly whyAsked: string;
  readonly options: readonly PrivateIntentClarificationOptionV1[];
}

export type PrivateIntentResolutionV1 =
  | {
      readonly status: "resolved";
      readonly scenarioId: PrivateIntentScenarioId;
      readonly routePreference: PrivateIntentRoutePreference;
      readonly keywordEvidence: readonly string[];
    }
  | {
      readonly status: "clarification";
      readonly clarification: PrivateIntentClarificationV1;
    };

const utf8 = new TextEncoder();

function bytesToHex(bytes: Uint8Array): `0x${string}` {
  return `0x${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

export function normalizePrivateAmount(value: string): string {
  const amount = value.trim();
  if (!/^(?:\d+\.?\d*|\.\d+)$/u.test(amount)) {
    throw new Error("Enter a positive USDC amount with at most six decimals.");
  }
  const [whole = "0", fraction = ""] = amount.split(".");
  if (
    fraction.length > 6 ||
    BigInt(`${whole || "0"}${fraction.padEnd(6, "0")}`) <= 0n
  ) {
    throw new Error("Enter a positive USDC amount with at most six decimals.");
  }
  return `${BigInt(whole || "0").toString()}${
    fraction ? `.${fraction.replace(/0+$/u, "")}` : ""
  }`.replace(/\.$/u, "");
}

/**
 * Hands the device-private material to EgressGuardV1 so registered V2-field
 * egress becomes an observed-session measurement instead of a design
 * intention. This does not cover legacy intents or standalone Stellar tools.
 *
 * Only the amount and its salt are guarded, and that asymmetry is deliberate.
 * In this route the recipient is the user's own already-public EVM wallet
 * binding, which the deterministic compiler legitimately receives and which the
 * public CCTP message encodes on-chain regardless. Registering it would block
 * the correct request while protecting nothing, so `WorkflowPlanV2` reports it
 * honestly as `recipientReceivedAsPublicWalletBinding` rather than pretending it
 * is confidential. The amount, by contrast, must never leave the device in raw
 * form during planning.
 */
function guardPrivateMaterial(
  field: "amount" | "recipient",
  value: string,
  salt: Uint8Array,
): void {
  if (field !== "amount") return;
  registerPrivateField("amount", value);
  // The salt opens the commitment. If it leaked alongside the commitment, the
  // exact amount would become derivable by anyone who could guess a candidate.
  registerPrivateField("opening", bytesToHex(salt));
}

export function forgetPrivateFieldGuards(): void {
  resetPrivateFields();
}

export function beginPrivateIntentObservation(): void {
  beginEgressGuardObservation();
}

export async function commitPrivateField(
  field: "amount" | "recipient",
  value: string,
  salt: Uint8Array,
): Promise<`0x${string}`> {
  guardPrivateMaterial(field, value, salt);
  const payload = [
    "KLETIA_PRIVATE_FIELD_V1",
    "stellar:testnet",
    field,
    value.trim(),
    bytesToHex(salt),
  ].join("\u001f");
  const digest = await crypto.subtle.digest("SHA-256", utf8.encode(payload));
  return bytesToHex(new Uint8Array(digest));
}

export function createPrivateSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

export function privateSaltToHex(salt: Uint8Array): `0x${string}` {
  if (salt.length !== 32) throw new Error("Private field salt is invalid.");
  return bytesToHex(salt);
}

export function privateSaltFromHex(value: string): Uint8Array {
  if (!/^0x[a-f\d]{64}$/iu.test(value)) {
    throw new Error("Private field salt is invalid.");
  }
  const output = new Uint8Array(32);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16);
  }
  return output;
}

/**
 * Reports whether this browser realm could host a confidential lane at all.
 *
 * The UI uses this to label the ledger-confidentiality control honestly instead
 * of offering a toggle that would fail at signing time.
 */
export function readPrivateIntentConfidentialSurface(): ConfidentialSurfaceReportV1 {
  return readConfidentialSurfaceReport();
}

/** Scenarios the device is allowed to express, for UI enumeration. */
export function listPrivateIntentScenarios(): readonly ClientIntentScenarioV1[] {
  return CLIENT_INTENT_SCENARIOS;
}

/**
 * Keyword evidence that a free-form goal plausibly refers to a scenario.
 *
 * This is a routing hint, not a parser. The envelope is always generated from
 * the registry entry, so a wrong guess produces a refusal rather than a wrong
 * transaction. Matching stays on the device because the free-form wording itself
 * must never cross the boundary.
 */
interface KeywordEvidenceGroup {
  readonly label: string;
  readonly pattern: RegExp;
}

const SCENARIO_KEYWORD_EVIDENCE: Readonly<
  Record<PrivateIntentScenarioId, readonly KeywordEvidenceGroup[]>
> = {
  arc_testnet_usdc_to_arbitrum_sepolia_aave_supply: [
    { label: "Arc source", pattern: /\barc\b/iu },
    { label: "Arbitrum destination", pattern: /\barbitrum\b/iu },
    { label: "USDC asset", pattern: /\busdc\b/iu },
    {
      label: "Aave supply outcome",
      pattern: /\b(?:aave|lend|lending|supply|deposit|yatır|yatir)\b/iu,
    },
  ],
  stellar_testnet_usdc_policy_anchored_transfer: [
    { label: "Stellar network", pattern: /\bstellar\b/iu },
    { label: "USDC asset", pattern: /\busdc\b/iu },
    {
      label: "Transfer outcome",
      pattern: /\b(?:transfer|send|gönder|gonder|öde|ode)\b/iu,
    },
    {
      label: "Policy anchor",
      pattern: /\b(?:policy|politika|budget|bütçe|butce|disclosure)\b/iu,
    },
  ],
  stellar_testnet_usdc_path_payment: [
    { label: "Stellar network", pattern: /\bstellar\b/iu },
    {
      label: "Path-payment outcome",
      pattern: /\b(?:path|route|rota|swap|takas|çevir|cevir)\b/iu,
    },
  ],
  stellar_testnet_usdc_confidential_treasury: [
    { label: "Stellar network", pattern: /\bstellar\b/iu },
    {
      label: "Ledger confidentiality request",
      pattern:
        /\b(?:confidential|hidden\s+(?:amount|balance)|private\s+(?:transfer|treasury|ledger)|gizli\s+(?:tutar|bakiye|transfer))\b/iu,
    },
  ],
};

const SCENARIO_PRESENTATION: Readonly<
  Record<
    PrivateIntentScenarioId,
    Omit<
      PrivateIntentClarificationOptionV1,
      "id" | "kind" | "scenarioId" | "keywordEvidence"
    >
  >
> = {
  arc_testnet_usdc_to_arbitrum_sepolia_aave_supply: {
    label: "Arc USDC → Arbitrum Sepolia Aave supply",
    selectable: true,
    executionReadiness: "executable",
    publicEffect:
      "The opened amount, wallet bindings and timing are public on the CCTP and Aave checkpoints.",
    confidentialEffect:
      "The exact amount stays device-local during planning; this does not hide public settlement.",
    runtimeEffect:
      "Compiles only while live CCTP, checkpoint-store and Aave readiness gates pass.",
  },
  stellar_testnet_usdc_policy_anchored_transfer: {
    label: "Stellar USDC transfer with policy anchor",
    selectable: false,
    executionReadiness: "shadow_only",
    publicEffect:
      "The Stellar transfer amount, recipient and timing would remain public.",
    confidentialEffect:
      "A policy commitment limits disclosure rules but does not hide the transfer.",
    runtimeEffect:
      "The Testnet registry is deployed and runtime-attested, but this standalone transfer scenario remains read-only until its exact transfer call and receipt lifecycle are bound into the unified compiler.",
  },
  stellar_testnet_usdc_path_payment: {
    label: "Stellar USDC path payment",
    selectable: false,
    executionReadiness: "shadow_only",
    publicEffect:
      "The path, amounts and recipient would be visible on the Stellar ledger.",
    confidentialEffect:
      "Local planning isolation does not make the path payment confidential.",
    runtimeEffect:
      "Read-only scenario until quote comparison is bound to an enforcing simulation.",
  },
  stellar_testnet_usdc_confidential_treasury: {
    label: "Private USDC cross-chain corridor",
    selectable: false,
    executionReadiness: "integration_incomplete",
    publicEffect:
      "Deposit, withdrawal, addresses and timing would still expose public metadata.",
    confidentialEffect:
      "Kletia integrates the official unaudited XLM Testnet privacy pool as a separate browser-only surface. It does not provide a USDC pool, private CCTP exit or hidden Aave execution.",
    runtimeEffect:
      "The requested private cross-chain corridor is incomplete and never signable; Kletia will not downgrade it to a public transfer.",
  },
};

const ROUTE_KEYWORD_EVIDENCE: Readonly<
  Record<"direct_cctp" | "stellar_centered_public" | "confidential", readonly KeywordEvidenceGroup[]>
> = {
  direct_cctp: [
    {
      label: "Direct CCTP route",
      pattern:
        /\b(?:direct(?:ly)?|direct\s+cctp|skip\s+stellar|without\s+stellar|doğrudan|direkt)\b/iu,
    },
  ],
  stellar_centered_public: [
    { label: "Stellar route", pattern: /\bstellar\b/iu },
    {
      label: "Public policy checkpoint",
      pattern:
        /\b(?:checkpoint|policy\s+(?:center|centre)|settlement\s+(?:center|centre)|via\s+stellar|through\s+stellar|stellar\s+üzerinden)\b/iu,
    },
  ],
  confidential: [
    {
      label: "Confidential settlement route",
      pattern:
        /\b(?:confidential|hidden\s+(?:amount|balance)|private\s+(?:bridge|ledger|settlement)|gizli\s+(?:tutar|bakiye|köprü|kopru))\b/iu,
    },
  ],
};

function matchedEvidence(
  goal: string,
  groups: readonly KeywordEvidenceGroup[],
): readonly string[] {
  return groups
    .filter((group) => group.pattern.test(goal))
    .map((group) => group.label);
}

function scenarioOption(
  scenarioId: PrivateIntentScenarioId,
  keywordEvidence: readonly string[],
): PrivateIntentClarificationOptionV1 {
  return {
    id: `scenario:${scenarioId}`,
    kind: "scenario",
    scenarioId,
    ...SCENARIO_PRESENTATION[scenarioId],
    keywordEvidence,
  };
}

function scenarioClarification(
  goal: string,
  whyAsked: string,
): PrivateIntentClarificationV1 {
  return {
    schemaVersion: "kletia_private_intent_clarification_v1",
    kind: "scenario",
    question: "Which reviewed outcome should Kletia compile?",
    whyAsked,
    options: (Object.keys(SCENARIO_PRESENTATION) as PrivateIntentScenarioId[]).map(
      (scenarioId) =>
        scenarioOption(
          scenarioId,
          matchedEvidence(goal, SCENARIO_KEYWORD_EVIDENCE[scenarioId]),
        ),
    ),
  };
}

export function createPrivateIntentRouteClarification(input: {
  scenarioId: PrivateIntentScenarioId;
  whyAsked: string;
}): PrivateIntentClarificationV1 {
  const scenario = SCENARIO_PRESENTATION[input.scenarioId];
  const routeOption = (
    routePreference: PrivateIntentRoutePreference,
    label: string,
    publicEffect: string,
    runtimeEffect: string,
  ): PrivateIntentClarificationOptionV1 => ({
    id: `route:${routePreference}`,
    kind: "route",
    scenarioId: input.scenarioId,
    routePreference,
    label,
    selectable: scenario.selectable,
    executionReadiness: scenario.executionReadiness,
    publicEffect,
    confidentialEffect:
      "Exact fields stay device-local during planning, but every selected ledger checkpoint is public.",
    runtimeEffect,
    keywordEvidence: [],
  });
  return {
    schemaVersion: "kletia_private_intent_clarification_v1",
    kind: "route",
    question: "Which public settlement route should the compiler bind?",
    whyAsked: input.whyAsked,
    options: [
      routeOption(
        "auto",
        "Auto · reviewed cost, risk and disclosure",
        "The winning live route determines which public ledgers learn the amount and wallet bindings.",
        "Ranks only live candidates; it never adds a Stellar hop without a measurable policy benefit.",
      ),
      routeOption(
        "direct_cctp",
        "Direct Arc → Arbitrum Sepolia",
        "The amount, wallets and timing are public on Arc, Circle and Arbitrum; Stellar observes no checkpoint.",
        "Lowest step count, subject to live direct-CCTP and Aave readiness.",
      ),
      routeOption(
        "stellar_centered_public",
        "Stellar public policy corridor",
        "Two public CCTP legs expose the selected tranche on Arc, Stellar and Arbitrum.",
        "Requires a connected Freighter account and live Stellar contract pins; never presented as confidential.",
      ),
      {
        id: "route:stellar_confidential",
        kind: "route",
        scenarioId: "stellar_testnet_usdc_confidential_treasury",
        label: "Stellar confidential corridor",
        selectable: false,
        executionReadiness: "integration_incomplete",
        publicEffect:
          "A future confidential lane would still expose bridge entry, exit, addresses and timing.",
        confidentialEffect:
          "The pinned XLM Testnet pool provides real in-pool privacy. It cannot hide CCTP or destination-chain execution and has no USDC pool.",
        runtimeEffect:
          "Private cross-chain execution is incomplete and never signable; selecting it cannot fall back to a public route.",
        keywordEvidence: [],
      },
    ],
  };
}

export function resolvePrivateIntentSelection(input: {
  prompt: string;
  scenarioId?: string;
  routePreference?: PrivateIntentRoutePreference;
}): PrivateIntentResolutionV1 {
  const goal = input.prompt.normalize("NFKC").trim();
  if (!goal) {
    return {
      status: "clarification",
      clarification: scenarioClarification(
        goal,
        "No semantic goal was provided, so choosing a financial workflow would require guessing.",
      ),
    };
  }

  let scenarioId: PrivateIntentScenarioId;
  let evidence: readonly string[];
  if (input.scenarioId) {
    if (
      !Object.prototype.hasOwnProperty.call(
        SCENARIO_PRESENTATION,
        input.scenarioId,
      )
    ) {
      return {
        status: "clarification",
        clarification: scenarioClarification(
          goal,
          "The previously selected scenario is not in the reviewed device registry.",
        ),
      };
    }
    scenarioId = input.scenarioId as PrivateIntentScenarioId;
    evidence = matchedEvidence(goal, SCENARIO_KEYWORD_EVIDENCE[scenarioId]);
  } else {
    const matches = (Object.keys(
      SCENARIO_KEYWORD_EVIDENCE,
    ) as PrivateIntentScenarioId[])
      .map((candidate) => ({
        scenarioId: candidate,
        evidence: matchedEvidence(
          goal,
          SCENARIO_KEYWORD_EVIDENCE[candidate],
        ),
        required: SCENARIO_KEYWORD_EVIDENCE[candidate].length,
      }))
      .filter((candidate) => candidate.evidence.length === candidate.required);

    if (matches.length !== 1) {
      return {
        status: "clarification",
        clarification: scenarioClarification(
          goal,
          matches.length > 1
            ? "The goal contains complete keyword evidence for more than one reviewed scenario. Kletia will not choose which funds move by ordering regex matches."
            : "The goal did not provide enough deterministic keyword evidence to bind exactly one reviewed scenario without guessing.",
        ),
      };
    }
    scenarioId = matches[0].scenarioId;
    evidence = matches[0].evidence;
  }

  const presentation = SCENARIO_PRESENTATION[scenarioId];
  if (
    !presentation.selectable ||
    presentation.executionReadiness !== "executable" ||
    !findClientIntentScenario(scenarioId)
  ) {
    return {
      status: "clarification",
      clarification: scenarioClarification(
        goal,
        `${presentation.label} was recognized, but its runtime is ${presentation.executionReadiness.replace("_", " ")}. It is shown for scope clarity and cannot become a signable workflow.`,
      ),
    };
  }

  // Once the user has selected a scenario card, the structured route state wins
  // over free-form wording. Before that selection, deterministic route evidence
  // may resolve one public route or force a structured question.
  if (input.scenarioId) {
    return {
      status: "resolved",
      scenarioId,
      routePreference: input.routePreference ?? "auto",
      keywordEvidence: evidence,
    };
  }

  const directEvidence = matchedEvidence(
    goal,
    ROUTE_KEYWORD_EVIDENCE.direct_cctp,
  );
  const stellarEvidence = matchedEvidence(
    goal,
    ROUTE_KEYWORD_EVIDENCE.stellar_centered_public,
  );
  const confidentialEvidence = matchedEvidence(
    goal,
    ROUTE_KEYWORD_EVIDENCE.confidential,
  );
  const routeMatches: PrivateIntentRoutePreference[] = [];
  if (directEvidence.length === ROUTE_KEYWORD_EVIDENCE.direct_cctp.length) {
    routeMatches.push("direct_cctp");
  }
  if (
    stellarEvidence.length ===
    ROUTE_KEYWORD_EVIDENCE.stellar_centered_public.length
  ) {
    routeMatches.push("stellar_centered_public");
  }
  if (confidentialEvidence.length > 0) {
    return {
      status: "clarification",
      clarification: createPrivateIntentRouteClarification({
        scenarioId,
        whyAsked:
          "The goal requests cross-chain ledger confidentiality. Kletia's separate XLM Testnet privacy pool cannot hide public CCTP or destination DeFi, so choose a clearly public route or use the shielded Stellar payment surface; Kletia will not downgrade silently.",
      }),
    };
  }
  if (routeMatches.length > 1) {
    return {
      status: "clarification",
      clarification: createPrivateIntentRouteClarification({
        scenarioId,
        whyAsked:
          "The goal contains conflicting direct and Stellar-centered route evidence, so the compiler needs an explicit route binding.",
      }),
    };
  }
  const inferredRoute = routeMatches[0];
  if (
    inferredRoute &&
    input.routePreference &&
    input.routePreference !== "auto" &&
    input.routePreference !== inferredRoute
  ) {
    return {
      status: "clarification",
      clarification: createPrivateIntentRouteClarification({
        scenarioId,
        whyAsked:
          "The free-form goal and the selected route control disagree. Confirm the route as structured state before compiling.",
      }),
    };
  }
  return {
    status: "resolved",
    scenarioId,
    routePreference: inferredRoute ?? input.routePreference ?? "auto",
    keywordEvidence: evidence,
  };
}

export function redactPrivatePrompt(input: {
  prompt: string;
  scenarioId?: string;
  routePreference?: PrivateIntentRoutePreference;
  includeBorrowCapacity?: boolean;
  requestLedgerConfidentiality?: boolean;
  toggles?: Readonly<Record<string, boolean>>;
}): string {
  const localGoal = input.prompt.trim();
  if (!localGoal) throw new Error("Describe the intended outcome.");

  // Ledger confidentiality is refused rather than silently downgraded. Two
  // independent conditions must hold before it could ever be requested: Kletia
  // must pin and validate its own holder/verifier/deployment/recovery runtime,
  // and this browser realm must be able to generate a proof at all. Asserting
  // the browser gate here means a
  // deployment that quietly loses cross-origin isolation fails closed instead of
  // continuing to advertise a capability it no longer has.
  if (input.requestLedgerConfidentiality === true) {
    assertConfidentialSurfaceOpen();
    throw new Error(
      "Ledger confidentiality is not available for this public CCTP workflow. Use the separate pinned XLM Testnet privacy-pool surface for in-pool shielded payments; private CCTP, private Aave and a USDC privacy pool are not available.",
    );
  }

  const resolution = resolvePrivateIntentSelection({
    prompt: localGoal,
    scenarioId: input.scenarioId,
    routePreference: input.routePreference,
  });
  if (resolution.status !== "resolved") {
    throw new Error(
      "This intent requires an explicit device-side scenario or route decision before a semantic envelope can be created.",
    );
  }
  const { scenarioId, routePreference } = resolution;

  // Free-form wording never crosses the device boundary. The browser reduces the
  // selected scenario to the byte-exact allowlisted envelope derived from the
  // registry; exact values remain in private slots and are opened only against a
  // public checkpoint.
  const toggles: Record<string, boolean> = { ...input.toggles };
  if (scenarioId === ARC_TO_ARBITRUM_SCENARIO) {
    const stellarCorridorAllowed = routePreference !== "direct_cctp";
    if (
      input.toggles?.stellarPolicyCenter !== undefined &&
      input.toggles.stellarPolicyCenter !== stellarCorridorAllowed
    ) {
      throw new Error(
        "The selected route policy conflicts with the Stellar public-corridor permission. Review the route before compiling a plan.",
      );
    }
    // The legacy field name is retained in the V2 envelope for byte-level
    // compatibility. Its bounded meaning is corridor permission: auto and an
    // explicit Stellar route permit the public corridor; Direct CCTP forbids it.
    // It does not claim that an onchain policy registry is deployed.
    toggles.stellarPolicyCenter = stellarCorridorAllowed;
    toggles.includeBorrowCapacity =
      input.toggles?.includeBorrowCapacity ?? input.includeBorrowCapacity !== false;
  }
  return buildClientIntentEnvelope({ scenarioId, toggles });
}
