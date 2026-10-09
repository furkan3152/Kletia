/**
 * Rule Book hooks in the intent service (policy design PF2 §15): narrowing
 * before the auction, plan-time denies and holds, prepare-time re-evaluation
 * with fresh prices, approvals, exposure reservation and release, nonce
 * pinning, Solana expiry, reconciliation at submit, nonce overrides, revoked
 * owners, fail-closed stores and prices. The reference gate runs over memory
 * ports and a scripted price market; adapters are the offline stubs.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { approvalDigest, policyHash, verifyDecisionChain, type KletiaEvent, type PolicyEventType } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { verifyEvmReferences } from "../adapters/verification.js";
import type { PreparedPayload, ProtocolAdapter } from "../adapters/types.js";
import { subscribePolicyEvents } from "../policy/events.js";
import { CHAINLINK_FEEDS, JUPITER_MINTS } from "../policy/feeds.js";
import { resetPolicyPricing } from "../policy/pricing.js";
import type { PolicyApprovalRecord } from "../policy/ports.js";
import { configurePlatform, createIntentDetailed, getIntent, prepareStep, refreshIntent, submitStep } from "../service.js";
import type { MemoryIntentStore } from "../store.js";
import {
  ACCOUNTS,
  EVM_ADDRESS,
  OTHER_EVM_ADDRESS,
  randomEvmHash,
  randomSolanaSignature,
  resetEngine,
  SOL_ADDRESS,
  STUB_ADAPTERS,
  stub,
  stubRelay,
  unsignedSolanaTransaction,
} from "./helpers.js";
import {
  AGENT_B_KEY,
  AGENT_KEY,
  feed,
  feedKey,
  installRuleBook,
  jupiter,
  PROJECT_ID,
  removeRuleBook,
  ROOT_KEY,
  ruleBook,
  type RuleBookWorld,
} from "./policyHarness.js";
import { installRpcMock, type RpcMock } from "./rpcMock.js";

let store: MemoryIntentStore;
let world: RuleBookWorld;

async function failure(promise: Promise<unknown>): Promise<PlatformError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof PlatformError, `expected PlatformError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the call to fail");
}

interface PolicyBody {
  readonly decisionId: string | null;
  readonly stage: string;
  readonly outcome: string;
  readonly keyId: string | null;
  readonly violations: readonly { readonly rule: string; readonly scope: string; readonly keyId?: string; readonly path?: string; readonly observed?: string; readonly limit?: string }[];
  readonly retryAt: string | null;
  readonly approval?: { readonly id: string; readonly url: string; readonly status?: string };
}

function policyOf(error: PlatformError): PolicyBody {
  const body = error.toJSON() as { policy?: PolicyBody };
  assert.ok(body.policy, `${error.code} carries error.policy`);
  return body.policy;
}

function rules(error: PlatformError): string[] {
  return policyOf(error).violations.map((violation) => violation.rule);
}

const BRIDGE = (amount: number, from = "base", to = "arbitrum") => ({ text: `bridge ${amount} USDC from ${from} to ${to}`, accounts: ACCOUNTS });
const SWAP_SOL = { text: "swap 1 SOL to USDC", accounts: ACCOUNTS };

function setSolPrice(price: number): void {
  world.market.jupiter.set(JUPITER_MINTS.wsol, jupiter(world.market, price));
  resetPolicyPricing();
}

function setUsdcPrice(price: number): void {
  for (const entry of [CHAINLINK_FEEDS.usdcUsdEthereum, CHAINLINK_FEEDS.usdcUsdBase, CHAINLINK_FEEDS.usdcUsdArbitrum]) world.market.chainlink.set(feedKey(entry), feed(price, { now: world.market.now }));
  world.market.jupiter.set(JUPITER_MINTS.usdc, jupiter(world.market, price));
  resetPolicyPricing();
}

function ledgerRows(exposureId?: string) {
  return world.ledger.snapshot().filter((row) => exposureId === undefined || row.record.id === exposureId);
}

function approvals(): Map<string, PolicyApprovalRecord> {
  return (world.approvals as unknown as { byIntent: Map<string, PolicyApprovalRecord> }).byIntent;
}

/** A second bridge venue, so a rule book can steer the auction away from Relay. */
const stubLifi: ProtocolAdapter = {
  ...stubRelay,
  id: "lifi",
  protocols: ["lifi"],
  label: "Stub LI.FI",
  plan: async (action) => ({ ...(await stubRelay.plan(action)), protocol: "lifi" }),
};

