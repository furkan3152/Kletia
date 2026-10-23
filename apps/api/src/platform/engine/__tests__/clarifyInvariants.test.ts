/**
 * Invariants of the clarify engine over the whole corpus and targeted
 * threads: complete sentences never get a question; gap questions never
 * target a stated slot; unsuggested reasons never suggest; at most two
 * questions and three chips; nicknames are never completed; the 1,500 rule;
 * transfer networks; the facts budget (8 balance and 2 name reads, preview
 * accounts never read, nothing read kept in the thread); the secret screen;
 * and the thread error codes (client-held threads included).
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CLARIFY_POLICY_VERSION, THREAD_LIMITS, UNSUGGESTED_REASONS, validateThread, type ClarifyThread } from "@kletia/core";
import { GRAMMAR_EXAMPLES, compileIntentText } from "../grammar.js";
import { configureHoldingsReaders } from "../holdings.js";
import { contextFor, installWallet, loadCorpus, runTurn, turnInputOf, type Corpus, type CorpusCase } from "../clarify/corpusHarness.js";
import { clarifyTurn, decideTurn, publicQuestion, type TurnDecision } from "../clarify/index.js";
import { isPlatformError, PlatformError } from "../../errors.js";

const corpus = loadCorpus(fileURLToPath(new URL("./fixtures/clarify-corpus.json", import.meta.url)));
const runnable = corpus.cases.filter((entry) => entry.phase !== 2);

after(() => configureHoldingsReaders(null));

/** Runs a case, yielding each turn's result with the reads it made (fresh holdings caches per turn). */
async function* turnsOf(entry: CorpusCase, source: Corpus = corpus) {
  const ctx = contextFor(source, entry);
  let thread: TurnDecision["thread"] | null = null;
  for (const turn of entry.turns) {
    const { reads } = installWallet(source, entry.wallet);
    const result = await runTurn(thread, turnInputOf(turn), ctx);
    yield { turn, result, reads: { ...reads }, ctx };
    if (result.decision) thread = result.decision.thread;
  }
}

function caseOf(id: string): CorpusCase {
  const entry = corpus.cases.find((candidate) => candidate.id === id);
  assert.ok(entry, id);
  return entry;
}

async function first(text: string, wallet = "full", request: CorpusCase["request"] = undefined): Promise<TurnDecision> {
  const entry = { id: "t", category: "test", title: "t", wallet, ...(request ? { request } : {}), turns: [] } as CorpusCase;
  installWallet(corpus, wallet);
  const result = await runTurn(null, { text }, contextFor(corpus, entry));
  assert.ok(result.decision, `${text}: ${result.error?.code} ${result.error?.message}`);
  return result.decision;
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (isPlatformError(error)) return error.code;
    throw error;
  }
  return "none";
}

const GAP = new Set(["AMOUNT_MISSING", "DESTINATION_MISSING", "OUTPUT_ASSET_MISSING", "INPUT_ASSET_MISSING", "RECIPIENT_MISSING", "SOURCE_MISSING", "TRANSFER_NETWORK", "NETWORK_AMBIGUOUS", "NETWORK_HANDOFF", "VENUE_MISSING", "COUNTERPART_MISSING", "FUNDS_ELSEWHERE"]);

describe("clarify recipient names", () => {
  it("does not say a name has no address when its records could not be read in time; the planner resolves it", async () => {
    const ctx = contextFor(corpus, { id: "t", category: "test", title: "t", wallet: "full", turns: [] } as CorpusCase);
    installWallet(corpus, "full", {
      resolveName: async () => {
        throw new PlatformError("NAME_RESOLUTION_UNAVAILABLE", "The ens records could not be read.", 503);
      },
    });
    const slow = await runTurn(null, { text: "send 5 USDC to vitalik.eth on optimism" }, ctx);
    assert.ok(slow.decision, `${slow.error?.code} ${slow.error?.message}`);
    assert.ok(!slow.decision.questions.some((q) => q.reason === "RECIPIENT_UNRESOLVED"), JSON.stringify(slow.decision.questions.map((q) => q.prompt)));
    // A name that resolves to nothing is still asked about.
    installWallet(corpus, "full", {
      resolveName: async () => {
        throw new PlatformError("RECIPIENT_NAME_UNRESOLVED", "no address", 422);
      },
    });
    const missing = await runTurn(null, { text: "send 5 USDC to nobody.eth on optimism" }, ctx);
    assert.equal(missing.decision?.questions[0]?.reason, "RECIPIENT_UNRESOLVED");
    assert.match(missing.decision?.questions[0]?.prompt ?? "", /nobody\.eth has no OP Mainnet address/u);
  });
});

