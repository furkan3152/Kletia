/**
 * Intent links, engine side (intent-links design L2): deliver sizing
 * (the live Relay sequence, the three-run cap, the 20 s cache) and
 * `planLinkIntent` over the offline stub venues: expansion per funding
 * choice, visitor accounts per VM, bounds, the unverified-publisher cap,
 * the envelope check (nothing stored on a violation), the publisher key's
 * Rule Book, `metadata.linkId` and indicative quotes.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { findAssetBySymbol, validateLinkDefinition, type AccountId, type IntentGraph, type LinkDefinition, type StoredLinkDefinition } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import type { ProtocolAdapter } from "../adapters/types.js";
import { assertLinkEnvelope, linkPolicyCheck, linkVisitorAccounts, planLinkIntent, resetDeliverSizing, sizeDelivery } from "../links/index.js";
import type { PolicyChainLevel } from "../policy/ports.js";
import { configurePolicyPricing } from "../policy/pricing.js";
import { configurePreviewPricer, previewEnforced } from "../preview/index.js";
import { configurePlatform, createIntentDetailed, getIntent, prepareStep } from "../service.js";
import { configureContractDirectory, type ContractDirectory } from "../contracts/directory.js";
import { registerNameResolver, resetNameResolvers, type NameResolver } from "../names.js";
import type { MemoryIntentStore } from "../store.js";
import { EVM_ACCOUNT as EVM_ACCOUNT_TEXT, EVM_ADDRESS, OTHER_EVM_ADDRESS, resetEngine, SOL_ACCOUNT as SOL_ACCOUNT_TEXT, STUB_ADAPTERS, stubRelay } from "./helpers.js";
import { installMarket, installRuleBook, removeRuleBook, ROOT_KEY, ruleBook, standardPrices } from "./policyHarness.js";
import { installRpcMock, type RpcMock } from "./rpcMock.js";

const LINK_ID = "lk_5f1c2a9b7e3d4c6a8b0e1f23";
const EVM_ACCOUNT = EVM_ACCOUNT_TEXT as AccountId;
const SOL_ACCOUNT = SOL_ACCOUNT_TEXT as AccountId;
const OWNER = "key_000000000000000000000001";
const MERCHANT = `eip155:8453:${OTHER_EVM_ADDRESS}` as AccountId;
const NOW = Date.parse("2026-10-09T12:00:00Z");

async function failure(promise: Promise<unknown>): Promise<PlatformError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof PlatformError, `expected PlatformError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the call to fail");
}

function usdcRef(network: "base" | "arbitrum" | "solana") {
  const asset = findAssetBySymbol(network, "USDC");
  assert.ok(asset);
  return { asset: asset.id, symbol: asset.symbol, decimals: asset.decimals };
}

function definition(body: Record<string, unknown>): LinkDefinition {
  const result = validateLinkDefinition({ expiresAt: "2026-12-31T23:59:59Z", blink: false, ...body }, { now: NOW });
  assert.ok(result.ok, JSON.stringify(result.ok ? null : result.issues));
  return result.value;
}

/** "Pay 25 USDC to the merchant on Base", from Base, Arbitrum or Solana USDC. */
function payLink(): StoredLinkDefinition {
  return {
    definition: definition({
      title: "Pay 25 USDC to Acme",
      publisher: { name: "Acme Store", website: "https://shop.acme.example" },
      destination: { actions: [{ kind: "transfer", network: "base", from: "USDC", amount: "25", recipient: MERCHANT }] },
      funding: { networks: ["base", "arbitrum", "solana"], assets: ["USDC"], amount: { mode: "deliver" } },
      metadata: { invoice: "A-1029" },
    }),
    pins: { recipients: [{ action: 0, account: MERCHANT }], contracts: [], destinationAsset: usdcRef("base") },
  };
}

