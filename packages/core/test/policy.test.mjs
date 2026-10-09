import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  AGENT_KEY_PATTERN,
  APPROVAL_ID_PATTERN,
  EXPOSURE_ID_PATTERN,
  OBSERVER_POLICY,
  POLICY_DECISION_ID_PATTERN,
  POLICY_TEMPLATES,
  accountMatchesPattern,
  canonicalJson,
  canonicalPolicy,
  comparePolicies,
  effectivePolicyDocument,
  formatUsdMicros,
  isSupportedTimeZone,
  normalizeAccountPattern,
  normalizeAssetEntry,
  policyFromTemplate,
  policyHash,
  policyUsdMicros,
  scheduleBitmap,
  validatePolicy,
} from "../dist/index.js";

const EVM = "0x8f3C0000000000000000000000000000000Aa21B";
const SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const schema = "kletia.policy/v1";
const ok = (document, options) => {
  const result = validatePolicy(document, options);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  return result;
};
const issuesOf = (document, options) => {
  const result = validatePolicy(document, options);
  assert.equal(result.ok, false, "expected issues");
  return result.issues.map((issue) => issue.path);
};

/** The design's §3.1 example, with real addresses. */
const FULL = {
  schema,
  label: "Research bot (payments)",
  mode: "live",
  networks: { allow: ["base", "arbitrum", "solana"], lanes: ["production"] },
  kinds: { allow: ["transfer", "bridge", "swap"] },
  protocols: { allow: ["relay", "lifi", "debridge-dln", "erc20-transfer", "spl-token", "system-transfer", "jupiter"], deny: [] },
  contracts: { allow: [{ id: "ct_5f1c2a9b7e3d4c6a8b0e1f23", entries: ["deposit"] }] },
  assets: { allow: ["USDC", "group:ETH", "SOL@solana"], categories: ["stablecoin", "native", "wrapped"], unlisted: "deny" },
  accounts: { allow: [`eip155:*:${EVM}`, `solana:*:${SOL}`] },
  recipients: { mode: "allowlist", allow: ["eip155:8453:0x1111111111111111111111111111111111112222", "acme-payroll.base.eth"], deny: ["eip155:*:0x0000000000000000000000000000000000000000"], names: "resolve" },
  limits: { maxSteps: 3, maxSlippageBps: 100, maxExtraCostUsd: "5", maxFeeUsd: "20", maxSeconds: 900 },
  caps: { perStepUsd: "1000", perIntentUsd: "1500", dailyUsd: "5000", weeklyUsd: "20000" },
  schedule: { timezone: "Europe/Istanbul", windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], from: "09:00", to: "18:00" }] },
  confirm: { aboveUsd: "500", when: ["external-recipient"], approvers: { keys: [], wallets: ["eip155:*:0x4b200000000000000000000000000000000009cD1".slice(0, 51)], requireWallet: true }, ttlSeconds: 3600 },
  permissions: { createChildKeys: false, webhooks: false, registerContracts: false, sessions: false, storeIntents: true, mcpCreateIntents: true },
  execution: { pinNonce: true },
  amendments: { delaySeconds: 3600 },
};

test("ids, key secrets and USD helpers", () => {
  assert.match("pdc_0c5a9e1f4b7d2a8c3e6f9b01", POLICY_DECISION_ID_PATTERN);
  assert.match(`apr_${"ab".repeat(16)}`, APPROVAL_ID_PATTERN);
  assert.match(`px_${"0".repeat(24)}`, EXPOSURE_ID_PATTERN);
  assert.match(`kl_agt_${"A1b2".repeat(8)}`, AGENT_KEY_PATTERN);
  assert.doesNotMatch(`kl_dev_${"A1b2".repeat(8)}`, AGENT_KEY_PATTERN);
  assert.equal(policyUsdMicros("1500"), 1_500_000_000n);
  assert.equal(policyUsdMicros("12.5"), 12_500_000n);
  assert.equal(formatUsdMicros(5_200_000_001n), "5200.01", "rounded up");
  assert.throws(() => policyUsdMicros("1.234"));
});

test("validatePolicy accepts the design's full example and normalises it", () => {
  const { value, warnings } = ok(FULL);
  assert.deepEqual(value.networks.allow, ["arbitrum", "base", "solana"], "sets are sorted");
  assert.deepEqual(value.assets.allow, ["SOL@solana", "USDC", "group:ETH"]);
  assert.deepEqual(value.accounts.allow, [`eip155:*:${EVM.toLowerCase()}`, `solana:*:${SOL}`], "EVM addresses lower-cased, Solana as is");
  assert.deepEqual(value.kinds.allow, ["bridge", "swap", "transfer"]);
  assert.equal(value.caps.dailyUsd, "5000");
  assert.deepEqual(warnings.map((warning) => warning.code), []);
});

