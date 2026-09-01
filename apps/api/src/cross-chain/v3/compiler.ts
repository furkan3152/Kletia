import { createHash, randomUUID } from "node:crypto";
import { getAddress } from "viem";
import { StrKey } from "@stellar/stellar-sdk";
import { ASSETS_V3, CHAINS_V3, assertSingleLane, assetFor, chainByKey } from "./chains.js";
import { capabilityById } from "./capabilities.js";
import { STELLAR_TESTNET } from "../../networks/stellar/config.js";
import { isStellarPolicyVerifierArtifactConfigurationComplete } from "../../networks/stellar/controlPlaneReadiness.js";
import type {
  AddressRef,
  AssetRef,
  Bn254ScalarHex,
  ChainRef,
  DisclosureDeltaV3,
  DisclosureLevel,
  IntentIRV3,
  IntentLegV3,
  IntentOperationV3,
  PrivacyBudgetV3,
  PrivacyField,
  RouteCandidateV3,
  SensitiveFieldBindingV3,
  WorkflowPlanV3,
  WorkflowStepV3,
} from "./types.js";

const HASH_PATTERN = /^0x[a-f\d]{64}$/iu;
const PRIVATE_REFERENCE_PATTERN = /^private:\/\/[a-z][a-z\d_-]{2,63}$/u;
const FORBIDDEN_PRIVATE_KEYS = new Set([
  "amount",
  "amountatomic",
  "exactamount",
  "recipient",
  "budget",
  "balance",
  "strategy",
  "privatevalue",
  "opening",
  "blind",
  "salt",
  "witness",
  "recoveryroot",
]);
// The browser policy proof uses a 720-ledger execution window (roughly one
// hour). The off-chain plan must not expire ten minutes into that on-chain
// policy while a CCTP attestation is still in flight. Short-lived quotes remain
// independently capped and refreshed before every burn.
const COMPILE_TTL_MS = 60 * 60 * 1_000;
const BN254_SCALAR_FIELD_MODULUS = BigInt(
  "0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001",
);

function controlled(code: string, message: string, statusCode = 400): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

function canonical(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>)
          .filter(([, nested]) => nested !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, normalize(nested)]),
      );
    }
    return entry;
  };
  return JSON.stringify(normalize(value));
}

function hash(domain: string, value: unknown): `0x${string}` {
  return `0x${createHash("sha256")
    .update(domain, "utf8")
    .update("\u001f", "utf8")
    .update(canonical(value), "utf8")
    .digest("hex")}`;
}

/**
 * Maps a deterministic public manifest into the BN254 scalar field without
 * pretending that SHA-256 is the circuit's Poseidon policy commitment.
 * Workflow roots are public identifiers; policyRoot and nullifier are produced
 * later from the device-private circuit witness.
 */
function hashToBn254Scalar(domain: string, value: unknown): Bn254ScalarHex {
  const digest = BigInt(hash(domain, value));
  const reduced = digest % BN254_SCALAR_FIELD_MODULUS;
  const nonZero = reduced === 0n ? 1n : reduced;
  return `0x${nonZero.toString(16).padStart(64, "0")}`;
}

function workflowRootMaterial(input: {
  readonly workflowId: string;
  readonly requestId: string;
  readonly sourceIntentReceipt: IntentIRV3["sourceIntentReceipt"];
  readonly lane: IntentIRV3["lane"];
  readonly semanticGoal: string;
  readonly legs: readonly IntentLegV3[];
  readonly routeId: string | null;
  readonly routeProtocols: readonly string[];
  readonly planningPolicyCommitment: `0x${string}`;
  readonly privacyBudgetCommitment: `0x${string}`;
  readonly expiresAt: number;
}) {
  return {
    workflowId: input.workflowId,
    requestId: input.requestId,
    sourceIntentReceipt: input.sourceIntentReceipt,
    lane: input.lane,
    semanticGoal: input.semanticGoal,
    legs: input.legs,
    selectedRouteId: input.routeId,
    selectedRouteProtocols: input.routeProtocols,
    planningPolicyCommitment: input.planningPolicyCommitment,
    privacyBudgetCommitment: input.privacyBudgetCommitment,
    expiresAt: input.expiresAt,
  };
}

export function deriveRouteBoundWorkflowRootV3(
  plan: WorkflowPlanV3,
  routeId: string,
): Bn254ScalarHex {
  const route = plan.routes.find((candidate) => candidate.id === routeId);
  if (!route) {
    throw controlled("WORKFLOW_V3_ROUTE_UNKNOWN", "The policy proof selected an unknown workflow route.", 409);
  }
  return hashToBn254Scalar(
    "KLETIA_WORKFLOW_ROOT_FIELD_V3",
    workflowRootMaterial({
      workflowId: plan.workflowId,
      requestId: plan.requestId,
      sourceIntentReceipt: plan.intent.sourceIntentReceipt,
      lane: plan.lane,
      semanticGoal: plan.intent.semanticGoal,
      legs: plan.intent.legs,
      routeId: route.id,
      routeProtocols: route.protocols,
      planningPolicyCommitment: plan.controlPlane.planningPolicyCommitment,
      privacyBudgetCommitment: plan.controlPlane.privacyBudgetCommitment,
      expiresAt: plan.expiresAt,
    }),
  );
}

export function bindLiveRouteHydrationV3(input: {
  readonly plan: WorkflowPlanV3;
  readonly routeId: string;
  readonly hydration: NonNullable<RouteCandidateV3["hydration"]>;
  readonly metrics: RouteCandidateV3["metrics"];
}): WorkflowPlanV3 {
  const { plan } = input;
  if (
    plan.expiresAt <= Date.now() ||
    plan.coordinationMarket.winner ||
    (plan.coordinationMarket.required &&
      plan.coordinationMarket.status !== "auction_open_required")
  ) {
    throw controlled(
      "WORKFLOW_V3_ROUTE_HYDRATION_STATE_INVALID",
      "An expired, opened or selected solver workflow cannot change its live route quote.",
      409,
    );
  }
  const route = plan.routes.find((candidate) => candidate.id === input.routeId);
  if (!route) {
    throw controlled("WORKFLOW_V3_ROUTE_UNKNOWN", "The requested route is not part of this workflow.", 409);
  }
  const amountBinding = plan.intent.privateBindings.find((binding) => binding.field === "amount");
  if (!amountBinding || amountBinding.commitment !== input.hydration.amountCommitment) {
    throw controlled(
      "WORKFLOW_V3_ROUTE_HYDRATION_COMMITMENT_MISMATCH",
      "The live quote did not bind the workflow's protected amount commitment.",
      409,
    );
  }
  const runtimeReady =
    input.hydration.sourceBalanceSufficient &&
    route.steps.every((step) => step.executionReadiness === "ready");
  const { solverRouteHash: _previousSolverRouteHash, ...routeWithoutSolverHash } = route;
  const hydratedRouteBase = {
    ...routeWithoutSolverHash,
    available: runtimeReady,
    unavailableReason: runtimeReady
      ? undefined
      : !input.hydration.sourceBalanceSufficient
        ? "The live Arc USDC balance is insufficient for this protected execution amount."
        : route.unavailableReason ?? "One or more route capabilities are not execution-ready.",
    quoteExpiresAt: input.hydration.quoteExpiresAt,
    hydration: input.hydration,
    metrics: input.metrics,
    steps: route.steps.map((step) =>
      step.protocol === "circle-cctp-v2" && step.operation === "bridge"
        ? { ...step, quoteExpiresAt: input.hydration.quoteExpiresAt }
        : step,
    ),
  } satisfies Omit<RouteCandidateV3, "solverRouteHash"> & { readonly solverRouteHash?: never };
  const hydratedRoute: RouteCandidateV3 = {
    ...hydratedRouteBase,
    solverRouteHash: hash("KLETIA_SOLVER_ROUTE_HYDRATED_V1", {
      id: hydratedRouteBase.id,
      lane: hydratedRouteBase.lane,
      chains: hydratedRouteBase.chains,
      protocols: hydratedRouteBase.protocols,
      quoteExpiresAt: hydratedRouteBase.quoteExpiresAt,
      metrics: hydratedRouteBase.metrics,
      hydration: hydratedRouteBase.hydration,
      steps: hydratedRouteBase.steps.map((step) => ({
        operation: step.operation,
        chain: step.chain.caip2,
        protocol: step.protocol,
        target: step.target ?? null,
        method: step.method ?? null,
        deadline: step.deadline,
      })),
    }),
  };
  const routes = plan.routes.map((candidate) =>
    candidate.id === hydratedRoute.id ? hydratedRoute : candidate,
  );
  const constraintsHash = hash("KLETIA_SOLVER_MARKET_CONSTRAINTS_V1", {
    lane: plan.lane,
    risk: plan.intent.risk,
    gasPolicy: plan.intent.gasPolicy,
    minimumEvidenceLevel: plan.intent.coordination.minimumEvidenceLevel,
    privacyBudgetCommitment: plan.controlPlane.privacyBudgetCommitment,
    candidateRoutes: routes.map((candidate) => ({
      id: candidate.id,
      routeHash: candidate.solverRouteHash,
      chains: candidate.chains,
      protocols: candidate.protocols,
      quoteExpiresAt: candidate.quoteExpiresAt,
      amountDependentCostsComplete: candidate.metrics.amountDependentCostsComplete,
      estimatedOutputAtomic: candidate.metrics.estimatedOutputAtomic,
    })),
  });
  const auctionRoot = hash("KLETIA_SOLVER_AUCTION_ROOT_V1", {
    workflowId: plan.workflowId,
    requestId: plan.requestId,
    lane: plan.lane,
    planningPolicyCommitment: plan.controlPlane.planningPolicyCommitment,
    constraintsHash,
    privateCommitments: plan.intent.privateBindings.map(({ field, commitment }) => ({ field, commitment })),
  });
  return {
    ...plan,
    routes,
    coordinationMarket: {
      ...plan.coordinationMarket,
      auctionRoot,
      constraintsHash,
    },
  };
}

