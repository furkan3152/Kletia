/**
 * Builds receipts and plan records and selects disclosures.
 */
import { CHAINS, isNetworkKey, type NetworkKey } from "../chains.js";
import { base64UrlDecode, sha256Hex, toWellFormedString } from "../hash.js";
import type { ProtocolId } from "../protocols.js";
import { receiptAnchorIssues, type ReceiptAnchor } from "../receiptAnchors.js";
import { receiptJcs } from "../receiptProfile.js";
import type {
  AssetAmount,
  IntentGraph,
  IntentRequest,
  IntentStep,
} from "../intent.js";
import {
  isReceiptableStatus,
  PLAN_RECORD_SPEC_VERSION,
  RECEIPT_DIGEST_PATTERN,
  RECEIPT_ID_PATTERN,
  RECEIPT_INTENT_GROUPS,
  RECEIPT_PROFILES,
  RECEIPT_SALT_PATTERN,
  RECEIPT_SPEC_VERSION,
  RECEIPT_STEP_GROUPS,
  type ReceiptProfile,
  TERMINAL_RECEIPT_STATUSES,
} from "./constants.js";
import type {
  PlanRecord,
  ReceiptAmount,
  ReceiptCollection,
  ReceiptDisclosure,
  ReceiptGroupValue,
  ReceiptIssuer,
  ReceiptPayload,
  ReceiptRequest,
  ReceiptRequestAction,
  ReceiptStepSkeleton,
} from "./types.js";
import {
  intentRef,
  ISO_TIME,
  planRecordDigest,
  receiptCommitment,
  receiptRequestDigest,
} from "./digests.js";

/* ============================================================== projections */

/** Plain decimal text of a finite number (no exponent); null otherwise. */
function decimalText(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  const text = String(Object.is(value, -0) ? 0 : value);
  if (!/e/iu.test(text)) return text;
  const negative = value < 0;
  const [mantissa = "0", exponentText = "0"] = text.replace(/^-/u, "").toLowerCase().split("e");
  const exponent = Number(exponentText);
  const [whole = "0", fraction = ""] = mantissa.split(".");
  const digits = whole + fraction;
  const point = whole.length + exponent;
  let out: string;
  if (point <= 0) out = `0.${"0".repeat(-point)}${digits}`;
  else if (point >= digits.length) out = digits + "0".repeat(point - digits.length);
  else out = `${digits.slice(0, point)}.${digits.slice(point)}`;
  out = out.replace(/^0+(?=\d)/u, "");
  if (out.includes(".")) out = out.replace(/0+$/u, "").replace(/\.$/u, "");
  return `${negative ? "-" : ""}${out}`;
}

/** Safe integers stay numbers; anything else becomes decimal text (the profile has no floats). */
function profileNumber(value: number): number | string {
  return Number.isSafeInteger(value) && !Object.is(value, -0) ? value : decimalText(value) ?? "0";
}

/** USD as a decimal string with 4 decimals, or null when absent or not finite. */
export function receiptUsd(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value) || Math.abs(value) >= 1e15) return null;
  const text = value.toFixed(4);
  return text === "-0.0000" ? "0.0000" : text;
}

const text = (value: string): string => toWellFormedString(value);

function receiptAmount(amount: AssetAmount | undefined): ReceiptAmount | null {
  if (!amount) return null;
  return { asset: amount.asset, symbol: text(amount.symbol), decimals: amount.decimals, amount: amount.amount };
}

function nonNegativeSeconds(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value)) return null;
  return Math.max(0, Math.round(value));
}

