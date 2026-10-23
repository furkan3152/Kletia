/**
 * Ready-time invariants and the grounding ledger (intent design A.4, package
 * P2-M1): `solver/invariants.ts` checks every resolved action against what the
 * person said before a thread may be ready, and fails closed (a refusal, never
 * a plan) when one does not hold. Pure checks first, then the engine: plans
 * that hold every invariant are ready, look-alikes Kletia does not list are
 * asked or refused on every path, and class spends are never one holding.
 * Offline: the clarify corpus' fixture wallets.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { isKnownSymbol, LOOKALIKE_FAMILIES } from "@kletia/core";
import { contextFor, installWallet, loadCorpus, runTurn, shape, uninstallWallet, type CorpusCase } from "../clarify/corpusHarness.js";
import type { TurnDecision } from "../clarify/index.js";
import type { ResolvedAction, WorkStep } from "../clarify/types.js";
import { invariantRefusal, lookalikeRefusal, readyViolations, unlistedLookalikes, type ActionMeta, type InvariantInput } from "../solver/invariants.js";

const corpus = loadCorpus(fileURLToPath(new URL("./fixtures/clarify-corpus.json", import.meta.url)));
after(() => uninstallWallet());

const user = <T>(v: T) => ({ v, by: "user" as const });
const self = (_action: ResolvedAction) => false;
const paysOther = (action: ResolvedAction) => action.recipient !== undefined;

function check(actions: ResolvedAction[], steps: WorkStep[], extra: Partial<InvariantInput> = {}): number[] {
  const meta: ActionMeta[] = actions.map((_action, index) => ({ step: index }));
  return readyViolations({ actions, meta, steps, saidRecipients: [], thirdParty: self, confirmed: false, ...extra }).map((violation) => violation.invariant);
}

async function first(text: string, wallet = "full", request?: CorpusCase["request"]): Promise<{ decision?: TurnDecision; error?: { code: string; message: string } }> {
  const entry = { id: "t", category: "test", title: "t", wallet, ...(request ? { request } : {}), turns: [] } as CorpusCase;
  installWallet(corpus, wallet);
  return runTurn(null, { text }, contextFor(corpus, entry));
}

describe("ready-time invariants: pure checks", () => {
  it("a plan that matches the words holds every invariant", () => {
    const steps: WorkStep[] = [{ kind: user("swap"), from: user("SOL"), to: user("USDC"), amount: user({ t: "exact", value: "1" }), network: user("solana") }];
    assert.deepEqual(check([{ kind: "swap", network: "solana", from: "SOL", to: "USDC", amount: "1" }], steps), []);
  });

  it("2 network continuity: a step that spends the previous output runs where it lands", () => {
    const steps: WorkStep[] = [
      { kind: user("bridge"), from: user("USDC"), amount: user({ t: "exact", value: "10" }), network: user("base"), toNetwork: user("arbitrum") },
      { kind: user("deposit"), amount: user({ t: "previous", bps: 10_000 }), protocol: user("aave-v3") },
    ];
    const actions: ResolvedAction[] = [
      { kind: "bridge", network: "base", toNetwork: "arbitrum", from: "USDC", amount: "10" },
      { kind: "deposit", network: "base", from: "USDC", amount: "max", protocol: "aave-v3" },
    ];
    assert.ok(check(actions, steps).includes(2));
    assert.ok(!check([actions[0] as ResolvedAction, { ...(actions[1] as ResolvedAction), network: "arbitrum" }], steps).includes(2));
  });

  it("3 recipient fidelity: every recipient said is paid, and only those", () => {
    const steps: WorkStep[] = [{ kind: user("transfer"), from: user("USDC"), amount: user({ t: "exact", value: "5" }), network: user("base"), recipient: user("vitalik.eth") }];
    const paid: ResolvedAction = { kind: "transfer", network: "base", from: "USDC", amount: "5", recipient: "vitalik.eth" };
    assert.deepEqual(check([paid], steps, { saidRecipients: ["vitalik.eth"], thirdParty: paysOther }), []);
    assert.ok(check([paid], steps, { saidRecipients: ["alice.eth"], thirdParty: paysOther }).includes(3), "a recipient nobody said");
    assert.ok(check([{ ...paid, recipient: undefined } as ResolvedAction], steps, { saidRecipients: ["vitalik.eth"] }).includes(3), "a said recipient left unpaid");
  });

  it("4 verb fidelity and 5 venue fidelity on strict steps", () => {
    const deposit: WorkStep[] = [{ kind: user("swap"), from: user("USDC"), to: user("ETH"), amount: user({ t: "exact", value: "50" }), network: user("base"), protocol: user("uniswap-v3") }];
    assert.ok(check([{ kind: "deposit", network: "base", from: "USDC", amount: "50", protocol: "aave-v3" }], deposit).includes(4), "a swap said, a deposit planned");
    assert.ok(check([{ kind: "swap", network: "base", from: "USDC", to: "ETH", amount: "50", protocol: "aerodrome" }], deposit).includes(5), "the venue said is not on its step");
    assert.deepEqual(check([{ kind: "swap", network: "base", from: "USDC", to: "ETH", amount: "50", protocol: "uniswap-v3" }], deposit), []);
  });

  it("8 address family: a raw address is never paid on a network of the other family", () => {
    const steps: WorkStep[] = [{ kind: user("transfer"), from: user("USDC"), amount: user({ t: "exact", value: "5" }), network: user("solana"), recipient: user("0x1111111111111111111111111111111111111111") }];
    const action: ResolvedAction = { kind: "transfer", network: "solana", from: "USDC", amount: "5", recipient: "0x1111111111111111111111111111111111111111" };
    assert.ok(check([action], steps, { saidRecipients: [action.recipient as string], thirdParty: paysOther }).includes(8));
  });

  it("10 no round trip: funds never return to a network they left unless the person answered", () => {
    const steps: WorkStep[] = [
      { kind: user("bridge"), from: user("USDC"), amount: user({ t: "exact", value: "10" }), network: user("base"), toNetwork: user("arbitrum") },
      { kind: user("bridge"), amount: user({ t: "previous", bps: 10_000 }), toNetwork: user("base") },
    ];
    const actions: ResolvedAction[] = [
      { kind: "bridge", network: "base", toNetwork: "arbitrum", from: "USDC", amount: "10" },
      { kind: "bridge", network: "arbitrum", toNetwork: "base", from: "USDC", amount: "max" },
    ];
    assert.ok(check(actions, steps).includes(10));
    const answered = steps.map((step, index) => (index === 1 ? { ...step, toNetwork: { v: "base" as const, by: "answer" as const } } : step));
    assert.ok(!check(actions, answered).includes(10));
  });

  it("13 third-party value: a whole holding paid to someone else needs a confirm; an assumed receiving network never passes", () => {
    const whole: WorkStep[] = [{ kind: user("transfer"), from: user("USDC"), amount: user({ t: "balance", bps: 10_000 }), network: user("arbitrum"), recipient: user("vitalik.eth") }];
    const action: ResolvedAction = { kind: "transfer", network: "arbitrum", from: "USDC", amount: "30", recipient: "vitalik.eth" };
    const base = { saidRecipients: ["vitalik.eth"], thirdParty: paysOther };
    assert.ok(check([action], whole, base).includes(13));
    assert.ok(!check([action], whole, { ...base, confirmed: true }).includes(13));
    const assumed: WorkStep[] = [{ ...whole[0], amount: user({ t: "exact", value: "5" }), network: { v: "base", by: "assumed" } }];
    assert.ok(check([{ ...action, network: "base", amount: "5" }], assumed, base).includes(13));
  });

  it("16 closed-class words: a word no rule consumed blocks the plan", () => {
    const steps: WorkStep[] = [{
      kind: user("swap"), from: user("SOL"), to: user("USDC"), amount: user({ t: "exact", value: "1" }), network: user("solana"),
      closedClass: { questionMark: false, hits: [{ phrase: "maybe", category: "question", start: 0, end: 5, rules: ["question-form"] }], lookalikes: [] },
    }];
    assert.ok(check([{ kind: "swap", network: "solana", from: "SOL", to: "USDC", amount: "1" }], steps).includes(16));
  });

  it("1 and 17 model-assisted readings: confirmed before planning, and never paying anyone", () => {
    const steps: WorkStep[] = [{ kind: user("transfer"), from: user("USDC"), amount: user({ t: "exact", value: "5" }), network: user("base"), recipient: user("vitalik.eth"), modelRead: true }];
    const action: ResolvedAction = { kind: "transfer", network: "base", from: "USDC", amount: "5", recipient: "vitalik.eth" };
    const found = check([action], steps, { saidRecipients: ["vitalik.eth"], thirdParty: paysOther });
    assert.ok(found.includes(1), "unconfirmed");
    assert.ok(found.includes(17), "a model-assisted reading pays someone else");
    assert.ok(check([action], steps, { saidRecipients: ["vitalik.eth"], thirdParty: paysOther, confirmed: true }).includes(17), "even confirmed");
  });

  it("a violation refuses with Kletia's words and the invariant numbers, never echoing the text", () => {
    const error = invariantRefusal([{ invariant: 3, action: -1, message: "x is said but not paid" }, { invariant: 8, action: 0, message: "family" }]);
    assert.equal(error.code, "INTENT_UNSUPPORTED");
    assert.equal(error.status, 422);
    assert.match(error.message, /^Kletia could not match this plan to your words, so it plans nothing\./u);
    assert.deepEqual(error.details, { invariants: [3, 8] });
    assert.equal(error.issues?.[0]?.path, "text");
  });
});

describe("look-alike families (A.4.14)", () => {
  it("finds typed members Kletia does not list, in their usual spellings, and never listed ones", () => {
    const found = (text: string) => unlistedLookalikes(text, LOOKALIKE_FAMILIES, isKnownSymbol).map((entry) => entry.typed);
    assert.deepEqual(found("swap 1 eth to steth on base"), ["stETH"]);
    assert.deepEqual(found("bridge 10 usdc.e to base"), ["USDC.e"]);
    assert.deepEqual(found("swap 2 sol to $stsol"), ["stSOL"]);
    assert.deepEqual(found("swap 1 eth to wsteth on base"), [], "wstETH is listed");
    assert.deepEqual(found("swap 1 sol to jitosol"), []);
  });

  it("the refusal names what Kletia lists instead, in Kletia's words", () => {
    const error = lookalikeRefusal({ typed: "stETH", listed: "wstETH (wrapped stETH, about 1.2 stETH each)" });
    assert.equal(error.code, "INTENT_UNSUPPORTED");
    assert.match(error.message, /^Kletia does not list stETH\. It lists wstETH/u);
  });

  it("an unlisted family member is asked or refused on every path, never planned as another member", async () => {
    for (const text of ["swap 1 ETH to stETH on base", "swap 1 SOL to stSOL", "stake 1 sol for bsol"]) {
      const run = await first(text);
      if (run.error) assert.equal(run.error.code, "INTENT_UNSUPPORTED", text);
      else {
        assert.equal(run.decision?.status, "needs_input", `${text}: ${run.decision?.actions ? shape(run.decision.actions) : ""}`);
        assert.ok(["ASSET_LOOKALIKE", "ASSET_TYPO"].includes(run.decision?.questions[0]?.reason ?? ""), text);
      }
    }
  });

  it("the swap's own input is never offered as the look-alike's replacement", async () => {
    const run = await first("swap 1 SOL to stSOL");
    const options = run.decision?.questions[0]?.options.map((option) => option.id) ?? [];
    assert.ok(!options.includes("SOL"));
    assert.deepEqual(options, ["JitoSOL", "JupSOL", "mSOL", "cancel"]);
  });
});

describe("class spends (WP9): every holding of the class, never one", () => {
  it("'move all my stables to arbitrum' asks the scope across networks (several networks hold stablecoins)", async () => {
    const run = await first("move all my stables to arbitrum", "wide");
    assert.equal(run.decision?.status, "needs_input");
    assert.equal(run.decision?.questions[0]?.reason, "SCOPE_AMBIGUOUS");
    assert.match(run.decision?.questions[0]?.prompt ?? "", /^Your stablecoins are on /u);
    assert.equal(run.decision?.questions[0]?.options[0]?.id, "all");
  });

  it("one network holding nearly all of the class is used, and what stays is a material chip (D4)", async () => {
    const run = await first("move all my stables to arbitrum", "full");
    assert.equal(run.decision?.status, "ready");
    assert.equal(shape(run.decision?.actions ?? []), "bridge@base->arbitrum 120.4 USDC");
    const scope = run.decision?.assumptions.find((entry) => entry.field === "actions[0].network");
    assert.ok(scope?.material);
    assert.deepEqual(scope?.alternatives.map((option) => option.id), ["solana"]);
  });

  it("a class on one network with several holdings lists every move for a confirm (no single holding planned silently)", async () => {
    const run = await first("swap all my stables to eth on optimism", "wide");
    assert.equal(run.decision?.status, "needs_input");
    assert.equal(run.decision?.questions[0]?.reason, "INTERPRETATION_CONFIRM");
    assert.match(run.decision?.questions[0]?.prompt ?? "", /^Every move: Swap \d+ USDC to ETH on OP Mainnet, then swap \d+ USDT to ETH on OP Mainnet\./u);
  });

  it("an exact dollar amount is still one holding (no class goal)", async () => {
    const run = await first("bridge 100 usd to arbitrum", "full");
    assert.ok(run.decision);
    assert.ok(run.decision.state.steps.every((step) => step.goal === undefined));
  });
});

describe("keep constraints (A.2, C.1 rule 9): subtracted before a share of the holding", () => {
  async function withKeep(text: string, keep: unknown[]): Promise<{ decision?: TurnDecision; error?: { code: string; message: string } }> {
    const plain = await first(text);
    const thread = JSON.parse(JSON.stringify(plain.decision!.thread)) as { steps: Record<string, unknown>[] };
    thread.steps[0]!.keep = keep;
    installWallet(corpus, "full");
    return runTurn(thread as never, { none: true }, contextFor(corpus, { id: "t", category: "test", title: "t", wallet: "full", turns: [] } as CorpusCase));
  }

  it("'all my SOL' after keeping 1 SOL spends the rest (fee reserve kept too), shown on a material chip", async () => {
    const run = await withKeep("swap all my SOL to USDC", [{ amount: { t: "exact", value: "1" } }]);
    assert.equal(shape(run.decision?.actions ?? []), "swap@solana 1.49 SOL->USDC");
    const chip = run.decision?.assumptions.find((entry) => entry.field === "actions[0].amount");
    assert.equal(chip?.label, "All your SOL after keeping 1: 1.49");
    assert.ok(chip?.material);
  });

  it("an exact amount that does not fit beside what is kept is asked; a keep that leaves nothing refuses", async () => {
    const asked = await withKeep("swap 2 SOL to USDC", [{ amount: { t: "exact", value: "1" } }]);
    assert.equal(asked.decision?.questions[0]?.reason, "AMOUNT_EXCEEDS_BALANCE");
    assert.deepEqual(asked.decision?.questions[0]?.options.map((option) => option.id), ["rest", "cancel"]);
    const nothing = await withKeep("swap all my SOL to USDC", [{ amount: { t: "exact", value: "3" } }]);
    assert.equal(nothing.error?.code, "AMOUNT_TOO_SMALL");
  });

  it("a keep this step cannot apply (another asset) asks the amount, never plans around it", async () => {
    const run = await withKeep("swap all my SOL to USDC", [{ amount: { t: "exact", value: "1" }, asset: "USDC" }]);
    assert.equal(run.decision?.status, "needs_input");
    assert.equal(run.decision?.questions[0]?.reason, "AMOUNT_MISSING");
  });
});