/** "Deposit USDC into Aave on Base from any network", 10-5,000 USDC. */
function depositLink(): StoredLinkDefinition {
  return {
    definition: definition({
      title: "Deposit USDC into Aave",
      publisher: { name: "Acme Yield", website: "https://acme.example" },
      destination: { actions: [{ kind: "deposit", network: "base", from: "USDC", amount: "$amount", protocol: "aave-v3" }] },
      funding: { networks: ["base", "arbitrum", "solana"], assets: ["USDC"], amount: { mode: "input", bounds: { USDC: { min: "10", max: "5000", default: "100" } } } },
    }),
    pins: { recipients: [], contracts: [], destinationAsset: usdcRef("base") },
  };
}

describe("deliver sizing", () => {
  beforeEach(() => resetDeliverSizing());

  it("reproduces the live Relay sequence: x0 = 25.075 is short, x1 = 25.157732 delivers", async () => {
    // Relay Solana USDC → Base USDC at 50 bps (design Appendix A11): input → guaranteed minimum.
    const quotes = new Map<bigint, bigint>([[25_075_000n, 24_922_771n], [25_157_732n, 25_005_071n]]);
    const asked: bigint[] = [];
    const result = await sizeDelivery({
      key: "live",
      targetUnits: 25_000_000n,
      targetDecimals: 6,
      inputDecimals: 6,
      plan: async (input, check) => {
        asked.push(input);
        // The design's x0 used 25.075 (a rounded first guess): answer the nearest captured quote.
        const minimum = quotes.get(input) ?? quotes.get(input <= 25_075_226n ? 25_075_000n : 25_157_732n) ?? 0n;
        check(minimum);
        return { input, minimum };
      },
    });
    assert.equal(result.runs, 2);
    assert.equal(asked[0], 25_075_226n, "x0 = ceil(25 × 10⁴ / 9,970)");
    assert.equal(result.minimumUnits, 25_005_071n);
    assert.ok(result.minimumUnits >= 25_000_000n);
    assert.ok(result.inputUnits > (asked[0] as bigint));
  });

  it("trims a first guess that overpays by more than 50 bps", async () => {
    const result = await sizeDelivery({
      key: "generous",
      targetUnits: 25_000_000n,
      targetDecimals: 6,
      inputDecimals: 6,
      plan: async (input, check) => {
        const minimum = (input * 10_100n) / 10_000n; // the venue pays 1 % more than the input
        check(minimum);
        return input;
      },
    });
    assert.equal(result.runs, 2);
    assert.ok(result.inputUnits < 25_075_226n, "the smaller input is kept");
    assert.ok(result.minimumUnits >= 25_000_000n);
  });

  it("gives up after three runs with LINK_DELIVERY_UNQUOTABLE, and lets other errors through", async () => {
    let runs = 0;
    const error = await failure(sizeDelivery({
      key: "short",
      targetUnits: 25_000_000n,
      targetDecimals: 6,
      inputDecimals: 6,
      plan: async (input, check) => {
        runs += 1;
        check(24_999_999n); // the venue never guarantees the full amount
        return input;
      },
    }));
    assert.equal(error.code, "LINK_DELIVERY_UNQUOTABLE");
    assert.equal(error.status, 502);
    assert.equal(runs, 3);
    const route = await failure(sizeDelivery({
      key: "route",
      targetUnits: 1n,
      targetDecimals: 6,
      inputDecimals: 6,
      plan: async () => {
        throw new PlatformError("ROUTE_UNAVAILABLE", "No venue quoted this route.", 422);
      },
    }));
    assert.equal(route.code, "ROUTE_UNAVAILABLE");
  });

  it("caches the accepted input for 20 s per link and source", async () => {
    const plan = (asked: bigint[]) => async (input: bigint, check: (minimum: bigint) => void) => {
      asked.push(input);
      check((input * 9_950n) / 10_000n);
      return input;
    };
    const first: bigint[] = [];
    const sized = await sizeDelivery({ key: "cached", targetUnits: 25_000_000n, targetDecimals: 6, inputDecimals: 6, plan: plan(first), now: NOW });
    assert.equal(sized.cached, false);
    const second: bigint[] = [];
    const again = await sizeDelivery({ key: "cached", targetUnits: 25_000_000n, targetDecimals: 6, inputDecimals: 6, plan: plan(second), now: NOW + 5_000 });
    assert.equal(again.cached, true);
    assert.equal(again.runs, 1);
    assert.deepEqual(second, [sized.inputUnits]);
    const third: bigint[] = [];
    const expired = await sizeDelivery({ key: "cached", targetUnits: 25_000_000n, targetDecimals: 6, inputDecimals: 6, plan: plan(third), now: NOW + 25_000 });
    assert.equal(expired.cached, false, "the cache holds 20 s");
  });
});

