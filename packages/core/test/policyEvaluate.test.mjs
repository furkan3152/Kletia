import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  EXECUTABLE_PROTOCOLS,
  INTENT_DEFAULT_SLIPPAGE_BPS,
  POLICY_DECISION_GENESIS,
  POLICY_ERROR_PRECEDENCE,
  POLICY_RULES,
  YIELD_VENUES,
  approvalCeilingUsdCents,
  approvalDigest,
  approvalMessageText,
  approvalTypedData,
  buildPolicyFacts,
  canonicalJson,
  effectiveExecution,
  effectivePermissions,
  evaluatePolicy,
  evaluatePolicyChain,
  isOwnAccount,
  narrowConstraints,
  policyDecisionChainHash,
  policyErrorCode,
  policyExposureId,
  policyNotionalUsdMicros,
  scheduleState,
  validatePolicy,
  verifyDecisionChain,
} from "../dist/index.js";

const schema = "kletia.policy/v1";
const EVM = "0x8f3c0000000000000000000000000000000aa21b";
const SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const OWN_BASE = `eip155:8453:${EVM}`;
const OWN_ARB = `eip155:42161:${EVM}`;
const OWN_SOL = `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${SOL}`;
const STRANGER = "eip155:8453:0x9999999999999999999999999999999999999999";
const USDC_BASE = "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const USDC_ARB = "eip155:42161/erc20:0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const ETH_BASE = "eip155:8453/slip44:60";
const UNLISTED = "eip155:8453/erc20:0x0000000000000000000000000000000000000abc";
const MON_NOON_UTC = Date.parse("2026-10-12T12:00:00Z");

const usd = (dollars) => BigInt(Math.round(dollars * 1_000_000));
const asset = (id, symbol, dollars, decimals = 6, listed = id !== UNLISTED) => ({ asset: id, symbol, decimals, amount: "1000000", listed, usdMicros: dollars === null ? null : usd(dollars) });
const stepFacts = (overrides = {}) => ({
  id: "s1",
  index: 0,
  kind: "transfer",
  protocol: "erc20-transfer",
  network: "base",
  root: true,
  input: asset(USDC_BASE, "USDC", 100),
  recipient: OWN_BASE,
  external: false,
  slippageBps: 0,
  extraCosts: [],
  ...overrides,
});
const facts = (steps = [stepFacts()], overrides = {}) => ({
  stage: "plan",
  stored: true,
  accounts: [OWN_BASE, OWN_SOL],
  steps,
  intent: { stepCount: steps.length, networks: ["base"], feesUsdMicros: usd(0.1), notionalUsdMicros: null, crossNetwork: false, ...(overrides.intent ?? {}) },
  ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "intent")),
});
const doc = (fields) => {
  const result = validatePolicy({ schema, ...fields });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  return result.value;
};
const run = (fields, factValue = facts(), context = {}) => evaluatePolicy(fields === null ? null : doc(fields), factValue, { scope: "key", keyId: "key_7d2e0000000000000000aaaa", now: MON_NOON_UTC, ...context });
const failed = (result) => result.allViolations.map((violation) => violation.rule);
const triggered = (result) => result.triggers.map((trigger) => trigger.rule);

test("every rule id has an article, a title, an outcome and an error code", () => {
  for (const [rule, info] of Object.entries(POLICY_RULES)) {
    assert.ok(info.article >= 1 && info.article <= 13, rule);
    assert.ok(info.title.length > 0, rule);
    assert.ok(["deny", "confirm", "observed"].includes(info.outcome), rule);
    assert.match(info.code, /^[A-Z_]+$/u, rule);
  }
  assert.equal(POLICY_RULES["caps.dailyUsd"].code, "POLICY_SPEND_LIMIT");
  assert.equal(POLICY_RULES["pricing.unavailable"].code, "POLICY_PRICE_UNAVAILABLE");
  assert.equal(POLICY_RULES["key.status"].code, "POLICY_OWNER_REVOKED");
});

