/**
 * The policy-bound signer (policy design §12.1.3): a local check that runs
 * before every signature an agent key's intents ask for. It refuses unless
 *
 * 1. the key's own rule book is exactly the one the operator pinned (the
 *    agent cannot be loosened without the operator re-pinning), the key and
 *    its ancestors are active, and optional ancestor pins hold;
 * 2. the intent is stamped for this key (`intent.policy.keyId`) with `allow`,
 *    or `confirm` with an approved approval whose digest is the intent's;
 * 3. core `evaluatePolicyChain` allows the prepared intent (USD as reported;
 *    rolling caps are the server's job, everything else is enforced here);
 * 4. the payload bytes are what the step needs: EVM chain, sender, targets
 *    from the core registries, exact approvals, transfers and values, pinned
 *    nonces for signers that honour them; Solana network, fee payer and a
 *    single signer.
 *
 * A refusal throws `KletiaPolicyError` with `stage: "sign"` and nothing is
 * signed. The guard reads from Kletia (rule book, approval) but never writes.
 */
import {
  CHAINS,
  approvalDigest,
  buildPolicyFacts,
  effectiveExecution,
  encodeBase58,
  evaluatePolicyChain,
  getYieldVenue,
  parseAccountId,
  parseAssetId,
  policyErrorCode,
  policyHash,
  venueContracts,
  type IntentGraph,
  type IntentStep,
  type NetworkKey,
  type PolicyChainEntry,
  type PolicyViolation,
  type StepExecutionPayload,
  type TransactionRequest,
} from "@kletia/core";
import type { KletiaClient } from "./client.js";
import { KletiaPolicyError } from "./errors.js";
import type { EffectivePolicyView } from "./types.js";

export interface PolicyGuardOptions {
  /** A client authenticated with the agent key (or a key that may read it). */
  readonly client: KletiaClient;
  /** The agent key whose intents are signed. */
  readonly keyId: string;
  /** Hash (`sha256:…`) of the key's own rule book, from the operator's configuration (never from the agent). */
  readonly pinnedHash: string;
  /** Optional pins of ancestor rule books by id (`key_…` or `prj_…`); `null` pins "no rule book". */
  readonly ancestorPins?: Readonly<Record<string, string | null>>;
  /** Extra local allowlist of networks (steps and destinations). */
  readonly networks?: readonly NetworkKey[];
  /** Clock (tests). */
  readonly now?: () => number;
}

export interface PolicyGuardInput {
  readonly intent: IntentGraph;
  readonly step: IntentStep;
  readonly payload: StepExecutionPayload;
  /** The signer about to sign (its `honorsNonce` declaration). */
  readonly signer?: { readonly honorsNonce?: boolean } | null;
}

export interface PolicyGuard {
  readonly keyId: string;
  readonly pinnedHash: string;
  /** Throws `KletiaPolicyError` (`stage: "sign"`) unless the payload may be signed. */
  check(input: PolicyGuardInput): Promise<void>;
}

const HASH = /^sha256:[0-9a-f]{64}$/u;
const APPROVE = /^0x095ea7b3(0{24}[0-9a-f]{40})([0-9a-f]{64})$/iu;
const TRANSFER = /^0xa9059cbb(0{24}[0-9a-f]{40})([0-9a-f]{64})$/iu;

function refusal(keyId: string, violations: readonly PolicyViolation[], code?: string): KletiaPolicyError {
  const first = violations[0];
  const reason = first ? `${first.message.replace(/\.$/u, "")} (${first.rule})` : "refused";
  return new KletiaPolicyError({
    code: code ?? policyErrorCode(violations) ?? "POLICY_VIOLATION",
    message: `The policy guard refused to sign: ${reason}${violations.length > 1 ? ` (and ${violations.length - 1} more)` : ""}. Nothing was signed.`,
    status: 0,
    issues: violations.slice(0, 20).map((violation) => ({ path: violation.path ?? violation.rule, message: `${violation.message} (${violation.rule})` })),
    policy: { decisionId: null, stage: "sign", outcome: "deny", keyId, violations: violations.slice(0, 20), retryAt: null },
  });
}

