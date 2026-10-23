import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_EVENT_TYPES,
  POLICY_PERMISSIONS,
  SUBAGENT_LIMITS,
  SUBAGENT_NEVER_PERMISSIONS,
  checkSubagentPolicy,
  comparePolicies,
  describeSubagentGrant,
  effectivePolicyDocument,
  policyHash,
  subagentApprovalMessage,
  subagentMessageNonce,
  validatePolicy,
} from "../dist/index.js";

/* Seeded generator: the same rule books on every run, many shapes per run. */
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const NETWORKS = ["arbitrum", "base", "ethereum", "solana"];
const KINDS = ["bridge", "deposit", "swap", "transfer"];
const PROTOCOLS = ["aave-v3", "across", "jupiter", "relay"];
const ASSETS = ["ETH", "USDC", "USDT", "group:USDC"];
const CATEGORIES = ["native", "stablecoin", "wrapped"];
const ACCOUNTS = ["eip155:*:0x4f183e308f24c81c05303821ad025812fbfd807d", "eip155:*:0x1111111111111111111111111111111111111111"];
const RECIPIENTS = ["eip155:8453:0x2222222222222222222222222222222222222222", "eip155:8453:0x3333333333333333333333333333333333333333"];
const CAPS = ["50", "200", "1000", "5000"];

function pick(random, values) {
  return values[Math.floor(random() * values.length)];
}

function someOf(random, values) {
  return values.filter(() => random() < 0.5);
}

/** A random valid rule book (agent defaults): each field present about half the time. */
function randomPolicy(random) {
  const document = { schema: "kletia.policy/v1" };
  const maybe = (probability = 0.5) => random() < probability;
  if (maybe(0.3)) document.mode = pick(random, ["live", "dry-run", "paused"]);
  else document.mode = "live";
  if (maybe()) document.networks = { allow: someOf(random, NETWORKS) };
  if (maybe(0.3)) document.networks = { ...document.networks, lanes: maybe() ? ["production"] : ["production", "testnet"] };
  if (maybe()) document.kinds = { allow: someOf(random, KINDS) };
  if (maybe()) document.protocols = { ...(maybe() ? { allow: someOf(random, PROTOCOLS) } : {}), ...(maybe() ? { deny: someOf(random, PROTOCOLS) } : {}) };
  if (maybe()) document.assets = { ...(maybe() ? { allow: someOf(random, ASSETS) } : {}), ...(maybe() ? { categories: someOf(random, CATEGORIES) } : {}), ...(maybe() ? { unlisted: pick(random, ["deny", "allow"]) } : {}) };
  if (maybe()) document.accounts = { allow: someOf(random, ACCOUNTS) };
  if (maybe()) {
    const mode = pick(random, ["own", "allowlist", "any"]);
    const allow = someOf(random, RECIPIENTS);
    document.recipients = { mode, ...(mode === "allowlist" ? { allow: allow.length > 0 ? allow : [RECIPIENTS[0]] } : {}), ...(maybe() ? { deny: [RECIPIENTS[1]] } : {}), ...(maybe() ? { names: pick(random, ["deny", "resolve", "trusted"]) } : {}) };
  }
  if (maybe()) document.limits = { maxSteps: 1 + Math.floor(random() * 8), ...(maybe() ? { maxSlippageBps: 10 + Math.floor(random() * 200) } : {}), ...(maybe() ? { maxFeeUsd: pick(random, ["5", "20"]) } : {}) };
  if (maybe()) {
    // Caps keep their order (perStepUsd ≤ perIntentUsd ≤ dailyUsd ≤ weeklyUsd).
    const caps = {};
    let floor = 0;
    for (const cap of ["perStepUsd", "perIntentUsd", "dailyUsd", "weeklyUsd"]) {
      if (!maybe()) continue;
      floor = Math.max(floor, Math.floor(random() * CAPS.length));
      caps[cap] = CAPS[floor];
    }
    document.caps = caps;
  }
  if (maybe(0.3)) document.schedule = { timezone: "UTC", windows: [{ days: someOf(random, ["mon", "tue", "wed", "thu", "fri"]).concat("sat"), from: pick(random, ["06:00", "08:00"]), to: pick(random, ["18:00", "20:00"]) }] };
  if (maybe(0.4)) document.confirm = { aboveUsd: pick(random, CAPS), ...(maybe() ? { when: someOf(random, ["cross-network", "external-recipient"]) } : {}), ...(maybe() ? { ttlSeconds: pick(random, [600, 3600, 7200]) } : {}) };
  if (maybe()) document.permissions = Object.fromEntries(POLICY_PERMISSIONS.filter(() => maybe()).map((permission) => [permission, maybe()]));
  if (maybe(0.3)) document.execution = { pinNonce: maybe() };
  if (maybe(0.3)) document.amendments = { delaySeconds: pick(random, [0, 600, 3600]) };
  const result = validatePolicy(document, { defaults: "agent" });
  assert.ok(result.ok, JSON.stringify(result.issues));
  return result.value;
}

