/**
 * Decision log store contract (policy design §9), on memory and, when KLETIA_TEST_DATABASE_URL is
 * set, Postgres: gapless sequence numbers per project past single digits, the head, newest-first
 * listing and a hash chain that verifies, with projects kept apart.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { verifyDecisionChain, type PolicyDecision } from "@kletia/core";
import { useTestEnvironment } from "./support.js";

useTestEnvironment();
const { MemoryDecisionStore, PostgresDecisionStore } = await import("../policies/decisions.js");
const { closePlatformDatabase } = await import("../db.js");
type DecisionStore = import("../policies/decisions.js").DecisionStore;
type PolicyDecisionDraft = Parameters<DecisionStore["append"]>[0];

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

function draft(projectId: string, index: number): PolicyDecisionDraft {
  return {
    id: `pdc_${hex(12)}`,
    at: new Date(Date.UTC(2026, 9, 9, 12, 0, index)).toISOString(),
    stage: "evaluate",
    outcome: index % 3 === 0 ? "deny" : "allow",
    projectId,
    keyId: `key_${hex(12)}`,
    actorKeyId: null,
    dryRun: false,
    chain: [],
    violations: [],
    triggers: [],
    warnings: [],
    requestDigest: hex(32),
  } as PolicyDecisionDraft;
}

function contract(name: string, make: () => DecisionStore): void {
  describe(`${name} decision store`, () => {
    it("keeps sequence numbers gapless past 9 (the 10th and later appends), with a verifying chain", async () => {
      const store = make();
      const project = `prj_${hex(12)}`;
      const other = `prj_${hex(12)}`;
      const appended: PolicyDecision[] = [];
      for (let index = 1; index <= 12; index += 1) {
        appended.push(await store.append(draft(project, index)));
        if (index === 5) await store.append(draft(other, index));
      }
      assert.deepEqual(appended.map((decision) => decision.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      assert.deepEqual(await store.head(project), { seq: 12, chainHash: appended[11]?.chainHash });
      assert.equal((await store.head(other))?.seq, 1, "projects keep their own sequences");
      const listed = await store.list({ projectId: project, limit: 50 });
      assert.deepEqual(listed.map((decision) => decision.seq), [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
      const verified = verifyDecisionChain([...listed].reverse(), { seq: 12, chainHash: appended[11]?.chainHash as string });
      assert.equal(verified.valid, true, JSON.stringify(verified));
      // Concurrent appends past ten still serialise on the project lock.
      const more = await Promise.all(Array.from({ length: 6 }, (_, offset) => store.append(draft(project, 13 + offset))));
      assert.deepEqual(more.map((decision) => decision.seq).sort((a, b) => a - b), [13, 14, 15, 16, 17, 18]);
      assert.equal((await store.head(project))?.seq, 18);
    });
  });
}

contract("memory", () => new MemoryDecisionStore());

const databaseUrl = process.env.KLETIA_TEST_DATABASE_URL?.trim();
describe("postgres", { skip: databaseUrl ? false : "set KLETIA_TEST_DATABASE_URL to run" }, () => {
  before(() => {
    process.env.KLETIA_DATABASE_URL = databaseUrl;
  });
  after(async () => {
    await closePlatformDatabase();
    delete process.env.KLETIA_DATABASE_URL;
  });
  contract("postgres", () => new PostgresDecisionStore());
});
