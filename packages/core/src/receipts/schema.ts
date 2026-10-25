/**
 * Exact-shape schema checks for receipt payloads and disclosure groups.
 */
import { CHAINS, isNetworkKey } from "../chains.js";
import { receiptAnchorIssues } from "../receiptAnchors.js";
import {
  PLAN_RECORD_SPEC_VERSION,
  RECEIPT_DIGEST_PATTERN,
  RECEIPT_ID_PATTERN,
  RECEIPTABLE_STATUSES,
} from "./constants.js";
import type { ReceiptAmount } from "./types.js";
import { DAY, ISO_TIME } from "./digests.js";

/* ------------------------------------------------------------ schema helpers */

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const HEX64 = RECEIPT_DIGEST_PATTERN;
const USD4 = /^-?(?:0|[1-9]\d*)\.\d{4}$/u;
const DECIMAL = /^(?:0|[1-9]\d*)$/u;
const STEP_ID = /^[A-Za-z0-9_-]{1,32}$/u;
const NETWORK_TEXT = /^[a-z0-9-]{1,32}$/u;
const CAIP2_TEXT = /^(?:eip155|solana):[-_a-zA-Z0-9]{1,32}$/u;
const CAIP10_TEXT = /^(?:eip155|solana):[-_a-zA-Z0-9]{1,32}:[-.%a-zA-Z0-9]{1,128}$/u;
const CAIP19_TEXT = /^(?:eip155|solana):[-_a-zA-Z0-9]{1,32}\/[-a-z0-9]{3,8}:[-.%a-zA-Z0-9]{1,128}$/u;
const KINDS = new Set(["swap", "transfer", "bridge", "stake", "unstake", "deposit", "withdraw", "borrow", "repay", "approve", "claim", "read", "call", "action"]);
const STEP_STATUSES = new Set(["pending", "ready", "awaiting_signature", "submitted", "confirmed", "settling", "settled", "failed", "skipped", "indeterminate"]);
const MODES = new Set(["wallet", "settlement", "read"]);

export function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) && keys.every((key) => required.includes(key) || optional.includes(key));
}
const isString = (value: unknown, max = 4096): value is string => typeof value === "string" && value.length <= max;
const isNullable = <T>(value: unknown, test: (entry: unknown) => entry is T): boolean => value === null || test(value);
export const isUint = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isIsoTime = (value: unknown): value is string => typeof value === "string" && ISO_TIME.test(value) && Number.isFinite(Date.parse(value));
export const isDay = (value: unknown): value is string => typeof value === "string" && DAY.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
export const isHex64 = (value: unknown): value is string => typeof value === "string" && HEX64.test(value);
const isUsd = (value: unknown): boolean => value === null || (typeof value === "string" && USD4.test(value));
const isCaip10 = (value: unknown): value is string => typeof value === "string" && CAIP10_TEXT.test(value);

function isReceiptAmount(value: unknown): value is ReceiptAmount {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["asset", "symbol", "decimals", "amount"]) &&
    typeof value.asset === "string" &&
    CAIP19_TEXT.test(value.asset) &&
    isString(value.symbol, 64) &&
    isUint(value.decimals) &&
    value.decimals <= 36 &&
    typeof value.amount === "string" &&
    DECIMAL.test(value.amount)
  );
}
const isAmountOrNull = (value: unknown): boolean => value === null || isReceiptAmount(value);
const isAmountList = (value: unknown): boolean => Array.isArray(value) && value.every(isReceiptAmount);
const isStringList = (value: unknown, max = 4096): boolean => Array.isArray(value) && value.every((entry) => isString(entry, max));