/** The parent as a child request: its own rule book with the permissions a sub-agent may ask for. */
function sameAsParent(parent) {
  const permissions = Object.fromEntries(
    Object.entries(parent.permissions ?? {}).filter(([permission]) => !SUBAGENT_NEVER_PERMISSIONS.includes(permission)),
  );
  return { ...parent, ...(parent.permissions ? { permissions } : {}) };
}

const chainOf = (...levels) => [{ policy: null, defaults: "project", id: "prj_key_x" }, ...levels.map((policy, index) => ({ policy, defaults: "agent", id: `key_${index}` }))];

test("a request equal to its parent (minus management permissions) is a subset", () => {
  const random = rng(1);
  for (let round = 0; round < 400; round += 1) {
    const parent = randomPolicy(random);
    const result = checkSubagentPolicy({ child: sameAsParent(parent), chain: chainOf(parent), childDepth: 2 });
    assert.ok(result.ok, `round ${round}: ${JSON.stringify(result.issues)} for ${JSON.stringify(parent)}`);
    for (const permission of SUBAGENT_NEVER_PERMISSIONS) assert.equal(result.document.permissions[permission], false);
  }
});

test("whatever passes is never looser than the parent, field by field (comparePolicies oracle)", () => {
  const random = rng(2);
  let passed = 0;
  for (let round = 0; round < 3_000; round += 1) {
    const parent = randomPolicy(random);
    const child = random() < 0.5 ? randomPolicy(random) : sameAsParent(parent);
    const result = checkSubagentPolicy({ child, chain: chainOf(parent), childDepth: 2 });
    if (!result.ok) continue;
    passed += 1;
    const { loosened } = comparePolicies(effectivePolicyDocument(parent, "agent"), effectivePolicyDocument(result.document, "agent"), { defaults: "agent" });
    // An absent approver-key list on the child only governs the child's own holds (every level's holds keep their approvers).
    assert.deepEqual(loosened.filter((path) => path !== "confirm.approvers.keys"), [], `round ${round}: parent ${JSON.stringify(parent)} child ${JSON.stringify(result.document)}`);
  }
  assert.ok(passed > 300, `enough generated children pass to exercise the oracle (${passed})`);
});

test("a chain is checked level by level: passing the chain is passing every level", () => {
  const random = rng(3);
  for (let round = 0; round < 1_500; round += 1) {
    const project = random() < 0.5 ? null : { ...randomPolicy(random), mode: "live", permissions: undefined };
    const ancestor = randomPolicy(random);
    const parent = randomPolicy(random);
    const child = { ...(random() < 0.5 ? randomPolicy(random) : sameAsParent(parent)), permissions: undefined, confirm: undefined };
    const chain = [{ policy: project, defaults: "project", id: "prj_key_x" }, { policy: ancestor, defaults: "agent", id: "key_a" }, { policy: parent, defaults: "agent", id: "key_p" }];
    const whole = checkSubagentPolicy({ child, chain, childDepth: 3 }).ok;
    const each = chain.every((level) => checkSubagentPolicy({ child, chain: [level], childDepth: 3 }).ok);
    assert.equal(whole, each, `round ${round}`);
  }
});