/** The request as the receipt profile carries it. */
export function projectRequest(request: IntentRequest): ReceiptRequest {
  const actions = request.actions?.map((action): ReceiptRequestAction => {
    const params = action.params
      ? Object.entries(action.params)
          .map(([key, value]) => {
            const type = typeof value as "string" | "number" | "boolean";
            const shown = typeof value === "number" ? decimalText(value) ?? "0" : String(value);
            return [text(key), type, text(shown)] as const;
          })
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      : undefined;
    return {
      kind: action.kind,
      network: action.network,
      ...(action.from !== undefined ? { from: text(action.from) } : {}),
      ...(action.to !== undefined ? { to: text(action.to) } : {}),
      ...(action.amount !== undefined ? { amount: text(action.amount) } : {}),
      ...(action.toNetwork !== undefined ? { toNetwork: action.toNetwork } : {}),
      ...(action.recipient !== undefined ? { recipient: text(action.recipient) } : {}),
      ...(action.protocol !== undefined ? { protocol: action.protocol } : {}),
      ...(params ? { params } : {}),
      ...(action.contract !== undefined ? { contract: text(action.contract) } : {}),
      ...(action.entry !== undefined ? { entry: text(action.entry) } : {}),
    };
  });
  const constraints = request.constraints;
  const projectedConstraints = constraints
    ? {
        ...(constraints.maxSlippageBps !== undefined ? { maxSlippageBps: profileNumber(constraints.maxSlippageBps) } : {}),
        ...(constraints.deadline !== undefined ? { deadline: profileNumber(constraints.deadline) } : {}),
        ...(constraints.maxFeeUsd !== undefined && decimalText(constraints.maxFeeUsd) !== null ? { maxFeeUsd: decimalText(constraints.maxFeeUsd) as string } : {}),
        ...(constraints.maxSeconds !== undefined ? { maxSeconds: profileNumber(constraints.maxSeconds) } : {}),
        ...(constraints.preferProtocols ? { preferProtocols: [...constraints.preferProtocols] } : {}),
        ...(constraints.avoidProtocols ? { avoidProtocols: [...constraints.avoidProtocols] } : {}),
        ...(constraints.allowTestnets !== undefined ? { allowTestnets: constraints.allowTestnets } : {}),
        ...(constraints.gasOnArrival
          ? {
              gasOnArrival: Object.entries(constraints.gasOnArrival)
                .filter((entry): entry is [string, string] => typeof entry[1] === "string")
                .map(([network, usd]) => [text(network), text(usd)] as const)
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
            }
          : {}),
      }
    : undefined;
  const metadata = request.metadata
    ? Object.entries(request.metadata)
        .map(([key, value]) => [text(key), text(value)] as const)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    : undefined;
  return {
    ...(request.text !== undefined ? { text: text(request.text) } : {}),
    ...(actions ? { actions } : {}),
    accounts: request.accounts.map((account) => text(account)),
    ...(request.defaultNetwork !== undefined ? { defaultNetwork: request.defaultNetwork } : {}),
    ...(request.sourceNetwork !== undefined ? { sourceNetwork: request.sourceNetwork } : {}),
    ...(projectedConstraints ? { constraints: projectedConstraints } : {}),
    ...(metadata ? { metadata } : {}),
    ...(request.clientReference !== undefined ? { clientReference: text(request.clientReference) } : {}),
  };
}

/**
 * The immutable plan record, captured once at planning (also for dry
 * runs). Its digest is `planRecordDigest(record)`.
 */
export function buildPlanRecord(graph: IntentGraph): PlanRecord {
  return {
    spec: PLAN_RECORD_SPEC_VERSION,
    createdAt: graph.createdAt,
    expiresAt: graph.expiresAt,
    interpretation: {
      source: graph.interpretation.source,
      normalizedText: graph.interpretation.normalizedText !== undefined ? text(graph.interpretation.normalizedText) : null,
      confidenceBps: Math.max(0, Math.min(10_000, Math.round((Number.isFinite(graph.interpretation.confidence) ? graph.interpretation.confidence : 0) * 10_000))),
      optimizations: (graph.interpretation.optimizations ?? []).map(text),
    },
    steps: graph.steps.map((step) => ({
      id: step.id,
      kind: step.kind,
      network: step.network,
      account: step.account,
      recipient: step.recipient ?? null,
      recipientName: step.recipientName !== undefined ? text(step.recipientName) : null,
      protocol: step.protocol,
      venue: step.venue ?? null,
      mode: step.mode,
      dependsOn: [...step.dependsOn],
      input: receiptAmount(step.input),
      expectedOutput: receiptAmount(step.expectedOutput),
      minimumOutput: receiptAmount(step.minimumOutput),
      extraCosts: (step.extraCosts ?? []).map((cost) => receiptAmount(cost) as ReceiptAmount),
      feesUsd: receiptUsd(step.feesUsd),
      estimatedSeconds: nonNegativeSeconds(step.estimatedSeconds),
      settlement: step.settlement
        ? {
            kind: step.settlement.kind,
            destinationNetwork: step.settlement.destinationNetwork ?? null,
            expectedSeconds: nonNegativeSeconds(step.settlement.expectedSeconds),
          }
        : null,
      call: step.call
        ? { contract: step.call.contract, revision: step.call.revision, definitionHash: step.call.definitionHash, entry: step.call.entry, target: step.call.target }
        : null,
    })),
    edges: graph.edges.map((edge) => ({ from: edge.from, to: edge.to, kind: edge.kind })),
    warnings: graph.warnings.map(text),
  };
}