export function assertNoRawPrivateFields(input: unknown): void {
  const seen = new WeakSet<object>();
  const walk = (value: unknown, depth: number): string | null => {
    if (!value || typeof value !== "object" || depth > 16) return null;
    if (seen.has(value)) return null;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const entry of value) {
        const match = walk(entry, depth + 1);
        if (match) return match;
      }
      return null;
    }
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const normalized = key.replace(/[^a-z]/giu, "").toLowerCase();
      if (FORBIDDEN_PRIVATE_KEYS.has(normalized)) return key;
      const match = walk(entry, depth + 1);
      if (match) return match;
    }
    return null;
  };
  const forbidden = walk(input, 0);
  if (forbidden) {
    throw controlled(
      "PRIVATE_FIELD_EGRESS_BLOCKED",
      `${forbidden} is an exact private field. Send a private:// reference and a 32-byte commitment instead.`,
      409,
    );
  }
}

function semanticGoal(value: unknown): string {
  const goal = String(value ?? "").normalize("NFKC").trim();
  if (goal.length < 8 || goal.length > 1_500) {
    throw controlled("SEMANTIC_GOAL_INVALID", "A redacted semantic goal between 8 and 1500 characters is required.");
  }
  if (/0x[a-f\d]{40}|\b[GC][A-Z2-7]{55}\b/iu.test(goal)) {
    throw controlled(
      "SEMANTIC_GOAL_CONTAINS_ADDRESS",
      "Wallet and recipient addresses must be supplied as typed bindings, not inside the semantic prompt.",
      409,
    );
  }
  if (/\b\d+(?:[.,]\d+)?\s*(?:usdc|xlm|eth|eurc|arb|klet)\b/iu.test(goal)) {
    throw controlled(
      "SEMANTIC_GOAL_CONTAINS_AMOUNT",
      "Exact financial amounts must remain in the Private Intent Composer.",
      409,
    );
  }
  return goal;
}

function disclosureLevel(value: unknown, fallback: DisclosureLevel): DisclosureLevel {
  return value === "device_only" || value === "selected_provider" || value === "public_execution"
    ? value
    : fallback;
}

function privacyBudget(value: unknown): PrivacyBudgetV3 {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const defaultLevel = disclosureLevel(input.defaultLevel, "device_only");
  const fieldsInput = input.fields && typeof input.fields === "object"
    ? input.fields as Record<string, unknown>
    : {};
  const fields: Partial<Record<PrivacyField, DisclosureLevel>> = {};
  for (const field of ["amount", "recipient", "balance", "budget", "strategy", "route", "wallet_identity", "timing"] as const) {
    if (fieldsInput[field] !== undefined) fields[field] = disclosureLevel(fieldsInput[field], defaultLevel);
  }
  const approvedProviders = Array.isArray(input.approvedProviders)
    ? [...new Set(input.approvedProviders.map(String).map((provider) => provider.trim()).filter(Boolean))].slice(0, 16)
    : [];
  return {
    schemaVersion: "kletia_privacy_budget_v3",
    defaultLevel,
    fields,
    approvedProviders,
    aiMode: input.aiMode === "deterministic_only" ? "deterministic_only" : "redacted_semantic",
    ledgerMode:
      input.ledgerMode === "stellar_confidential_required"
        ? "stellar_confidential_required"
        : "public",
    failClosed: true,
  };
}

function privateBindings(value: unknown, budget: PrivacyBudgetV3): readonly SensitiveFieldBindingV3[] {
  if (!Array.isArray(value)) return [];
  const bindings = value.map((entry): SensitiveFieldBindingV3 => {
    const candidate = entry as Record<string, unknown>;
    const field = String(candidate.field ?? "");
    const reference = String(candidate.reference ?? "");
    const commitment = String(candidate.commitment ?? "").toLowerCase();
    if (field !== "amount" && field !== "recipient" && field !== "budget") {
      throw controlled("PRIVATE_BINDING_FIELD_INVALID", "Private bindings support amount, recipient and budget fields.");
    }
    if (!PRIVATE_REFERENCE_PATTERN.test(reference) || !HASH_PATTERN.test(commitment)) {
      throw controlled("PRIVATE_BINDING_INVALID", `The ${field} binding requires a private:// reference and 32-byte commitment.`);
    }
    return {
      field,
      reference: reference as `private://${string}`,
      commitment: commitment as `0x${string}`,
      disclosureLevel: disclosureLevel(candidate.disclosureLevel, budget.fields[field] ?? budget.defaultLevel),
    };
  });
  if (new Set(bindings.map((binding) => binding.field)).size !== bindings.length) {
    throw controlled("PRIVATE_BINDING_DUPLICATE", "Each private field may be bound only once.");
  }
  return bindings;
}

function addressBinding(value: unknown, chain: ChainRef): AddressRef {
  const raw = String(value ?? "").trim();
  if (chain.family === "evm") {
    try {
      return { family: "evm", chainId: chain.chainId, address: getAddress(raw) };
    } catch {
      throw controlled("WALLET_BINDING_INVALID", `${chain.key} requires a valid EVM wallet.`);
    }
  }
  if (!StrKey.isValidEd25519PublicKey(raw)) {
    throw controlled("WALLET_BINDING_INVALID", `${chain.key} requires a valid Stellar G-account.`);
  }
  return { family: "stellar", network: chain.network, address: raw };
}

function parseWalletBindings(value: unknown): readonly AddressRef[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const input = value as Record<string, unknown>;
  return Object.entries(input).map(([key, address]) => {
    const chain = chainByKey(key);
    if (!chain) throw controlled("WALLET_CHAIN_INVALID", `Unknown wallet binding network: ${key}.`);
    return addressBinding(address, chain);
  });
}

function operation(value: unknown): IntentOperationV3 {
  const normalized = String(value ?? "").trim().toLowerCase() as IntentOperationV3;
  const allowed: readonly IntentOperationV3[] = [
    "portfolio", "trustline", "transfer", "swap", "bridge", "supply", "withdraw",
    "borrow_capacity", "repay", "path_payment", "vault_deposit",
    "vault_withdraw", "liquidity_add", "liquidity_remove", "data_purchase",
  ];
  if (!allowed.includes(normalized)) {
    throw controlled("INTENT_OPERATION_UNSUPPORTED", `Unsupported intent operation: ${normalized || "missing"}.`);
  }
  return normalized;
}

function parseLegs(value: unknown): readonly IntentLegV3[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 12) {
    throw controlled("INTENT_LEGS_INVALID", "Between one and twelve deterministic intent legs are required.");
  }
  return value.map((entry): IntentLegV3 => {
    const candidate = entry as Record<string, unknown>;
    const chain = chainByKey(candidate.chain);
    if (!chain) throw controlled("INTENT_CHAIN_UNSUPPORTED", `Unsupported network: ${String(candidate.chain ?? "missing")}.`);
    const assetIn = candidate.assetIn ? assetFor(chain, candidate.assetIn) : undefined;
    const assetOut = candidate.assetOut ? assetFor(chain, candidate.assetOut) : undefined;
    if (candidate.assetIn && !assetIn) {
      throw controlled("INTENT_ASSET_UNSUPPORTED", `${String(candidate.assetIn)} is not a reviewed asset on ${chain.key}.`);
    }
    if (candidate.assetOut && !assetOut) {
      throw controlled("INTENT_ASSET_UNSUPPORTED", `${String(candidate.assetOut)} is not a reviewed asset on ${chain.key}.`);
    }
    return {
      operation: operation(candidate.operation),
      chain,
      protocol: typeof candidate.protocol === "string" ? candidate.protocol.trim().toLowerCase() : undefined,
      assetIn: assetIn ?? undefined,
      assetOut: assetOut ?? undefined,
      recipient: candidate.recipientBinding === "private"
        ? { source: "private_binding" }
        : undefined,
    };
  });
}