test("one pass and one fail per rule (articles 1-8)", () => {
  const cases = [
    ["mode.paused", { mode: "paused" }, facts(), { mode: "live" }],
    ["mode.dryRun", { mode: "dry-run" }, facts(), { mode: "dry-run" }, facts(undefined, { stored: false })],
    ["networks.allow", { networks: { allow: ["solana"] } }, facts(), { networks: { allow: ["base"] } }],
    ["networks.lanes", { networks: { lanes: ["testnet"] } }, facts(), { networks: { lanes: ["production"] } }],
    ["kinds.allow", { kinds: { allow: ["swap"] } }, facts(), { kinds: { allow: ["transfer"] } }],
    ["protocols.allow", { protocols: { allow: ["relay"] } }, facts(), { protocols: { allow: ["erc20-transfer"] } }],
    ["protocols.deny", { protocols: { deny: ["erc20-transfer"] } }, facts(), { protocols: { deny: ["relay"] } }],
    ["assets.allow", { assets: { allow: ["ETH"] } }, facts(), { assets: { allow: ["USDC@base"] } }],
    ["assets.categories", { assets: { categories: ["native"] } }, facts(), { assets: { categories: ["stablecoin"] } }],
    ["assets.unlisted", { assets: { unlisted: "deny" } }, facts([stepFacts({ input: asset(UNLISTED, "USDC", 100) })]), { assets: { unlisted: "deny" } }, facts()],
    ["accounts.allow", { accounts: { allow: [`eip155:*:${EVM}`] } }, facts(), { accounts: { allow: [`eip155:*:${EVM}`, `solana:*:${SOL}`] } }],
    ["recipients.deny", { recipients: { deny: [`eip155:*:${EVM}`] } }, facts(), { recipients: { deny: [STRANGER] } }],
    ["recipients.mode", { recipients: { mode: "own" } }, facts([stepFacts({ recipient: STRANGER, external: true })]), { recipients: { mode: "own" } }, facts()],
    ["recipients.names", { recipients: { names: "deny" } }, facts([stepFacts({ recipientName: "me.base.eth" })]), { recipients: { names: "deny" } }, facts()],
    ["limits.maxSteps", { limits: { maxSteps: 1 } }, facts([stepFacts(), stepFacts({ id: "s2", index: 1 })]), { limits: { maxSteps: 2 } }],
    ["limits.maxSlippageBps", { limits: { maxSlippageBps: 10 } }, facts([stepFacts({ slippageBps: 50 })]), { limits: { maxSlippageBps: 50 } }],
    ["limits.maxExtraCostUsd", { limits: { maxExtraCostUsd: "1" } }, facts([stepFacts({ extraCosts: [asset(ETH_BASE, "ETH", 2, 18)] })]), { limits: { maxExtraCostUsd: "2" } }],
    ["limits.maxFeeUsd", { limits: { maxFeeUsd: "0.05" } }, facts(), { limits: { maxFeeUsd: "0.1" } }],
    ["limits.maxSeconds", { limits: { maxSeconds: 60 } }, facts([stepFacts({ kind: "bridge", destinationNetwork: "arbitrum", estimatedSeconds: 120 })]), { limits: { maxSeconds: 120 } }],
    ["caps.perStepUsd", { caps: { perStepUsd: "99.99" } }, facts(), { caps: { perStepUsd: "100" } }],
    ["caps.perIntentUsd", { caps: { perIntentUsd: "99" } }, facts(), { caps: { perIntentUsd: "100" } }],
  ];
  for (const [rule, failing, factValue, passing, passFacts] of cases) {
    const bad = run(failing, factValue);
    assert.ok(failed(bad).includes(rule), `${rule} fails: ${JSON.stringify(bad.allViolations)}`);
    assert.equal(bad.outcome, "deny", rule);
    const good = run(passing, passFacts ?? factValue);
    assert.ok(!failed(good).includes(rule), `${rule} passes: ${JSON.stringify(good.allViolations)}`);
    assert.ok(good.rules.some((result) => result.rule === rule && result.status === "pass"), `${rule} listed as passed`);
  }
});

test("contracts.allow: listed registration and entry; agent keys call none by default", () => {
  const call = stepFacts({ kind: "call", protocol: "custom-call", contract: { id: "ct_5f1c2a9b7e3d4c6a8b0e1f23", entry: "deposit", target: "0xbeef" } });
  assert.deepEqual(failed(run({ contracts: { allow: [{ id: "ct_5f1c2a9b7e3d4c6a8b0e1f23", entries: ["withdraw"] }] } }, facts([call]))), ["contracts.allow"]);
  assert.deepEqual(failed(run({ contracts: { allow: [{ id: "ct_5f1c2a9b7e3d4c6a8b0e1f23" }] } }, facts([call]))), []);
  assert.deepEqual(failed(run({}, facts([call]), { defaults: "agent" })), ["contracts.allow"]);
  assert.deepEqual(failed(run({}, facts([call]))), [], "project keys: no restriction from an absent section");
  assert.deepEqual(failed(run({ contracts: { allow: [] } }, facts([stepFacts({ kind: "call", protocol: "custom-call" })]))), ["contracts.allow"], "a call step without a registration fails closed");
});