test("validatePolicy refuses unknown fields, bad enums, ranges, decimal strings and sizes", () => {
  assert.deepEqual(issuesOf({ schema: "kletia.policy/v2" }), ["schema"]);
  assert.deepEqual(issuesOf({ schema, extra: true }), ["extra"]);
  assert.deepEqual(issuesOf({ schema, caps: { daily: "1" } }), ["caps.daily"]);
  assert.deepEqual(issuesOf({ schema, mode: "off" }), ["mode"]);
  assert.deepEqual(issuesOf({ schema, caps: { dailyUsd: 5000 } }), ["caps.dailyUsd"], "USD are strings, never numbers");
  assert.deepEqual(issuesOf({ schema, caps: { dailyUsd: "1.234" } }), ["caps.dailyUsd"]);
  assert.deepEqual(issuesOf({ schema, limits: { maxSteps: 9 } }), ["limits.maxSteps"]);
  assert.deepEqual(issuesOf({ schema, limits: { maxSlippageBps: 0 } }), ["limits.maxSlippageBps"]);
  assert.deepEqual(issuesOf({ schema, limits: { maxSeconds: 5 } }), ["limits.maxSeconds"]);
  assert.deepEqual(issuesOf({ schema, amendments: { delaySeconds: 604_801 } }), ["amendments.delaySeconds"]);
  assert.deepEqual(issuesOf({ schema, confirm: { ttlSeconds: 299 } }), ["confirm.ttlSeconds"]);
  assert.deepEqual(issuesOf({ schema, label: "tab\there" }), ["label"]);
  assert.deepEqual(issuesOf({ schema, label: "x".repeat(65) }), ["label"]);
  assert.deepEqual(issuesOf({ schema, networks: { allow: ["base", "base"] } }), ["networks.allow[1]"]);
  assert.deepEqual(issuesOf({ schema, networks: { allow: ["stellar"] } }), ["networks.allow[0]"]);
  assert.deepEqual(issuesOf({ schema, networks: { lanes: ["beta"] } }), ["networks.lanes[0]"]);
  assert.deepEqual(issuesOf({ schema, kinds: { allow: ["mint"] } }), ["kinds.allow[0]"]);
  assert.deepEqual(issuesOf({ schema, protocols: { allow: ["uniswap-v9"] } }), ["protocols.allow[0]"]);
  assert.deepEqual(issuesOf({ schema, protocols: { deny: Array.from({ length: 41 }, () => "relay") } }), ["protocols.deny"]);
  assert.deepEqual(issuesOf({ schema, contracts: { allow: [{ id: "ct_nope" }] } }), ["contracts.allow[0].id"]);
  assert.deepEqual(issuesOf({ schema, contracts: { allow: [{ id: "ct_5f1c2a9b7e3d4c6a8b0e1f23", entries: ["Bad Entry"] }] } }), ["contracts.allow[0].entries[0]"]);
  assert.deepEqual(issuesOf({ schema, permissions: { webhooks: "yes" } }), ["permissions.webhooks"]);
  assert.deepEqual(issuesOf({ schema, permissions: { admin: true } }), ["permissions.admin"]);
  assert.deepEqual(issuesOf({ schema, recipients: { allow: Array.from({ length: 201 }, (_, index) => `eip155:8453:0x${index.toString(16).padStart(40, "0")}`) } }), ["recipients.allow"]);
  const huge = { schema, recipients: { deny: Array.from({ length: 200 }, (_, index) => `${"a".repeat(60)}.${"b".repeat(57)}${index}.eth`) } };
  assert.equal(validatePolicy(huge).ok, false, "canonical size above 16 KB");
});