describe("planLinkIntent", () => {
  let store: MemoryIntentStore;
  let mock: RpcMock;

  beforeEach(() => {
    store = resetEngine();
    resetDeliverSizing();
    mock = installRpcMock();
    const market = installMarket();
    standardPrices(market);
    configurePreviewPricer({ price: async (asset) => (/USDC|erc20:0x833589|token:EPjF/u.test(asset) || asset.includes("erc20:0xaf88") ? 1 : null) });
  });

  afterEach(() => {
    mock.restore();
    configurePolicyPricing(null);
    configurePreviewPricer(null);
    removeRuleBook();
  });

  it("pays a deliver link from another network with one bridge to the pinned recipient, sized to deliver at least the amount", async () => {
    const { intent, preview, replayed } = await planLinkIntent({
      link: payLink(), linkId: LINK_ID, ownerKeyId: OWNER, choice: { network: "arbitrum", asset: "USDC" }, accounts: [`eip155:42161:${EVM_ADDRESS}` as AccountId], dryRun: false, publisherVerified: true,
    });
    assert.equal(replayed, false);
    assert.equal(intent.steps.length, 1, "the transfer is absorbed into the bridge");
    const bridge = intent.steps[0];
    assert.ok(bridge);
    assert.equal(bridge.kind, "bridge");
    assert.equal(bridge.network, "arbitrum");
    assert.equal(bridge.recipient, MERCHANT);
    assert.ok(BigInt(bridge.minimumOutput?.amount ?? "0") >= 25_000_000n, "at least 25 USDC guaranteed");
    assert.ok(BigInt(bridge.input?.amount ?? "0") > 25_000_000n);
    assert.equal(intent.metadata?.linkId, LINK_ID);
    assert.equal(intent.metadata?.invoice, "A-1029");
    assert.equal(previewEnforced(intent, bridge), true, "link intents are always simulated before prepare");
    assert.equal(preview.intentId, intent.id);
    assert.equal(preview.stage, "plan");
    assert.equal((await store.listByOwner(OWNER, 10)).length, 1, "only the accepted candidate was stored");
    // Only the preview's simulation reads reach the (mocked) chain; no provider was called.
    assert.deepEqual(mock.unknown.filter((entry) => !entry.startsWith("eth_simulateV1")), []);
  });

  it("replays a deliver intent on the visitor's retry without sizing it again", async () => {
    const input = { link: payLink(), linkId: LINK_ID, ownerKeyId: OWNER, choice: { network: "arbitrum" as const, asset: "USDC" }, accounts: [`eip155:42161:${EVM_ADDRESS}` as AccountId], dryRun: false, publisherVerified: true, clientReference: "invoice-A-1029" };
    const first = await planLinkIntent(input);
    resetDeliverSizing();
    const retry = await planLinkIntent(input);
    assert.equal(retry.replayed, true);
    assert.equal(retry.intent.id, first.intent.id);
    assert.equal((await store.listByOwner(OWNER, 10)).length, 1);
  });

  it("pays a deliver link directly on its own network", async () => {
    const { intent } = await planLinkIntent({
      link: payLink(), linkId: LINK_ID, ownerKeyId: OWNER, choice: { network: "base", asset: "USDC" }, accounts: [EVM_ACCOUNT], dryRun: true, publisherVerified: true,
    });
    assert.equal(intent.steps.length, 1);
    assert.equal(intent.steps[0]?.kind, "transfer");
    assert.equal(intent.steps[0]?.input?.amount, "25000000");
    assert.equal(intent.steps[0]?.recipient, MERCHANT);
    assert.equal((await store.listByOwner(OWNER, 10)).length, 0, "dry runs store nothing");
  });

  it("asks exactly one account per VM the route signs on", async () => {
    const link = payLink();
    const missing = await failure(planLinkIntent({ link, linkId: LINK_ID, ownerKeyId: OWNER, choice: { network: "solana", asset: "USDC" }, accounts: [EVM_ACCOUNT], dryRun: true, publisherVerified: true }));
    assert.equal(missing.code, "LINK_ACCOUNTS_REQUIRED");
    assert.ok(missing.issues?.some((issue) => /Solana/u.test(issue.message)));
    const extra = await failure(planLinkIntent({ link, linkId: LINK_ID, ownerKeyId: OWNER, choice: { network: "solana", asset: "USDC" }, accounts: [SOL_ACCOUNT, EVM_ACCOUNT], dryRun: true, publisherVerified: true }));
    assert.equal(extra.code, "LINK_ACCOUNTS_REQUIRED", "an extra EVM account could become a default payout");
    const twice = await failure(planLinkIntent({ link: depositLink(), linkId: LINK_ID, ownerKeyId: OWNER, choice: { network: "base", asset: "USDC", amount: "50" }, accounts: [EVM_ACCOUNT, `eip155:8453:${OTHER_EVM_ADDRESS}` as AccountId], dryRun: true, publisherVerified: true }));
    assert.equal(twice.code, "LINK_ACCOUNTS_REQUIRED");
    const solana = await planLinkIntent({ link, linkId: LINK_ID, ownerKeyId: OWNER, choice: { network: "solana", asset: "USDC" }, accounts: [SOL_ACCOUNT], dryRun: true, publisherVerified: true });
    assert.equal(solana.intent.steps[0]?.network, "solana");
    assert.deepEqual(solana.intent.request.accounts, [SOL_ACCOUNT]);
  });

  it("builds the funding leg per visitor choice and keeps amounts in bounds", async () => {
    const link = depositLink();
    const bridged = await planLinkIntent({ link, linkId: LINK_ID, ownerKeyId: OWNER, choice: { network: "arbitrum", asset: "USDC", amount: "250" }, accounts: [`eip155:42161:${EVM_ADDRESS}` as AccountId], dryRun: true, publisherVerified: true });
    assert.deepEqual(bridged.intent.steps.map((step) => step.kind), ["bridge", "deposit"]);
    assert.equal(bridged.intent.steps[0]?.input?.amount, "250000000");
    assert.deepEqual(bridged.intent.edges.map((edge) => edge.kind), ["funds"]);
    const direct = await planLinkIntent({ link, linkId: LINK_ID, ownerKeyId: OWNER, choice: { network: "base", asset: "USDC" }, accounts: [EVM_ACCOUNT], dryRun: true, publisherVerified: true });
    assert.deepEqual(direct.intent.steps.map((step) => step.kind), ["deposit"]);
    assert.equal(direct.intent.steps[0]?.input?.amount, "100000000", "the default amount");
    const above = await failure(planLinkIntent({ link, linkId: LINK_ID, ownerKeyId: OWNER, choice: { network: "base", asset: "USDC", amount: "5000.01" }, accounts: [EVM_ACCOUNT], dryRun: true, publisherVerified: true }));
    assert.equal(above.code, "LINK_INPUT_OUT_OF_BOUNDS");
    assert.equal(above.status, 422);
    const source = await failure(planLinkIntent({ link, linkId: LINK_ID, ownerKeyId: OWNER, choice: { network: "optimism", asset: "USDC", amount: "50" }, accounts: [EVM_ACCOUNT], dryRun: true, publisherVerified: true }));
    assert.equal(source.code, "LINK_SOURCE_NOT_ALLOWED");
  });

  it("limits unverified publishers to $1,000 per intent with the conservative oracle", async () => {
    const link = depositLink();
    const capped = await failure(planLinkIntent({ link, linkId: LINK_ID, ownerKeyId: OWNER, choice: { network: "base", asset: "USDC", amount: "1500" }, accounts: [EVM_ACCOUNT], dryRun: true }));
    assert.equal(capped.code, "LINK_INPUT_OUT_OF_BOUNDS");
    assert.match(capped.message, /\$1,000/u);
    const verified = await planLinkIntent({ link, linkId: LINK_ID, ownerKeyId: OWNER, choice: { network: "base", asset: "USDC", amount: "1500" }, accounts: [EVM_ACCOUNT], dryRun: true, publisherVerified: true });
    assert.equal(verified.intent.steps[0]?.input?.amount, "1500000000");
    configurePolicyPricing({ ethCall: async () => null, jupiterPrices: async () => ({}), solanaSlot: async () => 1n });
    const unpriced = await failure(planLinkIntent({ link, linkId: LINK_ID, ownerKeyId: OWNER, choice: { network: "base", asset: "USDC", amount: "20" }, accounts: [EVM_ACCOUNT], dryRun: true }));
    assert.equal(unpriced.code, "LINK_INPUT_OUT_OF_BOUNDS");
    assert.match(unpriced.message, /unknown/u);
  });

  it("refuses a plan that leaves the envelope and stores nothing", async () => {
    // A venue that settles somewhere else than asked (a planner or adapter bug).
    const rogue: ProtocolAdapter = {
      ...stubRelay,
      plan: async (action) => {
        const planned = await stubRelay.plan(action);
        return { ...planned, settlement: { kind: "cross-network", destinationNetwork: "solana", expectedSeconds: 20 } };
      },
    };
    configurePlatform({ adapters: [...STUB_ADAPTERS.filter((adapter) => adapter !== stubRelay), rogue] });
    const error = await failure(planLinkIntent({ link: depositLink(), linkId: LINK_ID, ownerKeyId: OWNER, choice: { network: "arbitrum", asset: "USDC", amount: "50" }, accounts: [`eip155:42161:${EVM_ADDRESS}` as AccountId], dryRun: false, publisherVerified: true }));
    assert.equal(error.code, "LINK_PLAN_OUT_OF_BOUNDS");
    assert.equal(error.status, 500);
    assert.equal((await store.listByOwner(OWNER, 10)).length, 0);
  });

  it("checks payers, recipients, contracts and the root input of a planned graph", async () => {
    const link = payLink();
    const planned = await planLinkIntent({ link, linkId: LINK_ID, ownerKeyId: OWNER, choice: { network: "base", asset: "USDC" }, accounts: [EVM_ACCOUNT], dryRun: true, publisherVerified: true });
    const { expandLink } = await import("@kletia/core");
    const expansion = expandLink(link, { network: "base", asset: "USDC" });
    const check = { expansion, accounts: [EVM_ACCOUNT], kinds: ["transfer"] };
    assert.doesNotThrow(() => assertLinkEnvelope(planned.intent, check));
    const mutate = (change: (graph: IntentGraph) => IntentGraph) => () => assertLinkEnvelope(change(planned.intent), check);
    const step = planned.intent.steps[0] as IntentGraph["steps"][number];
    const cases: [string, (graph: IntentGraph) => IntentGraph][] = [
      ["foreign recipient", (graph) => ({ ...graph, steps: [{ ...step, recipient: `eip155:8453:${"0x2222222222222222222222222222222222222222"}` as never }] })],
      ["the pinned address on another chain", (graph) => ({ ...graph, steps: [{ ...step, recipient: `eip155:42161:${OTHER_EVM_ADDRESS}` as never }] })],
      ["another payer", (graph) => ({ ...graph, steps: [{ ...step, account: `eip155:8453:${"0x3333333333333333333333333333333333333333"}` as never }] })],
      ["another amount", (graph) => ({ ...graph, steps: [{ ...step, input: { ...(step.input as NonNullable<typeof step.input>), amount: "25000001" } }] })],
      ["an unpinned contract", (graph) => ({ ...graph, steps: [{ ...step, kind: "call", call: { contract: "ct_000000000000000000000000", revision: 1, definitionHash: "x", entry: "e", target: OTHER_EVM_ADDRESS } as never }] })],
      ["an extra root step", (graph) => ({ ...graph, steps: [step, { ...step, id: "s2", index: 1 }] })],
    ];
    for (const [label, change] of cases) {
      assert.throws(mutate(change), (error: unknown) => error instanceof PlatformError && error.code === "LINK_PLAN_OUT_OF_BOUNDS", label);
    }
  });

  it("plans under the publisher key's Rule Book: a link cannot widen it", async () => {
    const world = installRuleBook();
    world.chains.setPolicy(ROOT_KEY, ruleBook({ recipients: { mode: "own" } }));
    const error = await failure(planLinkIntent({ link: payLink(), linkId: LINK_ID, ownerKeyId: ROOT_KEY, choice: { network: "base", asset: "USDC" }, accounts: [EVM_ACCOUNT], dryRun: false, publisherVerified: true }));
    assert.equal(error.code, "POLICY_VIOLATION");
    assert.equal((error.toJSON() as { policy?: { violations: { rule: string }[] } }).policy?.violations[0]?.rule, "recipients.mode");
    world.chains.setPolicy(ROOT_KEY, ruleBook({ recipients: { mode: "allowlist", allow: [MERCHANT] } }));
    const allowed = await planLinkIntent({ link: payLink(), linkId: LINK_ID, ownerKeyId: ROOT_KEY, choice: { network: "base", asset: "USDC" }, accounts: [EVM_ACCOUNT], dryRun: false, publisherVerified: true });
    assert.equal(allowed.intent.policy?.outcome, "allow");
    const decision = world.decisions.list("prj_00000000000000000000aaaa").at(-1);
    assert.equal(decision?.actorKeyId, null, "visitors act without a key");
  });

  it("quotes indicatively with placeholder accounts and never stores", async () => {
    const { intent, preview } = await planLinkIntent({ link: depositLink(), linkId: LINK_ID, ownerKeyId: OWNER, choice: { network: "solana", asset: "USDC", amount: "40" }, accounts: [], dryRun: false, indicative: true, publisherVerified: true });
    assert.equal(preview.stage, "indicative");
    assert.deepEqual(intent.request.accounts, [
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      "eip155:8453:0x000000000000000000000000000000000000c0de",
    ], "one placeholder per VM the route signs on");
    assert.equal((await store.listByOwner(OWNER, 10)).length, 0);
    await assert.rejects(getIntent(intent.id), (error: unknown) => error instanceof PlatformError && error.code === "INTENT_NOT_FOUND");
  });

  it("validates visitor accounts against the link's lane", () => {
    const expansion = { requiredVms: ["evm"], source: { network: "base" } } as never;
    assert.throws(() => linkVisitorAccounts(expansion, [`eip155:421614:${EVM_ADDRESS}`] as never), (error: unknown) => error instanceof PlatformError && error.code === "LINK_ACCOUNTS_REQUIRED");
    assert.equal(linkVisitorAccounts(expansion, [`eip155:10:${EVM_ADDRESS}`] as never)[0]?.chain.key, "optimism", "any production EVM chain names the address");
  });

  it("namespaces visitors' clientReference per link and accounts", async () => {
    const link = depositLink();
    const first = await planLinkIntent({ link, linkId: LINK_ID, ownerKeyId: OWNER, choice: { network: "base", asset: "USDC", amount: "50" }, accounts: [EVM_ACCOUNT], dryRun: false, publisherVerified: true, clientReference: "order-7" });
    const retry = await planLinkIntent({ link, linkId: LINK_ID, ownerKeyId: OWNER, choice: { network: "base", asset: "USDC", amount: "50" }, accounts: [EVM_ACCOUNT], dryRun: false, publisherVerified: true, clientReference: "order-7" });
    assert.equal(retry.replayed, true);
    assert.equal(retry.intent.id, first.intent.id);
    const stranger = await planLinkIntent({ link, linkId: LINK_ID, ownerKeyId: OWNER, choice: { network: "base", asset: "USDC", amount: "50" }, accounts: [`eip155:8453:${OTHER_EVM_ADDRESS}` as AccountId], dryRun: false, publisherVerified: true, clientReference: "order-7" });
    assert.equal(stranger.replayed, false, "another visitor never replays (or reads) someone else's intent");
    assert.notEqual(stranger.intent.id, first.intent.id);
    assert.match(first.intent.request.clientReference ?? "", /^link:[0-9a-f]{48}$/u);
    const bad = await failure(planLinkIntent({ link, linkId: LINK_ID, ownerKeyId: OWNER, choice: { network: "base", asset: "USDC", amount: "50" }, accounts: [EVM_ACCOUNT], dryRun: false, publisherVerified: true, clientReference: "bad ref" }));
    assert.equal(bad.code, "INVALID_REQUEST");
  });

  it("re-resolves pinned names: a moved name refuses the link, and prepare re-checks it like any name", async () => {
    const table = new Map([["acme.base.eth", OTHER_EVM_ADDRESS]]);
    const resolver: NameResolver = {
      id: "test-basenames",
      protocol: "basenames",
      suffixes: [".base.eth"],
      networks: ["base"],
      resolve: async (name) => {
        const address = table.get(name);
        return address ? { name, address, protocol: "basenames", detail: "test resolver" } : null;
      },
    };
    const unregister = registerNameResolver(resolver);
    try {
      const named = payLink();
      const link: StoredLinkDefinition = { ...named, pins: { ...named.pins, recipients: [{ action: 0, account: MERCHANT, name: "acme.base.eth" }] } };
      const { intent } = await planLinkIntent({ link, linkId: LINK_ID, ownerKeyId: OWNER, choice: { network: "base", asset: "USDC" }, accounts: [EVM_ACCOUNT], dryRun: false, publisherVerified: true });
      assert.equal(intent.steps[0]?.recipient, MERCHANT);
      assert.equal(intent.steps[0]?.recipientName, "acme.base.eth", "planned by name, so prepare re-resolves it");
      table.set("acme.base.eth", "0x2222222222222222222222222222222222222222");
      const moved = await failure(planLinkIntent({ link, linkId: LINK_ID, ownerKeyId: OWNER, choice: { network: "base", asset: "USDC" }, accounts: [EVM_ACCOUNT], dryRun: true, publisherVerified: true }));
      assert.equal(moved.code, "LINK_RECIPIENT_CHANGED");
      assert.equal(moved.status, 409);
      assert.equal((moved as unknown as { drift?: { reason: string } }).drift?.reason, "recipient_changed");
      const prepared = await failure(prepareStep(intent.id, "s1"));
      assert.equal(prepared.code, "RECIPIENT_NAME_CHANGED", "an intent made before the move never pays the new address");
    } finally {
      unregister();
      resetNameResolvers();
    }
  });

  it("refuses a link whose pinned registration moved to another revision", async () => {
    const contract = "ct_5f1c2a9b7e3d4c6a8b0e1f23";
    const link: StoredLinkDefinition = {
      ...depositLink(),
      pins: { recipients: [], contracts: [{ action: 0, contract, revision: 3, definitionHash: `sha256:${"ab".repeat(32)}`, entry: "deposit", target: OTHER_EVM_ADDRESS }], destinationAsset: usdcRef("base") },
    };
    let revision = 4;
    configureContractDirectory({ current: async () => ({ id: contract, status: "active", activeRevision: revision, definitionHash: `sha256:${"ab".repeat(32)}` }) } as unknown as ContractDirectory);
    try {
      const error = await failure(planLinkIntent({ link, linkId: LINK_ID, ownerKeyId: OWNER, choice: { network: "base", asset: "USDC", amount: "50" }, accounts: [EVM_ACCOUNT], dryRun: true, publisherVerified: true }));
      assert.equal(error.code, "LINK_CONTRACT_CHANGED");
      revision = 3;
      const { linkPinDrift } = await import("../links/index.js");
      assert.equal(await linkPinDrift(link), null);
    } finally {
      configureContractDirectory(null);
    }
  });

  it("keeps metadata.linkId for the engine: callers cannot set it", async () => {
    const error = await failure(createIntentDetailed({ text: "send 1 USDC to 0x1111111111111111111111111111111111111111 on base", accounts: [EVM_ACCOUNT], metadata: { linkId: LINK_ID } }, { ownerKeyId: OWNER }));
    assert.equal(error.code, "INVALID_REQUEST");
  });
});