function minimumHealthFactor(value: unknown): "1.5" | "1.6" | "1.8" | "2.0" {
  return value === "1.5" || value === "1.6" || value === "1.8" || value === "2.0"
    ? value
    : "1.6";
}

function coordinationMode(
  value: unknown,
): IntentIRV3["coordination"]["mode"] {
  return value === "direct" || value === "competitive" ? value : "automatic";
}

function minimumEvidenceLevel(
  value: unknown,
  crossChain: boolean,
): IntentIRV3["coordination"]["minimumEvidenceLevel"] {
  if (
    value === "observed" ||
    value === "chain_native_verified" ||
    value === "protocol_verified" ||
    value === "attested" ||
    value === "zk_verified"
  ) {
    return value;
  }
  return crossChain ? "protocol_verified" : "chain_native_verified";
}

function collectUnresolvedIntentFields(
  legs: readonly IntentLegV3[],
  bindings: readonly SensitiveFieldBindingV3[],
  budget: PrivacyBudgetV3,
): IntentIRV3["unresolved"] {
  const unresolved: Array<IntentIRV3["unresolved"][number]> = [];
  const amountBound = bindings.some((binding) => binding.field === "amount");
  const recipientBound = bindings.some((binding) => binding.field === "recipient");
  const amountOperations = new Set<IntentOperationV3>([
    "transfer", "swap", "bridge", "supply", "withdraw", "repay",
    "path_payment", "vault_deposit", "vault_withdraw", "liquidity_add",
    "liquidity_remove", "data_purchase",
  ]);
  if (legs.some((leg) => amountOperations.has(leg.operation)) && !amountBound) {
    unresolved.push({
      field: "amount",
      question: "Which protected amount should this workflow use?",
      options: [{
        id: "open_private_amount_composer",
        label: "Enter amount privately",
        effect: "The exact amount stays in the Private Intent Composer and the API receives only its commitment.",
      }],
    });
  }
  legs.forEach((leg, index) => {
    const prefix = `legs.${index}`;
    const requiresAssetIn = new Set<IntentOperationV3>([
      "trustline", "transfer", "swap", "bridge", "supply", "withdraw",
      "repay", "path_payment", "vault_deposit", "vault_withdraw",
      "liquidity_add", "liquidity_remove", "data_purchase",
    ]).has(leg.operation);
    const requiresAssetOut = leg.operation === "swap" || leg.operation === "bridge" || leg.operation === "path_payment";
    if (requiresAssetIn && !leg.assetIn) {
      unresolved.push({
        field: `${prefix}.assetIn`,
        question: `Which reviewed input asset should ${leg.operation} use on ${leg.chain.key}?`,
        options: [{
          id: `${prefix}.select_asset_in`,
          label: "Choose reviewed asset",
          effect: "Only assets whose network-specific identity is in the reviewed registry will be offered.",
        }],
      });
    }
    if (requiresAssetOut && !leg.assetOut) {
      unresolved.push({
        field: `${prefix}.assetOut`,
        question: `Which reviewed output asset should ${leg.operation} produce?`,
        options: [{
          id: `${prefix}.select_asset_out`,
          label: "Choose output asset",
          effect: "The choice will be bound to this lane and cannot be substituted across networks.",
        }],
      });
    }
    if (
      leg.operation === "transfer" &&
      (
        !leg.recipient ||
        !("source" in leg.recipient) ||
        leg.recipient.source !== "private_binding" ||
        !recipientBound
      )
    ) {
      unresolved.push({
        field: `${prefix}.recipient`,
        question: "Who should receive this transfer?",
        options: [{
          id: `${prefix}.open_private_recipient_composer`,
          label: "Enter recipient privately",
          effect: "The typed address will be family-checked locally and represented to the planner by a commitment.",
        }],
      });
    }
  });
  return unresolved;
}

function protocolForLeg(leg: IntentLegV3): string {
  if (leg.protocol) {
    const requested = leg.protocol.replace(/[_\s]+/gu, "-").toLowerCase();
    if (leg.operation === "bridge" && ["cctp", "cctp-v2", "circle-cctp", "circle-cctp-v2"].includes(requested)) {
      return "circle-cctp-v2";
    }
    if (leg.operation === "bridge" && requested === "across") return "across";
    if (leg.chain.key === "base_mainnet" && [
      "aave", "aave-v3", "aerodrome", "morpho", "morpho-blue",
      "moonwell", "compound", "compound-v3", "uniswap", "uniswap-v3",
    ].includes(requested)) {
      return "base-reviewed-defi";
    }
    if (leg.chain.key === "arbitrum_one") {
      if (["compound", "compound-v3", "comet", "arbitrum-compound-v3"].includes(requested)) {
        return "arbitrum-compound-v3";
      }
      if (["camelot", "camelot-v3", "camelot-v4", "arbitrum-camelot"].includes(requested)) {
        return "arbitrum-camelot";
      }
      if (["aave", "aave-v3", "uniswap", "uniswap-v3", "arbitrum-uniswap-aave"].includes(requested)) {
        return "arbitrum-uniswap-aave";
      }
    }
    if (leg.chain.key === "arbitrum_sepolia" && ["aave", "aave-v3", "aave-v3-arbitrum-sepolia"].includes(requested)) {
      return "aave-v3-arbitrum-sepolia";
    }
    if (leg.chain.family === "stellar" && ["sdex", "stellar", "stellar-classic"].includes(requested)) {
      return "stellar-classic";
    }
    return requested;
  }
  if (leg.operation === "bridge") return "circle-cctp-v2";
  if (leg.chain.key === "stellar_testnet") {
    if (leg.operation === "path_payment" || leg.operation === "swap") return "stellar-classic";
    return "stellar-classic";
  }
  if (leg.chain.key === "base_mainnet") return "base-reviewed-defi";
  if (leg.chain.key === "arbitrum_one") return "arbitrum-uniswap-aave";
  if (leg.chain.key === "arbitrum_sepolia") return "aave-v3-arbitrum-sepolia";
  return "arc-native";
}

function executionBindingForLeg(
  leg: IntentLegV3,
  protocol: string,
): { readonly target?: string; readonly method?: string; readonly hydrated: boolean; readonly reason?: string } {
  const hydrationRequired = (
    target: string,
    method: string,
  ): { readonly target: string; readonly method: string; readonly hydrated: false; readonly reason: string } => ({
    target,
    method,
    hydrated: false,
    reason: `${protocol} has a reviewed target and method, but Workflow V3 has not yet bound the exact amount, calldata or XDR, quote, signer and deadline into one executable envelope. Planning remains available; signing fails closed.`,
  });
  if (protocol === "aave-v3-arbitrum-sepolia") {
    if (leg.operation === "portfolio") {
      return {
        target: "0x12373B5085e3b42D42C1D4ABF3B3Cf4Df0E0Fa01",
        method: "getUserReserveData",
        hydrated: true,
      };
    }
    if (leg.operation === "borrow_capacity") {
      return {
        target: "0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff",
        method: "getUserAccountData",
        hydrated: true,
      };
    }
    return hydrationRequired(
      "0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff",
      leg.operation,
    );
  }
  if (protocol === "arbitrum-uniswap-aave") {
    return leg.operation === "swap"
      ? hydrationRequired(
          "0xE592427A0AEce92De3Edee1F18E0157C05861564",
          "exactInputSingle",
        )
      : hydrationRequired(
          "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
          leg.operation,
        );
  }
  if (protocol === "stellar-classic") {
    if (leg.operation === "portfolio") {
      return {
        target: "stellar-horizon-account-resource",
        method: "read_account",
        hydrated: true,
      };
    }
    return hydrationRequired("stellar-classic-ledger", leg.operation);
  }
  if (protocol === "circle-cctp-v2" && leg.chain.key === "arc_testnet") {
    return hydrationRequired(
      "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
      "depositForBurn",
    );
  }
  if (protocol === "circle-cctp-v2" && leg.chain.key === "stellar_testnet") {
    return hydrationRequired(
      STELLAR_TESTNET.cctp.tokenMessengerMinter,
      "deposit_for_burn",
    );
  }
  return {
    hydrated: false,
    reason: `${protocol} is registered for discovery, but its V3 exact-call hydrator is not bound yet. The legacy reviewed engine remains available where applicable.`,
  };
}

function assertProtocolLeg(leg: IntentLegV3): void {
  const protocol = protocolForLeg(leg);
  if (protocol === "aave-v3-arbitrum-sepolia" || protocol === "arc-native") return;
  const capability = capabilityById(protocol);
  if (!capability) {
    throw controlled("PROTOCOL_CAPABILITY_UNKNOWN", `Protocol ${protocol} is not registered.`);
  }
  if (!capability.chains.includes(leg.chain.key) || !capability.operations.includes(leg.operation)) {
    throw controlled(
      "PROTOCOL_CAPABILITY_MISMATCH",
      `${protocol} does not support ${leg.operation} on ${leg.chain.key}.`,
      409,
    );
  }
}