test("asset entries: SYMBOL, SYMBOL@network, group:X and CAIP-19, normalised to registry spellings", () => {
  assert.equal(normalizeAssetEntry("usdc"), "USDC");
  assert.equal(normalizeAssetEntry("jitosol@solana"), "JitoSOL@solana");
  assert.equal(normalizeAssetEntry("group:eth"), "group:ETH");
  assert.equal(normalizeAssetEntry("eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"), "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
  assert.equal(normalizeAssetEntry("eip155:8453/erc20:0x0000000000000000000000000000000000000abc"), "eip155:8453/erc20:0x0000000000000000000000000000000000000abc", "an unlisted token by exact id");
  for (const bad of ["DOGE", "USDC@stellar", "SOL@base", "group:DOGE", "eip155:8453/erc20:nope", ""]) assert.equal(normalizeAssetEntry(bad), null, bad);
  assert.deepEqual(issuesOf({ schema, assets: { allow: ["DOGE"] } }), ["assets.allow[0]"]);
  assert.deepEqual(issuesOf({ schema, assets: { categories: ["nft"] } }), ["assets.categories[0]"]);
  assert.deepEqual(issuesOf({ schema, assets: { unlisted: "maybe" } }), ["assets.unlisted"]);
});

test("CAIP-10 patterns: exact or same address on every chain of a namespace", () => {
  assert.equal(normalizeAccountPattern(`eip155:*:${EVM}`), `eip155:*:${EVM.toLowerCase()}`);
  assert.equal(normalizeAccountPattern(`eip155:8453:${EVM}`), `eip155:8453:${EVM.toLowerCase()}`);
  assert.equal(normalizeAccountPattern(`solana:*:${SOL}`), `solana:*:${SOL}`);
  for (const bad of [`eip155:*:${SOL}`, `solana:*:${EVM}`, EVM, "eip155:*:0x12", `cosmos:*:${EVM}`]) assert.equal(normalizeAccountPattern(bad), null, bad);
  assert.equal(accountMatchesPattern(`eip155:42161:${EVM}`, `eip155:*:${EVM.toLowerCase()}`), true);
  assert.equal(accountMatchesPattern(`eip155:42161:${EVM}`, `eip155:8453:${EVM.toLowerCase()}`), false);
  assert.equal(accountMatchesPattern(`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:${SOL}`, `solana:*:${SOL}`), true);
  assert.deepEqual(issuesOf({ schema, accounts: { allow: [EVM] } }), ["accounts.allow[0]"], "raw addresses are ambiguous");
  assert.equal(ok({ schema, recipients: { mode: "allowlist", allow: ["Acme-Payroll.Base.ETH"] } }).value.recipients.allow[0], "acme-payroll.base.eth");
  assert.deepEqual(issuesOf({ schema, recipients: { allow: ["not a name"] } }), ["recipients.allow[0]"]);
});

test("timetable: IANA zones the runtime supports (UTC included), HH:MM windows, 24:00, from < to", () => {
  assert.equal(isSupportedTimeZone("Europe/Istanbul"), true);
  assert.equal(isSupportedTimeZone("UTC"), true);
  assert.equal(isSupportedTimeZone("Mars/Olympus"), false);
  ok({ schema, schedule: { timezone: "UTC", windows: [{ days: ["sun"], from: "00:00", to: "24:00" }] } });
  assert.deepEqual(issuesOf({ schema, schedule: { timezone: "Mars/Olympus", windows: [{ days: ["mon"], from: "09:00", to: "17:00" }] } }), ["schedule.timezone"]);
  assert.deepEqual(issuesOf({ schema, schedule: { timezone: "UTC", windows: [{ days: ["mon"], from: "22:00", to: "02:00" }] } }), ["schedule.windows[0].to"], "overnight windows are two windows");
  assert.deepEqual(issuesOf({ schema, schedule: { timezone: "UTC", windows: [{ days: ["funday"], from: "09:00", to: "10:00" }] } }), ["schedule.windows[0].days[0]"]);
  assert.deepEqual(issuesOf({ schema, schedule: { timezone: "UTC", windows: [{ days: ["mon"], from: "24:00", to: "24:00" }] } }), ["schedule.windows[0].from", "schedule.windows[0].to"].slice(0, 1));
  assert.deepEqual(issuesOf({ schema, schedule: { timezone: "UTC", windows: [] } }), ["schedule.windows"]);
  const bitmap = scheduleBitmap({ timezone: "UTC", windows: [{ days: ["mon"], from: "09:00", to: "09:02" }] });
  assert.equal(bitmap.reduce((sum, bit) => sum + bit, 0), 2);
});

test("consistency rules are issues; the agent warnings are warnings", () => {
  assert.deepEqual(issuesOf({ schema, caps: { perStepUsd: "2000", perIntentUsd: "1500" } }), ["caps.perStepUsd"]);
  assert.deepEqual(issuesOf({ schema, caps: { dailyUsd: "5000", weeklyUsd: "4999.99" } }), ["caps.dailyUsd"]);
  assert.deepEqual(issuesOf({ schema, confirm: { approvers: { requireWallet: true } } }), ["confirm.approvers.requireWallet"]);
  assert.deepEqual(issuesOf({ schema, recipients: { mode: "allowlist" } }), ["recipients.allow"]);
  const warn = (document, options) => ok(document, options).warnings.map((warning) => warning.code);
  assert.deepEqual(warn({ schema, caps: { dailyUsd: "1" }, recipients: { mode: "own" } }), ["ACCOUNTS_NOT_PINNED"]);
  assert.deepEqual(warn({ schema, caps: { dailyUsd: "1" } }, { defaults: "agent" }), ["ACCOUNTS_NOT_PINNED"], "agents default to own recipients");
  assert.deepEqual(warn({ schema, caps: { dailyUsd: "1" } }), [], "project keys default to any recipient");
  assert.deepEqual(warn({ schema }), ["NO_CAPS"]);
  assert.deepEqual(warn({ schema, mode: "dry-run" }), [], "dry-run moves nothing");
  assert.deepEqual(warn({ schema, caps: { dailyUsd: "1" }, recipients: { names: "trusted" } }), ["TRUSTED_NAMES"]);
  assert.deepEqual(warn({ schema, caps: { dailyUsd: "1" }, kinds: { allow: ["call"] } }), ["CONTRACT_KINDS_WITHOUT_CONTRACTS"]);
  assert.deepEqual(warn({ schema, caps: { perIntentUsd: "500" }, confirm: { aboveUsd: "500" } }), ["CONFIRM_NEVER_TRIGGERS"]);
  assert.deepEqual(warn({ schema, caps: { dailyUsd: "1" }, networks: { allow: [] } }), ["EMPTY_ALLOWLIST"]);
});

test("canonicalPolicy and policyHash: key order, set order and address case do not matter; fixture hash", () => {
  const a = { schema, networks: { allow: ["solana", "base"] }, caps: { dailyUsd: "5000.00", perStepUsd: "100" }, accounts: { allow: [`eip155:*:${EVM}`] } };
  const b = { accounts: { allow: [`eip155:*:${EVM.toLowerCase()}`] }, caps: { perStepUsd: "100", dailyUsd: "5000" }, networks: { allow: ["base", "solana"] }, schema };
  assert.equal(canonicalPolicy(a), canonicalPolicy(b));
  const canonical = '{"accounts":{"allow":["eip155:*:0x8f3c0000000000000000000000000000000aa21b"]},"caps":{"dailyUsd":"5000","perStepUsd":"100"},"networks":{"allow":["base","solana"]},"schema":"kletia.policy/v1"}';
  assert.equal(canonicalPolicy(a), canonical);
  assert.equal(policyHash(a), `sha256:${createHash("sha256").update(canonical).digest("hex")}`);
  assert.equal(policyHash(a), policyHash(b));
  assert.equal(policyHash({ schema }), `sha256:${createHash("sha256").update('{"schema":"kletia.policy/v1"}').digest("hex")}`);
  assert.throws(() => canonicalPolicy({ schema, mode: "nope" }), /Invalid policy/u);
  assert.equal(canonicalJson(validatePolicy(FULL).value), canonicalPolicy(FULL));
});

const diff = (active, next, options) => comparePolicies(active, next, options);

test("comparePolicies: one tightening and one loosening per field family", () => {
  const cases = [
    ["mode", { mode: "live" }, { mode: "paused" }],
    ["networks.allow", { networks: { allow: ["base", "solana"] } }, { networks: { allow: ["base"] } }],
    ["networks.lanes", {}, { networks: { lanes: ["production"] } }],
    ["kinds.allow", { kinds: { allow: ["swap", "transfer"] } }, { kinds: { allow: ["transfer"] } }],
    ["protocols.allow", { protocols: { allow: ["relay", "lifi"] } }, { protocols: { allow: ["relay"] } }],
    ["protocols.deny", { protocols: { deny: ["lifi"] } }, { protocols: { deny: ["lifi", "relay"] } }],
    ["contracts.allow", { contracts: { allow: [{ id: "ct_5f1c2a9b7e3d4c6a8b0e1f23" }] } }, { contracts: { allow: [{ id: "ct_5f1c2a9b7e3d4c6a8b0e1f23", entries: ["deposit"] }] } }],
    ["assets.allow", { assets: { allow: ["USDC", "USDT"] } }, { assets: { allow: ["USDC"] } }],
    ["assets.categories", {}, { assets: { categories: ["stablecoin"] } }],
    ["assets.unlisted", { assets: { unlisted: "allow" } }, { assets: { unlisted: "deny" } }],
    ["accounts.allow", {}, { accounts: { allow: [`eip155:*:${EVM}`] } }],
    ["recipients.mode", { recipients: { mode: "any" } }, { recipients: { mode: "own" } }],
    ["recipients.allow", { recipients: { mode: "allowlist", allow: ["a.eth", "b.eth"] } }, { recipients: { mode: "allowlist", allow: ["a.eth"] } }],
    ["recipients.deny", {}, { recipients: { deny: ["bad.eth"] } }],
    ["recipients.names", { recipients: { names: "trusted" } }, { recipients: { names: "deny" } }],
    ["limits.maxSteps", { limits: { maxSteps: 5 } }, { limits: { maxSteps: 3 } }],
    ["limits.maxSlippageBps", {}, { limits: { maxSlippageBps: 50 } }],
    ["limits.maxExtraCostUsd", { limits: { maxExtraCostUsd: "5" } }, { limits: { maxExtraCostUsd: "4.99" } }],
    ["limits.maxFeeUsd", { limits: { maxFeeUsd: "20" } }, { limits: { maxFeeUsd: "10" } }],
    ["limits.maxSeconds", {}, { limits: { maxSeconds: 600 } }],
    ["caps.perStepUsd", { caps: { perStepUsd: "100" } }, { caps: { perStepUsd: "50" } }],
    ["caps.perIntentUsd", {}, { caps: { perIntentUsd: "100" } }],
    ["caps.dailyUsd", { caps: { dailyUsd: "5000" } }, { caps: { dailyUsd: "4000" } }],
    ["caps.weeklyUsd", { caps: { weeklyUsd: "20000" } }, { caps: { weeklyUsd: "1" } }],
    ["schedule", {}, { schedule: { timezone: "UTC", windows: [{ days: ["mon"], from: "09:00", to: "17:00" }] } }],
    ["confirm.aboveUsd", { confirm: { aboveUsd: "500" } }, { confirm: { aboveUsd: "100" } }],
    ["confirm.when", {}, { confirm: { when: ["cross-network"] } }],
    ["confirm.approvers.keys", { confirm: { approvers: { keys: ["key_0123456789abcdef01234567", "key_0123456789abcdef01234568"] } } }, { confirm: { approvers: { keys: ["key_0123456789abcdef01234567"] } } }],
    ["confirm.approvers.wallets", { confirm: { approvers: { wallets: [`eip155:*:${EVM}`, `solana:*:${SOL}`] } } }, { confirm: { approvers: { wallets: [`solana:*:${SOL}`] } } }],
    ["confirm.approvers.requireWallet", { confirm: { approvers: { wallets: [`solana:*:${SOL}`] } } }, { confirm: { approvers: { wallets: [`solana:*:${SOL}`], requireWallet: true } } }],
    ["confirm.ttlSeconds", { confirm: { ttlSeconds: 3600 } }, { confirm: { ttlSeconds: 600 } }],
    ["permissions.webhooks", { permissions: { webhooks: true } }, { permissions: { webhooks: false } }],
    ["permissions.links", { permissions: { links: true } }, { permissions: { links: false } }],
    ["execution.pinNonce", { execution: { pinNonce: false } }, { execution: { pinNonce: true } }],
    ["amendments.delaySeconds", { amendments: { delaySeconds: 0 } }, { amendments: { delaySeconds: 3600 } }],
  ];
  for (const [field, looseDoc, tightDoc] of cases) {
    const loose = ok({ schema, ...looseDoc }).value;
    const tight = ok({ schema, ...tightDoc }).value;
    assert.deepEqual(diff(loose, tight), { tightened: [field], loosened: [] }, `${field} tightens`);
    assert.deepEqual(diff(tight, loose), { tightened: [], loosened: [field] }, `${field} loosens`);
    assert.deepEqual(diff(tight, tight), { tightened: [], loosened: [] }, `${field} equal`);
  }
});

test("comparePolicies: schedules (bitmap coverage, time zone change), approvers, removal, first version and agent defaults", () => {
  const office = { schema, schedule: { timezone: "Europe/Istanbul", windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], from: "09:00", to: "18:00" }] } };
  const shorter = { schema, schedule: { timezone: "Europe/Istanbul", windows: [{ days: ["mon", "tue"], from: "10:00", to: "12:00" }, { days: ["fri"], from: "09:00", to: "18:00" }] } };
  const weekend = { schema, schedule: { timezone: "Europe/Istanbul", windows: [{ days: ["sat"], from: "10:00", to: "12:00" }] } };
  const otherZone = { schema, schedule: { timezone: "UTC", windows: [{ days: ["mon"], from: "10:00", to: "11:00" }] } };
  assert.deepEqual(diff(office, shorter).tightened, ["schedule"]);
  assert.deepEqual(diff(office, weekend).loosened, ["schedule"]);
  assert.deepEqual(diff(office, otherZone).loosened, ["schedule"], "a time zone change is loosening");
  assert.deepEqual(diff(office, { schema }).loosened, ["schedule"]);
  const removal = diff(ok(FULL).value, null);
  assert.ok(removal.loosened.includes("caps.dailyUsd") && removal.loosened.includes("recipients.mode") && removal.loosened.includes("mode") === false);
  assert.deepEqual(removal.tightened, []);
  const first = diff(null, ok({ schema, caps: { dailyUsd: "5" }, mode: "dry-run" }).value);
  assert.deepEqual(first, { tightened: ["mode", "caps.dailyUsd"], loosened: [] });
  // Agent defaults: an absent recipients section already means "own", so setting "any" loosens.
  assert.deepEqual(diff({ schema }, { schema, recipients: { mode: "any" } }, { defaults: "agent" }).loosened, ["recipients.mode"]);
  assert.deepEqual(diff({ schema }, { schema, recipients: { mode: "own" } }, { defaults: "agent" }), { tightened: [], loosened: [] });
  assert.deepEqual(diff({ schema }, { schema, contracts: { allow: [{ id: "ct_5f1c2a9b7e3d4c6a8b0e1f23" }] } }, { defaults: "agent" }).loosened, ["contracts.allow"]);
  assert.deepEqual(diff({ schema }, { schema, permissions: { webhooks: true } }, { defaults: "agent" }).loosened, ["permissions.webhooks"]);
  assert.deepEqual(diff({ schema }, { schema, execution: { pinNonce: false } }, { defaults: "agent" }).loosened, ["execution.pinNonce"]);
  assert.deepEqual(diff({ schema, label: "a" }, { schema, label: "b" }), { tightened: [], loosened: [] }, "labels are neutral");
});