test("recipients: own is the same address on any chain of the VM; allowlist, deny wins, names deny/resolve/trusted", () => {
  const bridge = stepFacts({ kind: "bridge", protocol: "relay", destinationNetwork: "arbitrum", recipient: OWN_ARB, external: false });
  assert.equal(isOwnAccount([OWN_BASE], OWN_ARB), true);
  assert.equal(isOwnAccount([OWN_SOL], `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:${SOL}`), true);
  assert.equal(isOwnAccount([OWN_BASE], STRANGER), false);
  assert.deepEqual(failed(run({ recipients: { mode: "own" } }, facts([bridge]))), []);
  // The evaluator recomputes "external" from the accounts (a wrong fact cannot widen).
  assert.deepEqual(failed(run({ recipients: { mode: "own" } }, facts([stepFacts({ recipient: STRANGER, external: false })]))), ["recipients.mode"]);
  const named = stepFacts({ recipient: STRANGER, external: true, recipientName: "acme.base.eth" });
  assert.deepEqual(failed(run({ recipients: { mode: "allowlist", allow: [STRANGER] } }, facts([named]))), []);
  assert.deepEqual(failed(run({ recipients: { mode: "allowlist", allow: ["acme.base.eth"] } }, facts([named]))), ["recipients.mode"], "resolve: the name is only an address source");
  assert.deepEqual(failed(run({ recipients: { mode: "allowlist", allow: ["acme.base.eth"], names: "trusted" } }, facts([named]))), [], "trusted: a listed name passes");
  assert.deepEqual(failed(run({ recipients: { mode: "allowlist", allow: [STRANGER], deny: ["acme.base.eth"] } }, facts([named]))), ["recipients.deny"], "deny wins");
  assert.deepEqual(failed(run({ recipients: { mode: "any", names: "deny" } }, facts([named]))), ["recipients.names"]);
  assert.deepEqual(failed(run({}, facts([named]), { defaults: "agent" })), ["recipients.mode"], "agents default to own");
  assert.deepEqual(failed(run({}, facts([named]))), [], "project keys default to any");
});

test("fresh value: funded steps spend what a previous step produced; extra costs always count", () => {
  const bridge = stepFacts({ kind: "bridge", protocol: "relay", destinationNetwork: "arbitrum", recipient: OWN_ARB, input: asset(USDC_BASE, "USDC", 100), extraCosts: [asset(ETH_BASE, "ETH", 0.5, 18)] });
  const deposit = stepFacts({ id: "s2", index: 1, kind: "deposit", protocol: "aave-v3", network: "arbitrum", root: false, recipient: OWN_ARB, input: asset(USDC_ARB, "USDC", 99.9) });
  assert.deepEqual(policyNotionalUsdMicros([bridge, deposit]), { value: usd(100.5), unpriced: [] });
  const result = run({ caps: { perIntentUsd: "100.5" } }, facts([bridge, deposit]));
  assert.equal(result.outcome, "allow");
  assert.equal(result.notionalUsdMicros, usd(100.5));
  assert.equal(run({ caps: { perIntentUsd: "100.49" } }, facts([bridge, deposit])).outcome, "deny");
});

test("unpriced amounts fail closed only when a USD rule needs them (pricing.unavailable, POLICY_PRICE_UNAVAILABLE)", () => {
  const unpriced = facts([stepFacts({ input: asset(USDC_BASE, "USDC", null) })]);
  assert.equal(run({ kinds: { allow: ["transfer"] } }, unpriced).outcome, "allow", "no USD rule, no price needed");
  for (const fields of [{ caps: { perStepUsd: "10" } }, { caps: { perIntentUsd: "10" } }, { confirm: { aboveUsd: "10" } }]) {
    const result = run(fields, unpriced);
    assert.deepEqual(failed(result), ["pricing.unavailable"], JSON.stringify(fields));
    assert.equal(result.code, "POLICY_PRICE_UNAVAILABLE");
  }
  assert.deepEqual(failed(run({ limits: { maxExtraCostUsd: "1" } }, facts([stepFacts({ extraCosts: [asset(ETH_BASE, "ETH", null, 18)] })]))), ["pricing.unavailable"]);
  assert.deepEqual(failed(run({ limits: { maxFeeUsd: "1" } }, facts(undefined, { intent: { feesUsdMicros: null } }))), ["limits.maxFeeUsd"], "unknown fees fail the fee rule itself");
});

test("window caps: usage + fresh value against the cap (plan preview), skipped without usage", () => {
  const usage = { dayUsdMicros: usd(4950), weekUsdMicros: usd(4950) };
  assert.deepEqual(failed(run({ caps: { dailyUsd: "5000" } }, facts(), { usage })), ["caps.dailyUsd"]);
  assert.equal(run({ caps: { dailyUsd: "5000" } }, facts(), { usage }).code, "POLICY_SPEND_LIMIT");
  assert.deepEqual(failed(run({ caps: { dailyUsd: "5050" } }, facts(), { usage })), []);
  assert.deepEqual(failed(run({ caps: { weeklyUsd: "5000" } }, facts(), { usage, windowDeltaUsdMicros: usd(10) })), [], "prepare counts the step's exposure");
  const skipped = run({ caps: { dailyUsd: "1" } }, facts());
  assert.deepEqual(failed(skipped), []);
  assert.ok(!skipped.rules.some((result) => result.rule === "caps.dailyUsd"));
  const observed = run({ caps: { dailyUsd: "5050" } }, facts(), { usage }).rules.find((result) => result.rule === "caps.dailyUsd");
  assert.equal(observed.observed, "100.00 + 4950.00 used");
});

