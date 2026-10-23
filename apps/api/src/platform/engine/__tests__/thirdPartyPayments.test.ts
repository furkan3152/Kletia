/**
 * Payments to someone else (intent design C.1 rule 4, C3, C4, I13, WP5,
 * WP10, AQ12; package P2-M1): where a third party receives is purpose (asked,
 * never a chip) unless said or implied by the recipient; a raw EVM address is
 * checked where it receives (seam S6, accountCode) and a failed check is
 * acknowledged, never passed silently; a payment that crosses networks asks
 * who bears the bridge fees (DELIVERY_AMOUNT) until exact delivery ships; an
 * address of the other family, a "the USDC" that has two referents, or a
 * payment above the balance are asked. Offline: the clarify corpus' wallets
 * and stub account-code readers.
 */
import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { ClarifyThread, NetworkKey } from "@kletia/core";
import { contextFor, installWallet, loadCorpus, runTurn, shape, uninstallWallet, type CorpusCase } from "../clarify/corpusHarness.js";
import type { TurnDecision, TurnInput } from "../clarify/index.js";
import { EXACT_DELIVERY_PLANNED } from "../clarify/policy.js";
import { configureAccountCodeReader, type HoldingsReaders } from "../holdings.js";
import { accountCode, classifyAccountCode } from "../nameResolvers.js";

const corpus = loadCorpus(fileURLToPath(new URL("./fixtures/clarify-corpus.json", import.meta.url)));
after(() => uninstallWallet());
afterEach(() => configureAccountCodeReader(null));

const ADDRESS = "0x1111111111111111111111111111111111111111";
const SOLANA_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

interface Turn {
  readonly decision?: TurnDecision;
  readonly error?: { readonly code: string; readonly message: string };
}

/** Runs a thread; `code` (when given) answers the account-code reads of every turn. */
async function thread(wallet: string, options: { request?: CorpusCase["request"]; code?: HoldingsReaders["accountCode"] }, ...inputs: (string | TurnInput)[]): Promise<Turn[]> {
  const entry = { id: "t", category: "test", title: "t", wallet, ...(options.request ? { request: options.request } : {}), turns: [] } as CorpusCase;
  const ctx = contextFor(corpus, entry);
  const out: Turn[] = [];
  let current: ClarifyThread | null = null;
  for (const input of inputs) {
    installWallet(corpus, wallet);
    if (options.code) configureAccountCodeReader(options.code);
    const result = await runTurn(current, typeof input === "string" ? { text: input } : input, ctx);
    out.push(result);
    if (result.decision) current = result.decision.thread;
  }
  return out;
}

const answer = (question: string, option: string): TurnInput => ({ answer: { question, option } });
const planOf = (turn: Turn | undefined) => (turn?.decision?.actions ? shape(turn.decision.actions) : `${turn?.decision?.status ?? turn?.error?.code}`);
const asked = (turn: Turn | undefined) => turn?.decision?.questions.map((q) => `${q.field}:${q.reason}`) ?? [];
const optionsOf = (turn: Turn | undefined) => turn?.decision?.questions[0]?.options.map((option) => option.id) ?? [];