function privacyLevel(budget: PrivacyBudgetV3, field: PrivacyField): DisclosureLevel {
  return budget.fields[field] ?? budget.defaultLevel;
}

function liveReadProvider(
  chain: ChainRef,
  protocol: string,
  operationName: WorkflowStepV3["operation"],
): string | null {
  if (operationName !== "portfolio" && operationName !== "borrow_capacity") return null;
  if (chain.key === "stellar_testnet" && protocol === "stellar-classic") {
    return "stellar_horizon";
  }
  if (chain.key === "arbitrum_sepolia" && protocol === "aave-v3-arbitrum-sepolia") {
    return "arbitrum_sepolia_rpc";
  }
  return null;
}

function liveReadFields(
  operationName: WorkflowStepV3["operation"],
): readonly PrivacyField[] {
  if (operationName === "borrow_capacity") {
    return ["wallet_identity", "balance", "strategy"];
  }
  if (operationName === "portfolio") {
    return ["wallet_identity", "balance"];
  }
  return ["wallet_identity"];
}

function stepDisclosure(
  stepId: string,
  operationName: WorkflowStepV3["operation"],
  budget: PrivacyBudgetV3,
  chain?: ChainRef,
  protocol?: string,
): readonly DisclosureDeltaV3[] {
  if (
    operationName === "control_plane_commit" ||
    operationName === "receipt_registry_commit" ||
    operationName === "receipt_registry_finalize" ||
    operationName === "control_plane_finalize"
  ) {
    return [
      {
        stepId,
        field: "wallet_identity",
        level: "public_execution",
        newlyVisibleTo: ["stellar_rpc", "stellar_public_ledger"],
        reason: "The control-plane owner, commitment and timing are public on Stellar.",
        userApprovalRequired: true,
      },
      {
        stepId,
        field: "route",
        level: "public_execution",
        newlyVisibleTo: ["stellar_public_ledger"],
        reason: "Only an opaque workflow root is anchored; intermediate checkpoint details stay in the workflow store.",
        userApprovalRequired: true,
      },
    ];
  }
  if (operationName === "attestation" || operationName === "portfolio" || operationName === "borrow_capacity") {
    const provider = chain && protocol
      ? liveReadProvider(chain, protocol, operationName)
      : null;
    const requiredProviders = provider ? ["kletia_api", provider] : ["kletia_api"];
    const approved = requiredProviders.every((candidate) => budget.approvedProviders.includes(candidate));
    return liveReadFields(operationName).map((field) => ({
      stepId,
      field,
      level: privacyLevel(budget, field),
      newlyVisibleTo: requiredProviders,
      reason: provider
        ? `This live read reveals ${field} to Kletia API and ${provider}; the persistent workflow store keeps only a snapshot commitment and block or ledger reference.`
        : "This checkpoint read requires a public account or transaction reference.",
      userApprovalRequired: privacyLevel(budget, field) === "device_only" || !approved,
    }));
  }
  return (["amount", "recipient", "timing", "wallet_identity"] as const).map((field) => ({
    stepId,
    field,
    level: "public_execution" as const,
    newlyVisibleTo: ["wallet_extension", "rpc", "public_ledger"],
    reason: `${operationName} settles on a public ledger; its exact transaction fields become public if signed.`,
    userApprovalRequired: true,
  }));
}

function routeSteps(
  id: string,
  legs: readonly IntentLegV3[],
  budget: PrivacyBudgetV3,
  controlPlaneRequired: boolean,
  controlPlaneReady: boolean,
  expiresAt: number,
): readonly WorkflowStepV3[] {
  const steps: WorkflowStepV3[] = [];
  const lane = assertSingleLane(legs.map((leg) => leg.chain));
  const controlPlaneChain =
    lane === "testnet" ? CHAINS_V3.stellar_testnet : CHAINS_V3.stellar_mainnet;
  const add = (input: Omit<WorkflowStepV3, "id" | "order" | "dependsOn" | "disclosure" | "status">) => {
    const stepId = `${id}-step-${steps.length + 1}`;
    const ready = input.executionReadiness === "ready";
    steps.push({
      ...input,
      id: stepId,
      order: steps.length + 1,
      dependsOn: steps.length === 0 ? [] : [steps[steps.length - 1].id],
      status:
        ready && steps.length === 0
          ? input.signer === "none" ? "ready" : "awaiting_signature"
          : ready ? "planned" : "blocked",
      disclosure: stepDisclosure(stepId, input.operation, budget, input.chain, input.protocol),
    });
  };

  if (controlPlaneRequired) {
    const target = controlPlaneContractId(lane);
    add({
      operation: "control_plane_commit",
      chain: controlPlaneChain,
      protocol: "kletia-intent-control-plane",
      signer: "stellar_wallet",
      amountBinding: "none",
      target,
      method: "commit",
      deadline: expiresAt,
      evidenceRequired: [{ kind: "workflow_committed_event", minimumLevel: "chain_native_verified" }],
      executionReadiness: controlPlaneReady ? "ready" : "deployment_required",
      unavailableReason: controlPlaneReady
        ? undefined
        : "The pinned Stellar Intent Control Plane did not pass live Testnet readiness.",
    });
    const receiptTarget = receiptRegistryContractId(lane);
    add({
      operation: "receipt_registry_commit",
      chain: controlPlaneChain,
      protocol: "kletia-policy-receipt-registry",
      signer: "stellar_wallet",
      amountBinding: "none",
      target: receiptTarget,
      method: "commit",
      deadline: expiresAt,
      evidenceRequired: [{ kind: "policy_committed_event", minimumLevel: "chain_native_verified" }],
      executionReadiness: controlPlaneReady ? "ready" : "deployment_required",
      unavailableReason: controlPlaneReady ? undefined : "The pinned Stellar receipt registry did not pass live Testnet readiness.",
    });
  }

  if (id === "arc-arbitrum-direct-cctp") {
    const directExecutionSteps: ReadonlyArray<
      Omit<WorkflowStepV3, "id" | "order" | "dependsOn" | "disclosure" | "status">
    > = [
      {
        operation: "approve",
        chain: CHAINS_V3.arc_testnet,
        protocol: "circle-cctp-v2",
        signer: "evm_wallet",
        amountBinding: "private_amount",
        target: ASSETS_V3.arc_usdc.address!,
        method: "approve",
        deadline: expiresAt,
        quoteExpiresAt: Date.now() + 2 * 60 * 1_000,
        evidenceRequired: [{ kind: "approval_event", minimumLevel: "chain_native_verified" }],
        executionReadiness: "ready",
      },
      {
        operation: "bridge",
        chain: CHAINS_V3.arc_testnet,
        protocol: "circle-cctp-v2",
        signer: "evm_wallet",
        amountBinding: "previous_output",
        target: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
        method: "depositForBurn",
        deadline: expiresAt,
        quoteExpiresAt: Date.now() + 2 * 60 * 1_000,
        evidenceRequired: [
          { kind: "message_sent_and_burn", minimumLevel: "protocol_verified" },
        ],
        executionReadiness: "ready",
      },
      {
        operation: "attestation",
        chain: CHAINS_V3.arc_testnet,
        protocol: "circle-cctp-v2",
        signer: "none",
        amountBinding: "previous_output",
        deadline: expiresAt,
        evidenceRequired: [{ kind: "circle_attestation", minimumLevel: "attested" }],
        executionReadiness: "ready",
      },
      {
        operation: "cctp_mint",
        chain: CHAINS_V3.arbitrum_sepolia,
        protocol: "circle-cctp-v2",
        signer: "evm_wallet",
        amountBinding: "previous_output",
        target: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
        method: "receiveMessage",
        deadline: expiresAt,
        evidenceRequired: [{ kind: "usdc_mint_transfer", minimumLevel: "protocol_verified" }],
        executionReadiness: "ready",
      },
      {
        operation: "approve",
        chain: CHAINS_V3.arbitrum_sepolia,
        protocol: "aave-v3-arbitrum-sepolia",
        signer: "evm_wallet",
        amountBinding: "previous_output",
        target: ASSETS_V3.arbitrum_sepolia_usdc.address!,
        method: "approve",
        deadline: expiresAt,
        evidenceRequired: [{ kind: "approval_event", minimumLevel: "chain_native_verified" }],
        executionReadiness: "ready",
      },
      {
        operation: "supply",
        chain: CHAINS_V3.arbitrum_sepolia,
        protocol: "aave-v3-arbitrum-sepolia",
        signer: "evm_wallet",
        amountBinding: "previous_output",
        target: "0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff",
        method: "supply",
        deadline: expiresAt,
        evidenceRequired: [{ kind: "aave_supply_event", minimumLevel: "protocol_verified" }],
        executionReadiness: "ready",
      },
      ...(legs.some((leg) => leg.operation === "borrow_capacity")
        ? [{
            operation: "borrow_capacity" as const,
            chain: CHAINS_V3.arbitrum_sepolia,
            protocol: "aave-v3-arbitrum-sepolia",
            signer: "none" as const,
            amountBinding: "none" as const,
            target: "0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff",
            method: "getUserAccountData",
            deadline: expiresAt,
            evidenceRequired: [{ kind: "live_aave_account_data", minimumLevel: "protocol_verified" as const }],
            executionReadiness: "ready" as const,
          }]
        : []),
    ];
    directExecutionSteps.forEach(add);
  } else for (const leg of legs) {
    const protocol = protocolForLeg(leg);
    const capability = capabilityById(protocol);
    const adapterEnabled = capability
      ? capability.executionEnabled &&
        (capability.executionChains ?? capability.chains).includes(leg.chain.key)
      : protocol === "aave-v3-arbitrum-sepolia" || protocol === "arc-native";
    const executionBinding = executionBindingForLeg(leg, protocol);
    const provider = liveReadProvider(leg.chain, protocol, leg.operation);
    const readFields = liveReadFields(leg.operation);
    const providerDisclosureReady = !provider || (
      readFields.every((field) => privacyLevel(budget, field) !== "device_only") &&
      budget.approvedProviders.includes("kletia_api") &&
      budget.approvedProviders.includes(provider)
    );
    const enabled = adapterEnabled && executionBinding.hydrated && providerDisclosureReady;
    add({
      operation: leg.operation,
      chain: leg.chain,
      protocol,
      target: executionBinding.target,
      method: executionBinding.method,
      signer:
        leg.operation === "portfolio" || leg.operation === "borrow_capacity"
          ? "none"
          : leg.chain.family === "stellar" ? "stellar_wallet" : "evm_wallet",
      amountBinding:
        leg.operation === "portfolio" || leg.operation === "borrow_capacity"
          ? "none"
          : steps.some((step) =>
              step.operation !== "control_plane_commit" &&
              step.operation !== "receipt_registry_commit")
            ? "previous_output"
            : "private_amount",
      deadline: expiresAt,
      quoteExpiresAt: Date.now() + 2 * 60 * 1_000,
      evidenceRequired: [{
        kind: leg.operation === "bridge" ? "protocol_settlement" : leg.operation === "portfolio" || leg.operation === "borrow_capacity" ? "live_read" : "transaction_receipt",
        minimumLevel: leg.operation === "bridge" ? "protocol_verified" : "chain_native_verified",
      }],
      executionReadiness: enabled ? "ready" : "capability_disabled",
      unavailableReason: enabled
        ? undefined
        : !providerDisclosureReady
          ? `The live read needs ${readFields.join(", ")} disclosure to kletia_api and ${provider}. Approve the fields and both providers in Privacy Budget or keep the read on-device.`
          : executionBinding.reason ?? capability?.reason ?? `${protocol} execution is not ready.`,
    });
    if (leg.operation === "bridge") {
      add({
        operation: "attestation",
        chain: leg.chain,
        protocol,
        signer: "none",
        amountBinding: "previous_output",
        deadline: expiresAt,
        evidenceRequired: [{ kind: "circle_attestation_or_across_fill", minimumLevel: "protocol_verified" }],
        executionReadiness: enabled ? "ready" : "capability_disabled",
        unavailableReason: enabled ? undefined : capability?.reason,
      });
    }
  }

  if (controlPlaneRequired) {
    const receiptTarget = receiptRegistryContractId(lane);
    add({
      operation: "receipt_registry_finalize",
      chain: controlPlaneChain,
      protocol: "kletia-policy-receipt-registry",
      signer: "stellar_wallet",
      amountBinding: "none",
      receiptBinding: "workflow_receipt_root",
      target: receiptTarget,
      method: "finalize",
      deadline: expiresAt,
      evidenceRequired: [{ kind: "receipt_root_finalized", minimumLevel: "chain_native_verified" }],
      executionReadiness: controlPlaneReady ? "ready" : "deployment_required",
      unavailableReason: controlPlaneReady ? undefined : "The reviewed Stellar receipt registry deployment is required.",
    });
    const controlPlaneTarget = controlPlaneContractId(lane);
    add({
      operation: "control_plane_finalize",
      chain: controlPlaneChain,
      protocol: "kletia-intent-control-plane",
      signer: "stellar_wallet",
      amountBinding: "none",
      receiptBinding: "workflow_receipt_root",
      target: controlPlaneTarget,
      method: "finalize",
      deadline: expiresAt,
      evidenceRequired: [{ kind: "workflow_receipt_root_finalized", minimumLevel: "chain_native_verified" }],
      executionReadiness: controlPlaneReady ? "ready" : "deployment_required",
      unavailableReason: controlPlaneReady ? undefined : "The reviewed Stellar Intent Control Plane deployment is required.",
    });
  }
  return steps;
}