describe("link policy check (static, at creation)", () => {
  const PROJECT = "prj_00000000000000000000aaaa";
  const level = (policy: Record<string, unknown> | null, defaults: "project" | "agent" = "project"): PolicyChainLevel[] => [
    { scope: "project", id: PROJECT, defaults: "project", policy: null, version: null, hash: null },
    { scope: "key", id: ROOT_KEY, defaults, policy: policy ? ruleBook(policy, defaults) : null, version: policy ? 1 : null, hash: null },
  ];

  beforeEach(() => {
    const market = installMarket();
    standardPrices(market);
  });

  afterEach(() => configurePolicyPricing(null));

  it("finds nothing for a key without rules", async () => {
    assert.deepEqual(await linkPolicyCheck({ link: payLink(), levels: level(null) }), { conflicts: [], holds: [] });
  });

  it("reports funding networks, recipients and amounts the key's rule book refuses", async () => {
    const networks = await linkPolicyCheck({ link: depositLink(), levels: level({ networks: { allow: ["base", "arbitrum"] } }) });
    assert.deepEqual([...new Set(networks.conflicts.map((violation) => violation.rule))], ["networks.allow"]);
    assert.match(networks.conflicts[0]?.message ?? "", /funding USDC on solana/u);
    const recipients = await linkPolicyCheck({ link: payLink(), levels: level({ recipients: { mode: "own" } }) });
    assert.deepEqual([...new Set(recipients.conflicts.map((violation) => violation.rule))], ["recipients.mode"]);
    assert.equal(recipients.conflicts[0]?.observed, MERCHANT);
    const allowed = await linkPolicyCheck({ link: payLink(), levels: level({ recipients: { mode: "allowlist", allow: [MERCHANT] } }) });
    assert.deepEqual(allowed.conflicts, []);
    const caps = await linkPolicyCheck({ link: depositLink(), levels: level({ caps: { perStepUsd: "1000" } }) });
    assert.ok(caps.conflicts.some((violation) => violation.rule === "caps.perStepUsd" && violation.observed === "5000.00"), "the largest amount a visitor may choose");
    const paused = await linkPolicyCheck({ link: payLink(), levels: level({ mode: "dry-run" }) });
    assert.ok(paused.conflicts.some((violation) => violation.rule === "mode.dryRun"));
  });

  it("lists reachable holds and ignores what only an auction can tell", async () => {
    const holds = await linkPolicyCheck({ link: depositLink(), levels: level({ confirm: { aboveUsd: "500", when: ["cross-network"] }, protocols: { allow: ["aave-v3"] }, limits: { maxSeconds: 60 } }) });
    assert.deepEqual(holds.conflicts, [], "protocol and timing rules are judged per visitor intent");
    assert.deepEqual(holds.holds.map((trigger) => trigger.rule).sort(), ["confirm.aboveUsd", "confirm.crossNetwork"]);
  });

  it("checks pinned contracts against contracts.allow (agents: none by default)", async () => {
    const contract = "ct_5f1c2a9b7e3d4c6a8b0e1f23";
    const link: StoredLinkDefinition = {
      definition: definition({
        title: "Deposit USDC into Acme Vault",
        publisher: { name: "Acme Yield", website: "https://acme.example" },
        destination: { actions: [{ kind: "call", network: "base", contract: "acme vault", entry: "deposit", amount: "$amount" }] },
        funding: { networks: ["base"], assets: ["USDC"], amount: { mode: "input", bounds: { USDC: { min: "10", max: "500" } } } },
      }),
      pins: { recipients: [], contracts: [{ action: 0, contract, revision: 3, definitionHash: `sha256:${"ab".repeat(32)}`, entry: "deposit", target: "0xbeef000000000000000000000000000000008183" }], destinationAsset: usdcRef("base") },
    };
    const agent = await linkPolicyCheck({ link, levels: level({ caps: { perStepUsd: "1000" } }, "agent") });
    assert.ok(agent.conflicts.some((violation) => violation.rule === "contracts.allow"));
    const listed = await linkPolicyCheck({ link, levels: level({ caps: { perStepUsd: "1000" }, contracts: { allow: [{ id: contract, entries: ["deposit"] }] } }, "agent") });
    assert.deepEqual(listed.conflicts, []);
  });
});