/** A guard violation outside the core rule ids (pins, stamps, payload bytes). */
function guardViolation(keyId: string, rule: string, message: string, extra: { path?: string; observed?: string; limit?: string } = {}): PolicyViolation {
  return { rule: rule as PolicyViolation["rule"], scope: "key", keyId, message, ...extra };
}

function addressOf(account: string): string | null {
  return parseAccountId(account)?.address ?? null;
}

function lower(value: string | undefined | null): string {
  return (value ?? "").toLowerCase();
}

function erc20Of(asset: string | undefined): string | null {
  const parsed = parseAssetId(asset);
  return parsed && parsed.assetNamespace === "erc20" ? parsed.reference.toLowerCase() : null;
}

function isNative(asset: string | undefined): boolean {
  return parseAssetId(asset)?.assetNamespace === "slip44";
}

function integer(value: string | undefined): bigint | null {
  return typeof value === "string" && /^\d{1,78}$/u.test(value) ? BigInt(value) : null;
}

/** EVM addresses a step's transactions may call (and approve), from the core registries. */
function evmTargets(step: IntentStep): { readonly calls: Set<string>; readonly spenders: Set<string> } {
  const calls = new Set(venueContracts(step.protocol, step.network).map(lower));
  const spenders = new Set(calls);
  if (step.venue) {
    const venue = getYieldVenue(step.venue);
    if (venue && venue.network === step.network) {
      calls.add(lower(venue.target));
      spenders.add(lower(venue.target));
      if ("spender" in venue && typeof venue.spender === "string") spenders.add(lower(venue.spender));
      if ("nativeRouter" in venue && typeof venue.nativeRouter === "string") calls.add(lower(venue.nativeRouter));
    }
  }
  if (step.call) {
    calls.add(lower(step.call.target));
    spenders.add(lower(step.call.target));
    if (step.call.approvalSpender) spenders.add(lower(step.call.approvalSpender));
  }
  return { calls, spenders };
}