function routeCandidate(input: {
  id: string;
  label: string;
  legs: readonly IntentLegV3[];
  protocols: readonly string[];
  budget: PrivacyBudgetV3;
  controlPlaneRequired: boolean;
  controlPlaneReady: boolean;
  duration: { min: number; max: number };
  failureRisk: number;
  protocolRisk: number;
  disclosureCost: number;
  score: number;
  expiresAt: number;
}): RouteCandidateV3 {
  const steps = routeSteps(
    input.id,
    input.legs,
    input.budget,
    input.controlPlaneRequired,
    input.controlPlaneReady,
    input.expiresAt,
  );
  const blocked = steps.find((step) => step.executionReadiness !== "ready");
  const confidentialRuntimeMissing =
    input.budget.ledgerMode === "stellar_confidential_required";
  return {
    id: input.id,
    solverRouteHash: hash("KLETIA_SOLVER_ROUTE_V1", {
      id: input.id,
      lane: assertSingleLane(input.legs.map((leg) => leg.chain)),
      legs: input.legs,
      protocols: input.protocols,
      steps: steps.map((step) => ({
        operation: step.operation,
        chain: step.chain.caip2,
        protocol: step.protocol,
        target: step.target ?? null,
        method: step.method ?? null,
        deadline: step.deadline,
      })),
    }),
    label: input.label,
    lane: assertSingleLane(input.legs.map((leg) => leg.chain)),
    chains: [...new Set(input.legs.map((leg) => leg.chain.key))],
    protocols: input.protocols,
    available: !blocked && !confidentialRuntimeMissing,
    unavailableReason: confidentialRuntimeMissing
      ? "A Stellar confidential ledger was required, but Kletia has no pinned holder, verifier, auditor, recovery and signable USDC treasury runtime. The request was not downgraded to public settlement."
      : blocked?.unavailableReason,
    quoteExpiresAt: Date.now() + 2 * 60 * 1_000,
    metrics: {
      estimatedOutputAtomic: null,
      gasCostUsd: null,
      bridgeFeeUsd: null,
      slippageBps: null,
      estimatedDurationSeconds: input.duration,
      estimatedApyBps: null,
      failureRisk: input.failureRisk,
      protocolRisk: input.protocolRisk,
      disclosureCost: input.disclosureCost,
      score: input.score,
      amountDependentCostsComplete: false,
    },
    rankingExplanation: [
      "Hard network, asset, protocol and privacy constraints were applied before ranking.",
      "Exact amount-dependent gas, bridge fee and output remain local until the user approves provider disclosure.",
      "This provisional score cannot authorize execution and must be refreshed after local transaction hydration.",
    ],
    steps,
  };
}