/* ================================================================ building */

export interface BuildReceiptInput {
  readonly graph: IntentGraph;
  readonly collection: ReceiptCollection;
  readonly receiptId: string;
  readonly sequence: number;
  readonly supersedes: string | null;
  /** ISO time of issuance; `issuedOn` is its UTC day. */
  readonly issuedAt: string;
  readonly issuer: ReceiptIssuer;
  /** Salt per group path; must return fresh base64url 16-byte salts (`randomReceiptSalt`). */
  readonly salts: (path: string) => string;
}

export interface BuiltReceipt {
  readonly payload: ReceiptPayload;
  readonly disclosures: Readonly<Record<string, ReceiptDisclosure>>;
}

const PROVIDERS: Partial<Record<ProtocolId, { readonly name: "relay" | "lifi" | "debridge"; readonly kind: string }>> = {
  relay: { name: "relay", kind: "request" },
  lifi: { name: "lifi", kind: "transfer" },
  "debridge-dln": { name: "debridge", kind: "order" },
};

const SUBMITTED_NOTE = "References submitted.";

function minIso(values: readonly string[]): string | null {
  let best: string | null = null;
  let bestTime = Number.POSITIVE_INFINITY;
  for (const value of values) {
    const time = Date.parse(value);
    if (Number.isFinite(time) && time < bestTime) {
      best = new Date(time).toISOString();
      bestTime = time;
    }
  }
  return best;
}

function firstSubmittedAt(graph: IntentGraph): string | null {
  const submitted = graph.steps.filter((step) => (step.references ?? []).length > 0);
  if (submitted.length === 0) return null;
  const notes = submitted.flatMap((step) => step.evidence.filter((entry) => entry.kind === "note" && entry.detail === SUBMITTED_NOTE).map((entry) => entry.observedAt));
  return (
    minIso(notes) ??
    minIso(submitted.flatMap((step) => step.evidence.filter((entry) => entry.kind === "transaction" || entry.kind === "receipt").map((entry) => entry.observedAt)))
  );
}

/** Profile-safe copy of an arbitrary JSON-like value (pins): floats/bigints → strings, undefined dropped, odd keys → pairs. */
function profileValue(value: unknown): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return profileNumber(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return text(value);
  if (Array.isArray(value)) return value.map((entry) => (entry === undefined ? null : profileValue(entry)));
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined && typeof entry !== "function");
    if (entries.every(([key]) => /^[A-Za-z0-9_.:-]{1,64}$/u.test(key))) {
      return Object.fromEntries(entries.map(([key, entry]) => [key, profileValue(entry)]));
    }
    return entries.map(([key, entry]) => [text(key), profileValue(entry)]).sort(([a], [b]) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0));
  }
  return null;
}

function laneOf(networks: readonly NetworkKey[]): "production" | "testnet" {
  return networks.some((network) => CHAINS[network].environment === "testnet") ? "testnet" : "production";
}

function stepChains(step: IntentStep): Set<string> {
  const chains = new Set<string>([step.chain]);
  const destination = step.settlement?.destinationNetwork;
  if (destination && isNetworkKey(destination)) chains.add(CHAINS[destination].id);
  return chains;
}

