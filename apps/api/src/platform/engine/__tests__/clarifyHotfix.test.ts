/**
 * Decide-and-place hotfix (intent design P2-M0): the live wrong readings the
 * red-team probe found in the decision layer.
 *
 * - A step that spends the previous step's output on a network other than the
 *   one that output lands on is refused, naming both networks, instead of
 *   spending funds already on its own network ("bridge 100 usdc from base to
 *   arbitrum then deposit it into aave on base").
 * - A typed symbol Kletia does not list is never read as a close listed symbol
 *   on a chip: a look-alike asks ASSET_LOOKALIKE ("swap 1 steth to eth" asks
 *   about wstETH), a plain typo asks ASSET_TYPO.
 * - "wsol" is no longer read silently as native SOL: it asks ASSET_LOOKALIKE.
 *
 * The policy rules are tested on constructed working states (no reader in the
 * way), the live prompts end to end with the corpus wallet "full".
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { NetworkKey, ThreadAmount } from "@kletia/core";
import { lookalikeOf } from "../clarify/catalog.js";
import { contextFor, installWallet, loadCorpus, runTurn, shape, uninstallWallet, type CorpusCase } from "../clarify/corpusHarness.js";
import type { TurnDecision } from "../clarify/index.js";
import { analyze } from "../clarify/policy.js";
import type { Analysis, FactsView, Kind, Question, TurnContext, WorkState, WorkStep } from "../clarify/types.js";
import { isPlatformError, type PlatformError } from "../../errors.js";

/* ------------------------------------------------------------ fixtures */

const EVM = "eip155:8453:0x4f1859Ae1Ed5a8e1d1BE7d7df3F1A47De5BC6e5C";
const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy";
const CTX: TurnContext = { accounts: [EVM, SOLANA], contracts: [] };

