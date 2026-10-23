/**
 * Plan and strict modes of the intent eval: a ready decision is
 * planned as a dry run against the offline venues and compared with what was
 * decided by end state (assets spent, received per network and holder,
 * positions, recipients), so equivalent route shapes pass and wrong ones
 * fail whatever the accept regex allows; a planner refusal of a ready
 * decision is `plans_unplannable` (the F-2 class). Strict mode sends the text
 * through the strict path, where every question is a refusal. On the repo
 * corpus every mode keeps its gates, with the planner findings ledgered.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { configureHoldingsReaders } from "../holdings.js";
import { configurePriceReader } from "../prices.js";
import type { ResolvedAction } from "../clarify/types.js";
import {
  EVAL_MODES,
  evalGates,
  formatScoreboard,
  loadEvalFixtures,
  loadIntentEval,
  modeRunOptions,
  runIntentEval,
  scoreIntentEval,
  type IntentEvalPrompt,
} from "../goal/evalHarness.js";
import { compareEndStates, endStateOfActions, type EndState } from "../goal/evalPlan.js";
import { formatLedgerReport, ledgerOk, loadLedger, loadOutcomes, loadTransitions, runRatchet } from "../goal/evalTransitions.js";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const repoPath = fixture("intent-eval.json");
const repo = loadIntentEval(repoPath);
const fixtures = loadEvalFixtures(repoPath, repo);
const ledger = loadLedger(fixture("intent-hard-ledger.json"));
const outcomes = loadOutcomes(fixture("intent-outcomes.json"));
const transitions = loadTransitions(fixture("intent-transitions.json"));

after(() => {
  configureHoldingsReaders(null);
  configurePriceReader(null);
});

const step = (overrides: Partial<ResolvedAction>): ResolvedAction => ({ kind: "swap", network: "solana", from: "SOL", to: "USDC", amount: "1", ...overrides }) as ResolvedAction;
const state = (overrides: Partial<EndState>): EndState => ({ spends: {}, receives: [], positions: [], recipients: [], ...overrides });

describe("end-state oracle", () => {
  it("reads spends, receipts, positions and recipients from decided actions", () => {
    const swapThenBridge = endStateOfActions([
      step({}),
      step({ kind: "bridge", from: "USDC", to: undefined, toNetwork: "base", amount: "max" }),
    ]);
    assert.deepEqual(swapThenBridge, state({ spends: { "solana:SOL": "1" }, receives: ["base:USDC@self"] }));
    const deposit = endStateOfActions([step({ kind: "deposit", network: "base", from: "USDC", to: undefined, amount: "50", protocol: "aave-v3" } as Partial<ResolvedAction>)]);
    assert.deepEqual(deposit.positions, ["+aave-v3:base:USDC"]);
    const pay = endStateOfActions([step({ kind: "transfer", network: "base", from: "USDC", to: undefined, amount: "5", recipient: "Vitalik.eth" })]);
    assert.deepEqual(pay.recipients, ["vitalik.eth"]);
    assert.deepEqual(pay.receives, ["base:USDC@vitalik.eth"]);
  });

  it("matches equivalent shapes and reports every difference", () => {
    const decided = state({ spends: { "solana:SOL": "1" }, receives: ["base:USDC@self"] });
    assert.deepEqual(compareEndStates(decided, state({ spends: { "solana:SOL": "1.0" }, receives: ["base:USDC@self"] })), []);
    // A native asset and its wrapped form are one asset; "max" matches any planned amount.
    assert.deepEqual(compareEndStates(state({ spends: { "base:WETH": "max" } }), state({ spends: { "base:ETH": "0.4" } })), []);
    assert.deepEqual(compareEndStates(decided, state({ spends: { "solana:SOL": "2" }, receives: ["base:USDC@self"] })), ["spend solana:SOL: decided 1, planned 2"]);
    assert.deepEqual(compareEndStates(decided, state({ spends: { "solana:SOL": "1" }, receives: ["arbitrum:USDC@self"] })), [
      "receive base:USDC@self decided, not planned",
      "receive arbitrum:USDC@self planned, not decided",
    ]);
  });
});

describe("plan and strict modes", () => {
  const pick = (ids: readonly string[]) => ({ ...repo, prompts: repo.prompts.filter((prompt) => ids.includes(prompt.id)) });

  it("plans a ready decision as a dry run with the same end state", async () => {
    const results = await runIntentEval(pick(["EXP001", "EXP012", "MUL005"]), fixtures, modeRunOptions("plan"));
    for (const result of results) {
      assert.equal(result.status, "ready", `${result.id}: ${result.message ?? ""}`);
      assert.deepEqual(result.planned, { ok: true }, result.id);
      assert.deepEqual(result.endStateDiff, [], result.id);
      assert.ok(result.endState && Object.keys(result.endState.spends).length > 0, `${result.id}: spends`);
    }
  });

  it("reports a decision the planner refuses as plans_unplannable (F-2)", async () => {
    const sample = pick(["TYP023"]);
    const [result] = await runIntentEval(sample, fixtures, modeRunOptions("plan"));
    assert.equal(result?.status, "ready");
    assert.equal(result?.planned?.ok, false);
    assert.equal(scoreIntentEval(sample, result ? [result] : []).rows[0]?.klass, "plans_unplannable");
  });

  it("strict mode plans what the strict path plans and refuses the rest", async () => {
    const sample: typeof repo = {
      ...repo,
      prompts: [
        { id: "S1", family: "explicit", say: "swap 1 SOL to USDC", wallet: "full", accept: ["P:^swap@solana 1 SOL->USDC$"], tags: [] },
        { id: "S2", family: "gap", say: "swap SOL to USDC", wallet: "full", accept: ["A:amount"], tags: [] },
      ] as IntentEvalPrompt[],
    };
    const results = await runIntentEval(sample, fixtures, modeRunOptions("strict"));
    assert.equal(results[0]?.status, "ready");
    assert.deepEqual(results[0]?.endStateDiff, []);
    assert.equal(results[1]?.status, "refused");
    assert.deepEqual(scoreIntentEval(sample, results, { strict: true }).rows.map((row) => row.klass), ["plan_ok", "refuse_ok"]);
  });

  for (const mode of EVAL_MODES) {
    it(`repo corpus, ${mode} mode: deterministic, gates hold, planner findings ledgered`, async () => {
      const first = await runRatchet(repoPath, mode, { ledger, outcomes, transitions });
      const second = await runRatchet(repoPath, mode, { ledger, outcomes, transitions });
      assert.deepEqual(second.results, first.results, "two runs agree");
      assert.ok(ledgerOk(first.ledger), formatLedgerReport("repo", mode, first.ledger));
      assert.deepEqual(first.transitions?.unreviewed, [], "unreviewed transitions");
      if (mode !== "strict") {
        const ledgered = new Set(ledger.entries.filter((entry) => entry.corpus === "repo" && entry.mode === mode).map((entry) => entry.id));
        const failed = evalGates(first.board, { mode, ledgered }).filter((gate) => !gate.ok);
        assert.deepEqual(failed, [], formatScoreboard(first.board, { failList: true, mode, ledgered }));
        assert.equal(first.board.byClass.plans_wrongly, 0);
      }
    });
  }
});