test("modes and agent permissions: paused refuses everything; dry-run refuses storing and preparing; agents may lose storeIntents", () => {
  assert.equal(run({ mode: "paused" }, facts(undefined, { stored: false })).outcome, "deny");
  assert.equal(run({ mode: "dry-run" }, facts(undefined, { stored: false })).outcome, "allow");
  assert.deepEqual(failed(run({ mode: "dry-run" }, facts(undefined, { stored: false, stage: "prepare" }))), ["mode.dryRun"]);
  assert.deepEqual(failed(run(null, facts(), { defaults: "agent" })), ["mode.dryRun"], "an agent without a rule book is an observer");
  assert.deepEqual(failed(run({ permissions: { storeIntents: false } }, facts(), { defaults: "agent" })), ["permissions.storeIntents", "recipients.mode"].slice(0, 1));
  assert.deepEqual(failed(run({ permissions: { storeIntents: false } }, facts())), [], "ignored on project keys");
  assert.deepEqual(failed(run({}, facts(), { keyActive: false })), ["key.status"]);
  assert.equal(run({}, facts(), { keyActive: false }).code, "POLICY_OWNER_REVOKED");
});

test("schedule: warning at plan, deny at prepare with Retry-After to the next opening", () => {
  const office = { schedule: { timezone: "Europe/Istanbul", windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], from: "09:00", to: "18:00" }] } };
  const saturday = Date.parse("2026-10-10T07:30:00Z");
  const plan = run(office, facts(), { now: saturday });
  assert.equal(plan.outcome, "allow");
  assert.equal(plan.warnings.length, 1);
  assert.ok(plan.rules.some((result) => result.rule === "schedule.window" && result.status === "warn"));
  const prepare = run(office, facts(undefined, { stage: "prepare" }), { now: saturday });
  assert.deepEqual(failed(prepare), ["schedule.window"]);
  assert.equal(prepare.code, "POLICY_SCHEDULE_CLOSED");
  assert.equal(prepare.retryAfterSeconds, 86_400, "capped at a day (opens Monday 06:00Z)");
  assert.equal(run(office, facts(undefined, { stage: "prepare" }), { now: Date.parse("2026-10-12T06:30:00Z") }).outcome, "allow");
});

test("scheduleState: DST on America/New_York (2026-11-01, 2027-03-14), 24:00 and the next change across a week", () => {
  const sunday1 = { timezone: "America/New_York", windows: [{ days: ["sun"], from: "01:00", to: "02:00" }] };
  const beforeFallBack = scheduleState(sunday1, Date.parse("2026-11-01T05:30:00Z"));
  assert.equal(beforeFallBack.open, true, "01:30 EDT");
  assert.equal(beforeFallBack.nextChange, "2026-11-01T07:00:00.000Z", "01:00-01:59 happens twice; 02:00 EST is 07:00Z");
  assert.equal(scheduleState(sunday1, Date.parse("2026-11-01T06:30:00Z")).open, true, "01:30 EST (the design's probe)");
  const sunday2 = { timezone: "America/New_York", windows: [{ days: ["sun"], from: "02:00", to: "03:00" }] };
  const springForward = scheduleState(sunday2, Date.parse("2027-03-14T06:30:00Z"));
  assert.equal(springForward.open, false, "01:30 EST");
  assert.equal(springForward.nextChange, "2027-03-21T06:00:00.000Z", "02:00-02:59 does not exist on 2027-03-14");
  const lateMonday = { timezone: "UTC", windows: [{ days: ["mon"], from: "23:00", to: "24:00" }] };
  assert.equal(scheduleState(lateMonday, Date.parse("2026-10-12T23:59:30Z")).open, true);
  assert.equal(scheduleState(lateMonday, Date.parse("2026-10-13T00:00:00Z")).open, false);
  const weekly = { timezone: "UTC", windows: [{ days: ["mon"], from: "09:00", to: "10:00" }] };
  const tuesday = scheduleState(weekly, Date.parse("2026-10-13T12:00:00Z"));
  assert.equal(tuesday.nextChange, "2026-10-19T09:00:00.000Z");
  assert.equal(tuesday.retryAfterSeconds, 86_400);
  assert.deepEqual(scheduleState(undefined), { open: true, nextChange: null, timezone: null, retryAfterSeconds: null });
  const broken = scheduleState({ timezone: "Mars/Olympus", windows: weekly.windows });
  assert.equal(broken.open, false);
  assert.equal(broken.error, true, "a zone the runtime cannot format is closed (fail closed)");
});