function routesForIntent(
  intent: IntentIRV3,
  controlPlaneRequired: boolean,
  controlPlaneReady: boolean,
  expiresAt: number,
): readonly RouteCandidateV3[] {
  const chainKeys = intent.legs.map((leg) => leg.chain.key);
  const source = chainKeys[0];
  const destination = chainKeys[chainKeys.length - 1];
  const hasBridge = intent.legs.some((leg) => leg.operation === "bridge");
  if (!hasBridge) {
    const protocols = [...new Set(intent.legs.map(protocolForLeg))];
    return [routeCandidate({
      id: "single-chain-reviewed",
      label: "Reviewed single-chain execution",
      legs: intent.legs,
      protocols,
      budget: intent.privacyBudget,
      controlPlaneRequired,
      controlPlaneReady,
      duration: { min: 5, max: 90 },
      failureRisk: 10,
      protocolRisk: 10,
      disclosureCost: 40,
      score: 60,
      expiresAt,
    })];
  }

  if (intent.lane === "production" && source === "base_mainnet" && destination === "arbitrum_one") {
    const directLegs = intent.legs.map((leg) => leg.operation === "bridge" ? { ...leg, protocol: "across" } : leg);
    const cctpLegs = intent.legs.map((leg) => leg.operation === "bridge" ? { ...leg, protocol: "circle-cctp-v2" } : leg);
    return [
      routeCandidate({
        id: "base-arbitrum-across",
        label: "Across fast route",
        legs: directLegs,
        protocols: [...new Set(directLegs.map(protocolForLeg))],
        budget: intent.privacyBudget,
        controlPlaneRequired,
        controlPlaneReady,
        duration: { min: 30, max: 300 },
        failureRisk: 20,
        protocolRisk: 15,
        disclosureCost: 75,
        score: 110,
        expiresAt,
      }),
      routeCandidate({
        id: "base-arbitrum-cctp",
        label: "Circle CCTP V2 route",
        legs: cctpLegs,
        protocols: [...new Set(cctpLegs.map(protocolForLeg))],
        budget: intent.privacyBudget,
        controlPlaneRequired,
        controlPlaneReady,
        duration: { min: 60, max: 1_200 },
        failureRisk: 16,
        protocolRisk: 10,
        disclosureCost: 80,
        score: 116,
        expiresAt,
      }),
    ];
  }

  if (intent.lane === "testnet" && source === "arc_testnet" && destination === "arbitrum_sepolia") {
    const directLegs = intent.legs.map((leg) => leg.operation === "bridge" ? { ...leg, protocol: "circle-cctp-v2" } : leg);
    const bridgeIndex = intent.legs.findIndex((leg) => leg.operation === "bridge");
    const stellarLegs: IntentLegV3[] = [
      ...intent.legs.slice(0, bridgeIndex),
      {
        operation: "bridge",
        chain: CHAINS_V3.arc_testnet,
        protocol: "circle-cctp-v2",
        assetIn: ASSETS_V3.arc_usdc,
        assetOut: ASSETS_V3.stellar_testnet_usdc,
      },
      {
        operation: "bridge",
        chain: CHAINS_V3.stellar_testnet,
        protocol: "circle-cctp-v2",
        assetIn: ASSETS_V3.stellar_testnet_usdc,
        assetOut: ASSETS_V3.arbitrum_sepolia_usdc,
      },
      ...intent.legs.slice(bridgeIndex + 1),
    ];
    return [
      routeCandidate({
        id: "arc-arbitrum-direct-cctp",
        label: "Direct public CCTP route",
        legs: directLegs,
        protocols: [...new Set(directLegs.map(protocolForLeg))],
        budget: intent.privacyBudget,
        controlPlaneRequired,
        controlPlaneReady,
        duration: { min: 60, max: 1_200 },
        failureRisk: 18,
        protocolRisk: 10,
        disclosureCost: 80,
        score: 108,
        expiresAt,
      }),
      routeCandidate({
        id: "arc-stellar-arbitrum-cctp",
        label: "Stellar-centered public checkpoint route",
        legs: stellarLegs,
        protocols: [...new Set(stellarLegs.map(protocolForLeg))],
        budget: intent.privacyBudget,
        controlPlaneRequired: true,
        controlPlaneReady,
        duration: { min: 120, max: 2_400 },
        failureRisk: 28,
        protocolRisk: 14,
        disclosureCost: 120,
        score: 162,
        expiresAt,
      }),
    ];
  }

  return [routeCandidate({
    id: "registered-route",
    label: "Registered staged route",
    legs: intent.legs,
    protocols: [...new Set(intent.legs.map(protocolForLeg))],
    budget: intent.privacyBudget,
    controlPlaneRequired,
    controlPlaneReady,
    duration: { min: 60, max: 3_600 },
    failureRisk: 35,
    protocolRisk: 25,
    disclosureCost: 100,
    score: 180,
    expiresAt,
  })];
}

function controlPlaneContractId(lane: "production" | "testnet"): string {
  return (
    process.env[
      lane === "testnet"
        ? "STELLAR_INTENT_CONTROL_PLANE_TESTNET_CONTRACT_ID"
        : "STELLAR_INTENT_CONTROL_PLANE_MAINNET_CONTRACT_ID"
    ]?.trim() ||
    (lane === "testnet"
      ? process.env.STELLAR_INTENT_CONTROL_PLANE_CONTRACT_ID?.trim()
      : "") ||
    ""
  );
}

function receiptRegistryContractId(lane: "production" | "testnet"): string {
  return (
    process.env[
      lane === "testnet"
        ? "STELLAR_POLICY_RECEIPT_REGISTRY_TESTNET_CONTRACT_ID"
        : "STELLAR_POLICY_RECEIPT_REGISTRY_MAINNET_CONTRACT_ID"
    ]?.trim() ||
    (lane === "testnet"
      ? process.env.STELLAR_POLICY_REGISTRY_CONTRACT_ID?.trim()
      : "") ||
    ""
  );
}

function verifierRegistryContractId(lane: "production" | "testnet"): string {
  return (
    process.env[
      lane === "testnet"
        ? "STELLAR_POLICY_VERIFIER_REGISTRY_TESTNET_CONTRACT_ID"
        : "STELLAR_POLICY_VERIFIER_REGISTRY_MAINNET_CONTRACT_ID"
    ]?.trim() || ""
  );
}

function solverMarketContractId(
  kind: "bond_vault" | "route_auction",
  lane: "production" | "testnet",
): string {
  const prefix = kind === "bond_vault"
    ? "STELLAR_SOLVER_BOND_VAULT"
    : "STELLAR_ROUTE_AUCTION";
  return process.env[`${prefix}_${lane === "testnet" ? "TESTNET" : "MAINNET"}_CONTRACT_ID`]
    ?.trim() || "";
}

function solverMarketConfigurationReady(lane: "production" | "testnet"): boolean {
  return Boolean(
    lane === "testnet" &&
      process.env.STELLAR_SOLVER_MARKET_ENABLED?.trim() === "true" &&
      StrKey.isValidContract(solverMarketContractId("bond_vault", lane)) &&
      StrKey.isValidContract(solverMarketContractId("route_auction", lane)),
  );
}

function controlPlaneConfigurationReady(lane: "production" | "testnet"): boolean {
  const enabled = process.env.STELLAR_INTENT_CONTROL_PLANE_ENABLED?.trim() === "true";
  const proofArtifactsReady =
    process.env.STELLAR_POLICY_VERIFIER_ARTIFACTS_READY?.trim() === "true";
  const contract = controlPlaneContractId(lane);
  const receipt = receiptRegistryContractId(lane);
  const verifier = verifierRegistryContractId(lane);
  if (
    !enabled ||
    !proofArtifactsReady ||
    !isStellarPolicyVerifierArtifactConfigurationComplete() ||
    !StrKey.isValidContract(contract) ||
    !StrKey.isValidContract(receipt) ||
    !StrKey.isValidContract(verifier)
  ) {
    return false;
  }
  return lane === "testnet";
}