test("templates: observer is valid as is; the others validate once their fill points are given", () => {
  assert.equal(POLICY_TEMPLATES.observer.document, OBSERVER_POLICY);
  assert.equal(validatePolicy(POLICY_TEMPLATES.observer.document).ok, true);
  const unfilled = policyFromTemplate("payments-agent");
  assert.equal(unfilled.ok, false);
  assert.deepEqual(unfilled.issues.map((issue) => issue.path).sort(), ["confirm.approvers.requireWallet", "recipients.allow"]);
  const filled = policyFromTemplate("payments-agent", {
    accounts: [`eip155:*:${EVM}`],
    recipients: ["eip155:8453:0x1111111111111111111111111111111111112222"],
    approverWallets: ["eip155:*:0x4b20000000000000000000000000000000009cd1"],
  });
  assert.equal(filled.ok, true, JSON.stringify(filled.issues));
  assert.deepEqual(filled.warnings, []);
  const treasury = policyFromTemplate("treasury-rebalancer", { accounts: [`eip155:*:${EVM}`, `solana:*:${SOL}`] });
  assert.equal(treasury.ok, true, JSON.stringify(treasury.issues));
  const operator = policyFromTemplate("contract-operator", { contracts: [{ id: "ct_5f1c2a9b7e3d4c6a8b0e1f23", entries: ["deposit"] }], accounts: [`eip155:*:${EVM}`] });
  assert.equal(operator.ok, true);
  for (const template of Object.values(POLICY_TEMPLATES)) assert.ok(template.title && template.summary, template.id);
});

test("effectivePolicyDocument fills agent defaults for display only", () => {
  const view = effectivePolicyDocument({ schema, caps: { dailyUsd: "10" } }, "agent");
  assert.equal(view.recipients.mode, "own");
  assert.deepEqual(view.contracts.allow, []);
  assert.equal(view.assets.unlisted, "deny");
  assert.equal(view.permissions.storeIntents, true);
  assert.equal(view.permissions.webhooks, false);
  assert.equal(view.execution.pinNonce, true);
  assert.equal(effectivePolicyDocument(null, "agent").mode, "dry-run", "no rule book on an agent = observer");
  assert.deepEqual(effectivePolicyDocument({ schema }, "project"), { schema });
});