test("confirm triggers hold for approval; at prepare the approval state decides (required, rejected, expired, stale, approved)", () => {
  const bridge = stepFacts({ kind: "bridge", protocol: "relay", destinationNetwork: "arbitrum", recipient: STRANGER, external: true, input: asset(USDC_BASE, "USDC", 900) });
  const policy = doc({ confirm: { aboveUsd: "500", when: ["external-recipient", "cross-network", "contract-call"] } });
  const plan = evaluatePolicy(policy, facts([bridge], { intent: { crossNetwork: true } }), { scope: "key" });
  assert.equal(plan.outcome, "confirm");
  assert.deepEqual(triggered(plan), ["confirm.aboveUsd", "confirm.externalRecipient", "confirm.crossNetwork"]);
  const chain = [{ policy, scope: "key", keyId: "key_a" }];
  const prepare = facts([bridge], { stage: "prepare" });
  const pending = evaluatePolicyChain(chain, prepare, { approval: { status: "pending" } });
  assert.deepEqual(failed(pending), ["approval.required"]);
  assert.equal(pending.code, "POLICY_APPROVAL_REQUIRED");
  assert.equal(pending.retryAfterSeconds, 15);
  assert.equal(evaluatePolicyChain(chain, prepare).code, "POLICY_APPROVAL_REQUIRED", "no approval yet");
  assert.equal(evaluatePolicyChain(chain, prepare, { approval: { status: "rejected" } }).code, "POLICY_APPROVAL_REJECTED");
  assert.equal(evaluatePolicyChain(chain, prepare, { approval: { status: "expired" } }).code, "POLICY_APPROVAL_EXPIRED");
  const ceiling = approvalCeilingUsdCents(usd(900)) * 10_000n;
  assert.equal(evaluatePolicyChain(chain, prepare, { approval: { status: "approved", ceilingUsdMicros: ceiling } }).outcome, "allow");
  const moved = facts([{ ...bridge, input: asset(USDC_BASE, "USDC", 950) }], { stage: "prepare" });
  assert.equal(evaluatePolicyChain(chain, moved, { approval: { status: "approved", ceilingUsdMicros: ceiling } }).code, "POLICY_APPROVAL_STALE");
  // An approval satisfies confirm triggers only: caps still apply.
  const capped = [{ policy: doc({ confirm: { aboveUsd: "500" }, caps: { perStepUsd: "800" } }), scope: "key" }];
  assert.deepEqual(failed(evaluatePolicyChain(capped, prepare, { approval: { status: "approved", ceilingUsdMicros: ceiling } })), ["caps.perStepUsd"]);
});

test("chains: evaluated root first, tagged per rule book, worst outcome wins, 20-violation cap", () => {
  const chain = [
    { policy: doc({ networks: { allow: ["base"] } }), scope: "project", keyId: "prj_1" },
    { policy: doc({ confirm: { aboveUsd: "50" } }), scope: "key", keyId: "key_root" },
    { policy: doc({ kinds: { allow: ["swap"] } }), scope: "key", keyId: "key_agent", defaults: "agent" },
  ];
  const result = evaluatePolicyChain(chain, facts());
  assert.equal(result.outcome, "deny");
  assert.deepEqual(result.allViolations.map((violation) => [violation.rule, violation.scope, violation.keyId]), [["kinds.allow", "key", "key_agent"]]);
  assert.deepEqual(result.triggers.map((trigger) => trigger.keyId), ["key_root"]);
  assert.equal(evaluatePolicyChain(chain.slice(0, 2), facts()).outcome, "confirm");
  assert.equal(evaluatePolicyChain(chain.slice(0, 1), facts()).outcome, "allow");
  const many = Array.from({ length: 25 }, (_, index) => stepFacts({ id: `s${index + 1}`, index, network: "solana" }));
  const capped = run({ networks: { allow: ["base"] } }, facts(many));
  assert.equal(capped.violations.length, 20);
  assert.equal(capped.allViolations.length, 25);
});

test("policyErrorCode follows the design's precedence (non-retryable first)", () => {
  assert.deepEqual(POLICY_ERROR_PRECEDENCE.slice(0, 2), ["POLICY_VIOLATION", "POLICY_OWNER_REVOKED"]);
  assert.equal(policyErrorCode([{ rule: "schedule.window" }, { rule: "caps.dailyUsd" }]), "POLICY_SPEND_LIMIT");
  assert.equal(policyErrorCode([{ rule: "approval.required" }, { rule: "networks.allow" }]), "POLICY_VIOLATION");
  assert.equal(policyErrorCode([{ rule: "pricing.unavailable" }, { rule: "approval.stale" }]), "POLICY_APPROVAL_STALE");
  assert.equal(policyErrorCode([]), null);
});

test("narrowConstraints: slippage, fees, seconds, avoided and preferred venues, testnets; untouched when nothing restricts", () => {
  const request = { text: "bridge", accounts: [OWN_BASE], constraints: { maxFeeUsd: 30, preferProtocols: ["lifi", "relay"], avoidProtocols: ["across"] } };
  const chain = [
    doc({ limits: { maxSlippageBps: 100, maxFeeUsd: "20" }, protocols: { deny: ["debridge-dln"] } }),
    doc({ limits: { maxSlippageBps: 30, maxSeconds: 300 }, protocols: { allow: ["relay", "erc20-transfer"] }, networks: { lanes: ["production"] } }),
    null,
  ];
  const narrowed = narrowConstraints(chain, request).constraints;
  assert.equal(narrowed.maxSlippageBps, 30);
  assert.equal(narrowed.maxFeeUsd, 20);
  assert.equal(narrowed.maxSeconds, 300);
  assert.ok(narrowed.avoidProtocols.includes("across") && narrowed.avoidProtocols.includes("debridge-dln") && narrowed.avoidProtocols.includes("lifi"));
  assert.ok(!narrowed.avoidProtocols.includes("relay"));
  assert.deepEqual(narrowed.preferProtocols, ["relay"]);
  assert.equal(narrowed.allowTestnets, false);
  assert.equal(narrowConstraints([doc({ limits: { maxSlippageBps: 500 } })], { accounts: [OWN_BASE] }).constraints.maxSlippageBps, INTENT_DEFAULT_SLIPPAGE_BPS, "starts from the planner default");
  const untouched = { accounts: [OWN_BASE], constraints: { maxSlippageBps: 10 } };
  assert.equal(narrowConstraints([doc({ caps: { dailyUsd: "1" } })], untouched), untouched);
  assert.ok(EXECUTABLE_PROTOCOLS.includes("relay") && !EXECUTABLE_PROTOCOLS.includes("webacy"));
});