test("widening any one field of an equal request is refused on that field", () => {
  const random = rng(4);
  const widenings = [
    ["networks.allow", (parent) => (parent.networks?.allow ? { networks: { ...parent.networks, allow: parent.networks.allow.length < NETWORKS.length ? NETWORKS : undefined } } : null)],
    ["kinds.allow", (parent) => (parent.kinds?.allow ? { kinds: { allow: undefined } } : null)],
    ["protocols.deny", (parent) => (parent.protocols?.deny?.length ? { protocols: { ...parent.protocols, deny: [] } } : null)],
    ["caps.dailyUsd", (parent) => (parent.caps?.dailyUsd ? { caps: { ...parent.caps, dailyUsd: "99999" } } : null)],
    ["caps.weeklyUsd", (parent) => (parent.caps?.weeklyUsd ? { caps: { ...parent.caps, weeklyUsd: undefined } } : null)],
    ["mode", (parent) => (parent.mode !== "live" ? { mode: "live" } : null)],
    ["recipients.mode", (parent) => ((parent.recipients?.mode ?? "own") !== "any" ? { recipients: { mode: "any" } } : null)],
    ["assets.unlisted", (parent) => ((parent.assets?.unlisted ?? "deny") === "deny" ? { assets: { unlisted: "allow" } } : null)],
    ["permissions.webhooks", () => ({ permissions: { webhooks: true } })],
    ["limits.maxSteps", (parent) => (parent.limits?.maxSteps ? { limits: { ...parent.limits, maxSteps: undefined } } : null)],
    ["schedule", (parent) => (parent.schedule ? { schedule: undefined } : null)],
    ["amendments.delaySeconds", (parent) => ((parent.amendments?.delaySeconds ?? 0) > 0 ? { amendments: { delaySeconds: 0 } } : null)],
  ];
  let checked = 0;
  for (let round = 0; round < 600; round += 1) {
    const parent = randomPolicy(random);
    for (const [path, widen] of widenings) {
      const patch = widen(parent);
      if (!patch) continue;
      const child = { ...sameAsParent(parent), ...patch };
      if (patch.assets) child.assets = { ...parent.assets, ...patch.assets };
      const result = checkSubagentPolicy({ child, chain: chainOf(parent), childDepth: 2 });
      assert.equal(result.ok, false, `round ${round}: widening ${path} of ${JSON.stringify(parent)} passed`);
      assert.ok(result.issues.some((issue) => issue.path === path), `round ${round}: ${path} not named in ${JSON.stringify(result.issues)}`);
      checked += 1;
    }
  }
  assert.ok(checked > 1_000);
});