export function compileWorkflowPlanV3(
  body: unknown,
  options: {
    readonly liveControlPlaneReady?: boolean;
    readonly liveSolverMarketReady?: boolean;
    readonly liveSolverMinimumBondAtomic?: string;
  } = {},
): WorkflowPlanV3 {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw controlled("INTENT_V3_BODY_INVALID", "A structured V3 intent body is required.");
  }
  const input = body as Record<string, unknown>;
  // Private bindings are intentionally omitted from this traversal because
  // their commitments and opaque references are allowed; exact values are not.
  // Privacy Budget field names such as `amount` are policy keys rather than
  // plaintext values and are parsed through a closed enum below.
  const {
    privateBindings: _privateBindings,
    privacyBudget: _privacyBudget,
    ...publicIntentEnvelope
  } = input;
  assertNoRawPrivateFields(publicIntentEnvelope);
  const sourceReceiptInput = input.sourceIntentReceipt;
  let sourceIntentReceipt: IntentIRV3["sourceIntentReceipt"] = null;
  if (sourceReceiptInput !== undefined && sourceReceiptInput !== null) {
    if (!sourceReceiptInput || typeof sourceReceiptInput !== "object" || Array.isArray(sourceReceiptInput)) {
      throw controlled("SOURCE_INTENT_RECEIPT_INVALID", "The source intent receipt binding is malformed.", 409);
    }
    const source = sourceReceiptInput as Record<string, unknown>;
    if (
      source.schemaVersion !== "kletia_source_intent_receipt_v1" ||
      source.engine !== "workflow_v2" ||
      source.scenarioId !== "arc_testnet_usdc_to_arbitrum_sepolia_aave_supply" ||
      typeof source.workflowId !== "string" ||
      !/^[0-9a-f-]{36}$/iu.test(source.workflowId) ||
      typeof source.requestId !== "string" ||
      !/^[0-9a-f-]{36}$/iu.test(source.requestId) ||
      typeof source.planCoreSha256 !== "string" ||
      !/^0x[a-f\d]{64}$/iu.test(source.planCoreSha256) ||
      (source.selectedRoute !== "direct_cctp" && source.selectedRoute !== "stellar_centered_public")
    ) {
      throw controlled("SOURCE_INTENT_RECEIPT_INVALID", "The source intent receipt binding is malformed.", 409);
    }
    sourceIntentReceipt = {
      schemaVersion: "kletia_source_intent_receipt_v1",
      engine: "workflow_v2",
      scenarioId: "arc_testnet_usdc_to_arbitrum_sepolia_aave_supply",
      workflowId: source.workflowId,
      requestId: source.requestId,
      planCoreSha256: source.planCoreSha256 as `0x${string}`,
      selectedRoute: source.selectedRoute,
    };
  }
  const goal = semanticGoal(input.semanticGoal);
  const budget = privacyBudget(input.privacyBudget);
  const bindings = privateBindings(input.privateBindings, budget);
  const legs = parseLegs(input.legs);
  const lane = assertSingleLane(legs.map((leg) => leg.chain));
  const chainCount = new Set(legs.map((leg) => leg.chain.key)).size;
  const requestedCoordinationMode = coordinationMode(input.coordinationMode);
  const preferredRouteId = input.preferredRouteId === undefined || input.preferredRouteId === null
    ? null
    : String(input.preferredRouteId);
  if (preferredRouteId !== null && !/^[a-z0-9][a-z0-9-]{2,127}$/u.test(preferredRouteId)) {
    throw controlled("PREFERRED_ROUTE_INVALID", "The preferred route identifier is invalid.", 409);
  }
  // A cross-chain graph is not, by itself, an economic reason to pay for an
  // auction. At this stage the exact amount is still held behind the private
  // binding, so an automatic value threshold would be guesswork and would make
  // small transfers pay the same coordination overhead as large workflows.
  // The reviewed direct adapters are therefore the default for both `direct`
  // and `automatic`; the solver market is an explicit, user-authorized mode.
  const solverMarketRequired = requestedCoordinationMode === "competitive";
  for (const leg of legs) assertProtocolLeg(leg);
  const wallets = parseWalletBindings(input.walletBindings);
  const walletIdentityLevel = privacyLevel(budget, "wallet_identity");
  if (wallets.length > 0 && walletIdentityLevel === "device_only") {
    throw controlled(
      "PRIVACY_BUDGET_WALLET_EGRESS_CONFLICT",
      "wallet_identity is device_only, but wallet bindings were included in an API request. Approve kletia_api as a selected provider or compile entirely on-device.",
      409,
    );
  }
  if (
    wallets.length > 0 &&
    walletIdentityLevel === "selected_provider" &&
    !budget.approvedProviders.includes("kletia_api")
  ) {
    throw controlled(
      "PRIVACY_BUDGET_PROVIDER_NOT_APPROVED",
      "wallet_identity may be disclosed only to selected providers, but kletia_api was not approved.",
      409,
    );
  }
  const requiredChainKeys = new Set(
    legs.map((leg) => leg.chain.key),
  );
  for (const key of requiredChainKeys) {
    const chain = CHAINS_V3[key as keyof typeof CHAINS_V3];
    const bound = wallets.some((wallet) =>
      chain.family === "evm"
        ? wallet.family === "evm" && wallet.chainId === chain.chainId
        : wallet.family === "stellar" && wallet.network === chain.network,
    );
    if (!bound) {
      throw controlled("WALLET_BINDING_REQUIRED", `A compatible wallet binding is required for ${key}.`);
    }
  }
  const inputRisk = input.risk && typeof input.risk === "object" ? input.risk as Record<string, unknown> : {};
  const slippage = Number(inputRisk.maximumSlippageBps ?? 100);
  if (!Number.isInteger(slippage) || slippage < 1 || slippage > 500) {
    throw controlled("SLIPPAGE_POLICY_INVALID", "Maximum slippage must be between 1 and 500 basis points.");
  }
  const intent: IntentIRV3 = {
    schemaVersion: "kletia_intent_ir_v3",
    requestId: typeof input.requestId === "string" && /^[0-9a-f-]{36}$/iu.test(input.requestId) ? input.requestId : randomUUID(),
    sourceIntentReceipt,
    semanticGoal: goal,
    preferredRouteId,
    lane,
    legs,
    privateBindings: bindings,
    privacyBudget: budget,
    risk: {
      tolerance: inputRisk.tolerance === "conservative" || inputRisk.tolerance === "aggressive" ? inputRisk.tolerance : "balanced",
      minimumHealthFactor: minimumHealthFactor(inputRisk.minimumHealthFactor),
      maximumSlippageBps: slippage,
    },
    gasPolicy: { preserveDestinationGas: true, automaticSpendingAllowed: false },
    coordination: {
      mode: requestedCoordinationMode,
      minimumEvidenceLevel: minimumEvidenceLevel(
        input.minimumEvidenceLevel,
        chainCount > 1,
      ),
      solverMayCustodyUserFunds: false,
      indeterminateResultMayBeRetried: false,
    },
    unresolved: collectUnresolvedIntentFields(legs, bindings, budget),
  };
  if (sourceIntentReceipt && sourceIntentReceipt.requestId !== intent.requestId) {
    throw controlled(
      "SOURCE_INTENT_REQUEST_MISMATCH",
      "The V3 request must preserve the exact request ID from the user-approved intent receipt.",
      409,
    );
  }
  if (sourceIntentReceipt) {
    const expectedRouteId = sourceIntentReceipt.selectedRoute === "direct_cctp"
      ? "arc-arbitrum-direct-cctp"
      : "arc-stellar-arbitrum-cctp";
    const hasExpectedGraph =
      intent.lane === "testnet" &&
      intent.legs.length === 3 &&
      intent.legs[0]?.operation === "bridge" &&
      intent.legs[0]?.chain.key === "arc_testnet" &&
      intent.legs[1]?.operation === "supply" &&
      intent.legs[1]?.chain.key === "arbitrum_sepolia" &&
      intent.legs[2]?.operation === "borrow_capacity" &&
      intent.legs[2]?.chain.key === "arbitrum_sepolia";
    if (!hasExpectedGraph || preferredRouteId !== expectedRouteId) {
      throw controlled(
        "SOURCE_INTENT_GRAPH_MISMATCH",
        "The V3 graph or preferred route does not match the exact user-approved intent receipt.",
        409,
      );
    }
  }
  const asksConfidentiality = budget.ledgerMode === "stellar_confidential_required";
  const controlPlaneRequired =
    chainCount > 1 || legs.length > 1 || asksConfidentiality || solverMarketRequired;
  const controlPlaneReady =
    options.liveControlPlaneReady === true && controlPlaneConfigurationReady(lane);
  const solverMarketReady =
    options.liveSolverMarketReady === true && solverMarketConfigurationReady(lane);
  if (
    controlPlaneRequired &&
    !wallets.some((wallet) => wallet.family === "stellar" && wallet.network === (lane === "testnet" ? "testnet" : "public"))
  ) {
    throw controlled(
      "STELLAR_CONTROL_PLANE_WALLET_REQUIRED",
      `A Stellar ${lane === "testnet" ? "Testnet" : "Mainnet"} wallet is required for this multi-step or private workflow.`,
      409,
    );
  }
  const createdAt = Date.now();
  const expiresAt = createdAt + COMPILE_TTL_MS;
  const workflowId = randomUUID();
  const planningPolicyCommitment = hash("KLETIA_PLANNING_POLICY_COMMITMENT_V3", {
    privacyBudget: budget,
    risk: intent.risk,
    gasPolicy: intent.gasPolicy,
    privateCommitments: bindings.map(({ field, commitment }) => ({ field, commitment })),
  });
  const privacyBudgetCommitment = hash("KLETIA_PRIVACY_BUDGET_COMMITMENT_V3", budget);
  const unresolvedReason = intent.unresolved.length > 0
    ? `Resolve ${intent.unresolved.map((entry) => entry.field).join(", ")} before route selection.`
    : null;
  const routes = [...routesForIntent(intent, controlPlaneRequired, controlPlaneReady, expiresAt)]
    .map((route) => unresolvedReason
      ? { ...route, available: false, unavailableReason: unresolvedReason }
      : route)
    .sort((left, right) => left.metrics.score - right.metrics.score);
  // Competitive workflows cannot inherit the API's provisional favorite.
  // Route selection remains empty until the sealed commit-reveal market has a
  // winner and that exact route is rebound into the device policy proof.
  const preferredRoute = preferredRouteId === null
    ? null
    : routes.find((route) => route.id === preferredRouteId) ?? null;
  if (preferredRouteId !== null && !preferredRoute) {
    throw controlled(
      "PREFERRED_ROUTE_NOT_IN_PLAN",
      "The user-approved route is not compatible with the compiled intent graph.",
      409,
    );
  }
  const selected = solverMarketRequired
    ? null
    : preferredRouteId !== null
      ? preferredRoute?.available ? preferredRoute : null
      : routes.find((route) => route.available) ?? null;
  const marketConstraintsHash = hash("KLETIA_SOLVER_MARKET_CONSTRAINTS_V1", {
    lane,
    risk: intent.risk,
    gasPolicy: intent.gasPolicy,
    minimumEvidenceLevel: intent.coordination.minimumEvidenceLevel,
    privacyBudgetCommitment,
    candidateRoutes: routes.map((route) => ({
      id: route.id,
      chains: route.chains,
      protocols: route.protocols,
      quoteExpiresAt: route.quoteExpiresAt,
    })),
  });
  const auctionRoot = hash("KLETIA_SOLVER_AUCTION_ROOT_V1", {
    workflowId,
    requestId: intent.requestId,
    lane,
    planningPolicyCommitment,
    constraintsHash: marketConstraintsHash,
    privateCommitments: bindings.map(({ field, commitment }) => ({ field, commitment })),
  });
  const workflowRoot = hashToBn254Scalar(
    "KLETIA_WORKFLOW_ROOT_FIELD_V3",
    workflowRootMaterial({
      workflowId,
      requestId: intent.requestId,
      sourceIntentReceipt: intent.sourceIntentReceipt,
      lane,
      semanticGoal: goal,
      legs,
      routeId: selected?.id ?? null,
      routeProtocols: selected?.protocols ?? [],
      planningPolicyCommitment,
      privacyBudgetCommitment,
      expiresAt,
    }),
  );
  const disclosureDiff = routes.flatMap((route) => route.steps.flatMap((step) => step.disclosure));
  if (solverMarketRequired) {
    disclosureDiff.push(
      {
        stepId: "solver-market-auction",
        field: "route",
        level: "public_execution",
        newlyVisibleTo: ["stellar_rpc", "stellar_public_ledger", "competing_solvers"],
        reason: "Bid terms stay hidden during commit, then the route hash and economic terms become public during reveal.",
        userApprovalRequired: privacyLevel(budget, "route") !== "public_execution",
      },
      {
        stepId: "solver-market-auction",
        field: "amount",
        level: "public_execution",
        newlyVisibleTo: ["stellar_rpc", "stellar_public_ledger", "competing_solvers"],
        reason: "Minimum output, promised output and solver fee expose the economic scale of the auction after reveal.",
        userApprovalRequired: privacyLevel(budget, "amount") !== "public_execution",
      },
      {
        stepId: "solver-market-auction",
        field: "wallet_identity",
        level: "public_execution",
        newlyVisibleTo: ["stellar_rpc", "stellar_public_ledger"],
        reason: "The auction owner, bidder identities and workflow-scoped bond locks are public Stellar state.",
        userApprovalRequired: privacyLevel(budget, "wallet_identity") !== "public_execution",
      },
      {
        stepId: "solver-market-auction",
        field: "timing",
        level: "public_execution",
        newlyVisibleTo: ["stellar_rpc", "stellar_public_ledger"],
        reason: "Commit, reveal, settlement and bond-recovery ledger windows are public.",
        userApprovalRequired: privacyLevel(budget, "timing") !== "public_execution",
      },
    );
  }
  return {
    version: 3,
    schemaVersion: "kletia_workflow_plan_v3",
    workflowId,
    requestId: intent.requestId,
    createdAt,
    expiresAt,
    lane,
    intent,
    walletBindings: wallets,
    controlPlane: {
      required: controlPlaneRequired,
      mode: controlPlaneRequired ? "stellar_intent_control_plane" : "local_manifest",
      network: controlPlaneRequired ? (lane === "testnet" ? "stellar_testnet" : "stellar_mainnet") : null,
      status: controlPlaneRequired ? (controlPlaneReady ? "ready" : "deployment_required") : "not_required",
      workflowRoot,
      planningPolicyCommitment,
      privacyBudgetCommitment,
      policyRoot: null,
      nullifier: null,
      proofBinding: {
        schemaVersion: "kletia_policy_proof_binding_v1",
        status: controlPlaneRequired ? "device_proof_required" : "not_required",
        routeId: null,
        verifierVersion: null,
        protocolRegistryRoot: null,
        assetRegistryRoot: null,
        recipientPolicyRoot: null,
        executionExpiresAtLedger: null,
        executionContextCommitment: null,
        publicInputsHash: null,
        proofSha256: null,
        verifiedAtLedger: null,
      },
      commitment: {
        status: controlPlaneRequired ? "device_proof_required" : "not_required",
        owner: null,
        nonce: null,
        transactionHash: null,
        committedAtLedger: null,
        receiptCloseByLedger: null,
        retentionFloorLedger: null,
      },
      receiptRegistry: {
        status: controlPlaneRequired ? "control_plane_required" : "not_required",
        owner: null,
        nonce: null,
        transactionHash: null,
        committedAtLedger: null,
      },
      externalExecutionTruthProven: false,
    },
    coordinationMarket: {
      required: solverMarketRequired,
      mode: solverMarketRequired
        ? "stellar_commit_reveal_auction"
        : "direct_adapter",
      network: solverMarketRequired
        ? lane === "testnet" ? "stellar_testnet" : "stellar_mainnet"
        : null,
      status: solverMarketRequired
        ? solverMarketReady ? "auction_open_required" : "deployment_required"
        : "not_required",
      reasons: solverMarketRequired
        ? [
            "The user explicitly requested competitive execution instead of the reviewed direct-adapter path.",
            "A workflow-scoped solver bond is required before a bid is accepted.",
            "Stellar records competition and resolution; it does not make a foreign-chain claim true by itself.",
          ]
        : [
            requestedCoordinationMode === "automatic" && chainCount > 1
              ? "Automatic mode keeps this cross-chain intent on reviewed direct adapters; a solver auction is opt-in because the private amount is not available for a trustworthy value threshold at compile time."
              : "This intent can use a reviewed direct adapter without paying for a solver auction.",
          ],
      auctionRoot,
      constraintsHash: marketConstraintsHash,
      winner: null,
      contracts: {
        sourceReady: true,
        bondVault:
          solverMarketRequired && StrKey.isValidContract(solverMarketContractId("bond_vault", lane))
            ? solverMarketContractId("bond_vault", lane)
            : null,
        routeAuction:
          solverMarketRequired && StrKey.isValidContract(solverMarketContractId("route_auction", lane))
            ? solverMarketContractId("route_auction", lane)
            : null,
        deploymentManifest: "contracts/stellar/deployments/testnet/solver-market.v1.json",
      },
      auctionPolicy: {
        commitmentScheme: "sha256_soroban_xdr_kletia_route_bid_v1",
        winnerRule: "highest_promised_net_output_then_shortest_duration",
        maximumBids: 32,
        minimumBondAtomic:
          solverMarketRequired &&
          /^\d+$/u.test(options.liveSolverMinimumBondAtomic || "") &&
          BigInt(options.liveSolverMinimumBondAtomic || "0") > 0n
            ? options.liveSolverMinimumBondAtomic!
            : null,
        exactWorkflowBondRequired: true,
        staleQuoteCanWin: false,
        automaticTimeoutSlashing: false,
      },
      publicDisclosure: {
        auctionTermsOnStellar: solverMarketRequired,
        commitmentsHideBidTermsUntilReveal: true,
        revealedBidEconomicsPublic: solverMarketRequired,
        solverIdentityPublic: solverMarketRequired,
        workflowTimingPublic: solverMarketRequired,
      },
      evidenceBoundary: {
        bidCommitmentProvesQuoteTruth: false,
        stellarProvesForeignExecutionByItself: false,
        slashOnlyForProvableSolverFault: true,
        bridgeDelayOrIndeterminateMayBeSlashed: false,
      },
    },
    routes,
    selectedRouteId: selected?.id ?? null,
    currentStepId:
      selected?.steps.find((step) => step.status === "awaiting_signature" || step.status === "ready")?.id ?? null,
    privacy: {
      budget,
      disclosureDiff,
      aiReceivedRawPrivateFields: false,
      ledgerConfidentiality:
        budget.ledgerMode === "stellar_confidential_required"
          ? "stellar_confidential_zone_only"
          : "none",
      anonymityGuaranteed: false,
    },
    executionPolicy: {
      perFinancialStepWalletApproval: true,
      crossChainAtomicity: "staged_checkpointed_no_global_rollback",
      environmentMixingAllowed: false,
      silentRetryAllowed: false,
      mockDataAllowed: false,
    },
  };
}

export function canonicalWorkflowPlanV3(plan: WorkflowPlanV3): string {
  return canonical(plan);
}

export function workflowPlanV3Hash(plan: WorkflowPlanV3): `0x${string}` {
  return hash("KLETIA_WORKFLOW_PLAN_V3", plan);
}