describe("the receiving network of a payment is purpose", () => {
  it("a plain .eth name: where it receives is asked, never suggested and never a chip", async () => {
    const [turn] = await thread("full", {}, "send 5 USDC to vitalik.eth");
    assert.deepEqual(asked(turn), ["actions[0].network:TRANSFER_NETWORK"]);
    assert.ok(turn?.decision?.questions[0]?.options.every((option) => !option.recommended));
    assert.ok(!turn?.decision?.assumptions.some((entry) => entry.field === "actions[0].network"));
  });

  it("a raw address too, even when one network holds the funds or the integrator set a default", async () => {
    const [only] = await thread("evm_base", {}, `send 5 USDC to ${ADDRESS}`);
    assert.deepEqual(asked(only), ["actions[0].network:TRANSFER_NETWORK"]);
    const [defaulted] = await thread("preview", { request: { defaultNetwork: "base" } }, `send 5 USDC to ${ADDRESS}`);
    assert.deepEqual(asked(defaulted), ["actions[0].network:TRANSFER_NETWORK"]);
  });

  it("a recipient that implies its network needs no question (.base.eth on Base, .sns on Solana)", async () => {
    const [basename] = await thread("full", {}, "send 5 USDC to jesse.base.eth");
    assert.equal(planOf(basename), "transfer@base 5 USDC to jesse.base.eth");
    const [sns] = await thread("full", {}, "send 1 USDC to toly.sns");
    assert.equal(planOf(sns), "transfer@solana 1 USDC to toly.sns");
  });

  it("a fixed departure says where the money starts, not where a third party receives", async () => {
    const [ask, planned] = await thread("two_usdc", { request: { sourceNetwork: "arbitrum" } }, "send 5 USDC to vitalik.eth", answer("q.actions.0.network", "arbitrum"));
    assert.deepEqual(asked(ask), ["actions[0].network:TRANSFER_NETWORK"]);
    assert.equal(planOf(planned), "transfer@arbitrum 5 USDC to vitalik.eth");
  });
});

describe("crossing payments (C3): who bears the bridge fees is asked", () => {
  it("exact delivery is not planned yet, so the person chooses to send the stated amount", () => {
    assert.equal(EXACT_DELIVERY_PLANNED, false);
  });

  it("departure Base, a Solana address: DELIVERY_AMOUNT, then one bridge leg that pays the recipient", async () => {
    const [ask, planned] = await thread("full", { request: { sourceNetwork: "base" } }, `send 5 USDC to ${SOLANA_ADDRESS}`, answer("q.actions.0.amount", "send"));
    assert.deepEqual(asked(ask), ["actions[0].amount:DELIVERY_AMOUNT"]);
    assert.deepEqual(optionsOf(ask), ["send", "cancel"]);
    assert.match(ask?.decision?.questions[0]?.prompt ?? "", /receives on Solana, and the USDC is on Base/u);
    assert.equal(planOf(planned), `bridge@base->solana 5 USDC to ${SOLANA_ADDRESS}`);
  });

  it("a payment above the balance where it receives offers funds elsewhere (WP10), each a crossing payment", async () => {
    const [ask, crossing, planned] = await thread("full", {}, "send 5 USDC to vitalik.eth on optimism", answer("q.actions.0.amount", "base"), answer("q.actions.0.amount", "send"));
    assert.deepEqual(asked(ask), ["actions[0].amount:AMOUNT_EXCEEDS_BALANCE"]);
    assert.deepEqual(optionsOf(ask), ["base", "arbitrum", "solana", "keep"]);
    assert.deepEqual(asked(crossing), ["actions[0].amount:DELIVERY_AMOUNT"]);
    assert.equal(planOf(planned), "bridge@base->optimism 5 USDC to vitalik.eth");
  });
});

describe("addresses and families (WP5, AQ12)", () => {
  it("an EVM address with a Solana network is asked where it receives", async () => {
    const [turn] = await thread("full", {}, `send 10 usdc to ${ADDRESS} on solana`);
    assert.deepEqual(asked(turn), ["actions[0].recipient:RECIPIENT_NETWORK_MISMATCH"]);
    assert.deepEqual(optionsOf(turn), ["base", "arbitrum"]);
  });

  it("SOL to an Ethereum name: the name receives where SOL is not listed, so the recipient is asked", async () => {
    const [turn] = await thread("full", {}, "send 0.1 SOL to vitalik.eth");
    assert.deepEqual(asked(turn), ["actions[0].recipient:RECIPIENT_NETWORK_MISMATCH"]);
    assert.equal(turn?.decision?.questions[0]?.kind, "address");
  });

  it("'the USDC' after a swap that delivers USDC, while USDC is also held there, is asked (REFERENCE_AMBIGUOUS)", async () => {
    const [turn] = await thread("full", {}, "swap 1 SOL to USDC then send the USDC to toly.sns");
    assert.deepEqual(asked(turn), ["actions[1].amount:REFERENCE_AMBIGUOUS"]);
    assert.deepEqual(optionsOf(turn), ["output", "cancel"]);
  });
});