test("sub-agents start permissionless and never get what the chain lacks", () => {
  const parent = { schema: "kletia.policy/v1", mode: "live", permissions: { createChildKeys: true, mcpCreateIntents: true, webhooks: true } };
  const plain = checkSubagentPolicy({ child: { schema: "kletia.policy/v1", mode: "live" }, chain: chainOf(parent), childDepth: 2 });
  assert.ok(plain.ok);
  assert.deepEqual(plain.document.permissions, { createChildKeys: false, webhooks: false, registerContracts: false, sessions: false, storeIntents: true, mcpCreateIntents: false, links: false, automations: false });
  const nested = checkSubagentPolicy({ child: { schema: "kletia.policy/v1", permissions: { createChildKeys: true, mcpCreateIntents: true } }, chain: chainOf(parent), childDepth: 2 });
  assert.ok(nested.ok);
  assert.equal(nested.document.permissions.createChildKeys, true);
  const tooDeep = checkSubagentPolicy({ child: { schema: "kletia.policy/v1", permissions: { createChildKeys: true } }, chain: chainOf(parent, parent), childDepth: SUBAGENT_LIMITS.maxDepth });
  assert.deepEqual(tooDeep.issues.map((issue) => issue.path), ["permissions.createChildKeys"]);
  for (const permission of SUBAGENT_NEVER_PERMISSIONS) {
    const refused = checkSubagentPolicy({ child: { schema: "kletia.policy/v1", permissions: { [permission]: true } }, chain: chainOf(parent), childDepth: 2 });
    assert.deepEqual(refused.issues.map((issue) => issue.path), [`permissions.${permission}`]);
  }
  const lacking = checkSubagentPolicy({ child: { schema: "kletia.policy/v1", permissions: { links: false, storeIntents: true } }, chain: chainOf({ schema: "kletia.policy/v1", permissions: { storeIntents: false } }), childDepth: 2 });
  assert.deepEqual(lacking.issues.map((issue) => issue.path), ["permissions.storeIntents"]);
  // The observer parent: a live child is wider than dry-run.
  assert.deepEqual(checkSubagentPolicy({ child: { schema: "kletia.policy/v1", mode: "live" }, chain: chainOf(null), childDepth: 2 }).issues.map((issue) => issue.path), ["mode"]);
});

test("sub-agent perps stay inside the parent's perps section", () => {
  const off = { schema: "kletia.policy/v1", mode: "live", permissions: { createChildKeys: true } };
  const on = { ...off, perps: { enabled: true, maxLeverage: 5, venues: ["gmx-v2"] } };
  const ask = (perps, parent) => checkSubagentPolicy({ child: { schema: "kletia.policy/v1", mode: "live", perps }, chain: chainOf(parent), childDepth: 2 });
  assert.ok(ask(undefined, off).ok, "no perps section asks for nothing");
  assert.deepEqual(ask({ enabled: true, maxLeverage: 2, venues: ["gmx-v2"] }, off).issues.map((issue) => issue.path), ["perps.enabled"]);
  assert.ok(ask({ enabled: true, maxLeverage: 5, venues: ["gmx-v2"] }, on).ok);
  assert.deepEqual(ask({ enabled: true, maxLeverage: 10, venues: ["gmx-v2"] }, on).issues.map((issue) => issue.path), ["perps.maxLeverage"]);
  assert.deepEqual(ask({ enabled: true, venues: ["gmx-v2"] }, on).issues.map((issue) => issue.path), ["perps.maxLeverage"]);
  assert.deepEqual(ask({ enabled: true, maxLeverage: 3, venues: ["hyperliquid"] }, on).issues.map((issue) => issue.path), ["perps.venues"]);
  assert.deepEqual(ask({ enabled: true, maxLeverage: 3 }, on).issues.map((issue) => issue.path), ["perps.venues"]);
});

test("approver identities, account wildcards, expiry and depth", () => {
  const parent = {
    schema: "kletia.policy/v1",
    accounts: { allow: ["eip155:*:0x4f183e308f24c81c05303821ad025812fbfd807d"] },
    confirm: { aboveUsd: "100", approvers: { wallets: ["eip155:1:0x9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a"] } },
  };
  const narrower = { schema: "kletia.policy/v1", accounts: { allow: ["eip155:8453:0x4f183e308f24c81c05303821ad025812fbfd807d"] }, confirm: { aboveUsd: "50" } };
  assert.ok(checkSubagentPolicy({ child: narrower, chain: chainOf(parent), childDepth: 2 }).ok, "an exact account is covered by the parent's wildcard");
  const stranger = { ...narrower, confirm: { aboveUsd: "50", approvers: { wallets: ["eip155:1:0x7777777777777777777777777777777777777777"] } } };
  assert.deepEqual(checkSubagentPolicy({ child: stranger, chain: chainOf(parent), childDepth: 2 }).issues.map((issue) => issue.path), ["confirm.approvers.wallets"]);
  const now = Date.parse("2026-10-23T00:00:00Z");
  const late = checkSubagentPolicy({ child: narrower, chain: chainOf(parent), childDepth: 2, childExpiresAt: new Date(now + 2 * 86_400_000).toISOString(), parentExpiresAt: new Date(now + 86_400_000).toISOString() });
  assert.deepEqual(late.issues.map((issue) => issue.path), ["expiresAt"]);
  assert.deepEqual(checkSubagentPolicy({ child: narrower, chain: chainOf(parent), childDepth: SUBAGENT_LIMITS.maxDepth + 1 }).issues.map((issue) => issue.path), ["depth"]);
  assert.deepEqual(checkSubagentPolicy({ child: narrower, chain: [], childDepth: 1 }).ok, false, "no chain: fail closed");
});