/** Problems with the EVM transactions of a step (policy design §12.1.3 item 4). */
function evmPayloadProblems(step: IntentStep, transactions: readonly TransactionRequest[], pinNonce: boolean, honorsNonce: boolean): { rule: string; message: string; path: string }[] {
  const problems: { rule: string; message: string; path: string }[] = [];
  const chain = CHAINS[step.network];
  const sender = lower(addressOf(step.account));
  const recipient = lower(addressOf(step.recipient ?? step.account));
  const token = erc20Of(step.input?.asset);
  const input = integer(step.input?.amount);
  const { calls, spenders } = evmTargets(step);
  let nativeAllowance = 0n;
  if (isNative(step.input?.asset) && input !== null) nativeAllowance += input;
  for (const cost of step.extraCosts ?? []) {
    const amount = integer(cost.amount);
    if (isNative(cost.asset) && amount !== null) nativeAllowance += amount;
  }
  let valueTotal = 0n;
  transactions.forEach((transaction, index) => {
    const path = `transactions[${index}]`;
    if (transaction.vm !== "evm") {
      problems.push({ rule: "payload.vm", message: `A ${transaction.vm} transaction does not belong to an EVM step.`, path });
      return;
    }
    if (transaction.network !== step.network || transaction.chainId !== chain.evmChainId) problems.push({ rule: "payload.chain", message: `Chain ${transaction.chainId} is not the step's chain ${chain.evmChainId}.`, path });
    if (lower(transaction.from) !== sender) problems.push({ rule: "payload.from", message: "The transaction is not sent by the step account.", path });
    const value = integer(transaction.value);
    if (value === null) {
      problems.push({ rule: "payload.value", message: "The transaction value is not a decimal integer.", path });
      return;
    }
    valueTotal += value;
    if (pinNonce) {
      if (transaction.nonce === undefined || !/^\d{1,20}$/u.test(transaction.nonce)) problems.push({ rule: "execution.pinNonce", message: "The rule book pins nonces but the transaction carries none.", path });
      else if (!honorsNonce) problems.push({ rule: "execution.pinNonce", message: "The rule book pins nonces and this signer does not declare honorsNonce.", path });
    }
    const to = lower(transaction.to);
    const data = lower(transaction.data);
    const approve = APPROVE.exec(data);
    const transfer = TRANSFER.exec(data);
    if (!to) {
      problems.push({ rule: "payload.to", message: "Contract creations are never signed.", path });
      return;
    }
    if (approve) {
      const spender = `0x${(approve[1] as string).slice(24)}`;
      const amount = BigInt(`0x${approve[2] as string}`);
      if (token === null || to !== token) problems.push({ rule: "payload.approve", message: "The approval is for a token other than the step input.", path });
      if (!spenders.has(spender)) problems.push({ rule: "payload.approve", message: `The approval's spender ${spender} is not a contract this step uses.`, path });
      if (input === null || amount > input) problems.push({ rule: "payload.approve", message: "The approval exceeds the step input (unlimited approvals are never signed).", path });
      if (value !== 0n) problems.push({ rule: "payload.value", message: "An approval sends no value.", path });
      return;
    }
    if (token !== null && to === token) {
      if (!transfer || step.kind !== "transfer") {
        problems.push({ rule: "payload.to", message: "The only call to the input token a step may make is an approval (or the transfer of a transfer step).", path });
        return;
      }
      const target = `0x${(transfer[1] as string).slice(24)}`;
      const amount = BigInt(`0x${transfer[2] as string}`);
      if (target !== recipient) problems.push({ rule: "payload.transfer", message: "The transfer pays another recipient than the step's.", path });
      if (input === null || amount !== input) problems.push({ rule: "payload.transfer", message: "The transfer amount differs from the step input.", path });
      if (value !== 0n) problems.push({ rule: "payload.value", message: "A token transfer sends no value.", path });
      return;
    }
    if (step.kind === "transfer" && isNative(step.input?.asset)) {
      if (to !== recipient || data !== "0x") problems.push({ rule: "payload.transfer", message: "A native transfer goes to the step recipient with no calldata.", path });
      return;
    }
    if (!calls.has(to)) problems.push({ rule: "payload.to", message: `${to} is not a contract the step's venue (${step.protocol}) uses.`, path });
  });
  if (valueTotal > nativeAllowance) {
    problems.push({ rule: "payload.value", message: "The payload sends more native value than the step input and its native extra costs.", path: "transactions" });
  }
  return problems;
}

/** Fee payer and signer count of a serialized Solana transaction (legacy or v0); null when unreadable. */
export function solanaTransactionSigners(base64: string): { readonly feePayer: string; readonly requiredSignatures: number; readonly version: "legacy" | 0 } | null {
  let bytes: Uint8Array;
  try {
    const binary = atob(base64);
    bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  } catch {
    return null;
  }
  let offset = 0;
  const compactU16 = (): number | null => {
    let value = 0;
    for (let shift = 0; shift < 21; shift += 7) {
      const byte = bytes[offset];
      if (byte === undefined) return null;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
    }
    return null;
  };
  const signatures = compactU16();
  if (signatures === null || signatures > 64) return null;
  offset += signatures * 64;
  const prefix = bytes[offset];
  if (prefix === undefined) return null;
  let version: "legacy" | 0 = "legacy";
  if (prefix & 0x80) {
    if ((prefix & 0x7f) !== 0) return null; // Unknown message version: refuse rather than guess its layout.
    version = 0;
    offset += 1;
  }
  const requiredSignatures = bytes[offset];
  if (requiredSignatures === undefined) return null;
  offset += 3;
  const keys = compactU16();
  if (keys === null || keys < 1 || offset + 32 > bytes.length) return null;
  const feePayer = encodeBase58(bytes.slice(offset, offset + 32));
  if (signatures !== requiredSignatures) return null;
  return { feePayer, requiredSignatures, version };
}

