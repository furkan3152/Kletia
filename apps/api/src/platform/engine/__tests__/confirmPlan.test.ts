/**
 * Confirm mechanics (intent design A.3, I14; package P2-M1): a confirm is a
 * question about the solved, concrete plan of the whole message; the thread
 * keeps only the digest of the end state the person accepted, and a plan
 * with another end state is asked again. A model-assisted reading is
 * confirmed only by the person (the desk, or the confirm card's token): an
 * API or agent answer is refused with CONFIRM_AUTHORITY_REQUIRED.
 * Offline: the clarify corpus' fixture wallets.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { ClarifyThread } from "@kletia/core";
import { contextFor, installWallet, loadCorpus, runTurn, shape, uninstallWallet, type CorpusCase } from "../clarify/corpusHarness.js";
import type { TurnContext, TurnDecision, TurnInput } from "../clarify/index.js";
import type { ResolvedAction } from "../clarify/types.js";
import { confirmPrompt, describeAction, endStateDigest, planSummary, settledAcks } from "../solver/confirm.js";

const corpus = loadCorpus(fileURLToPath(new URL("./fixtures/clarify-corpus.json", import.meta.url)));
after(() => uninstallWallet());

const ctxOf = (wallet: string, extra: Partial<TurnContext> = {}): TurnContext =>
  ({ ...contextFor(corpus, { id: "t", category: "test", title: "t", wallet, turns: [] } as CorpusCase), ...extra }) as TurnContext;

async function turn(wallet: string, thread: ClarifyThread | null, input: string | TurnInput, extra: Partial<TurnContext> = {}): Promise<{ decision?: TurnDecision; error?: { code: string; message: string } }> {
  installWallet(corpus, wallet);
  return runTurn(thread, typeof input === "string" ? { text: input } : input, ctxOf(wallet, extra));
}

const swap: ResolvedAction = { kind: "swap", network: "solana", from: "SOL", to: "USDC", amount: "1" };
const pay: ResolvedAction = { kind: "transfer", network: "base", from: "USDC", amount: "5", recipient: "Vitalik.eth" };

describe("end-state digest", () => {
  it("is deterministic and changes with any asset, amount, recipient, network, choice or departure", () => {
    const digest = endStateDigest([swap, pay], []);
    assert.match(digest, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(endStateDigest([swap, pay], []), digest);
    assert.equal(endStateDigest([swap, { ...pay, recipient: "vitalik.eth" }], []), digest, "names compare case-insensitively");
    for (const changed of [
      endStateDigest([{ ...swap, amount: "2" }, pay], []),
      endStateDigest([swap, { ...pay, recipient: "alice.eth" }], []),
      endStateDigest([swap, { ...pay, network: "arbitrum" }], []),
      endStateDigest([{ ...swap, to: "USDT" }, pay], []),
      endStateDigest([swap, pay], ["delivery:0=send"]),
      endStateDigest([swap, pay], [], { sourceNetwork: "solana" }),
    ]) assert.notEqual(changed, digest);
  });

  it("settledAcks finds the longest settled prefix of the acknowledgements, and nothing for a foreign digest", () => {
    const acks = [{ id: "delivery:0", choices: ["delivery:0=send"] }, { id: "gas:base", choices: ["gas:base=topup", "gas:base=anyway"] }];
    const digest = (choices: readonly string[]) => endStateDigest([pay], choices);
    assert.deepEqual(settledAcks(digest(["delivery:0=send"]), acks, digest), ["delivery:0=send"]);
    assert.deepEqual(settledAcks(digest(["delivery:0=send", "gas:base=anyway"]), acks, digest), ["delivery:0=send", "gas:base=anyway"]);
    assert.deepEqual(settledAcks(endStateDigest([swap], ["delivery:0=send"]), acks, digest), [], "a digest of another plan settles nothing");
    assert.deepEqual(settledAcks(undefined, acks, digest), []);
  });

  it("the prompt names the solved plan in Kletia's words, within 160 characters", () => {
    assert.equal(planSummary([swap, { kind: "bridge", network: "solana", toNetwork: "base", from: "USDC", amount: "max" }]), "Swap 1 SOL to USDC on Solana, then bridge it from Solana to Base");
    assert.equal(describeAction({ kind: "bridge", network: "base", toNetwork: "solana", from: "USDC", amount: "5", recipient: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" }, 0),
      "bridge 5 USDC from Base to Solana and pay 9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM there", "a recipient is never shortened in a prompt");
    const long = Array.from({ length: 8 }, () => pay);
    assert.ok(confirmPrompt(long, "Every move: ").length <= 160);
    assert.equal(confirmPrompt([swap], "Confirm: "), "Confirm: Swap 1 SOL to USDC on Solana.");
  });
});

describe("confirming a solved plan", () => {
  const sentence = "send all my USDC on arbitrum to vitalik.eth";

  it("a whole holding paid to someone else is confirmed with its amount; 'Yes, plan it' plans it and keeps the digest", async () => {
    const first = await turn("full", null, sentence);
    const q = first.decision?.questions[0];
    assert.equal(q?.reason, "INTERPRETATION_CONFIRM");
    assert.equal(q?.kind, "confirm");
    assert.match(q?.prompt ?? "", /30 USDC/u);
    assert.match(q?.prompt ?? "", /vitalik\.eth/u);
    assert.deepEqual(q?.options.map((option) => option.id), ["confirm", "cancel"]);
    assert.equal(first.decision?.thread.confirmDigest, undefined, "nothing is confirmed yet");
    const second = await turn("full", first.decision!.thread, { answer: { question: q!.id, option: "confirm" } });
    assert.equal(second.decision?.status, "ready");
    assert.equal(shape(second.decision!.actions!), "transfer@arbitrum 30 USDC to vitalik.eth");
    assert.match(second.decision?.thread.confirmDigest ?? "", /^sha256:[0-9a-f]{64}$/u);
    // The same end state on a later turn stays confirmed.
    const again = await turn("full", second.decision!.thread, { none: true });
    assert.equal(again.decision?.status, "ready");
  });

  it("a plan whose end state changed (another balance) is confirmed again", async () => {
    const first = await turn("full", null, sentence);
    const confirmed = await turn("full", first.decision!.thread, { answer: { question: first.decision!.questions[0]!.id, option: "confirm" } });
    const moved = await turn("two_usdc", confirmed.decision!.thread, { none: true });
    assert.equal(moved.decision?.status, "needs_input");
    assert.equal(moved.decision?.questions[0]?.reason, "INTERPRETATION_CONFIRM");
    assert.match(moved.decision?.questions[0]?.prompt ?? "", /150 USDC/u);
  });

  it("a forged digest settles nothing; 'No, rewrite it' cancels; a new sentence starts unconfirmed", async () => {
    const first = await turn("full", null, sentence);
    const forged = { ...first.decision!.thread, confirmDigest: `sha256:${"0".repeat(64)}` } as ClarifyThread;
    const still = await turn("full", forged, { none: true });
    assert.equal(still.decision?.questions[0]?.reason, "INTERPRETATION_CONFIRM");
    const cancelled = await turn("full", first.decision!.thread, { answer: { question: first.decision!.questions[0]!.id, option: "cancel" } });
    assert.equal(cancelled.decision?.status, "cancelled");
    const confirmed = await turn("full", first.decision!.thread, { answer: { question: first.decision!.questions[0]!.id, option: "confirm" } });
    const replaced = await turn("full", confirmed.decision!.thread, "swap 1 SOL to USDC");
    assert.equal(replaced.decision?.status, "ready");
    assert.equal(replaced.decision?.thread.confirmDigest, undefined);
  });
});

describe("model-assisted readings: only the person confirms", () => {
  async function modelReadThread(): Promise<{ thread: ClarifyThread; questionId: string; decision: TurnDecision }> {
    const plain = await turn("full", null, "swap 1 SOL to USDC");
    // What a model-assisted reading leaves on its step (seam S1): the step is marked, so its plan is confirmed.
    const thread = JSON.parse(JSON.stringify(plain.decision!.thread)) as { steps: Record<string, unknown>[] };
    thread.steps[0]!.modelRead = true;
    const asked = await turn("full", thread as unknown as ClarifyThread, { none: true });
    return { thread: asked.decision!.thread, questionId: asked.decision!.questions[0]!.id, decision: asked.decision! };
  }

  it("a model-assisted reading is confirmed with a neutral disclosure and an 'ackllm' option", async () => {
    const { decision } = await modelReadThread();
    const q = decision.questions[0];
    assert.equal(q?.reason, "INTERPRETATION_CONFIRM");
    assert.match(q?.prompt ?? "", /^Model-assisted reading: Swap 1 SOL to USDC on Solana\.$/u);
    assert.equal(q?.why, "Model-assisted reading. Kletia plans it only when you confirm.");
    assert.match(q?.options[0]?.value.target ?? "", /^ackllm:sha256:/u);
    assert.equal(decision.modelReading, true);
  });

  it("an API or agent answer is refused (403 CONFIRM_AUTHORITY_REQUIRED), as option or as text", async () => {
    const { thread, questionId } = await modelReadThread();
    const byOption = await turn("full", thread, { answer: { question: questionId, option: "confirm" } });
    assert.equal(byOption.error?.code, "CONFIRM_AUTHORITY_REQUIRED");
    const byText = await turn("full", thread, "confirm");
    assert.equal(byText.error?.code, "CONFIRM_AUTHORITY_REQUIRED");
    const explicitApi = await turn("full", thread, { answer: { question: questionId, option: "confirm" } }, { confirmAuthority: "api" });
    assert.equal(explicitApi.error?.code, "CONFIRM_AUTHORITY_REQUIRED");
  });

  it("the desk or the confirm card's token confirms it; the plan is ready and says it carries a model reading", async () => {
    const { thread, questionId } = await modelReadThread();
    for (const authority of ["desk", "token"] as const) {
      const confirmed = await turn("full", thread, { answer: { question: questionId, option: "confirm" } }, { confirmAuthority: authority });
      assert.equal(confirmed.decision?.status, "ready", authority);
      assert.equal(shape(confirmed.decision!.actions!), "swap@solana 1 SOL->USDC");
      assert.equal(confirmed.decision?.modelReading, true);
    }
  });
});