describe("seam S6: a raw EVM address is checked where it receives", () => {
  const codes = (map: Partial<Record<NetworkKey, "none" | "delegated" | "contract" | "fail">>): HoldingsReaders["accountCode"] => async (network) => {
    const kind = map[network] ?? "none";
    if (kind === "fail") throw new Error("offline");
    return kind;
  };
  const sentence = `send 5 USDC to ${ADDRESS} on base`;

  it("no code anywhere, a contract or an EIP-7702 account there: planned", async () => {
    for (const map of [{}, { base: "contract" as const }, { base: "delegated" as const }]) {
      const [turn] = await thread("full", { code: codes(map) }, sentence);
      assert.equal(planOf(turn), `transfer@base 5 USDC to ${ADDRESS}`, JSON.stringify(map));
    }
  });

  it("no code on Base but a contract on Arbitrum: where it should receive is asked (a Safe exists only where deployed)", async () => {
    const [turn, moved] = await thread("full", { code: codes({ arbitrum: "contract" }) }, sentence, answer("q.actions.0.recipient", "arbitrum"));
    assert.deepEqual(asked(turn), ["actions[0].recipient:RECIPIENT_NETWORK_MISMATCH"]);
    assert.deepEqual(optionsOf(turn), ["arbitrum"]);
    assert.match(turn?.decision?.questions[0]?.prompt ?? "", /is a contract on Arbitrum One but has no code on Base/u);
    assert.equal(moved?.decision?.status, "ready");
    assert.match(planOf(moved), /->arbitrum|@arbitrum/u);
  });

  it("a read that fails is acknowledged, never a silent pass; 'pay anyway' plans it", async () => {
    const [turn, planned] = await thread("full", { code: codes({ base: "fail" }) }, sentence, answer("q.actions.0.recipient", "anyway"));
    assert.deepEqual(asked(turn), ["actions[0].recipient:RECIPIENT_NETWORK_MISMATCH"]);
    assert.deepEqual(optionsOf(turn), ["anyway", "cancel"]);
    assert.match(turn?.decision?.questions[0]?.prompt ?? "", /could not check .+ on Base right now/u);
    assert.equal(planOf(planned), `transfer@base 5 USDC to ${ADDRESS}`);
  });

  it("classifyAccountCode: empty is none, an EIP-7702 designator is delegated, other code a contract, junk is null", () => {
    assert.equal(classifyAccountCode("0x"), "none");
    assert.equal(classifyAccountCode("0x0"), "none");
    assert.equal(classifyAccountCode(`0xef0100${"ab".repeat(20)}`), "delegated");
    assert.equal(classifyAccountCode("0x6080604052"), "contract");
    assert.equal(classifyAccountCode("0xzz"), null);
    assert.equal(classifyAccountCode(null), null);
  });

  it("accountCode: reads eth_getCode; a failed, slow, malformed or non-EVM read is unknown (never none)", async () => {
    const client = (result: () => Promise<unknown>) => ({ client: () => ({ request: result }) as never });
    assert.equal(await accountCode("base", ADDRESS, 1_000, client(async () => "0x")), "none");
    assert.equal(await accountCode("base", ADDRESS, 1_000, client(async () => "0x6080")), "contract");
    assert.equal(await accountCode("base", ADDRESS, 1_000, client(async () => { throw new Error("rpc"); })), "unknown");
    assert.equal(await accountCode("base", ADDRESS, 20, client(() => new Promise((resolve) => setTimeout(() => resolve("0x"), 500)))), "unknown");
    assert.equal(await accountCode("base", ADDRESS, 1_000, client(async () => 42)), "unknown");
    assert.equal(await accountCode("solana", ADDRESS, 1_000, client(async () => "0x")), "unknown");
    assert.equal(await accountCode("base", "0x1234", 1_000, client(async () => "0x")), "unknown");
  });
});