const BALANCES: Readonly<Partial<Record<NetworkKey, Readonly<Record<string, string>>>>> = {
  base: { ETH: "0.05", USDC: "120.40", USDbC: "50", WETH: "0", wstETH: "0" },
  arbitrum: { ETH: "0.01", USDC: "30", WETH: "0" },
  ethereum: { ETH: "2", USDC: "0", WETH: "0", wstETH: "3" },
  optimism: { ETH: "0", USDC: "0" },
  solana: { SOL: "2.5", USDC: "12", USDT: "0" },
};
const NAMES: Readonly<Record<string, string>> = { "vitalik.eth": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" };

const FACTS: FactsView = {
  balance: (network, symbol) => {
    const row = BALANCES[network];
    if (!row) return undefined;
    const key = Object.keys(row).find((entry) => entry.toUpperCase() === symbol.toUpperCase());
    return key === undefined ? undefined : row[key];
  },
  resolveName: (name) => NAMES[name.toLowerCase()] ?? null,
  position: () => undefined,
};

interface StepInput {
  kind: Kind;
  amount?: ThreadAmount;
  from?: string;
  to?: string;
  network?: NetworkKey;
  toNetwork?: NetworkKey;
  recipient?: string;
  protocol?: string;
}

const PREVIOUS: ThreadAmount = { t: "previous", bps: 10_000 };
const exact = (value: string): ThreadAmount => ({ t: "exact", value });

function step(input: StepInput): WorkStep {
  const out: WorkStep = { kind: { v: input.kind, by: "user" } };
  if (input.amount) out.amount = { v: input.amount, by: "user" };
  if (input.from) out.from = { v: input.from, by: "user" };
  if (input.to) out.to = { v: input.to, by: "user" };
  if (input.network) out.network = { v: input.network, by: "user" };
  if (input.toNetwork) out.toNetwork = { v: input.toNetwork, by: "user" };
  if (input.recipient) out.recipient = { v: input.recipient, by: "user" };
  if (input.protocol) out.protocol = { v: input.protocol, by: "user" };
  return out;
}

function state(...steps: StepInput[]): WorkState {
  return { id: "th_test", rev: 0, status: "needs_input", steps: steps.map(step), open: [], corrections: [], turns: [], undo: [] };
}

function refusal(run: () => unknown): PlatformError {
  try {
    run();
  } catch (error) {
    assert.ok(isPlatformError(error), String(error));
    return error;
  }
  assert.fail("expected a refusal");
}

function only(analysis: Analysis): Question {
  assert.equal(analysis.resolved, null, "not ready");
  assert.equal(analysis.questions.length, 1, JSON.stringify(analysis.questions.map((q) => q.reason)));
  return analysis.questions[0] as Question;
}

/* ------------------------------------------- network continuity (WP3) */

describe("a dependent step on another network than the previous output (P2-M0, superseded by P2-M1: C.1)", () => {
  it("bridge to Arbitrum One, then deposit it on Base: NETWORK_CONTRADICTION, never a deposit of other Base funds", () => {
    const q = only(analyze(state(
      { kind: "bridge", amount: exact("100"), from: "USDC", network: "base", toNetwork: "arbitrum" },
      { kind: "deposit", amount: PREVIOUS, network: "base", protocol: "aave-v3" },
    ), CTX, FACTS));
    assert.equal(q.reason, "NETWORK_CONTRADICTION");
    assert.equal(q.field, "actions[1].network");
    assert.match(q.prompt, /^Step 2 deposits on Base, but step 1 delivers the USDC on Arbitrum One\. Which did you mean\?$/u);
    assert.deepEqual(q.options.map((option) => option.id), ["arbitrum", "skip", "cancel"]);
    assert.equal(q.options.some((option) => option.recommended), false);
  });

  it("the same bridge with the deposit's network left open deposits where the bridge lands", () => {
    const analysis = analyze(state(
      { kind: "bridge", amount: exact("100"), from: "USDC", network: "base", toNetwork: "arbitrum" },
      { kind: "deposit", amount: PREVIOUS, protocol: "aave-v3" },
    ), CTX, FACTS);
    assert.deepEqual(analysis.questions, []);
    assert.deepEqual(analysis.resolved?.map((action) => [action.kind, action.network, action.toNetwork ?? null, action.amount]), [
      ["bridge", "base", "arbitrum", "100"],
      ["deposit", "arbitrum", null, "max"],
    ]);
  });

  it("a deposit said on the network the bridge lands on is ready", () => {
    const analysis = analyze(state(
      { kind: "bridge", amount: exact("100"), from: "USDC", network: "base", toNetwork: "arbitrum" },
      { kind: "deposit", amount: PREVIOUS, network: "arbitrum", protocol: "aave-v3" },
    ), CTX, FACTS);
    assert.deepEqual(analysis.resolved?.map((action) => `${action.kind}@${action.network}`), ["bridge@base", "deposit@arbitrum"]);
  });

  it("a payment of the bridged funds said on the source network is a contradiction question", () => {
    const q = only(analyze(state(
      { kind: "bridge", amount: exact("100"), from: "USDC", network: "base", toNetwork: "arbitrum" },
      { kind: "transfer", amount: PREVIOUS, network: "base", recipient: "vitalik.eth" },
    ), CTX, FACTS));
    assert.equal(q.reason, "NETWORK_CONTRADICTION");
    assert.match(q.prompt, /^Step 2 sends on Base, but step 1 delivers the USDC on Arbitrum One\./u);
  });

  it("a swap's output paid on another network said for the payment becomes one leg that pays the recipient there", () => {
    const analysis = analyze(state(
      { kind: "swap", amount: exact("100"), from: "USDC", to: "ETH", network: "base" },
      { kind: "transfer", amount: PREVIOUS, network: "arbitrum", recipient: "vitalik.eth" },
    ), CTX, FACTS);
    assert.deepEqual(analysis.questions, []);
    assert.deepEqual(analysis.resolved?.map((action) => [action.kind, action.network, action.toNetwork ?? null, action.from, action.amount, action.recipient ?? null]), [
      ["swap", "base", null, "USDC", "100", null],
      ["bridge", "base", "arbitrum", "ETH", "max", "vitalik.eth"],
    ]);
    assert.ok(analysis.assumptions.some((entry) => entry.field === "actions[1].network" && entry.material), "the crossing payment is a material chip");
  });

  it("a swap on Solana, then a deposit on Base: a crossing leg carries the USDC to Base (C.1 rule 2), never other Base funds", () => {
    const analysis = analyze(state(
      { kind: "swap", amount: exact("1"), from: "SOL", to: "USDC" },
      { kind: "deposit", amount: PREVIOUS, network: "base", protocol: "aave-v3" },
    ), CTX, FACTS);
    assert.deepEqual(analysis.resolved?.map((action) => [action.kind, action.network, action.toNetwork ?? null, action.amount]), [
      ["swap", "solana", null, "1"],
      ["bridge", "solana", "base", "max"],
      ["deposit", "base", null, "max"],
    ]);
  });

  it("a dependent bridge that starts on another network than the previous output is a contradiction question", () => {
    const q = only(analyze(state(
      { kind: "swap", amount: exact("1"), from: "SOL", to: "USDC", network: "solana" },
      { kind: "bridge", amount: PREVIOUS, network: "base", toNetwork: "arbitrum" },
    ), CTX, FACTS));
    assert.equal(q.reason, "NETWORK_CONTRADICTION");
    assert.match(q.prompt, /^Step 2 bridges from Base, but step 1 delivers the USDC on Solana\./u);
    assert.deepEqual(q.options.map((option) => option.label), ["Bridge from Solana", "Neither, cancel"]);
  });

  it("a recipient that implies another network than the previous output (a Solana address after a Base swap) is paid by one crossing leg", () => {
    const analysis = analyze(state(
      { kind: "swap", amount: exact("0.01"), from: "ETH", to: "USDC", network: "base" },
      { kind: "transfer", amount: PREVIOUS, recipient: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" },
    ), CTX, FACTS);
    assert.deepEqual(analysis.resolved?.map((action) => `${action.kind}@${action.network}->${action.toNetwork ?? "-"} ${action.amount}`), ["swap@base->- 0.01", "bridge@base->solana max"]);
  });

  it("a step with its own amount on the network the bridge leaves: two claims on Base's USDC above the balance ask SPEND_CONFLICT", () => {
    const q = only(analyze(state(
      { kind: "bridge", amount: exact("100"), from: "USDC", network: "base", toNetwork: "arbitrum" },
      { kind: "deposit", amount: exact("50"), from: "USDC", network: "base", protocol: "aave-v3" },
    ), CTX, FACTS));
    assert.equal(q.reason, "SPEND_CONFLICT");
    assert.equal(q.field, "actions[1].amount");
    assert.deepEqual(q.options.map((option) => [option.id, option.value.amount]), [["rest", { t: "exact", value: "20.4" }]]);
    const covered = analyze(state(
      { kind: "bridge", amount: exact("100"), from: "USDC", network: "base", toNetwork: "arbitrum" },
      { kind: "deposit", amount: exact("20"), from: "USDC", network: "base", protocol: "aave-v3" },
    ), CTX, FACTS);
    assert.deepEqual(covered.resolved?.map((action) => `${action.kind}@${action.network} ${action.amount}`), ["bridge@base 100", "deposit@base 20"]);
  });
});

/* ------------------------------------------------ symbols (A10, D9) */

describe("a symbol is never corrected on a chip (P2-M0)", () => {
  it("stETH on Ethereum asks ASSET_LOOKALIKE about wstETH with no suggestion", () => {
    const q = only(analyze(state({ kind: "swap", amount: exact("1"), from: "steth", to: "ETH", network: "ethereum" }), CTX, FACTS));
    assert.equal(q.reason, "ASSET_LOOKALIKE");
    assert.equal(q.field, "actions[0].from");
    assert.equal(q.prompt, "Kletia lists wstETH (wrapped stETH, about 1.2 stETH each), not stETH. Use wstETH?");
    assert.deepEqual(q.options.map((option) => option.id), ["wstETH", "cancel"]);
    assert.equal(q.options.some((option) => option.recommended), false, "a look-alike is never suggested");
    assert.equal(q.options[0]?.detail, "You hold 3 wstETH on Ethereum");
    assert.deepEqual(q.options[1]?.value, { target: "cancel" });
    assert.equal(q.allowsText, true);
  });

  it("stETH as the token to receive asks too", () => {
    const q = only(analyze(state({ kind: "swap", amount: exact("1"), from: "ETH", to: "steth", network: "ethereum" }), CTX, FACTS));
    assert.equal(q.reason, "ASSET_LOOKALIKE");
    assert.equal(q.field, "actions[0].to");
    assert.equal(q.prompt, "Kletia lists wstETH (wrapped stETH, about 1.2 stETH each), not stETH. Receive wstETH?");
    assert.equal(q.options[0]?.label, "Receive wstETH");
  });

  it("stETH on Base (wstETH listed there) asks as well", () => {
    const q = only(analyze(state({ kind: "swap", amount: exact("1"), from: "steth", to: "USDC", network: "base" }), CTX, FACTS));
    assert.equal(q.reason, "ASSET_LOOKALIKE");
    assert.deepEqual(q.options.map((option) => option.id), ["wstETH", "cancel"]);
  });

  it("bridged USDC.e asks about native USDC", () => {
    const q = only(analyze(state({ kind: "swap", amount: exact("1"), from: "usdce", to: "ETH", network: "arbitrum" }), CTX, FACTS));
    assert.equal(q.reason, "ASSET_LOOKALIKE");
    assert.equal(q.prompt, "Kletia lists USDC (the native token), not USDC.e. Use USDC?");
  });

  it("a plain typo on an EVM network asks ASSET_TYPO with the listed symbol suggested (D9's question)", () => {
    for (const [from, to, field] of [["ETH", "wethh", "actions[0].to"], ["wethh", "USDC", "actions[0].from"]] as const) {
      const q = only(analyze(state({ kind: "swap", amount: exact("0.01"), from, to, network: "base" }), CTX, FACTS));
      assert.equal(q.reason, "ASSET_TYPO", `${from} -> ${to}`);
      assert.equal(q.field, field);
      assert.equal(q.prompt, "Did you mean WETH?");
      assert.deepEqual(q.options.map((option) => option.id), ["WETH", "cancel"]);
      assert.equal(q.options.find((option) => option.recommended)?.id, "WETH");
    }
  });

  it("a close symbol on Solana asks on the spend side too (no correction chip)", () => {
    const analysis = analyze(state({ kind: "swap", amount: exact("1.5"), from: "SOLL", to: "USDC", network: "solana" }), CTX, FACTS);
    const q = only(analysis);
    assert.equal(q.reason, "ASSET_LOOKALIKE");
    assert.equal(q.field, "actions[0].from");
    assert.equal(q.prompt, "Did you mean SOL?");
    assert.deepEqual(q.options.map((option) => option.id), ["SOL"]);
    assert.equal(analysis.assumptions.some((entry) => entry.source === "correction"), false);
  });

  it("an unlisted look-alike (eETH) asks ASSET_LOOKALIKE with the listed token it is mistaken for, never a correction", () => {
    const q = only(analyze(state({ kind: "swap", amount: exact("1"), from: "eeth", to: "USDC", network: "ethereum" }), CTX, FACTS));
    assert.equal(q.reason, "ASSET_LOOKALIKE");
    assert.equal(q.prompt, "Kletia lists weETH (wrapped eETH, worth more than 1 eETH each), not eETH. Use weETH?");
    assert.deepEqual(q.options.map((option) => option.id), ["weETH", "cancel"]);
  });

  it("several close symbols that are not look-alikes still ask which one", () => {
    const q = only(analyze(state({ kind: "swap", amount: exact("1"), from: "usdq", to: "ETH", network: "base" }), CTX, FACTS));
    assert.ok(["ASSET_AMBIGUOUS", "ASSET_TYPO", "ASSET_LOOKALIKE"].includes(q.reason), q.reason);
  });

  it("listed symbols and renames are unchanged: wstETH reads as itself, MATIC as POL on a chip", () => {
    const listed = analyze(state({ kind: "swap", amount: exact("1"), from: "wstETH", to: "ETH", network: "ethereum" }), CTX, FACTS);
    assert.deepEqual(listed.resolved?.map((action) => [action.from, action.to]), [["wstETH", "ETH"]]);
    const renamed = analyze(state({ kind: "swap", amount: exact("1"), from: "MATIC", to: "USDC", network: "polygon" }), CTX, FACTS);
    assert.equal(renamed.questions.length, 0);
    assert.equal(renamed.resolved?.[0]?.from, "POL");
  });

  it("look-alike families pair members only, never plain typos", () => {
    assert.deepEqual(lookalikeOf("steth", "wstETH"), { typed: "stETH", note: "wrapped stETH, about 1.2 stETH each" });
    assert.deepEqual(lookalikeOf("USDC.e", "USDC"), { typed: "USDC.e", note: "the native token" });
    assert.deepEqual(lookalikeOf("bsol", "mSOL"), { typed: "bSOL" });
    assert.equal(lookalikeOf("wethh", "WETH"), null);
    assert.equal(lookalikeOf("SOLL", "SOL"), null);
    assert.equal(lookalikeOf("wstETH", "wstETH"), null);
    assert.equal(lookalikeOf("steth", "USDC"), null);
  });
});

describe("wSOL is asked, never read silently as native SOL (P2-M0)", () => {
  it("spending wsol asks ASSET_LOOKALIKE: Kletia spends native SOL", () => {
    const q = only(analyze(state({ kind: "swap", amount: exact("1"), from: "wsol", to: "USDC" }), CTX, FACTS));
    assert.equal(q.reason, "ASSET_LOOKALIKE");
    assert.equal(q.field, "actions[0].from");
    assert.equal(q.prompt, "Kletia spends native SOL; wSOL held in a token account is not used. Use SOL?");
    assert.deepEqual(q.options.map((option) => [option.id, option.label]), [["SOL", "Use SOL"], ["cancel", "Neither, cancel"]]);
    assert.equal(q.options.some((option) => option.recommended), false);
  });

  it("receiving wsol asks too: Kletia delivers native SOL", () => {
    const q = only(analyze(state({ kind: "swap", amount: exact("10"), from: "USDC", to: "WSOL", network: "solana" }), CTX, FACTS));
    assert.equal(q.reason, "ASSET_LOOKALIKE");
    assert.equal(q.field, "actions[0].to");
    assert.equal(q.prompt, "Kletia delivers native SOL, not wSOL in a token account. Receive SOL?");
  });

  it("a payment of wsol asks before anything is sent", () => {
    const q = only(analyze(state({ kind: "transfer", amount: exact("1"), from: "wsol", recipient: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" }), CTX, FACTS));
    assert.equal(q.reason, "ASSET_LOOKALIKE");
  });
});

/* ------------------------------------- the live prompts, end to end */

const corpus = loadCorpus(fileURLToPath(new URL("./fixtures/clarify-corpus.json", import.meta.url)));
const contextOf = (wallet: string) => contextFor(corpus, { id: "t", category: "test", title: "t", wallet, turns: [] } as unknown as CorpusCase);

after(() => uninstallWallet());

/** One turn with a corpus wallet ("wide" holds wstETH on Ethereum). */
async function say(thread: TurnDecision["thread"] | null, input: Parameters<typeof runTurn>[1], wallet = "full") {
  installWallet(corpus, wallet);
  return runTurn(thread, input, contextOf(wallet));
}

describe("the red-team prompts (Appendix 4, P2-M0 rows)", () => {
  it("\"bridge 100 usdc from base to arbitrum then deposit it into aave on base\" asks NETWORK_CONTRADICTION (P2-M1); each answer plans one network", async () => {
    const run = await say(null, { text: "bridge 100 usdc from base to arbitrum then deposit it into aave on base" });
    assert.ok(run.decision, run.error?.message);
    assert.equal(run.decision.status, "needs_input");
    const q = run.decision.questions[0];
    assert.equal(q?.reason, "NETWORK_CONTRADICTION");
    const follow = await say(run.decision.thread, { answer: { question: q?.id as string, option: "arbitrum" } });
    assert.equal(shape(follow.decision?.actions ?? []), "bridge@base->arbitrum 100 USDC | deposit@arbitrum max USDC [aave-v3]");
    const skip = await say(run.decision.thread, { answer: { question: q?.id as string, option: "skip" } });
    assert.equal(shape(skip.decision?.actions ?? []), "deposit@base 100 USDC [aave-v3]");
  });

  it("\"swap 1 steth to eth on ethereum\" asks ASSET_LOOKALIKE; choosing wstETH plans it, cancel ends the task", async () => {
    const first = await say(null, { text: "swap 1 steth to eth on ethereum" }, "wide");
    assert.ok(first.decision, first.error?.message);
    assert.equal(first.decision.status, "needs_input");
    const q = first.decision.questions[0];
    assert.equal(q?.reason, "ASSET_LOOKALIKE");
    assert.equal(first.decision.assumptions.some((entry) => entry.source === "correction"), false, "no correction chip");
    const chosen = await say(first.decision.thread, { answer: { question: q?.id as string, option: "wstETH" } }, "wide");
    assert.ok(chosen.decision, chosen.error?.message);
    assert.equal(chosen.decision.status, "ready");
    assert.equal(shape(chosen.decision.actions ?? []), "swap@ethereum 1 wstETH->ETH");
    const cancelled = await say(first.decision.thread, { answer: { question: q?.id as string, option: "cancel" } }, "wide");
    assert.equal(cancelled.decision?.status, "cancelled");
  });

  it("\"swap 1 wsol to usdc\" asks ASSET_LOOKALIKE; \"Use SOL\" plans native SOL", async () => {
    const first = await say(null, { text: "swap 1 wsol to usdc" });
    assert.ok(first.decision, first.error?.message);
    assert.equal(first.decision.status, "needs_input");
    const q = first.decision.questions[0];
    assert.equal(q?.reason, "ASSET_LOOKALIKE");
    assert.equal(q?.prompt, "Kletia spends native SOL; wSOL held in a token account is not used. Use SOL?");
    const chosen = await say(first.decision.thread, { answer: { question: q?.id as string, option: "SOL" } });
    assert.ok(chosen.decision, chosen.error?.message);
    assert.equal(chosen.decision.status, "ready");
    assert.equal(shape(chosen.decision.actions ?? []), "swap@solana 1 SOL->USDC");
  });

  it("\"swap 10 usdc to wsol\" asks instead of delivering native SOL silently", async () => {
    const run = await say(null, { text: "swap 10 usdc to wsol" });
    assert.ok(run.decision, run.error?.message);
    assert.equal(run.decision.status, "needs_input");
    assert.deepEqual(run.decision.questions.map((q) => [q.field, q.reason]), [["actions[0].to", "ASSET_LOOKALIKE"]]);
  });
});