describe("Rule Book gate in the intent service", () => {
  let events: KletiaEvent<PolicyEventType>[];
  let unsubscribe: () => void;

  beforeEach(() => {
    store = resetEngine();
    world = installRuleBook();
    events = [];
    unsubscribe = subscribePolicyEvents((event) => events.push(event as KletiaEvent<PolicyEventType>));
  });

  afterEach(() => {
    unsubscribe();
    removeRuleBook();
  });

  it("leaves keyless intents and keys without any rule book untouched", async () => {
    const keyless = await createIntentDetailed(SWAP_SOL);
    assert.equal(keyless.intent.policy, undefined);
    assert.equal(world.chains.reads, 0, "keyless intents never read the policy store");
    const { intent } = await createIntentDetailed(SWAP_SOL, { ownerKeyId: ROOT_KEY });
    assert.equal(intent.policy, undefined);
    const { payload } = await prepareStep(intent.id, "s1");
    assert.equal(payload.policy, undefined);
    assert.equal(ledgerRows().length, 0);
    assert.equal(world.decisions.list(PROJECT_ID).length, 0);
  });

  it("narrows constraints before planning so the auction never sees a denied venue", async () => {
    configurePlatform({ adapters: [...STUB_ADAPTERS, stubLifi] });
    world.chains.setProject(ruleBook({ protocols: { deny: ["relay"] }, limits: { maxSlippageBps: 30 } }));
    const { intent } = await createIntentDetailed(BRIDGE(10), { ownerKeyId: ROOT_KEY });
    assert.equal(intent.steps[0]?.protocol, "lifi");
    assert.deepEqual(intent.request.constraints?.avoidProtocols, ["relay"], "the stored request shows what was applied");
    assert.equal(intent.request.constraints?.maxSlippageBps, 30);
    assert.equal(intent.policy?.outcome, "allow");
    assert.deepEqual(intent.policy?.chain.map((link) => link.id), [PROJECT_ID]);
    world.chains.setProject(ruleBook({ protocols: { allow: ["relay", "erc20-transfer", "spl-token", "system-transfer", "jupiter"] } }));
    const allowed = await createIntentDetailed(BRIDGE(10), { ownerKeyId: ROOT_KEY });
    assert.equal(allowed.intent.steps[0]?.protocol, "relay", "an allowlist avoids every other executable venue");
    assert.ok(allowed.intent.request.constraints?.avoidProtocols?.includes("lifi"));
  });

  it("refuses at plan, for stored intents and dry runs alike, and stores nothing", async () => {
    world.chains.addAgent(AGENT_KEY, ROOT_KEY, ruleBook({ caps: { perIntentUsd: "500" } }, "agent"));
    const request = { text: `send 10 USDC to ${OTHER_EVM_ADDRESS} on base`, accounts: ACCOUNTS };
    for (const dryRun of [false, true]) {
      const error = await failure(createIntentDetailed(request, { ownerKeyId: AGENT_KEY, dryRun }));
      assert.equal(error.code, "POLICY_VIOLATION");
      assert.equal(error.status, 403);
      const policy = policyOf(error);
      assert.equal(policy.stage, "plan");
      assert.equal(policy.keyId, AGENT_KEY);
      assert.deepEqual(rules(error), ["recipients.mode"], "agents pay only their own accounts by default");
      assert.equal(policy.violations[0]?.path, "steps[0].recipient");
      assert.match(error.message, /recipients\.mode/u);
      assert.deepEqual(error.issues?.map((entry) => entry.path), ["steps[0].recipient"]);
    }
    assert.equal((await store.listByOwner(AGENT_KEY, 10)).length, 0);
    const decisions = world.decisions.list(PROJECT_ID);
    assert.deepEqual(decisions.map((decision) => decision.outcome), ["deny", "deny"]);
    assert.deepEqual(decisions.map((decision) => decision.dryRun), [false, true]);
    assert.ok(events.some((event) => event.type === "policy.violation"));
  });

  it("checks request-level rules before any quote is spent", async () => {
    let plans = 0;
    configurePlatform({ adapters: STUB_ADAPTERS.map((adapter) => ({ ...adapter, plan: async (action) => { plans += 1; return adapter.plan(action); } })) });
    world.chains.setPolicy(ROOT_KEY, ruleBook({ accounts: { allow: [`eip155:*:${EVM_ADDRESS}`] } }));
    const error = await failure(createIntentDetailed(SWAP_SOL, { ownerKeyId: ROOT_KEY }));
    assert.equal(error.code, "POLICY_VIOLATION");
    assert.deepEqual(rules(error), ["accounts.allow"]);
    assert.equal(policyOf(error).violations[0]?.path, "accounts[1]");
    world.chains.setProject(ruleBook({ mode: "paused" }));
    const paused = await failure(createIntentDetailed(BRIDGE(5), { ownerKeyId: ROOT_KEY, dryRun: true }));
    assert.deepEqual(rules(paused), ["mode.paused", "accounts.allow"], "every violation is listed, root first");
    assert.deepEqual(policyOf(paused).violations.map((violation) => violation.scope), ["project", "key"]);
    assert.equal(plans, 0, "no venue was asked");
  });

  it("lets an observer agent plan dry runs but never store or prepare", async () => {
    world.chains.addAgent(AGENT_KEY, ROOT_KEY, null);
    const dry = await createIntentDetailed(SWAP_SOL, { ownerKeyId: AGENT_KEY, dryRun: true });
    assert.equal(dry.intent.policy?.outcome, "allow");
    const error = await failure(createIntentDetailed(SWAP_SOL, { ownerKeyId: AGENT_KEY }));
    assert.deepEqual(rules(error), ["mode.dryRun"]);
  });

  it("holds an intent above the threshold, extends its lifetime and clears it with an approval", async () => {
    world.chains.setPolicy(ROOT_KEY, ruleBook({ confirm: { aboveUsd: "100", ttlSeconds: 7_200 } }));
    const { intent } = await createIntentDetailed(BRIDGE(500), { ownerKeyId: ROOT_KEY });
    const stamp = intent.policy;
    assert.ok(stamp?.approval);
    assert.equal(stamp.outcome, "confirm");
    assert.equal(stamp.notionalUsd, "500.00");
    assert.equal(stamp.approval.ceilingUsd, "510.00", "notional × 1.02");
    assert.deepEqual(stamp.approval.triggers, ["confirm.aboveUsd"]);
    assert.match(stamp.approval.url, /^https:\/\/kletia\.test\/approve#apr_[0-9a-f]{32}$/u);
    assert.equal(Date.parse(intent.expiresAt) - Date.parse(intent.createdAt), 7_200_000, "a human has the hold's time");
    assert.equal(intent.plan?.record.expiresAt, intent.expiresAt, "the plan record commits to the extended expiry");
    const held = await world.approvals.forIntent(intent.id);
    assert.ok(held);
    assert.equal(held.id, stamp.approval.id);
    assert.equal(held.digest, approvalDigest(intent, ROOT_KEY));
    assert.equal(held.ceilingUsdCents, 51_000n);
    assert.ok(events.some((event) => event.type === "policy.approval_requested"));

    const pending = await failure(prepareStep(intent.id, "s1"));
    assert.equal(pending.code, "POLICY_APPROVAL_REQUIRED");
    assert.equal(pending.status, 403);
    assert.equal((pending as unknown as { retryAfterSeconds?: number }).retryAfterSeconds, 15);
    assert.equal(policyOf(pending).approval?.id, held.id);
    assert.equal(policyOf(pending).approval?.status, "pending");

    await world.approvals.decide(held.id, "approved");
    const { payload } = await prepareStep(intent.id, "s1");
    assert.ok(payload.policy);
    assert.equal(payload.policy.notionalUsd, "500.00");
    assert.match(payload.policy.exposureId, /^px_[0-9a-f]{24}$/u);
    assert.deepEqual(payload.policy.chainHashes, [policyHash(ruleBook({ confirm: { aboveUsd: "100", ttlSeconds: 7_200 } }))]);

    const dry = await createIntentDetailed(BRIDGE(500), { ownerKeyId: ROOT_KEY, dryRun: true });
    assert.equal(dry.intent.policy?.outcome, "confirm");
    assert.equal(dry.intent.policy?.approval, undefined, "dry runs never create holds");
  });

  it("cancels the intent when an approver rejects it", async () => {
    world.chains.setPolicy(ROOT_KEY, ruleBook({ confirm: { aboveUsd: "100" } }));
    const { intent } = await createIntentDetailed(BRIDGE(500), { ownerKeyId: ROOT_KEY });
    await world.approvals.decide(intent.policy?.approval?.id as string, "rejected");
    const error = await failure(prepareStep(intent.id, "s1"));
    assert.equal(error.code, "POLICY_APPROVAL_REJECTED");
    assert.equal((await getIntent(intent.id)).status, "cancelled");
  });

  it("refuses expired holds (410) and approvals whose ceiling the fresh value exceeds (409)", async () => {
    world.chains.setPolicy(ROOT_KEY, ruleBook({ confirm: { aboveUsd: "100" } }));
    const expired = await createIntentDetailed(BRIDGE(500), { ownerKeyId: ROOT_KEY });
    const record = approvals().get(expired.intent.id) as PolicyApprovalRecord;
    approvals().set(expired.intent.id, { ...record, expiresAt: new Date(Date.now() - 1_000).toISOString() });
    const gone = await failure(prepareStep(expired.intent.id, "s1"));
    assert.equal(gone.code, "POLICY_APPROVAL_EXPIRED");
    assert.equal(gone.status, 410);

    const stale = await createIntentDetailed(BRIDGE(500), { ownerKeyId: ROOT_KEY });
    await world.approvals.decide(stale.intent.policy?.approval?.id as string, "approved");
    setUsdcPrice(1.1);
    const moved = await failure(prepareStep(stale.intent.id, "s1"));
    assert.equal(moved.code, "POLICY_APPROVAL_STALE");
    assert.equal(moved.status, 409);
    assert.equal(policyOf(moved).violations.find((violation) => violation.rule === "approval.stale")?.limit, "510.00");
  });

  it("keeps a hold stamped at plan even when fresh prices fall below the threshold", async () => {
    world.chains.setPolicy(ROOT_KEY, ruleBook({ confirm: { aboveUsd: "120" } }));
    const { intent } = await createIntentDetailed(SWAP_SOL, { ownerKeyId: ROOT_KEY });
    assert.equal(intent.policy?.outcome, "confirm", "1 SOL at $150");
    setSolPrice(100);
    const still = await failure(prepareStep(intent.id, "s1"));
    assert.equal(still.code, "POLICY_APPROVAL_REQUIRED", "waiting for a dip does not skip the approver");
    // The hold row went missing (its creation failed after the intent was stored): it is recreated from the stamp.
    approvals().delete(intent.id);
    const again = await failure(prepareStep(intent.id, "s1"));
    assert.equal(again.code, "POLICY_APPROVAL_REQUIRED");
    const recreated = await world.approvals.forIntent(intent.id);
    assert.equal(recreated?.id, intent.policy?.approval?.id);
    assert.equal(recreated?.ceilingUsdCents, 15_300n);
    await world.approvals.decide(recreated?.id as string, "approved");
    const { payload } = await prepareStep(intent.id, "s1");
    assert.equal(payload.policy?.notionalUsd, "100.00");
  });

  it("re-evaluates at prepare with fresh prices: allow becomes a hold, or a per-step cap refusal", async () => {
    world.chains.setPolicy(ROOT_KEY, ruleBook({ confirm: { aboveUsd: "200" } }));
    const held = await createIntentDetailed(SWAP_SOL, { ownerKeyId: ROOT_KEY });
    assert.equal(held.intent.policy?.outcome, "allow", "1 SOL at $150");
    setSolPrice(250);
    const raised = await failure(prepareStep(held.intent.id, "s1"));
    assert.equal(raised.code, "POLICY_APPROVAL_REQUIRED");
    const created = await world.approvals.forIntent(held.intent.id);
    assert.ok(created, "the hold starts at prepare");
    assert.equal(created.ceilingUsdCents, 25_500n);
    assert.equal(policyOf(raised).approval?.id, created.id);

    setSolPrice(150);
    world.chains.setPolicy(ROOT_KEY, ruleBook({ caps: { perStepUsd: "200" } }));
    const capped = await createIntentDetailed(SWAP_SOL, { ownerKeyId: ROOT_KEY });
    assert.equal(capped.intent.policy?.outcome, "allow");
    setSolPrice(250);
    const refused = await failure(prepareStep(capped.intent.id, "s1"));
    assert.equal(refused.code, "POLICY_VIOLATION");
    assert.deepEqual(rules(refused), ["caps.perStepUsd"]);
    assert.equal(policyOf(refused).violations[0]?.observed, "250.00");
    assert.equal(policyOf(refused).stage, "prepare");
  });

  it("reserves the exposure in every scope before the payload leaves", async () => {
    world.chains.addAgent(AGENT_KEY, ROOT_KEY, ruleBook({ caps: { dailyUsd: "1000" } }, "agent"));
    const { intent } = await createIntentDetailed(SWAP_SOL, { ownerKeyId: AGENT_KEY });
    const { payload } = await prepareStep(intent.id, "s1");
    const rows = ledgerRows(payload.policy?.exposureId);
    assert.deepEqual(rows.map((row) => row.scope).sort(), [AGENT_KEY, PROJECT_ID, ROOT_KEY].sort());
    assert.ok(rows.every((row) => row.state === "open" && row.record.usdMicros === 150_000_000n));
    const decision = world.decisions.list(PROJECT_ID).find((entry) => entry.id === payload.policy?.decisionId);
    assert.equal(decision?.stage, "prepare");
    assert.equal(decision?.outcome, "allow");
    assert.equal(decision?.exposureId, payload.policy?.exposureId);
    assert.deepEqual(decision?.usage, [{ scope: AGENT_KEY, window: "24h", usedUsd: "150.00", capUsd: "1000.00" }]);
  });

  it("marks the exposure dead when the graph commit fails (the payload never left)", async () => {
    world.chains.setPolicy(ROOT_KEY, ruleBook({ caps: { dailyUsd: "1000" } }));
    const { intent } = await createIntentDetailed(SWAP_SOL, { ownerKeyId: ROOT_KEY });
    const update = store.update.bind(store);
    store.update = async () => {
      store.update = update;
      throw new PlatformError("INTENT_CONFLICT", "The intent changed concurrently.", 409);
    };
    const error = await failure(prepareStep(intent.id, "s1"));
    assert.equal(error.code, "INTENT_CONFLICT");
    const rows = ledgerRows();
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.state === "dead"));
    assert.equal((await world.ledger.usage([ROOT_KEY], Date.now())).get(ROOT_KEY)?.dayUsdMicros, 0n);
  });

  it("pins consecutive nonces for agents so re-prepares on one nonce count once", async () => {
    stub.relayEvmTransactions = 2;
    world.chains.addAgent(AGENT_KEY, ROOT_KEY, ruleBook({ caps: { dailyUsd: "150" } }, "agent"));
    const { intent } = await createIntentDetailed(BRIDGE(100), { ownerKeyId: AGENT_KEY });
    const first = await prepareStep(intent.id, "s1");
    assert.deepEqual(first.payload.transactions.map((transaction) => (transaction.vm === "evm" ? transaction.nonce : null)), ["7", "8"]);
    const row = ledgerRows(first.payload.policy?.exposureId)[0];
    assert.equal(row?.exclusiveKey, `evm:8453:${EVM_ADDRESS.toLowerCase()}:7`);
    assert.equal(first.payload.quoteBinding, first.intent.steps[0]?.prepared?.quoteBinding, "the binding never covers the nonce");
    const again = await prepareStep(intent.id, "s1");
    assert.notEqual(again.payload.policy?.exposureId, first.payload.policy?.exposureId);
    assert.equal((await world.ledger.usage([AGENT_KEY], Date.now())).get(AGENT_KEY)?.dayUsdMicros, 100_000_000n, "the same nonce: one exposure");
    world.nonce = 9n;
    const refused = await failure(prepareStep(intent.id, "s1"));
    assert.equal(refused.code, "POLICY_SPEND_LIMIT");
    assert.ok(((refused as unknown as { retryAfterSeconds?: number }).retryAfterSeconds ?? 0) > 86_000, "Retry-After when the first exposure leaves the window");
    assert.ok(policyOf(refused).retryAt);
  });

  it("fails closed when the nonce cannot be read for a pinning rule book", async () => {
    world.chains.addAgent(AGENT_KEY, ROOT_KEY, ruleBook({ caps: { dailyUsd: "1000" } }, "agent"));
    const { intent } = await createIntentDetailed(BRIDGE(10), { ownerKeyId: AGENT_KEY });
    const { configurePolicyReads } = await import("../policy/execution.js");
    configurePolicyReads({ pendingNonce: async () => { throw new Error("rpc down"); } });
    const error = await failure(prepareStep(intent.id, "s1"));
    assert.equal(error.code, "RPC_UNAVAILABLE");
    assert.equal(ledgerRows().length, 0);
  });

  it("counts every unpinned EVM payload on its own (project keys)", async () => {
    world.chains.setPolicy(ROOT_KEY, ruleBook({ caps: { dailyUsd: "150" } }));
    const { intent } = await createIntentDetailed(BRIDGE(100), { ownerKeyId: ROOT_KEY });
    const first = await prepareStep(intent.id, "s1");
    assert.ok(first.payload.transactions.every((transaction) => transaction.vm !== "evm" || transaction.nonce === undefined), "project keys are not pinned");
    const error = await failure(prepareStep(intent.id, "s1"));
    assert.equal(error.code, "POLICY_SPEND_LIMIT");
    assert.match(error.message, /refused this payload/u);
    assert.match(policyOf(error).violations[0]?.observed ?? "", /^100\.00 \+ 100\.00 used$/u);
    assert.match(JSON.stringify(policyOf(error).violations), /pin nonces/u);
  });

  it("lets a Solana re-prepare supersede payloads whose blockhash expired", async () => {
    world.chains.setPolicy(ROOT_KEY, ruleBook({ caps: { dailyUsd: "200" } }));
    const { intent } = await createIntentDetailed(SWAP_SOL, { ownerKeyId: ROOT_KEY });
    const first = await prepareStep(intent.id, "s1");
    assert.equal(ledgerRows(first.payload.policy?.exposureId)[0]?.record.validUntilHeight, 1_000);
    const replay = await prepareStep(intent.id, "s1");
    assert.equal(replay.payload.policy?.exposureId, first.payload.policy?.exposureId, "byte-identical Solana payloads are one exposure");
    // Another payload (another blockhash) while the first can still land: counted, so refused.
    stub.tamper = (payload: PreparedPayload) => ({
      ...payload,
      transactions: payload.transactions.map((transaction) => (transaction.vm === "svm" ? { ...transaction, transaction: unsignedSolanaTransaction(SOL_ADDRESS, "11111111111111111111111111111111"), lastValidBlockHeight: 3_000 } : transaction)),
      records: payload.records.map((entry) => ({ ...entry, to: "11111111111111111111111111111111" })),
    });
    world.height = 900n;
    assert.equal((await failure(prepareStep(intent.id, "s1"))).code, "POLICY_SPEND_LIMIT");
    world.height = 1_200n;
    const second = await prepareStep(intent.id, "s1");
    assert.ok(second.payload.policy);
    const states = new Map(ledgerRows().map((row) => [row.record.id, row.state]));
    assert.equal(states.get(first.payload.policy?.exposureId as string), "dead");
    assert.equal(states.get(second.payload.policy.exposureId), "open");
  });

  it("turns the exposure landed at submit, once, and records payloads that landed uncleared", async () => {
    world.chains.setPolicy(ROOT_KEY, ruleBook({ caps: { dailyUsd: "1000" } }));
    const { intent } = await createIntentDetailed(SWAP_SOL, { ownerKeyId: ROOT_KEY });
    const { payload } = await prepareStep(intent.id, "s1");
    await submitStep(intent.id, "s1", [randomSolanaSignature()]);
    assert.ok(ledgerRows(payload.policy?.exposureId).every((row) => row.state === "landed"));
    const decisions = world.decisions.list(PROJECT_ID).length;
    await refreshIntent(intent.id);
    assert.equal(world.decisions.list(PROJECT_ID).length, decisions, "nothing new to reconcile");

    // Prepared while the key had no rule book: the landed payload is recorded, never refused.
    world.chains.setPolicy(ROOT_KEY, null);
    const before = await createIntentDetailed(BRIDGE(40), { ownerKeyId: ROOT_KEY });
    const prepared = await prepareStep(before.intent.id, "s1");
    assert.equal(prepared.payload.policy, undefined);
    world.chains.setPolicy(ROOT_KEY, ruleBook({ caps: { dailyUsd: "1000" } }));
    await submitStep(before.intent.id, "s1", prepared.payload.transactions.map(() => randomEvmHash()));
    const observed = world.decisions.list(PROJECT_ID).filter((decision) => decision.outcome === "observed");
    assert.deepEqual(observed.map((decision) => decision.violations[0]?.rule), ["submit.uncleared"]);
    assert.equal((await world.ledger.usage([ROOT_KEY], Date.now())).get(ROOT_KEY)?.dayUsdMicros, 190_000_000n, "$150 + $40 counted");
    assert.ok(events.some((event) => event.type === "policy.violation" && (event.data as { rules: readonly string[] }).rules.includes("submit.uncleared")));
  });

  describe("with a landed EVM transaction", () => {
    let mock: RpcMock;
    beforeEach(() => {
      mock = installRpcMock();
    });
    afterEach(() => mock.restore());

    it("detects a landed nonce other than the pinned one and stops counting the group once", async () => {
      stub.relayEvmTransactions = 1;
      stub.verify = (context) => verifyEvmReferences(context);
      world.chains.addAgent(AGENT_KEY, ROOT_KEY, ruleBook({ caps: { dailyUsd: "1000" } }, "agent"));
      const { intent } = await createIntentDetailed(BRIDGE(25, "arbitrum", "base"), { ownerKeyId: AGENT_KEY });
      const { payload } = await prepareStep(intent.id, "s1");
      const transaction = payload.transactions[0];
      assert.ok(transaction?.vm === "evm");
      assert.equal(transaction.nonce, "7");
      const hash = randomEvmHash();
      mock.evm.set(hash.toLowerCase(), {
        hash,
        from: transaction.from,
        to: transaction.to,
        input: transaction.data,
        value: BigInt(transaction.value),
        chainId: 42161,
        status: "success",
        blockNumber: 5_000n,
        timestamp: Math.floor(Date.now() / 1000) + 5,
      });
      await submitStep(intent.id, "s1", [hash]);
      const rows = ledgerRows(payload.policy?.exposureId);
      assert.ok(rows.every((row) => row.state === "landed"));
      assert.ok(rows.every((row) => row.exclusiveKey === null), "the group no longer counts once");
      const observed = world.decisions.list(PROJECT_ID).filter((decision) => decision.outcome === "observed");
      assert.equal(observed[0]?.violations[0]?.rule, "execution.pinNonce");
      assert.equal(observed[0]?.violations[0]?.observed, "1", "the mock chain reports nonce 1");
      assert.equal(observed[0]?.violations[0]?.limit, "7");
    });
  });

  it("refuses to prepare once the owner or an ancestor is revoked", async () => {
    world.chains.addAgent(AGENT_KEY, ROOT_KEY, ruleBook({ caps: { dailyUsd: "1000" } }, "agent"));
    const { intent } = await createIntentDetailed(SWAP_SOL, { ownerKeyId: AGENT_KEY });
    world.chains.revoke(ROOT_KEY);
    const error = await failure(prepareStep(intent.id, "s1"));
    assert.equal(error.code, "POLICY_OWNER_REVOKED");
    assert.equal(error.status, 403);
    assert.deepEqual(rules(error), ["key.status"]);
    assert.equal(ledgerRows().length, 0);
    assert.equal((await getIntent(intent.id)).steps[0]?.status, "ready", "nothing was handed out");
  });

  it("fails closed when the policy store cannot be read", async () => {
    world.chains.setPolicy(ROOT_KEY, ruleBook({ caps: { dailyUsd: "1000" } }));
    const { intent } = await createIntentDetailed(SWAP_SOL, { ownerKeyId: ROOT_KEY });
    world.chains.fail = true;
    for (const attempt of [createIntentDetailed(SWAP_SOL, { ownerKeyId: ROOT_KEY }), createIntentDetailed(SWAP_SOL, { ownerKeyId: ROOT_KEY, dryRun: true }), prepareStep(intent.id, "s1")]) {
      const error = await failure(attempt);
      assert.equal(error.code, "STORE_UNAVAILABLE");
      assert.equal(error.status, 503);
    }
  });

  it("refuses amounts a USD rule needs but no fresh source prices (POLICY_PRICE_UNAVAILABLE)", async () => {
    world.chains.setPolicy(ROOT_KEY, ruleBook({ caps: { perStepUsd: "1000" } }));
    world.market.jupiter.delete(JUPITER_MINTS.wsol);
    resetPolicyPricing();
    const error = await failure(createIntentDetailed(SWAP_SOL, { ownerKeyId: ROOT_KEY }));
    assert.equal(error.code, "POLICY_PRICE_UNAVAILABLE");
    assert.equal(error.status, 503);
    assert.deepEqual(rules(error), ["pricing.unavailable"]);
    // Without a USD rule the same intent is fine.
    world.chains.setPolicy(ROOT_KEY, ruleBook({ networks: { allow: ["solana"] } }));
    assert.equal((await createIntentDetailed(SWAP_SOL, { ownerKeyId: ROOT_KEY })).intent.policy?.outcome, "allow");
  });

  it("warns at plan and refuses at prepare outside the timetable, with Retry-After", async () => {
    const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
    const later = days[(new Date().getUTCDay() + 3) % 7] as (typeof days)[number];
    world.chains.setPolicy(ROOT_KEY, ruleBook({ schedule: { timezone: "UTC", windows: [{ days: [later], from: "00:00", to: "24:00" }] } }));
    const { intent } = await createIntentDetailed(SWAP_SOL, { ownerKeyId: ROOT_KEY });
    assert.equal(intent.policy?.outcome, "allow");
    const plan = world.decisions.list(PROJECT_ID).at(-1);
    assert.ok(plan?.warnings.some((warning) => /timetable/u.test(warning)));
    const error = await failure(prepareStep(intent.id, "s1"));
    assert.equal(error.code, "POLICY_SCHEDULE_CLOSED");
    assert.equal((error as unknown as { retryAfterSeconds?: number }).retryAfterSeconds, 86_400, "capped at a day");
  });

  it("bounds every key by the project rule book; window caps count the whole subtree", async () => {
    world.chains.setProject(ruleBook({ caps: { dailyUsd: "250" } }));
    world.chains.addAgent(AGENT_KEY, ROOT_KEY, ruleBook({ caps: { dailyUsd: "1000" } }, "agent"));
    world.chains.addAgent(AGENT_B_KEY, ROOT_KEY, ruleBook({ caps: { dailyUsd: "1000" } }, "agent"));
    const a = await createIntentDetailed(SWAP_SOL, { ownerKeyId: AGENT_KEY });
    const b = await createIntentDetailed(SWAP_SOL, { ownerKeyId: AGENT_B_KEY });
    await prepareStep(a.intent.id, "s1");
    const error = await failure(prepareStep(b.intent.id, "s1"));
    assert.equal(error.code, "POLICY_SPEND_LIMIT");
    assert.equal(policyOf(error).keyId, PROJECT_ID);
    assert.equal(policyOf(error).violations[0]?.scope, "project");
  });

  it("keeps a hash-chained decision log per project", async () => {
    world.chains.setPolicy(ROOT_KEY, ruleBook({ caps: { dailyUsd: "1000" } }));
    const { intent } = await createIntentDetailed(SWAP_SOL, { ownerKeyId: ROOT_KEY });
    await prepareStep(intent.id, "s1");
    world.chains.setPolicy(ROOT_KEY, ruleBook({ caps: { dailyUsd: "1000" }, recipients: { mode: "own" } }));
    await failure(createIntentDetailed({ text: `send 10 USDC to ${OTHER_EVM_ADDRESS} on base`, accounts: ACCOUNTS }, { ownerKeyId: ROOT_KEY, dryRun: true }));
    const decisions = world.decisions.list(PROJECT_ID);
    assert.ok(decisions.length >= 2);
    assert.deepEqual(decisions.map((decision) => decision.seq), decisions.map((_, index) => index + 1));
    assert.equal(verifyDecisionChain(decisions).valid, true);
    assert.ok(decisions.every((decision) => /^sha256:[0-9a-f]{64}$/u.test(decision.requestDigest)));
  });

  it("reserves metadata.linkId for link intents", async () => {
    const error = await failure(createIntentDetailed({ ...SWAP_SOL, metadata: { linkId: "lk_5f1c2a9b7e3d4c6a8b0e1f23" } }));
    assert.equal(error.code, "INVALID_REQUEST");
    assert.equal(error.issues?.[0]?.path, "metadata.linkId");
  });

  it("serialises the refusal envelope with error.policy and the issues", async () => {
    world.chains.setPolicy(ROOT_KEY, ruleBook({ networks: { allow: ["base"] } }));
    const error = await failure(createIntentDetailed(SWAP_SOL, { ownerKeyId: ROOT_KEY }));
    const body = JSON.parse(JSON.stringify(error)) as { code: string; message: string; issues: unknown[]; policy: PolicyBody };
    assert.equal(body.code, "POLICY_VIOLATION");
    assert.match(body.message, /^The rule book of key_0{23}1 refused this intent: /u);
    assert.match(body.policy.decisionId ?? "", /^pdc_[0-9a-f]{24}$/u);
    assert.deepEqual(body.policy.violations.map((violation) => [violation.rule, violation.scope, violation.keyId, violation.path, violation.observed, violation.limit]), [
      ["networks.allow", "key", ROOT_KEY, "steps[0].network", "solana", "base"],
    ]);
    assert.deepEqual(body.issues, [{ path: "steps[0].network", message: "Solana is not an allowed network. (networks.allow)" }]);
  });
});