test("effective permissions and execution across a chain", () => {
  assert.equal(effectivePermissions([{ policy: doc({}), defaults: "project" }]).webhooks, true, "project keys are not restricted");
  const agent = effectivePermissions([{ policy: null, defaults: "project" }, { policy: doc({ permissions: { webhooks: true } }), defaults: "agent" }]);
  assert.equal(agent.webhooks, true);
  assert.equal(agent.createChildKeys, false);
  assert.equal(agent.storeIntents, true);
  assert.equal(agent.links, false);
  const grandchild = effectivePermissions([{ policy: doc({ permissions: { webhooks: false } }), defaults: "agent" }, { policy: doc({ permissions: { webhooks: true } }), defaults: "agent" }]);
  assert.equal(grandchild.webhooks, false, "a child is never wider than its parent");
  assert.equal(effectiveExecution([{ policy: null, defaults: "project" }]).pinNonce, false);
  assert.equal(effectiveExecution([{ policy: null, defaults: "project" }, { policy: doc({}), defaults: "agent" }]).pinNonce, true);
});

const GRAPH = {
  spec: "kletia.intent/v1",
  id: "int_cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
  createdAt: "2026-10-09T12:52:10Z",
  updatedAt: "2026-10-09T12:52:10Z",
  expiresAt: "2026-10-09T13:52:10Z",
  status: "planned",
  request: { text: "bridge 900 USDC from base to arbitrum", accounts: [OWN_BASE] },
  interpretation: { source: "grammar", confidence: 1 },
  steps: [
    {
      id: "s1", index: 0, kind: "bridge", title: "Bridge", network: "base", chain: "eip155:8453", account: OWN_BASE, protocol: "relay", mode: "wallet", dependsOn: [], status: "ready", evidence: [],
      input: { asset: USDC_BASE, symbol: "USDC", decimals: 6, amount: "900000000", formatted: "900", usd: 900 },
      expectedOutput: { asset: USDC_ARB, symbol: "USDC", decimals: 6, amount: "899700000", formatted: "899.7", usd: 899.7 },
      minimumOutput: { asset: USDC_ARB, symbol: "USDC", decimals: 6, amount: "895201500", formatted: "895.2015", usd: 895.2 },
      recipient: STRANGER.replace("8453", "42161"), recipientName: "acme.base.eth",
      settlement: { kind: "cross-network", destinationNetwork: "arbitrum", expectedSeconds: 16 }, estimatedSeconds: 16, feesUsd: 0.02,
      extraCosts: [{ asset: ETH_BASE, symbol: "ETH", decimals: 18, amount: "100000000000000", formatted: "0.0001", usd: 0.25 }],
    },
    {
      id: "s2", index: 1, kind: "deposit", title: "Deposit", network: "arbitrum", chain: "eip155:42161", account: OWN_ARB, protocol: "aave-v3", mode: "wallet", dependsOn: ["s1"], status: "pending", evidence: [],
      input: { asset: USDC_ARB, symbol: "USDC", decimals: 6, amount: "895201500", formatted: "895.2015", usd: 895.2 },
    },
  ],
  edges: [{ from: "s1", to: "s2", kind: "funds" }],
  summary: { title: "x", networks: ["base", "arbitrum"], inputs: [], outputs: [], signaturesRequired: 2, crossNetwork: true },
  warnings: [],
};

test("buildPolicyFacts: roots from funds edges, external recipients, slippage from expected vs minimum, unknown wallet fees", () => {
  const built = buildPolicyFacts(GRAPH, { stage: "sign", stored: true });
  assert.equal(built.steps[0].root, true);
  assert.equal(built.steps[1].root, false);
  assert.equal(built.steps[0].external, true);
  assert.equal(built.steps[1].external, false);
  assert.equal(built.steps[0].destinationNetwork, "arbitrum");
  assert.equal(built.steps[0].slippageBps, 50, "(899.7 − 895.2015) / 899.7 rounded up");
  assert.equal(built.steps[0].input.listed, true);
  assert.equal(built.steps[0].input.category, "stablecoin");
  assert.equal(built.steps[0].input.group, "USDC");
  assert.equal(built.intent.feesUsdMicros, null, "s2 has no fee estimate");
  assert.equal(built.intent.notionalUsdMicros, usd(900.25));
  assert.deepEqual(built.intent.networks, ["base", "arbitrum"]);
  assert.equal(built.intent.crossNetwork, true);
  const priced = buildPolicyFacts(GRAPH, { stage: "prepare", stored: true, price: (amount) => (amount.symbol === "USDC" ? BigInt(amount.amount) : null) });
  assert.equal(priced.steps[0].extraCosts[0].usdMicros, null);
  assert.equal(priced.intent.notionalUsdMicros, null);
});