describe("clarify invariants", () => {
  it("every grammar example is ready with no question and the strict grammar's actions", async () => {
    for (const text of GRAMMAR_EXAMPLES) {
      let decision = await first(text);
      // D2 and gas (C.1 rule 8) are funds checks, not gaps: an example amount above the fixture balance is asked and,
      // kept, plans as written; a network without gas is asked and, "plan anyway", plans as written.
      for (let round = 0; round < 3; round += 1) {
        const check = decision.questions[0];
        const settle = check?.reason === "AMOUNT_EXCEEDS_BALANCE" ? "keep" : check?.reason === "GAS_ON_ARRIVAL" ? "anyway" : null;
        if (!check || !settle || decision.questions.length !== 1) break;
        assert.ok(check.options.some((option) => option.id === settle), text);
        const settled = await runTurn(decision.thread, { answer: { question: check.id, option: settle } }, contextFor(corpus, { id: "t", category: "test", title: "t", wallet: "full", turns: [] } as CorpusCase));
        assert.ok(settled.decision, `${text}: ${settled.error?.code}`);
        decision = settled.decision;
      }
      assert.equal(decision.status, "ready", `${text}: ${JSON.stringify(decision.questions.map((q) => q.reason))}`);
      assert.equal(decision.questions.length, 0, text);
      const today = compileIntentText(text, { accounts: corpus.fixtures.wallets.full!.accounts as never }).actions;
      assert.deepEqual((decision.actions ?? []).map((action) => [action.kind, action.network]), today.map((action) => [action.kind, action.network]), text);
    }
  });

  it("asks gap questions only about slots nobody stated, at most two per turn, and chips at most three per plan", async () => {
    let gaps = 0;
    for (const entry of runnable) {
      for await (const { result } of turnsOf(entry)) {
        const decision = result.decision;
        if (!decision) continue;
        assert.ok(decision.questions.length <= 2, `${entry.id}: ${decision.questions.length} questions`);
        if (decision.status === "ready") assert.ok(decision.assumptions.length <= 3, `${entry.id}: ${decision.assumptions.length} chips`);
        for (const q of decision.questions) {
          if (!GAP.has(q.reason)) continue;
          const match = /^actions\[(\d+)\]\.(\w+)$/u.exec(q.field);
          assert.ok(match, `${entry.id}: gap question on a step slot (${q.field})`);
          const slot = (decision.thread.steps[Number(match[1])] as Record<string, { by?: string } | undefined> | undefined)?.[match[2] as string];
          assert.ok(!slot || slot.by === "assumed" || slot.by === "derived", `${entry.id}: ${q.reason} asks for ${q.field}, already ${slot?.by}`);
          gaps += 1;
        }
      }
    }
    assert.ok(gaps >= 40, `checked ${gaps} gap questions`);
  });

  it("never suggests an option for gap and recipient questions (public view included)", async () => {
    for (const entry of runnable) {
      for await (const { result } of turnsOf(entry)) {
        for (const q of result.decision?.questions ?? []) {
          const view = publicQuestion(q);
          assert.ok(view.options.filter((option) => option.recommended).length <= 1, `${entry.id}: one suggestion at most`);
          if (UNSUGGESTED_REASONS.has(q.reason)) assert.ok(!view.options.some((option) => option.recommended), `${entry.id}: ${q.reason} suggests`);
          assert.equal(view.purpose, !["VENUE_MISSING", "NETWORK_AMBIGUOUS", "VENUE_AMBIGUOUS"].includes(q.reason), `${entry.id}: purpose flag`);
        }
      }
    }
  });

  it("never completes, stores or offers a nickname as a name", async () => {
    for (const text of ["send 5 USDC to my friend", "send 5 USDC to vitalik"]) {
      const decision = await first(text);
      assert.equal(decision.questions[0]?.reason, "RECIPIENT_MISSING");
      assert.deepEqual(decision.questions[0]?.options, []);
      const blob = JSON.stringify(decision.thread);
      assert.ok(!blob.includes("friend") && !blob.includes("vitalik"), `${text}: the word is not kept`);
      assert.equal(decision.thread.steps[0]?.recipient, undefined);
    }
  });

  it("asks about '1,500' only when the balance covers 1.5 and not 1,500", async () => {
    const asked = await first("swap 1,500 USDC to ETH on base");
    assert.equal(asked.questions[0]?.reason, "AMOUNT_FORMAT_AMBIGUOUS");
    const rich: Corpus = { ...corpus, fixtures: { ...corpus.fixtures, wallets: { ...corpus.fixtures.wallets, rich: { ...corpus.fixtures.wallets.full!, balances: { ...corpus.fixtures.wallets.full!.balances, base: { USDC: "2000", ETH: "1" } } } } } };
    installWallet(rich, "rich");
    const covered = await runTurn(null, { text: "swap 1,500 USDC to ETH on base" }, contextFor(rich, { wallet: "rich" } as CorpusCase));
    assert.equal(covered.decision?.status, "ready");
    assert.equal(covered.decision?.actions?.[0]?.amount, "1500");
    const unknown = await first("swap 1,500 USDC to ETH on base", "preview");
    assert.equal(unknown.actions?.[0]?.amount, "1500");
  });

  it("asks where a payment lands (purpose, C.1 rule 4): two funded networks, one, or none known; never a chip", async () => {
    const two = await first("send 5 USDC to 0x000000000000000000000000000000000000dEaD");
    assert.equal(two.questions[0]?.reason, "TRANSFER_NETWORK");
    assert.deepEqual(two.questions[0]?.options.map((option) => option.id), ["base", "arbitrum"]);
    assert.ok(!two.questions[0]?.options.some((option) => option.recommended), "never a suggestion");
    // One network holds the funds: still asked (an address may exist on one network only), with that network offered.
    const one = await first("send 5 USDC to 0x000000000000000000000000000000000000dEaD", "evm_base");
    assert.equal(one.status, "needs_input");
    assert.equal(one.questions[0]?.reason, "TRANSFER_NETWORK");
    assert.deepEqual(one.questions[0]?.options.map((option) => option.id), ["base"]);
    assert.ok(!one.assumptions.some((entry) => entry.field === "actions[0].network"), "no network chip for a payment");
    const unknown = await first("send 5 USDC to 0x1111111111111111111111111111111111111111", "preview");
    assert.equal(unknown.questions[0]?.reason, "TRANSFER_NETWORK");
  });

  it("reads facts only within the turn budget, never reads preview accounts and keeps nothing read in the thread", async () => {
    for (const entry of runnable) {
      for await (const { result, reads } of turnsOf(entry)) {
        assert.ok(reads.balances <= 8, `${entry.id}: ${reads.balances} balance reads`);
        assert.ok(reads.names <= 2, `${entry.id}: ${reads.names} name reads`);
        if (entry.wallet === "preview") assert.equal(reads.balances + reads.names, 0, `${entry.id}: preview accounts are never read`);
        const blob = JSON.stringify(result.decision?.thread ?? {});
        // Balances of the full wallet and resolved addresses never land in the thread.
        assert.ok(!blob.includes("120.4") && !blob.includes("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045") && !blob.includes("86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY"), `${entry.id}: no facts in the thread`);
        if (result.decision) assert.ok(validateThread(result.decision.thread).ok, `${entry.id}: the thread validates`);
      }
    }
  });

  it("keeps thread labels in Kletia's words and the thread within its limits", async () => {
    const allowed = /^(?:Started the task|Replaced the task with a new sentence|Undid the last change|Answered the open question|Chose: |Changed|Moved it to|Pinned the bridge to|Added a step|Cancelled the task)/u;
    for (const entry of runnable) {
      let last: TurnDecision["thread"] | null = null;
      for await (const { result } of turnsOf(entry)) if (result.decision) last = result.decision.thread;
      if (!last) continue;
      assert.ok(Buffer.byteLength(JSON.stringify(last)) <= THREAD_LIMITS.maxBytes, `${entry.id}: size`);
      assert.ok(last.turns.length <= THREAD_LIMITS.storedTurns && last.undo.length <= THREAD_LIMITS.undoSnapshots, `${entry.id}: limits`);
      for (const turn of last.turns.filter((entry) => entry.role === "user")) assert.match(turn.label, allowed, `${entry.id}: ${turn.label}`);
    }
  });

  it("screens every message and answer for secrets before anything else (thread unchanged)", async () => {
    const decision = await first("swap SOL to USDC");
    const key = `0x${"ab".repeat(32)}`;
    const ctx = contextFor(corpus, caseOf("B01"));
    for (const input of [{ text: `make it 2, my private key is ${key}` }, { answer: { question: "q.actions.0.amount", text: key } }]) {
      const code = await refusal(decideTurn(decision.thread, input, ctx));
      assert.equal(code, "MESSAGE_SECRET_REFUSED");
    }
  });

  it("emits the thread error codes for client-held threads", async () => {
    const decision = await first("bridge 25 USDC from base");
    const ctx = contextFor(corpus, caseOf("D01"));
    assert.equal(await refusal(decideTurn(decision.thread, { answer: { question: "q.actions.0.amount", option: "all" } }, ctx)), "QUESTION_NOT_OPEN");
    assert.equal(await refusal(decideTurn(decision.thread, { answer: { question: "q.actions.0.toNetwork", option: "mars" } }, ctx)), "ANSWER_INVALID");
    assert.equal(await refusal(decideTurn(decision.thread, { answer: { question: "q.actions.0.toNetwork", text: "somewhere nice" } }, ctx)), "ANSWER_INVALID");
    assert.equal(await refusal(decideTurn(decision.thread, { assumption: { id: "a.actions.0.network", option: "arbitrum" } }, ctx)), "ANSWER_INVALID");
    const ready = await first("swap 1 SOL to USDC");
    assert.equal(await refusal(decideTurn(ready.thread, { text: "double it" }, ctx)), "EDIT_UNSUPPORTED");
    assert.equal(await refusal(decideTurn(ready.thread, { text: "undo" }, ctx)), "EDIT_UNSUPPORTED");
    const cancelled = await decideTurn(ready.thread, { text: "cancel" }, ctx);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(await refusal(decideTurn(cancelled.thread, { text: "make it 2" }, ctx)), "THREAD_CLOSED");
    const old: ClarifyThread = { ...ready.thread, rev: THREAD_LIMITS.maxTurns };
    assert.equal(await refusal(decideTurn(old, { text: "make it 2" }, ctx)), "THREAD_CLOSED");
    const forged = { ...ready.thread, pendingEdit: { op: "drain", to: "0x1111111111111111111111111111111111111111" } } as ClarifyThread;
    assert.equal(await refusal(decideTurn(forged, { text: "make it 2" }, ctx)), "THREAD_INVALID");
    const accounts = corpus.fixtures.wallets.full!.accounts as never;
    assert.equal(await refusal(clarifyTurn({ text: "make it 2", accounts, thread: { ...ready.thread, spec: "other" } as never }, { thread: null })), "THREAD_INVALID");
    assert.equal(await refusal(clarifyTurn({ accounts, thread: { ...ready.thread, steps: "x" } as never }, { thread: null })), "THREAD_INVALID");
    assert.equal(await refusal(clarifyTurn({ text: "swap 1 SOL to USDC", accounts, actions: [] } as never, { thread: null })), "INVALID_REQUEST");
  });

  it("re-decides assumed slots of a thread written by an older policy and keeps what the user said", async () => {
    const decision = await first("swap 10 USDC to ETH");
    assert.equal(decision.thread.steps[0]?.network?.by, "assumed");
    const older: ClarifyThread = { ...decision.thread, policy: "2020-01.1", steps: [{ ...decision.thread.steps[0]!, network: { v: "arbitrum", by: "assumed", why: { source: "balance", code: "balance.largest" } } }] };
    const again = await decideTurn(older, { none: true } as never, contextFor(corpus, caseOf("E01")));
    assert.equal(again.actions?.[0]?.network, "base", "the stale assumption is decided again");
    assert.equal(again.thread.policy, CLARIFY_POLICY_VERSION);
  });

  it("asks the contract gaps of bring-your-own-contract clauses (registered networks only)", async () => {
    const amount = await first("deposit USDC into acme vault");
    assert.equal(amount.questions[0]?.reason, "AMOUNT_MISSING");
    const network = await first("deposit 100 USDC into acme pool");
    assert.equal(network.questions[0]?.reason, "NETWORK_AMBIGUOUS");
    assert.deepEqual(network.questions[0]?.options.map((option) => option.id), ["base", "arbitrum"]);
  });

  it("keeps journey prompts out of the thread: a planned thread has no open question", async () => {
    const decision = await first("swap 1 SOL to USDC");
    assert.equal(decision.thread.status, "ready");
    assert.deepEqual(decision.thread.open, []);
  });
});
