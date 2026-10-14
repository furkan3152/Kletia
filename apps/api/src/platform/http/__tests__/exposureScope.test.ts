/**
 * Exposure scope (integrator design 4.8, F28): exposures of intents owned by
 * a publishable key, and of link and session intents, are written to and
 * checked against the owner key's own windows only, under the chain's
 * effective (smallest) caps. The reference gate runs over memory ports and
 * a scripted price market; adapters are the offline stubs. With
 * KLETIA_TEST_DATABASE_URL, the Postgres intent store keeps the scope too.
 *
 *   cd apps/api && node --import tsx --test src/platform/http/__tests__/exposureScope.test.ts
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { IntentGraph } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { ACCOUNTS, resetEngine } from "../../engine/__tests__/helpers.js";
import { FakeChains, installRuleBook, PROJECT_ID, removeRuleBook, ROOT_KEY, ruleBook, type RuleBookWorld } from "../../engine/__tests__/policyHarness.js";
import { configurePolicyGate } from "../../engine/policy/gate.js";
import { createRuleBookGate, ownWindows } from "../../engine/policy/ruleBookGate.js";
import type { PolicyChainSnapshot } from "../../engine/policy/ports.js";
import { createIntentDetailed, prepareStep } from "../../engine/service.js";
import { MemoryIntentStore, PostgresIntentStore } from "../../engine/store.js";

const PUB_KEY = "key_00000000000000000000pub1";
const SMALL_SWAP = { text: "swap 0.01 SOL to USDC", accounts: ACCOUNTS };
const SWAP = { text: "swap 1 SOL to USDC", accounts: ACCOUNTS };

/** The HTTP chain source returns the owner record with its kind; this one marks PUB_KEY publishable. */
class KindChains extends FakeChains {
  override async chain(ownerKeyId: string): Promise<PolicyChainSnapshot | undefined> {
    const snapshot = await super.chain(ownerKeyId);
    return snapshot ? { ...snapshot, record: { kind: ownerKeyId === PUB_KEY ? "publishable" : "project" } } as PolicyChainSnapshot : undefined;
  }
}

let world: RuleBookWorld;
let store: MemoryIntentStore;

