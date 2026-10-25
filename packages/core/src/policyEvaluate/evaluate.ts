/**
 * Evaluates one Rule Book against policy facts.
 */
import { CHAINS } from "../chains.js";
import { protocolDependencies } from "../protocols.js";
import {
  accountMatchesPattern,
  AGENT_POLICY_DEFAULTS,
  formatUsdMicros,
  OBSERVER_POLICY,
  policyUsdMicros,
  POLICY_LIMITS,
  type PolicyDocument,
} from "../policy.js";
import {
  observedProtocol,
  policyErrorCode,
  type PolicyEvaluation,
  type PolicyEvaluationContext,
  type PolicyFacts,
  type PolicyOutcome,
  type PolicyRuleId,
  type PolicyRuleResult,
  type PolicyViolation,
  type StepFacts,
} from "./rules.js";
import {
  assetMatchesEntry,
  inputUnknown,
  isOwnAccount,
  laneOf,
  listedForPolicy,
  normalizeAssetIdText,
  policyNotionalUsdMicros,
  REGISTRY,
} from "./facts.js";
import { scheduleState } from "./constraints.js";

/**
 * Evaluates one rule book against facts. Runs every rule so the
 * explanation is complete; the outcome is the worst of the lattice
 * `allow < confirm < deny`. A null document is no rule book (project
 * defaults) or the `observer` template (agent defaults).
 */
