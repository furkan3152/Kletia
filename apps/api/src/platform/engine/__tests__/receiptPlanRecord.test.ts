/**
 * The immutable plan record (receipts design §4.5): captured once by the
 * planner for stored intents and dry runs, its digest equal to the engine's
 * own SHA-256 over the receipt profile (parity with core), and untouched by
 * prepare, submit and settlement, which rewrite the steps' amounts.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { beforeEach, describe, it } from "node:test";
import { buildPlanRecord, planRecordDigest, receiptJcs } from "@kletia/core";
import { createIntentDetailed, getIntent, prepareStep, submitStep } from "../service.js";
import { ACCOUNTS, randomEvmHash, resetEngine } from "./helpers.js";

beforeEach(() => {
  resetEngine();
});

describe("plan record", () => {
  it("is set at planning, for dry runs too, with a digest the engine reproduces with node:crypto", async () => {
    const { intent } = await createIntentDetailed({ text: "swap 1 SOL to USDC", accounts: ACCOUNTS });
    const { intent: dry } = await createIntentDetailed({ text: "swap 1 SOL to USDC", accounts: ACCOUNTS }, { dryRun: true });
    for (const graph of [intent, dry]) {
      assert.ok(graph.plan, "graph.plan");
      assert.equal(graph.plan.record.spec, "kletia.plan/v1");
      assert.equal(graph.plan.digest, planRecordDigest(graph.plan.record));
      assert.equal(graph.plan.digest, createHash("sha256").update(receiptJcs(graph.plan.record), "utf8").digest("hex"));
      // The record describes the graph as planned.
      const { plan: _plan, ...rest } = graph;
      assert.deepEqual(buildPlanRecord(rest), graph.plan.record);
    }
    assert.equal(intent.plan?.record.steps[0]?.input?.amount, intent.steps[0]?.input?.amount);
  });

  it("survives prepare, submit and settlement unchanged while the steps' amounts move", async () => {
    const { intent } = await createIntentDetailed({ text: "bridge 25 USDC from base to arbitrum", accounts: ACCOUNTS });
    const plan = intent.plan;
    assert.ok(plan);
    const prepared = await prepareStep(intent.id, "s1");
    assert.deepEqual(prepared.intent.plan, plan);
    const submitted = await submitStep(intent.id, "s1", prepared.payload.transactions.map(() => randomEvmHash()));
    assert.deepEqual(submitted.plan, plan);
    const latest = await getIntent(intent.id);
    assert.deepEqual(latest.plan, plan);
    assert.equal(planRecordDigest(latest.plan?.record ?? plan.record), plan.digest);
  });
});