function solanaPayloadProblems(step: IntentStep, transactions: readonly TransactionRequest[]): { rule: string; message: string; path: string }[] {
  const problems: { rule: string; message: string; path: string }[] = [];
  const account = addressOf(step.account);
  transactions.forEach((transaction, index) => {
    const path = `transactions[${index}]`;
    if (transaction.vm !== "svm") {
      problems.push({ rule: "payload.vm", message: "An EVM transaction does not belong to a Solana step.", path });
      return;
    }
    if (transaction.network !== step.network) problems.push({ rule: "payload.chain", message: `The transaction is for ${transaction.network}, not ${step.network}.`, path });
    const decoded = solanaTransactionSigners(transaction.transaction);
    if (!decoded) {
      problems.push({ rule: "payload.decode", message: "The transaction could not be decoded (legacy and v0 messages only).", path });
      return;
    }
    if (decoded.feePayer !== account || transaction.feePayer !== account) problems.push({ rule: "payload.from", message: "The fee payer is not the step account.", path });
    if (decoded.requiredSignatures !== 1) problems.push({ rule: "payload.signers", message: `The transaction needs ${decoded.requiredSignatures} signatures; only the step account may sign.`, path });
  });
  return problems;
}

function guardPinProblems(options: PolicyGuardOptions, own: { status: string; hash: string | null; document: unknown } | null, effective: EffectivePolicyView | undefined): PolicyViolation[] {
  const { keyId, pinnedHash } = options;
  const out: PolicyViolation[] = [];
  if (!effective) return [guardViolation(keyId, "guard.chain", "Kletia returned no effective chain for this key.")];
  if (!effective.keyActive) out.push(guardViolation(keyId, "key.status", "The key or one of its ancestors is revoked or expired."));
  const ownLevel = effective.levels[effective.levels.length - 1];
  if (!ownLevel || ownLevel.id !== keyId || ownLevel.scope !== "key") out.push(guardViolation(keyId, "guard.chain", "The effective chain does not end with this key."));
  if (!own || own.status !== "active" || own.hash !== pinnedHash || ownLevel?.hash !== pinnedHash) {
    out.push(guardViolation(keyId, "guard.pinnedHash", "The key's active rule book is not the pinned one; the operator must re-pin after a change.", { observed: own?.hash ?? "none", limit: pinnedHash }));
  } else {
    // The document itself must hash to the pin (the server's hash field is not trusted alone).
    let computed: string | null = null;
    try {
      computed = policyHash(own.document);
    } catch {
      computed = null;
    }
    if (computed !== pinnedHash) out.push(guardViolation(keyId, "guard.pinnedHash", "The rule book document does not hash to the pinned hash.", { observed: computed ?? "invalid", limit: pinnedHash }));
  }
  for (const [id, pin] of Object.entries(options.ancestorPins ?? {})) {
    const level = effective.levels.find((candidate) => candidate.id === id);
    if (!level) out.push(guardViolation(keyId, "guard.ancestorPins", `The pinned ancestor ${id} is not in the key's chain.`));
    else if ((level.hash ?? null) !== pin) out.push(guardViolation(keyId, "guard.ancestorPins", `The rule book of ${id} is not the pinned one.`, { observed: level.hash ?? "none", limit: pin ?? "none" }));
  }
  return out;
}

/**
 * Creates the guard and checks the pins once (a mismatch rejects at once,
 * before any intent is executed). Pass it to `executeIntent` as `policyGuard`.
 */