function assertSalt(path: string, salt: unknown): string {
  if (typeof salt !== "string" || !RECEIPT_SALT_PATTERN.test(salt) || base64UrlDecode(salt)?.length !== 16) {
    throw new Error(`Receipt salt for ${path} must be base64url of 16 random bytes.`);
  }
  return salt;
}

/**
 * Builds the signed payload and every disclosure of one receipt (pure; the
 * caller signs `receiptSigningInput(await receiptDigest(payload))`). Throws
 * when the intent is not receiptable, the collection is not `ready`, an
 * anchor sits on a chain the step does not touch, salts are malformed or
 * repeated, or the result falls outside the receipt profile.
 */
export function buildReceipt(input: BuildReceiptInput): BuiltReceipt {
  const { graph, collection, issuer } = input;
  if (!RECEIPT_ID_PATTERN.test(input.receiptId)) throw new Error("receiptId must be rcpt_ + 32 hex characters.");
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) throw new Error("sequence must be a positive integer.");
  if (input.sequence === 1 ? input.supersedes !== null : !(typeof input.supersedes === "string" && RECEIPT_DIGEST_PATTERN.test(input.supersedes))) {
    throw new Error("supersedes must be null for sequence 1 and the previous receipt's digest otherwise.");
  }
  if (!ISO_TIME.test(input.issuedAt)) throw new Error("issuedAt must be an ISO 8601 UTC time.");
  if (issuer.name !== "Kletia" || !issuer.kid) throw new Error("issuer must name Kletia and carry the signing key id.");
  if (!isReceiptableStatus(graph.status)) throw new Error(`Intents in status ${graph.status} get no receipt.`);
  if (collection.state !== "ready") throw new Error(`Receipt inputs are not ready (${collection.state}); never issue on unfinalized data.`);
  if (graph.plan && planRecordDigest(graph.plan.record) !== graph.plan.digest) throw new Error("graph.plan.digest does not match its record.");

  const status = graph.status;
  const usedSalts = new Set<string>();
  const disclosures: Record<string, ReceiptDisclosure> = {};
  const commit = (path: string, value: ReceiptGroupValue): string => {
    const salt = assertSalt(path, input.salts(path));
    if (usedSalts.has(salt)) throw new Error(`Receipt salt for ${path} repeats another group's salt; salts must be fresh.`);
    usedSalts.add(salt);
    const disclosure = { salt, value };
    disclosures[path] = disclosure;
    return receiptCommitment(path, disclosure);
  };

  const networks: NetworkKey[] = [];
  const addNetwork = (network: NetworkKey | undefined) => {
    if (network && !networks.includes(network)) networks.push(network);
  };
  for (const step of graph.steps) {
    addNetwork(step.network);
    addNetwork(step.settlement?.destinationNetwork);
  }

  const anchorsOf = (step: IntentStep): readonly ReceiptAnchor[] => collection.anchors[step.id] ?? [];
  let anchorCount = 0;
  for (const step of graph.steps) {
    const chains = stepChains(step);
    for (const anchor of anchorsOf(step)) {
      const issues = receiptAnchorIssues(anchor);
      if (issues.length > 0) throw new Error(`Anchor of step ${step.id} is malformed (${issues.join(", ")}).`);
      if (!chains.has(anchor.chain)) throw new Error(`Anchor ${anchor.vm === "evm" ? anchor.tx : anchor.signature} of step ${step.id} is on ${anchor.chain}, which the step does not touch.`);
      anchorCount += 1;
    }
  }
  if (status === "cancelled" && anchorCount > 0) throw new Error("A cancelled intent cannot carry anchors.");

  const finishedAt = new Date(Date.parse(graph.updatedAt)).toISOString();
  const submittedAt = firstSubmittedAt(graph);
  const plannedSteps = new Map((graph.plan?.record.steps ?? []).map((step) => [step.id, step]));
  const fundedTargets = new Set(graph.edges.filter((edge) => edge.kind === "funds").map((edge) => edge.to));
  const fundingSources = new Set(graph.edges.filter((edge) => edge.kind === "funds").map((edge) => edge.from));

  const request = projectRequest(graph.request);
  const intentCommitments = {
    request: commit("intent.request", { requestDigest: receiptRequestDigest(request), request }),
    plan: commit(
      "intent.plan",
      graph.plan ? { planDigest: graph.plan.digest, plan: graph.plan.record } : { planDigest: null, plan: null, reason: "intent created before plan records" },
    ),
    timing: commit("intent.timing", {
      createdAt: graph.createdAt,
      firstSubmittedAt: submittedAt,
      finishedAt,
      issuedAt: input.issuedAt,
      finalityHeads: collection.finalityHeads.map((head) => ({ ...head })),
      finalityMode: collection.finalityMode.map((mode) => ({ ...mode })),
    }),
    outcome: commit("intent.outcome", {
      title: text(graph.summary.title),
      inputs: graph.steps
        .filter((step) => !fundedTargets.has(step.id) && (step.references ?? []).length > 0 && step.input)
        .map((step) => receiptAmount(step.input) as ReceiptAmount),
      outputs: graph.steps
        .filter((step) => !fundingSources.has(step.id) && step.actualOutput)
        .map((step) => receiptAmount(step.actualOutput) as ReceiptAmount),
      totalFeesUsd: receiptUsd(graph.summary.totalFeesUsd),
      warnings: graph.warnings.map(text),
    }),
  };

  const steps = graph.steps.map((step): ReceiptStepSkeleton => {
    const anchors = anchorsOf(step);
    const provider = step.settlement?.trackingId && PROVIDERS[step.protocol]
      ? { ...(PROVIDERS[step.protocol] as { name: "relay" | "lifi" | "debridge"; kind: string }), trackingId: text(step.settlement.trackingId) }
      : null;
    const crossNetwork = step.settlement?.kind === "cross-network";
    const planned = plannedSteps.get(step.id);
    const quotes = step.evidence
      .filter((entry) => entry.kind === "quote" && typeof entry.reference === "string" && RECEIPT_DIGEST_PATTERN.test(entry.reference))
      .map((entry) => ({ binding: entry.reference as string, preparedAt: entry.observedAt }));
    if (step.prepared && !quotes.some((quote) => quote.binding === step.prepared?.quoteBinding)) {
      quotes.push({ binding: step.prepared.quoteBinding, preparedAt: step.prepared.preparedAt });
    }
    const landedBinding = collection.landedBindings[step.id] ?? null;
    if (landedBinding !== null && !quotes.some((quote) => quote.binding === landedBinding)) {
      throw new Error(`Step ${step.id}: the landed binding is not one of the step's prepared payloads.`);
    }
    const call = step.call;
    const commitments = {
      parties: commit(`steps.${step.id}.parties`, {
        account: step.account,
        recipient: step.recipient ?? null,
        recipientName: step.recipientName !== undefined ? text(step.recipientName) : null,
        destinationAccount: crossNetwork ? step.recipient ?? null : null,
      }),
      amounts: commit(`steps.${step.id}.amounts`, {
        input: receiptAmount(step.input),
        expectedOutput: receiptAmount(step.expectedOutput),
        minimumOutput: receiptAmount(step.minimumOutput),
        actualOutput: receiptAmount(step.actualOutput),
        plannedInput: planned?.input?.amount ?? null,
        plannedMinimum: planned?.minimumOutput?.amount ?? null,
        extraCosts: (step.extraCosts ?? []).map((cost) => receiptAmount(cost) as ReceiptAmount),
        feesUsd: receiptUsd(step.feesUsd),
      }),
      evidence: commit(`steps.${step.id}.evidence`, {
        quotes,
        landedBinding,
        anchors: anchors.map((anchor) => ({ ...anchor })),
        provider,
        contract: call
          ? {
              contractId: call.contract,
              pins: profileValue(call.pins ?? call.programs ?? null),
              reviewDigest: sha256Hex(receiptJcs(profileValue(call.review))),
            }
          : null,
        failure: step.failure ? { code: step.failure.code, message: text(step.failure.message) } : null,
        notes: step.evidence
          .filter((entry) => typeof entry.detail === "string" && entry.detail.length > 0)
          .map((entry) => ({ kind: entry.kind, observedAt: entry.observedAt, detail: text(entry.detail as string) })),
      }),
    };
    return {
      id: step.id,
      index: step.index,
      kind: step.kind,
      network: step.network,
      chain: step.chain,
      protocol: step.protocol,
      mode: step.mode,
      status: step.status,
      dependsOn: [...step.dependsOn],
      settlement: step.settlement ? { kind: step.settlement.kind, destinationNetwork: step.settlement.destinationNetwork ?? null } : null,
      assets: { input: step.input?.asset ?? null, output: (step.expectedOutput ?? step.minimumOutput ?? step.actualOutput)?.asset ?? null },
      venue: step.venue ?? null,
      contract: call
        ? {
            integrator: text(call.integrator.name),
            domainVerified: call.integrator.domainVerified,
            vm: call.vm,
            target: call.target,
            function: call.function ?? null,
            definitionHash: call.definitionHash,
            revision: call.revision,
          }
        : null,
      failure: step.failure ? { code: step.failure.code } : null,
      evidenceClass: anchors.length === 0 ? "none" : provider ? "onchain+provider" : "onchain",
      commitments,
    };
  });

  const durationSeconds = submittedAt === null ? null : Math.max(0, Math.round((Date.parse(finishedAt) - Date.parse(submittedAt)) / 1000));
  const payload: ReceiptPayload = {
    spec: RECEIPT_SPEC_VERSION,
    receiptId: input.receiptId,
    sequence: input.sequence,
    supersedes: input.supersedes,
    issuedOn: input.issuedAt.slice(0, 10),
    issuer: { name: "Kletia", origin: text(issuer.origin), apiVersion: text(issuer.apiVersion), kid: issuer.kid },
    intent: {
      ref: intentRef(graph.id),
      spec: graph.spec,
      status,
      terminal: (TERMINAL_RECEIPT_STATUSES as readonly string[]).includes(status),
      lane: laneOf(networks),
      source: graph.interpretation.source,
      networks,
      finishedOn: finishedAt.slice(0, 10),
      durationSeconds,
      finality: anchorCount > 0 ? "finalized" : "none",
      commitments: intentCommitments,
    },
    steps,
    edges: graph.edges.map((edge) => ({ from: edge.from, to: edge.to, kind: edge.kind })),
  };
  // Throws ReceiptProfileError (with a path) if anything slipped outside the profile.
  receiptJcs(payload);
  return { payload, disclosures };
}