export function evaluatePolicy(policy: PolicyDocument | null, facts: PolicyFacts, context: PolicyEvaluationContext): PolicyEvaluation {
  const agent = context.defaults === "agent";
  const doc: PolicyDocument = policy ?? (agent ? OBSERVER_POLICY : { schema: "kletia.policy/v1" });
  const tag = { scope: context.scope, ...(context.keyId !== undefined ? { keyId: context.keyId } : {}) };
  const rules: PolicyRuleResult[] = [];
  const violations: PolicyViolation[] = [];
  const triggers: PolicyViolation[] = [];
  const warnings: string[] = [];
  let retryAfterSeconds: number | null = null;
  const stage = facts.stage;
  const enforcing = stage === "prepare" || stage === "sign";

  const pass = (rule: PolicyRuleId, detail: Partial<PolicyRuleResult> = {}) => rules.push({ rule, ...tag, status: "pass", ...detail });
  const fail = (rule: PolicyRuleId, message: string, detail: { path?: string; observed?: string; limit?: string } = {}) => {
    const violation: PolicyViolation = { rule, ...tag, message, ...detail };
    violations.push(violation);
    rules.push({ rule, ...tag, status: "fail", message, ...detail });
  };
  const raise = (rule: PolicyRuleId, message: string, detail: { path?: string; observed?: string; limit?: string } = {}) => {
    triggers.push({ rule, ...tag, message, ...detail });
    rules.push({ rule, ...tag, status: "trigger", message, ...detail });
  };
  /** Runs a per-item rule: one result, failing on the first offender (every offender is listed in violations). */
  const each = <T>(rule: PolicyRuleId, items: readonly T[], test: (item: T) => { path: string; message: string; observed?: string } | null, limit?: string) => {
    let failed = false;
    for (const item of items) {
      const problem = test(item);
      if (problem) {
        failed = true;
        fail(rule, problem.message, { path: problem.path, ...(problem.observed !== undefined ? { observed: problem.observed } : {}), ...(limit !== undefined ? { limit } : {}) });
      }
    }
    if (!failed) pass(rule, limit !== undefined ? { limit } : {});
  };

  const own = facts.accounts;
  const steps = facts.steps.map((step) => ({ ...step, external: step.external || !isOwnAccount(own, step.recipient) }));
  const assetsOf = (step: StepFacts) => [
    ...(step.input ? [{ asset: step.input, path: `steps[${step.index}].input` }] : []),
    ...(step.output ? [{ asset: step.output, path: `steps[${step.index}].output` }] : []),
  ];
  const networksOf = (step: StepFacts) => [
    { network: step.network, path: `steps[${step.index}].network` },
    ...(step.destinationNetwork && step.destinationNetwork !== step.network ? [{ network: step.destinationNetwork, path: `steps[${step.index}].destinationNetwork` }] : []),
  ];

  // Article 1: service.
  if (context.keyActive === false) fail("key.status", "The key or one of its ancestors is revoked or expired.");
  else if (context.keyActive === true) pass("key.status");
  const mode = doc.mode ?? "live";
  if (mode === "paused") fail("mode.paused", "The rule book is paused: nothing is planned or prepared.", { observed: "paused" });
  else pass("mode.paused", { observed: mode });
  if (mode === "dry-run") {
    if (facts.stored || enforcing) fail("mode.dryRun", "The rule book is in dry-run mode: plans and quotes only, nothing is stored or prepared.", { observed: facts.stored ? "stored intent" : stage });
    else pass("mode.dryRun", { observed: "dry run" });
  }
  if (agent && facts.stored) {
    const allowed = doc.permissions?.storeIntents ?? AGENT_POLICY_DEFAULTS.permissions.storeIntents;
    if (!allowed) fail("permissions.storeIntents", "This agent key may not store intents.");
    else pass("permissions.storeIntents");
  }

  // Article 2: lines.
  const allSteps = steps;
  if (doc.networks?.allow) {
    const allow = doc.networks.allow;
    each("networks.allow", allSteps.flatMap(networksOf), (entry) => (allow.includes(entry.network) ? null : { path: entry.path, message: `${CHAINS[entry.network].name} is not an allowed network.`, observed: entry.network }), allow.join(", "));
  }
  if (doc.networks?.lanes) {
    const lanes = doc.networks.lanes as readonly string[];
    each("networks.lanes", allSteps.flatMap(networksOf), (entry) => (lanes.includes(laneOf(entry.network)) ? null : { path: entry.path, message: `${CHAINS[entry.network].name} is on the ${laneOf(entry.network)} lane.`, observed: laneOf(entry.network) }), lanes.join(", "));
  }

  // Article 3: carriers.
  if (doc.kinds?.allow) {
    const allow = doc.kinds.allow;
    each("kinds.allow", allSteps, (step) => (allow.includes(step.kind) ? null : { path: `steps[${step.index}].kind`, message: `Step kind ${step.kind} is not allowed.`, observed: step.kind }), allow.join(", "));
  }
  // A step uses its protocol and every protocol it is routed through (Raydium swaps run through
  // the Jupiter program): an allow list must allow all of them, a deny of any of them denies the step.
  if (doc.protocols?.allow) {
    const allow = doc.protocols.allow;
    each(
      "protocols.allow",
      allSteps,
      (step) => {
        const missing = protocolDependencies(step.protocol).find((protocol) => !allow.includes(protocol));
        if (missing === undefined) return null;
        const message = missing === step.protocol ? `${step.protocol} is not an allowed protocol.` : `${step.protocol} runs through ${missing}, which is not an allowed protocol.`;
        return { path: `steps[${step.index}].protocol`, message, observed: observedProtocol(step.protocol) };
      },
      allow.join(", "),
    );
  }
  if (doc.protocols?.deny) {
    const denied = doc.protocols.deny;
    each(
      "protocols.deny",
      allSteps,
      (step) => {
        const hit = protocolDependencies(step.protocol).find((protocol) => denied.includes(protocol));
        if (hit === undefined) return null;
        const message = hit === step.protocol ? `${step.protocol} is denied.` : `${step.protocol} runs through ${hit}, which is denied.`;
        return { path: `steps[${step.index}].protocol`, message, observed: observedProtocol(step.protocol) };
      },
      denied.join(", "),
    );
  }

  // Article 4: private sidings.
  const contractAllow = doc.contracts?.allow ?? (agent ? AGENT_POLICY_DEFAULTS.contractsAllow : undefined);
  if (contractAllow) {
    const contractSteps = allSteps.filter((step) => step.kind === "call" || step.kind === "action" || step.contract !== undefined);
    each(
      "contracts.allow",
      contractSteps,
      (step) => {
        const listed = step.contract ? contractAllow.find((entry) => entry.id === step.contract?.id) : undefined;
        const ok = listed !== undefined && (listed.entries === undefined || listed.entries.includes(step.contract?.entry ?? ""));
        return ok
          ? null
          : { path: `steps[${step.index}].contract`, message: step.contract ? `Registration ${step.contract.id} entry ${step.contract.entry} is not listed.` : "A custom contract step without a registration.", observed: step.contract ? `${step.contract.id}:${step.contract.entry}` : "unknown" };
      },
      contractAllow.map((entry) => entry.id).join(", ") || "none",
    );
  }

  // Article 5: cargo.
  const stepAssets = allSteps.flatMap(assetsOf);
  if (doc.assets?.allow) {
    const allow = doc.assets.allow;
    each("assets.allow", stepAssets, (entry) => (allow.some((pattern) => assetMatchesEntry(entry.asset.asset, pattern)) ? null : { path: entry.path, message: `${entry.asset.symbol} is not an allowed asset.`, observed: entry.asset.asset }), allow.join(", "));
  }
  if (doc.assets?.categories) {
    const categories = doc.assets.categories as readonly string[];
    each(
      "assets.categories",
      stepAssets,
      (entry) => {
        const descriptor = REGISTRY.get(normalizeAssetIdText(entry.asset.asset));
        return descriptor && categories.includes(descriptor.category) ? null : { path: entry.path, message: `${entry.asset.symbol} is not in an allowed category.`, observed: descriptor?.category ?? "unlisted" };
      },
      categories.join(", "),
    );
  }
  const unlisted = doc.assets?.unlisted ?? (agent ? AGENT_POLICY_DEFAULTS.assetsUnlisted : "allow");
  if (unlisted === "deny") {
    each("assets.unlisted", stepAssets, (entry) => (listedForPolicy(entry.asset.asset) ? null : { path: entry.path, message: `${entry.asset.asset} is not a listed token.`, observed: entry.asset.asset }), "listed tokens only");
  }

  // Article 6: passengers.
  if (doc.accounts?.allow) {
    const allow = doc.accounts.allow;
    each(
      "accounts.allow",
      facts.accounts.map((account, index) => ({ account, index })),
      (entry) => (allow.some((pattern) => accountMatchesPattern(entry.account, pattern)) ? null : { path: `accounts[${entry.index}]`, message: `${entry.account} is not a pinned account.`, observed: entry.account }),
      `${allow.length} pinned`,
    );
  }

  // Article 7: destinations.
  const recipients = doc.recipients;
  const names = recipients?.names ?? "resolve";
  const nameOf = (step: StepFacts) => step.recipientName?.trim().toLowerCase();
  if (recipients?.deny) {
    const denied = recipients.deny;
    each(
      "recipients.deny",
      allSteps,
      (step) =>
        denied.some((pattern) => accountMatchesPattern(step.recipient, pattern) || (nameOf(step) !== undefined && pattern.trim().toLowerCase() === nameOf(step)))
          ? { path: `steps[${step.index}].recipient`, message: "The recipient is denied.", observed: step.recipientName ? `${step.recipientName} (${step.recipient})` : step.recipient }
          : null,
      `${denied.length} denied`,
    );
  }
  const recipientMode = recipients?.mode ?? (agent ? AGENT_POLICY_DEFAULTS.recipientsMode : "any");
  if (recipientMode !== "any") {
    const allow = recipients?.allow ?? [];
    each(
      "recipients.mode",
      allSteps,
      (step) => {
        if (!step.external) return null;
        if (recipientMode === "allowlist") {
          if (allow.some((pattern) => accountMatchesPattern(step.recipient, pattern))) return null;
          const name = nameOf(step);
          if (names === "trusted" && name !== undefined && allow.some((pattern) => pattern.trim().toLowerCase() === name)) return null;
        }
        return {
          path: `steps[${step.index}].recipient`,
          message: recipientMode === "own" ? "Recipient is not one of the request's accounts." : "Recipient is neither one of the request's accounts nor allowed.",
          observed: step.recipient,
        };
      },
      recipientMode,
    );
  }
  if (names === "deny") {
    each("recipients.names", allSteps, (step) => (step.recipientName ? { path: `steps[${step.index}].recipientName`, message: "Recipients given as names are not allowed.", observed: step.recipientName } : null), "deny");
  }

  // Article 8: fares.
  const notional = policyNotionalUsdMicros(allSteps);
  const unpricedNeeds: string[] = [];
  const limits = doc.limits;
  if (limits?.maxSteps !== undefined) {
    const count = Math.max(facts.intent.stepCount, allSteps.length);
    if (count > limits.maxSteps) fail("limits.maxSteps", `${count} steps exceed the limit.`, { observed: String(count), limit: String(limits.maxSteps) });
    else pass("limits.maxSteps", { observed: String(count), limit: String(limits.maxSteps) });
  }
  if (limits?.maxSlippageBps !== undefined) {
    const max = limits.maxSlippageBps;
    each("limits.maxSlippageBps", allSteps, (step) => (step.slippageBps > max ? { path: `steps[${step.index}].slippageBps`, message: `Slippage ${step.slippageBps} bps exceeds the limit.`, observed: String(step.slippageBps) } : null), String(max));
  }
  if (limits?.maxExtraCostUsd !== undefined) {
    const max = policyUsdMicros(limits.maxExtraCostUsd);
    each(
      "limits.maxExtraCostUsd",
      allSteps.filter((step) => step.extraCosts.length > 0),
      (step) => {
        if (step.extraCosts.some((cost) => cost.usdMicros === null)) {
          unpricedNeeds.push(`steps[${step.index}].extraCosts`);
          return null;
        }
        const total = step.extraCosts.reduce((sum, cost) => sum + (cost.usdMicros as bigint), 0n);
        return total > max ? { path: `steps[${step.index}].extraCosts`, message: `Extra costs of $${formatUsdMicros(total)} exceed the limit.`, observed: formatUsdMicros(total) } : null;
      },
      formatUsdMicros(max),
    );
  }
  if (limits?.maxFeeUsd !== undefined) {
    const max = policyUsdMicros(limits.maxFeeUsd);
    const fees = facts.intent.feesUsdMicros;
    if (fees === null) fail("limits.maxFeeUsd", "Network fees are unknown for at least one step, so the fee limit cannot be checked.", { path: "intent.feesUsd", observed: "unknown", limit: formatUsdMicros(max) });
    else if (fees > max) fail("limits.maxFeeUsd", `Estimated fees of $${formatUsdMicros(fees)} exceed the limit.`, { path: "intent.feesUsd", observed: formatUsdMicros(fees), limit: formatUsdMicros(max) });
    else pass("limits.maxFeeUsd", { observed: formatUsdMicros(fees), limit: formatUsdMicros(max) });
  }
  if (limits?.maxSeconds !== undefined) {
    const max = limits.maxSeconds;
    each(
      "limits.maxSeconds",
      allSteps.filter((step) => step.destinationNetwork !== undefined && step.destinationNetwork !== step.network),
      (step) =>
        step.estimatedSeconds === undefined
          ? { path: `steps[${step.index}].estimatedSeconds`, message: "The settlement time of this cross-network step is unknown.", observed: "unknown" }
          : step.estimatedSeconds > max
            ? { path: `steps[${step.index}].estimatedSeconds`, message: `Settlement estimate ${step.estimatedSeconds} s exceeds the limit.`, observed: String(step.estimatedSeconds) }
            : null,
      String(max),
    );
  }
  const caps = doc.caps;
  if (caps?.perStepUsd !== undefined) {
    const max = policyUsdMicros(caps.perStepUsd);
    each(
      "caps.perStepUsd",
      allSteps.filter((step) => step.input !== undefined || inputUnknown(step)),
      (step) => {
        const value = step.input?.usdMicros ?? null;
        if (value === null) {
          unpricedNeeds.push(`steps[${step.index}].input`);
          return null;
        }
        return value > max ? { path: `steps[${step.index}].input`, message: `Step notional $${formatUsdMicros(value)} exceeds the per-step cap.`, observed: formatUsdMicros(value) } : null;
      },
      formatUsdMicros(max),
    );
  }
  const needNotional = (rule: PolicyRuleId): bigint | null => {
    if (notional.value === null) unpricedNeeds.push(...notional.unpriced.map((path) => `${path} (${rule})`));
    return notional.value;
  };
  if (caps?.perIntentUsd !== undefined) {
    const max = policyUsdMicros(caps.perIntentUsd);
    const value = needNotional("caps.perIntentUsd");
    if (value !== null && value > max) fail("caps.perIntentUsd", `The intent moves $${formatUsdMicros(value)}, above the per-intent cap.`, { observed: formatUsdMicros(value), limit: formatUsdMicros(max) });
    else if (value !== null) pass("caps.perIntentUsd", { observed: formatUsdMicros(value), limit: formatUsdMicros(max) });
  }
  for (const [rule, cap, used] of [
    ["caps.dailyUsd", caps?.dailyUsd, context.usage?.dayUsdMicros],
    ["caps.weeklyUsd", caps?.weeklyUsd, context.usage?.weekUsdMicros],
  ] as const) {
    if (cap === undefined || used === undefined) continue;
    const max = policyUsdMicros(cap);
    const delta = context.windowDeltaUsdMicros ?? needNotional(rule);
    if (delta === null) continue;
    const observedText = `${formatUsdMicros(delta)} + ${formatUsdMicros(used)} used`;
    if (used + delta > max) fail(rule, `This would move $${formatUsdMicros(used + delta)} in the window, above the cap.`, { observed: observedText, limit: formatUsdMicros(max) });
    else pass(rule, { observed: observedText, limit: formatUsdMicros(max) });
  }

  // Article 9: timetable.
  if (doc.schedule) {
    const state = scheduleState(doc.schedule, context.now ?? Date.now());
    if (state.open) pass("schedule.window", { observed: "open", limit: doc.schedule.timezone });
    else {
      const message = state.error
        ? `The time zone ${doc.schedule.timezone} cannot be evaluated here.`
        : `Outside every window of the timetable (${doc.schedule.timezone})${state.nextChange ? `; opens ${state.nextChange}` : ""}.`;
      if (enforcing) {
        fail("schedule.window", message, { observed: "closed", limit: doc.schedule.timezone });
        if (state.retryAfterSeconds !== null) retryAfterSeconds = state.retryAfterSeconds;
      } else {
        rules.push({ rule: "schedule.window", ...tag, status: "warn", message, observed: "closed", limit: doc.schedule.timezone });
        warnings.push(message);
      }
    }
  }

  // Article 10: inspection.
  const confirm = doc.confirm;
  if (confirm?.aboveUsd !== undefined) {
    const threshold = policyUsdMicros(confirm.aboveUsd);
    const value = needNotional("confirm.aboveUsd");
    if (value !== null && value > threshold) raise("confirm.aboveUsd", `The intent moves $${formatUsdMicros(value)}, above the confirmation threshold.`, { observed: formatUsdMicros(value), limit: formatUsdMicros(threshold) });
    else if (value !== null) pass("confirm.aboveUsd", { observed: formatUsdMicros(value), limit: formatUsdMicros(threshold) });
  }
  const when = confirm?.when ?? [];
  if (when.includes("external-recipient")) {
    const external = allSteps.find((step) => step.external);
    if (external) raise("confirm.externalRecipient", "A step pays a recipient outside the request's accounts.", { path: `steps[${external.index}].recipient`, observed: external.recipient });
    else pass("confirm.externalRecipient");
  }
  if (when.includes("contract-call")) {
    const call = allSteps.find((step) => step.kind === "call" || step.kind === "action" || step.contract !== undefined);
    if (call) raise("confirm.contractCall", "A step calls a custom contract.", { path: `steps[${call.index}].contract`, observed: call.contract?.id ?? call.kind });
    else pass("confirm.contractCall");
  }
  if (when.includes("cross-network")) {
    if (facts.intent.crossNetwork || allSteps.some((step) => step.destinationNetwork !== undefined && step.destinationNetwork !== step.network)) raise("confirm.crossNetwork", "The intent crosses networks.");
    else pass("confirm.crossNetwork");
  }

  if (unpricedNeeds.length > 0) {
    fail("pricing.unavailable", "No fresh price for an amount a USD rule needs; refused until a price source answers.", { path: unpricedNeeds[0] as string, observed: [...new Set(unpricedNeeds)].slice(0, 5).join(", ") });
  }

  const outcome: PolicyOutcome = violations.length > 0 ? "deny" : triggers.length > 0 ? "confirm" : "allow";
  return {
    outcome,
    violations: violations.slice(0, POLICY_LIMITS.violationsReturned),
    allViolations: violations,
    triggers,
    rules,
    warnings,
    notionalUsdMicros: notional.value,
    code: policyErrorCode(violations),
    retryAfterSeconds: violations.some((violation) => violation.rule === "schedule.window") ? retryAfterSeconds : null,
  };
}