test("approvals: digest, ceiling, EIP-712 typed data and the Solana message text", () => {
  const digest = approvalDigest(GRAPH, "key_9a7f0000000000000000aaaa");
  assert.match(digest, /^0x[0-9a-f]{64}$/u);
  const expected = createHash("sha256").update(canonicalJson({
    intent: GRAPH.id,
    owner: "key_9a7f0000000000000000aaaa",
    accounts: GRAPH.request.accounts,
    steps: GRAPH.steps.map((step) => ({ id: step.id, kind: step.kind, network: step.network, destinationNetwork: step.settlement?.destinationNetwork, protocol: step.protocol, venue: step.venue, input: step.input?.asset, output: step.expectedOutput?.asset, recipient: step.recipient ?? step.account, recipientName: step.recipientName, contract: step.call?.contract, entry: step.call?.entry })),
  })).digest("hex");
  assert.equal(digest, `0x${expected}`);
  assert.equal(approvalDigest({ ...GRAPH, steps: GRAPH.steps.map((step) => ({ ...step, input: { ...step.input, amount: "1" } })) }, "key_9a7f0000000000000000aaaa"), digest, "amounts are not in the digest");
  assert.notEqual(approvalDigest({ ...GRAPH, steps: [{ ...GRAPH.steps[0], recipient: OWN_ARB }, GRAPH.steps[1]] }, "key_9a7f0000000000000000aaaa"), digest);
  assert.equal(approvalCeilingUsdCents(usd(5200)), 530_400n);
  assert.equal(approvalCeilingUsdCents(1n), 1n, "rounded up");
  const input = { approvalId: `apr_${"ab".repeat(16)}`, intentId: GRAPH.id, digest, ceilingUsdCents: 530_400n, decision: "approve", expiresAt: "2026-10-09T13:52:10Z" };
  const typed = approvalTypedData({ ...input, signer: OWN_BASE });
  assert.deepEqual(typed.domain, { name: "Kletia Approvals", version: "1", chainId: 8453 });
  assert.deepEqual(typed.types.Approval.map((field) => `${field.type} ${field.name}`), ["string approval", "string intent", "bytes32 digest", "uint256 ceilingUsdCents", "string decision", "uint64 expiresAt"]);
  assert.equal(typed.primaryType, "Approval");
  assert.deepEqual(typed.message, { approval: input.approvalId, intent: GRAPH.id, digest, ceilingUsdCents: 530_400n, decision: "approve", expiresAt: 1_791_553_930n });
  assert.equal(approvalTypedData({ ...input, signer: OWN_ARB }).domain.chainId, 42161, "the signer's chain");
  assert.throws(() => approvalTypedData({ ...input, signer: OWN_SOL }), /Solana approvals/u);
  assert.equal(
    approvalMessageText(input),
    ["Kletia approval", `approval: apr_${"ab".repeat(16)}`, `intent: ${GRAPH.id}`, `digest: ${digest}`, "up to: $5,304.00", "decision: approve", "expires: 2026-10-09T13:52:10Z"].join("\n"),
  );
  assert.ok(!/ \n|\r/u.test(approvalMessageText(input)), "LF only, no trailing spaces");
});

test("decision log: the hash chain verifies, detects rewrites against a stored head, gaps and broken links", () => {
  const records = [];
  let prev = POLICY_DECISION_GENESIS;
  for (let seq = 1; seq <= 3; seq += 1) {
    const record = { id: `pdc_${String(seq).padStart(24, "0")}`, at: `2026-10-09T12:5${seq}:00Z`, stage: "plan", outcome: seq === 2 ? "deny" : "allow", projectId: "prj_1", keyId: "key_a", actorKeyId: "key_a", dryRun: false, chain: [], violations: [], triggers: [], warnings: [], requestDigest: createHash("sha256").update(`r${seq}`).digest("hex") };
    const chainHash = policyDecisionChainHash(prev, record);
    assert.equal(chainHash, `0x${createHash("sha256").update(`${prev}\n${canonicalJson(record)}`).digest("hex")}`);
    records.push({ ...record, seq, prevHash: prev, chainHash });
    prev = chainHash;
  }
  const page = [...records].reverse();
  assert.deepEqual(verifyDecisionChain(page), { valid: true, head: { seq: 3, chainHash: records[2].chainHash }, problems: [] });
  assert.equal(verifyDecisionChain(page, { seq: 2, chainHash: records[1].chainHash }).valid, true);
  assert.equal(verifyDecisionChain(page, { seq: 2, chainHash: `0x${"1".repeat(64)}` }).valid, false, "the stored head was rewritten");
  assert.equal(verifyDecisionChain(page, { seq: 9, chainHash: records[2].chainHash }).valid, false, "decisions after the stored head were dropped");
  const tampered = page.map((record) => (record.seq === 2 ? { ...record, outcome: "allow" } : record));
  assert.equal(verifyDecisionChain(tampered).valid, false);
  assert.equal(verifyDecisionChain([records[0], records[2]]).valid, false, "gap");
  assert.equal(policyExposureId("int_x", "s1", "ab"), `px_${createHash("sha256").update("int_x|s1|ab").digest("hex").slice(0, 24)}`);
});