/** Every commitment slot of a payload (`intent.request`, …, `steps.<id>.evidence`). */
export function receiptGroupSlots(payload: Pick<ReceiptPayload, "steps">): string[] {
  return [
    ...RECEIPT_INTENT_GROUPS.map((group) => `intent.${group}`),
    ...payload.steps.flatMap((step) => RECEIPT_STEP_GROUPS.map((group) => `steps.${step.id}.${group}`)),
  ];
}

/** Expands group patterns (`steps.*.evidence`) or a profile name into the concrete slots of a payload. */
export function receiptGroupPaths(patterns: ReceiptProfile | readonly string[], payload: Pick<ReceiptPayload, "steps">): string[] {
  const list = typeof patterns === "string" ? RECEIPT_PROFILES[patterns] : patterns;
  const slots = receiptGroupSlots(payload);
  const out: string[] = [];
  for (const pattern of list) {
    const matches = pattern.includes("*") ? slots.filter((slot) => matchesPattern(pattern, slot)) : slots.filter((slot) => slot === pattern);
    for (const match of matches) if (!out.includes(match)) out.push(match);
  }
  return out;
}

function matchesPattern(pattern: string, slot: string): boolean {
  const parts = pattern.split(".");
  const target = slot.split(".");
  return parts.length === target.length && parts.every((part, index) => part === "*" || part === target[index]);
}

/** The subset of disclosures for the given paths (holders share any subset; the signature still verifies). */
export function selectReceiptDisclosures(
  disclosures: Readonly<Record<string, ReceiptDisclosure>>,
  paths: readonly string[],
): Record<string, ReceiptDisclosure> {
  const out: Record<string, ReceiptDisclosure> = {};
  for (const path of paths) {
    const disclosure = disclosures[path];
    if (disclosure) out[path] = disclosure;
  }
  return out;
}