export function payloadSchemaIssues(payload: Record<string, unknown>): string[] {
  const issues: string[] = [];
  const check = (ok: boolean, path: string) => {
    if (!ok) issues.push(path);
  };
  if (!hasExactKeys(payload, ["spec", "receiptId", "sequence", "supersedes", "issuedOn", "issuer", "intent", "steps", "edges"])) return ["payload"];
  check(typeof payload.receiptId === "string" && RECEIPT_ID_PATTERN.test(payload.receiptId), "payload.receiptId");
  check(isUint(payload.sequence) && payload.sequence >= 1, "payload.sequence");
  check(payload.sequence === 1 ? payload.supersedes === null : isHex64(payload.supersedes), "payload.supersedes");
  check(isDay(payload.issuedOn), "payload.issuedOn");
  const issuer = payload.issuer;
  check(
    isRecord(issuer) &&
      hasExactKeys(issuer, ["name", "origin", "apiVersion", "kid"]) &&
      issuer.name === "Kletia" &&
      isString(issuer.origin, 256) &&
      isString(issuer.apiVersion, 32) &&
      isString(issuer.kid, 128),
    "payload.issuer",
  );
  const intent = payload.intent;
  if (
    !isRecord(intent) ||
    !hasExactKeys(intent, ["ref", "spec", "status", "terminal", "lane", "source", "networks", "finishedOn", "durationSeconds", "finality", "commitments"])
  ) {
    issues.push("payload.intent");
  } else {
    check(isHex64(intent.ref), "payload.intent.ref");
    check(intent.spec === "kletia.intent/v1", "payload.intent.spec");
    const status = intent.status;
    check(typeof status === "string" && (RECEIPTABLE_STATUSES as readonly string[]).includes(status), "payload.intent.status");
    check(intent.terminal === (status === "completed" || status === "cancelled"), "payload.intent.terminal");
    check(intent.lane === "production" || intent.lane === "testnet", "payload.intent.lane");
    check(intent.source === "structured" || intent.source === "grammar" || intent.source === "assistant", "payload.intent.source");
    check(Array.isArray(intent.networks) && intent.networks.length > 0 && intent.networks.every((network) => typeof network === "string" && NETWORK_TEXT.test(network)), "payload.intent.networks");
    check(isDay(intent.finishedOn), "payload.intent.finishedOn");
    check(intent.durationSeconds === null || isUint(intent.durationSeconds), "payload.intent.durationSeconds");
    check(intent.finality === "finalized" || intent.finality === "none", "payload.intent.finality");
    const commitments = intent.commitments;
    check(
      isRecord(commitments) && hasExactKeys(commitments, ["request", "plan", "timing", "outcome"]) && Object.values(commitments).every(isHex64),
      "payload.intent.commitments",
    );
  }
  if (!Array.isArray(payload.steps) || payload.steps.length === 0 || payload.steps.length > 16) {
    issues.push("payload.steps");
  } else {
    const ids = new Set<string>();
    payload.steps.forEach((step, index) => {
      const path = `payload.steps[${index}]`;
      if (
        !isRecord(step) ||
        !hasExactKeys(step, ["id", "index", "kind", "network", "chain", "protocol", "mode", "status", "dependsOn", "settlement", "assets", "venue", "contract", "failure", "evidenceClass", "commitments"])
      ) {
        issues.push(path);
        return;
      }
      check(typeof step.id === "string" && STEP_ID.test(step.id) && !ids.has(step.id), `${path}.id`);
      if (typeof step.id === "string") ids.add(step.id);
      check(isUint(step.index), `${path}.index`);
      check(typeof step.kind === "string" && KINDS.has(step.kind), `${path}.kind`);
      check(typeof step.network === "string" && NETWORK_TEXT.test(step.network), `${path}.network`);
      check(typeof step.chain === "string" && CAIP2_TEXT.test(step.chain) && (!isNetworkKey(step.network) || CHAINS[step.network].id === step.chain), `${path}.chain`);
      check(isString(step.protocol, 64), `${path}.protocol`);
      check(typeof step.mode === "string" && MODES.has(step.mode), `${path}.mode`);
      check(typeof step.status === "string" && STEP_STATUSES.has(step.status), `${path}.status`);
      check(isStringList(step.dependsOn, 32), `${path}.dependsOn`);
      const settlement = step.settlement;
      check(
        settlement === null ||
          (isRecord(settlement) &&
            hasExactKeys(settlement, ["kind", "destinationNetwork"]) &&
            (settlement.kind === "same-network" || settlement.kind === "cross-network") &&
            (settlement.destinationNetwork === null || (typeof settlement.destinationNetwork === "string" && NETWORK_TEXT.test(settlement.destinationNetwork)))),
        `${path}.settlement`,
      );
      const assets = step.assets;
      check(
        isRecord(assets) &&
          hasExactKeys(assets, ["input", "output"]) &&
          [assets.input, assets.output].every((asset) => asset === null || (typeof asset === "string" && CAIP19_TEXT.test(asset))),
        `${path}.assets`,
      );
      check(step.venue === null || isString(step.venue, 128), `${path}.venue`);
      const contract = step.contract;
      check(
        contract === null ||
          (isRecord(contract) &&
            hasExactKeys(contract, ["integrator", "domainVerified", "vm", "target", "function", "definitionHash", "revision"]) &&
            isString(contract.integrator, 64) &&
            typeof contract.domainVerified === "boolean" &&
            (contract.vm === "evm" || contract.vm === "svm") &&
            isString(contract.target, 256) &&
            (contract.function === null || isString(contract.function, 512)) &&
            isHex64(contract.definitionHash) &&
            isUint(contract.revision)),
        `${path}.contract`,
      );
      check(step.failure === null || (isRecord(step.failure) && hasExactKeys(step.failure, ["code"]) && isString(step.failure.code, 64)), `${path}.failure`);
      check(step.evidenceClass === "onchain" || step.evidenceClass === "onchain+provider" || step.evidenceClass === "none", `${path}.evidenceClass`);
      const commitments = step.commitments;
      check(
        isRecord(commitments) && hasExactKeys(commitments, ["parties", "amounts", "evidence"]) && Object.values(commitments).every(isHex64),
        `${path}.commitments`,
      );
    });
  }
  check(
    Array.isArray(payload.edges) &&
      payload.edges.every(
        (edge) =>
          isRecord(edge) && hasExactKeys(edge, ["from", "to", "kind"]) && isString(edge.from, 32) && isString(edge.to, 32) && (edge.kind === "funds" || edge.kind === "orders"),
      ),
    "payload.edges",
  );
  return issues;
}