export async function createPolicyGuard(options: PolicyGuardOptions): Promise<PolicyGuard> {
  if (!HASH.test(options.pinnedHash)) throw new TypeError("pinnedHash must be a rule book hash (sha256: followed by 64 lower-case hex characters).");
  for (const [id, pin] of Object.entries(options.ancestorPins ?? {})) {
    if (pin !== null && !HASH.test(pin)) throw new TypeError(`ancestorPins.${id} must be a rule book hash or null.`);
  }
  const now = options.now ?? Date.now;
  const { client, keyId } = options;

  const readChain = async () => {
    const read = await client.policies.get(keyId);
    const head = read.policy;
    const own = head ? { status: head.status, hash: head.hash, document: head.document } : null;
    const problems = guardPinProblems(options, own, read.effective);
    if (problems.length > 0) throw refusal(keyId, problems, problems.some((problem) => problem.rule === "key.status") ? "POLICY_OWNER_REVOKED" : "POLICY_VIOLATION");
    return { effective: read.effective as EffectivePolicyView, own: own?.document };
  };

  await readChain();

  return {
    keyId,
    pinnedHash: options.pinnedHash,
    async check({ intent, step, payload, signer }) {
      const { effective, own } = await readChain();
      const violations: PolicyViolation[] = [];
      // 2. The stamp: this key's intent, allowed or approved.
      const stamp = intent.policy;
      let approval: { status: "approved"; ceilingUsdMicros: bigint } | null = null;
      if (!stamp || stamp.keyId !== keyId) {
        throw refusal(keyId, [guardViolation(keyId, "guard.stamp", stamp ? `The intent belongs to ${stamp.keyId}, not ${keyId}.` : "The intent carries no Rule Book stamp; keyless intents are never signed.")]);
      }
      if (stamp.outcome === "confirm") {
        if (!stamp.approval) throw refusal(keyId, [guardViolation(keyId, "approval.required", "The intent is held for approval but names none.")], "POLICY_APPROVAL_REQUIRED");
        const view = await client.approvals.get(stamp.approval.id);
        if (view.status !== "approved") {
          const rule = view.status === "rejected" ? "approval.rejected" : view.status === "expired" ? "approval.expired" : "approval.required";
          throw refusal(keyId, [guardViolation(keyId, rule, `The approval is ${view.status}.`)]);
        }
        if (view.intentId !== intent.id || view.digest !== approvalDigest(intent, keyId) || !/^\d{1,18}$/u.test(view.signing.ceilingUsdCents)) {
          throw refusal(keyId, [guardViolation(keyId, "approval.stale", "The approval was given for other steps than these.")], "POLICY_APPROVAL_STALE");
        }
        approval = { status: "approved", ceilingUsdMicros: BigInt(view.signing.ceilingUsdCents) * 10_000n };
      } else if (stamp.outcome !== "allow") {
        throw refusal(keyId, [guardViolation(keyId, "guard.stamp", `Unexpected stamp outcome ${String(stamp.outcome)}.`)]);
      }
      // The payload must be cleared by the same chain (hashes root first).
      const chainHashes = effective.chain.map((link) => link.hash);
      if (!payload.policy) violations.push(guardViolation(keyId, "guard.clearance", "The payload carries no Rule Book clearance."));
      else if (JSON.stringify(payload.policy.chainHashes) !== JSON.stringify(chainHashes)) violations.push(guardViolation(keyId, "guard.clearance", "The payload was cleared by another rule book chain than the pinned one."));
      // 3. Core evaluation (no usage: rolling caps are counted by the server).
      const chain: PolicyChainEntry[] = effective.levels.map((level, index) => ({
        policy: index === effective.levels.length - 1 ? ((own as PolicyChainEntry["policy"]) ?? null) : level.document,
        scope: level.scope,
        keyId: level.id,
        defaults: level.defaults,
      }));
      const facts = buildPolicyFacts(intent, { stage: "sign", stored: true });
      const evaluation = evaluatePolicyChain(chain, facts, { now: now(), keyActive: effective.keyActive, approval });
      violations.push(...evaluation.allViolations);
      if (options.networks) {
        for (const network of facts.intent.networks) {
          if (!options.networks.includes(network)) violations.push(guardViolation(keyId, "networks.allow", `${network} is not in the guard's local network allowlist.`, { observed: network, limit: options.networks.join(", ") }));
        }
      }
      // 4. The bytes.
      const pinNonce = effectiveExecution(chain).pinNonce;
      const problems = CHAINS[step.network].vm === "evm"
        ? evmPayloadProblems(step, payload.transactions, pinNonce, signer?.honorsNonce === true)
        : solanaPayloadProblems(step, payload.transactions);
      for (const problem of problems) violations.push(guardViolation(keyId, problem.rule, problem.message, { path: `steps.${step.id}.${problem.path}` }));
      if (violations.length > 0) throw refusal(keyId, violations, evaluation.code ?? undefined);
    },
  };
}