test("fail-closed edges: raw deny patterns still match, value-moving steps without an input are unpriced, approvals need a ceiling", () => {
  // A stored document that skipped normalisation (checksummed address, upper-case name) still denies.
  const raw = { schema, recipients: { deny: ["eip155:*:0x9999999999999999999999999999999999999999".replace("0x9", "0X9").replace("0X9", "0x9"), "ACME.BASE.ETH"] } };
  const checksummed = { schema, recipients: { deny: ["eip155:8453:0x8F3C0000000000000000000000000000000AA21B"] } };
  assert.deepEqual(failed(evaluatePolicy(checksummed, facts(), { scope: "key" })), ["recipients.deny"]);
  assert.deepEqual(failed(evaluatePolicy(raw, facts([stepFacts({ recipient: OWN_ARB, recipientName: "acme.base.eth" })]), { scope: "key" })), ["recipients.deny"]);
  const withdraw = stepFacts({ kind: "withdraw", protocol: "aave-v3", input: undefined });
  assert.deepEqual(failed(run({ caps: { perStepUsd: "10" } }, facts([withdraw]))), ["pricing.unavailable"]);
  assert.deepEqual(failed(run({ caps: { perIntentUsd: "10" } }, facts([withdraw]))), ["pricing.unavailable"]);
  assert.deepEqual(failed(run({ caps: { perStepUsd: "10" } }, facts([stepFacts({ kind: "claim", protocol: "kamino", input: undefined })]))), [], "claims move nothing of their own");
  const chain = [{ policy: doc({ confirm: { aboveUsd: "50" } }), scope: "key" }];
  const prepare = facts(undefined, { stage: "prepare" });
  assert.equal(evaluatePolicyChain(chain, prepare, { approval: { status: "approved" } }).code, "POLICY_APPROVAL_STALE", "an approval without a ceiling never clears");
  assert.equal(evaluatePolicyChain(chain, prepare, { approval: { status: "approved", ceilingUsdMicros: usd(1000) } }).outcome, "allow");
});

test("assets.unlisted: core venue position tokens (aTokens, vault shares, jlTokens) pass; other unlisted tokens fail", () => {
  const aave = YIELD_VENUES.find((venue) => venue.id === "base:aave-v3:usdc");
  assert.ok(aave && "receipt" in aave, "the Base Aave V3 USDC reserve is in the registry");
  const aToken = `eip155:8453/erc20:${aave.receipt.address}`;
  const deposit = stepFacts({ kind: "deposit", protocol: "aave-v3", input: asset(USDC_BASE, "USDC", 100), output: asset(aToken, "aBasUSDC", 100, 6, false) });
  // Agent default (`assets.unlisted: deny`) and an explicit deny: the aToken output is not a token named by the request.
  assert.deepEqual(failed(run({}, facts([deposit]), { defaults: "agent" })).filter((rule) => rule.startsWith("assets.")), []);
  assert.deepEqual(failed(run({ assets: { unlisted: "deny" } }, facts([deposit]))), []);
  const withdraw = stepFacts({ kind: "withdraw", protocol: "aave-v3", input: asset(`eip155:8453/erc20:${aave.receipt.address.toLowerCase()}`, "aBasUSDC", 100, 6, false), output: asset(USDC_BASE, "USDC", 100) });
  assert.deepEqual(failed(run({ assets: { unlisted: "deny" } }, facts([withdraw]))), [], "address case does not matter");
  const jupiterLend = YIELD_VENUES.find((venue) => venue.kind === "jupiter-lend");
  assert.ok(jupiterLend);
  const jlToken = `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:${jupiterLend.receipt.address}`;
  assert.deepEqual(failed(run({ assets: { unlisted: "deny" } }, facts([stepFacts({ kind: "deposit", network: "solana", protocol: "jupiter-lend", output: asset(jlToken, "jlUSDC", 100, 6, false) })]))), []);
  // The same address on another network, or any other unlisted token, still fails closed.
  const elsewhere = `eip155:42161/erc20:${aave.receipt.address}`;
  assert.deepEqual(failed(run({ assets: { unlisted: "deny" } }, facts([stepFacts({ kind: "deposit", protocol: "aave-v3", output: asset(elsewhere, "aBasUSDC", 100, 6, false) })]))), ["assets.unlisted"]);
  assert.deepEqual(failed(run({}, facts([stepFacts({ kind: "swap", protocol: "uniswap-v3", output: asset(UNLISTED, "DEGEN", 100) })]), { defaults: "agent" })).filter((rule) => rule.startsWith("assets.")), ["assets.unlisted"]);
  // assets.allow and assets.categories still apply to position tokens as written.
  assert.deepEqual(failed(run({ assets: { allow: ["USDC"] } }, facts([deposit]))), ["assets.allow"]);
});