export function groupSchemaIssues(path: string, value: unknown): string[] {
  if (!isRecord(value)) return ["value must be an object"];
  const group = path.split(".").pop();
  const issues: string[] = [];
  const check = (ok: boolean, field: string) => {
    if (!ok) issues.push(field);
  };
  switch (path.startsWith("intent.") ? `intent.${group}` : `step.${group}`) {
    case "intent.request":
      if (!hasExactKeys(value, ["requestDigest", "request"])) return ["fields"];
      check(isHex64(value.requestDigest), "requestDigest");
      check(isRecord(value.request) && isStringList(value.request.accounts, 256), "request");
      return issues;
    case "intent.plan":
      if (!hasExactKeys(value, ["planDigest", "plan"], ["reason"])) return ["fields"];
      check(value.planDigest === null || isHex64(value.planDigest), "planDigest");
      check(value.plan === null || (isRecord(value.plan) && value.plan.spec === PLAN_RECORD_SPEC_VERSION), "plan");
      check(value.reason === undefined || value.reason === "intent created before plan records", "reason");
      return issues;
    case "intent.timing":
      if (!hasExactKeys(value, ["createdAt", "firstSubmittedAt", "finishedAt", "issuedAt", "finalityHeads", "finalityMode"])) return ["fields"];
      check(isIsoTime(value.createdAt), "createdAt");
      check(value.firstSubmittedAt === null || isIsoTime(value.firstSubmittedAt), "firstSubmittedAt");
      check(isIsoTime(value.finishedAt), "finishedAt");
      check(isIsoTime(value.issuedAt), "issuedAt");
      check(
        Array.isArray(value.finalityHeads) &&
          value.finalityHeads.every(
            (head) =>
              isRecord(head) &&
              typeof head.chain === "string" &&
              CAIP2_TEXT.test(head.chain) &&
              ((hasExactKeys(head, ["chain", "block"]) && typeof head.block === "string" && DECIMAL.test(head.block)) ||
                (hasExactKeys(head, ["chain", "slot"]) && typeof head.slot === "string" && DECIMAL.test(head.slot))),
          ),
        "finalityHeads",
      );
      check(
        Array.isArray(value.finalityMode) &&
          value.finalityMode.every(
            (mode) =>
              isRecord(mode) &&
              hasExactKeys(mode, ["chain", "mode"]) &&
              typeof mode.chain === "string" &&
              CAIP2_TEXT.test(mode.chain) &&
              typeof mode.mode === "string" &&
              /^(?:finalized|depth:[1-9]\d{0,5})$/u.test(mode.mode),
          ),
        "finalityMode",
      );
      return issues;
    case "intent.outcome":
      if (!hasExactKeys(value, ["title", "inputs", "outputs", "totalFeesUsd", "warnings"])) return ["fields"];
      check(isString(value.title, 1000), "title");
      check(isAmountList(value.inputs), "inputs");
      check(isAmountList(value.outputs), "outputs");
      check(isUsd(value.totalFeesUsd), "totalFeesUsd");
      check(isStringList(value.warnings), "warnings");
      return issues;
    case "step.parties":
      if (!hasExactKeys(value, ["account", "recipient", "recipientName", "destinationAccount"])) return ["fields"];
      check(isCaip10(value.account), "account");
      check(isNullable(value.recipient, isCaip10), "recipient");
      check(value.recipientName === null || isString(value.recipientName, 253), "recipientName");
      check(isNullable(value.destinationAccount, isCaip10), "destinationAccount");
      return issues;
    case "step.amounts":
      if (!hasExactKeys(value, ["input", "expectedOutput", "minimumOutput", "actualOutput", "plannedInput", "plannedMinimum", "extraCosts", "feesUsd"])) return ["fields"];
      for (const field of ["input", "expectedOutput", "minimumOutput", "actualOutput"]) check(isAmountOrNull(value[field]), field);
      for (const field of ["plannedInput", "plannedMinimum"]) check(value[field] === null || (typeof value[field] === "string" && DECIMAL.test(value[field] as string)), field);
      check(isAmountList(value.extraCosts), "extraCosts");
      check(isUsd(value.feesUsd), "feesUsd");
      return issues;
    case "step.evidence": {
      if (!hasExactKeys(value, ["quotes", "landedBinding", "anchors", "provider", "contract", "failure", "notes"])) return ["fields"];
      check(
        Array.isArray(value.quotes) && value.quotes.every((quote) => isRecord(quote) && hasExactKeys(quote, ["binding", "preparedAt"]) && isHex64(quote.binding) && isIsoTime(quote.preparedAt)),
        "quotes",
      );
      check(value.landedBinding === null || isHex64(value.landedBinding), "landedBinding");
      if (
        isHex64(value.landedBinding) &&
        Array.isArray(value.quotes) &&
        !value.quotes.some((quote) => isRecord(quote) && quote.binding === value.landedBinding)
      ) {
        issues.push("landedBinding is not one of the quotes");
      }
      if (!Array.isArray(value.anchors)) issues.push("anchors");
      else value.anchors.forEach((anchor, index) => issues.push(...receiptAnchorIssues(anchor).map((field) => `anchors[${index}].${field}`)));
      const provider = value.provider;
      check(
        provider === null ||
          (isRecord(provider) &&
            hasExactKeys(provider, ["name", "trackingId", "kind"]) &&
            (provider.name === "relay" || provider.name === "lifi" || provider.name === "debridge") &&
            isString(provider.trackingId, 256) &&
            isString(provider.kind, 32)),
        "provider",
      );
      const contract = value.contract;
      check(
        contract === null ||
          (isRecord(contract) && hasExactKeys(contract, ["contractId", "pins", "reviewDigest"]) && isString(contract.contractId, 64) && isHex64(contract.reviewDigest)),
        "contract",
      );
      check(value.failure === null || (isRecord(value.failure) && hasExactKeys(value.failure, ["code", "message"]) && isString(value.failure.code, 64) && isString(value.failure.message)), "failure");
      check(
        Array.isArray(value.notes) &&
          value.notes.every((note) => isRecord(note) && hasExactKeys(note, ["kind", "observedAt", "detail"]) && isString(note.kind, 32) && isIsoTime(note.observedAt) && isString(note.detail)),
        "notes",
      );
      return issues;
    }
    default:
      return ["unknown group"];
  }
}