test("the grant description and the approval message name exactly what is granted", () => {
  const parent = { schema: "kletia.policy/v1", mode: "live", networks: { allow: ["base", "solana"] }, caps: { dailyUsd: "1000" }, permissions: { createChildKeys: true } };
  const child = checkSubagentPolicy({ child: { schema: "kletia.policy/v1", mode: "live", networks: { allow: ["base"] }, kinds: { allow: ["transfer"] }, caps: { dailyUsd: "250", perIntentUsd: "100" } }, chain: chainOf(parent), childDepth: 2 }).document;
  const lines = describeSubagentGrant(child, parent);
  const byPath = Object.fromEntries(lines.map((line) => [line.path, line]));
  assert.deepEqual([byPath["networks.allow"].child, byPath["networks.allow"].parent, byPath["networks.allow"].same], ["base", "base, solana", false]);
  assert.deepEqual([byPath["caps.dailyUsd"].child, byPath["caps.dailyUsd"].parent], ["$250", "$1000"]);
  assert.equal(byPath.mode.same, true);
  assert.equal(byPath.permissions.child, "storeIntents");
  const input = {
    origin: "https://kletiaai.xyz",
    walletKind: "evm",
    address: "0x4F183e308f24c81C05303821AD025812fBFd807D",
    chainId: 8453,
    decision: "approve",
    requestId: `sar_${"a".repeat(32)}`,
    projectId: `prj_key_${"b".repeat(24)}`,
    parentKeyId: `key_${"c".repeat(24)}`,
    name: "invoice\npayer",
    policyHash: policyHash(child),
    document: child,
    keyExpiresAt: "2026-10-30T00:00:00.000Z",
    nonce: "Q2xhaW1Ob25jZTEyMzQ1Ng",
    issuedAt: "2026-10-23T00:00:00.000Z",
    expiresAt: "2026-10-23T00:10:00.000Z",
  };
  const message = subagentApprovalMessage(input);
  assert.equal(message.split("\n")[0], "kletiaai.xyz wants you to decide a Kletia sub-agent request with your Ethereum account:");
  assert.match(message, /^Approve sub-agent "invoice payer" under agent key key_c{24}\.$/mu, "names are one line");
  assert.match(message, new RegExp(`^Rule book: ${input.policyHash}$`, "mu"));
  assert.match(message, /^Caps: \$100 per intent, \$250 per 24 h$/mu);
  assert.match(message, /^Permissions: storeIntents$/mu);
  assert.match(message, /^Chain ID: 8453$/mu);
  assert.equal(subagentMessageNonce(message), input.nonce);
  assert.notEqual(subagentApprovalMessage({ ...input, decision: "deny" }), message, "the decision is part of what is signed");
  assert.match(subagentApprovalMessage({ ...input, walletKind: "solana", chainId: null, address: "So11111111111111111111111111111111111111112" }), /^Chain ID: mainnet$/mu);
  assert.deepEqual(AGENT_EVENT_TYPES, ["agent.subagent_requested", "agent.subagent_approved", "agent.subagent_denied", "agent.subagent_revoked"]);
});