async function failure(promise: Promise<unknown>): Promise<PlatformError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof PlatformError, `expected PlatformError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the call to fail");
}

async function usage(scope: string): Promise<bigint> {
  return (await world.ledger.usage([scope], Date.now())).get(scope)?.dayUsdMicros ?? 0n;
}

let chains: KindChains;

beforeEach(() => {
  store = resetEngine();
  world = installRuleBook();
  // A gate over a chain source that reports owner kinds (the market, ledger and logs of the harness).
  chains = new KindChains();
  chains.keys.set(PUB_KEY, { parent: ROOT_KEY, agent: false, active: true, policy: null, version: 0 });
  configurePolicyGate(createRuleBookGate({ chains, ledger: world.ledger, approvals: world.approvals, decisions: world.decisions }));
});

afterEach(() => {
  removeRuleBook();
});

describe("ownWindows", () => {
  const snapshot = (kind?: string): PolicyChainSnapshot => ({ projectId: PROJECT_ID, ownerKeyId: PUB_KEY, lineage: [ROOT_KEY], keyActive: true, levels: [], ...(kind ? { record: { kind } } : {}) }) as PolicyChainSnapshot;
  it("scopes publishable owners and hinted intents, nothing else", () => {
    assert.equal(ownWindows(snapshot("publishable"), undefined), true);
    assert.equal(ownWindows(snapshot("project"), undefined), false);
    assert.equal(ownWindows(snapshot(), undefined), false);
    assert.equal(ownWindows(snapshot("agent"), { exposureScope: "owner" }), true);
  });
});

describe("exposures in the owner's own windows", () => {
  it("leaves a project dailyUsd cap untouched after 20 publishable prepares", async () => {
    chains.setProject(ruleBook({ caps: { dailyUsd: "100" } }));
    chains.setPolicy(PUB_KEY, ruleBook({ permissions: { storeIntents: true } }));
    for (let index = 0; index < 20; index += 1) {
      const { intent } = await createIntentDetailed(SMALL_SWAP, { ownerKeyId: PUB_KEY });
      const { payload } = await prepareStep(intent.id, "s1");
      const rows = world.ledger.snapshot().filter((row) => row.record.id === payload.policy?.exposureId);
      assert.deepEqual(rows.map((row) => row.scope), [PUB_KEY], "written to the publishable key's scope only");
    }
    assert.equal(await usage(PROJECT_ID), 0n, "the project window is untouched");
    assert.equal(await usage(ROOT_KEY), 0n, "the parent server key's window is untouched");
    assert.equal(await usage(PUB_KEY), 30_000_000n, "20 x $1.50 in the publishable key's own window");
  });

  it("still applies the chain's effective cap to the owner's own window", async () => {
    chains.setProject(ruleBook({ caps: { dailyUsd: "2" } }));
    chains.setPolicy(ROOT_KEY, ruleBook({ caps: { dailyUsd: "500" } }));
    const first = await createIntentDetailed(SMALL_SWAP, { ownerKeyId: PUB_KEY });
    await prepareStep(first.intent.id, "s1");
    assert.equal(await usage(PUB_KEY), 1_500_000n);
    // $1.50 more would pass $2 in the publishable key's own window: refused (the project's cap, smallest of the chain).
    const refused = await failure((async () => {
      const second = await createIntentDetailed(SMALL_SWAP, { ownerKeyId: PUB_KEY });
      await prepareStep(second.intent.id, "s1");
    })());
    assert.equal(refused.code, "POLICY_SPEND_LIMIT");
    assert.equal(await usage(PROJECT_ID), 0n, "the project window itself never counted");
    // Another publishable key of the project has its own window under the same cap.
    const other = "key_00000000000000000000pub2";
    chains.keys.set(other, { parent: ROOT_KEY, agent: false, active: true, policy: null, version: 0 });
    const third = await createIntentDetailed(SMALL_SWAP, { ownerKeyId: other, exposureScope: "owner" });
    await prepareStep(third.intent.id, "s1");
    assert.equal(await usage(other), 1_500_000n);
  });

  it("keeps server-key intents in every level's window", async () => {
    chains.setProject(ruleBook({ caps: { dailyUsd: "1000" } }));
    const { intent } = await createIntentDetailed(SMALL_SWAP, { ownerKeyId: ROOT_KEY });
    const { payload } = await prepareStep(intent.id, "s1");
    const scopes = world.ledger.snapshot().filter((row) => row.record.id === payload.policy?.exposureId).map((row) => row.scope).sort();
    assert.deepEqual(scopes, [PROJECT_ID, ROOT_KEY].sort());
  });

  it("scopes session and link intents of a server key to its own window, and stores the scope", async () => {
    chains.setProject(ruleBook({ caps: { dailyUsd: "1000" } }));
    const session = await createIntentDetailed({ ...SMALL_SWAP, metadata: { sessionId: "cs_x" } }, { ownerKeyId: ROOT_KEY, exposureScope: "owner" });
    const link = await createIntentDetailed(SMALL_SWAP, { ownerKeyId: ROOT_KEY, linkId: `lk_${"a".repeat(24)}`, actorKeyId: null });
    for (const intent of [session.intent, link.intent] as IntentGraph[]) assert.deepEqual(await store.metaOf(intent.id), { ownerKeyId: ROOT_KEY, exposureScope: "owner" });
    // (Link intents force strict simulation at prepare; the session intent shows where the exposure goes.)
    const { payload } = await prepareStep(session.intent.id, "s1");
    const scopes = world.ledger.snapshot().filter((row) => row.record.id === payload.policy?.exposureId).map((row) => row.scope);
    assert.deepEqual(scopes, [ROOT_KEY]);
    assert.equal(await usage(PROJECT_ID), 0n);
    // A forged metadata.sessionId on an ordinary intent changes nothing.
    const forged = await createIntentDetailed({ ...SMALL_SWAP, metadata: { sessionId: "cs_forged" } }, { ownerKeyId: ROOT_KEY });
    assert.deepEqual(await store.metaOf(forged.intent.id), { ownerKeyId: ROOT_KEY });
    await prepareStep(forged.intent.id, "s1");
    assert.equal(await usage(PROJECT_ID), 1_500_000n);
  });
});

describe("intent store meta", () => {
  it("keeps the contract authority and the exposure scope (memory)", async () => {
    const memory = new MemoryIntentStore();
    const { intent } = await createIntentDetailed(SMALL_SWAP, { dryRun: true });
    await memory.create(intent, { ownerKeyId: PUB_KEY, contractAuthorityKeyId: ROOT_KEY, exposureScope: "owner" });
    assert.deepEqual(await memory.metaOf(intent.id), { ownerKeyId: PUB_KEY, contractAuthorityKeyId: ROOT_KEY, exposureScope: "owner" });
    assert.equal(await memory.metaOf("int_missing"), undefined);
  });

  const url = process.env.KLETIA_TEST_DATABASE_URL;
  it("keeps the contract authority and the exposure scope (Postgres)", { skip: url ? false : "KLETIA_TEST_DATABASE_URL not set" }, async () => {
    const pg = new PostgresIntentStore(url as string);
    try {
      const { intent } = await createIntentDetailed(SMALL_SWAP, { dryRun: true });
      const graph = { ...intent, id: `int_${randomBytes(16).toString("hex")}` };
      await pg.create(graph, { ownerKeyId: PUB_KEY, contractAuthorityKeyId: ROOT_KEY, exposureScope: "owner" });
      assert.deepEqual(await pg.metaOf(graph.id), { ownerKeyId: PUB_KEY, contractAuthorityKeyId: ROOT_KEY, exposureScope: "owner" });
      const plain = { ...intent, id: `int_${randomBytes(16).toString("hex")}` };
      await pg.create(plain, { ownerKeyId: ROOT_KEY });
      assert.deepEqual(await pg.metaOf(plain.id), { ownerKeyId: ROOT_KEY });
    } finally {
      await pg.close();
    }
  });
});
