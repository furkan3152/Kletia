/**
 * Reader frames and binding (intent design A.2, package P4-M3): what each
 * side of a clause is, which network belongs to which asset, and what "it",
 * "them", "the rest", "N of it", "keep", "the same" and a trailing "?" bind
 * to. Every rule has its U2 / red-team example and at least three
 * paraphrases written for this test.
 *
 * - WP1: a DEX or bridge venue after on/in/via is a route constraint, never
 *   custody; a venue of both kinds takes its kind from the verb.
 * - C11: "my X" with no amount is all of it only for same-asset custody moves.
 * - AQ1 / RF3: asset-network words after a convert verb are the token; a
 *   token with one home network is spent or wanted there; a network attaches
 *   to the asset it follows; an ellipsis network is copied only where the
 *   token is listed.
 * - RF4 / F-1: "from base", "my base usdc", "using eth on arbitrum" say where
 *   the money is (`fundFrom`), not where a stake or deposit runs.
 * - AQ2: "N of it" is exactly N of the previous output's token, where it lands.
 * - AQ8, AQ10, AQ11: earn markers, "worth", funding phrases.
 * - RF8: lists of payments, "each", "the same", parallel lists refused.
 * - RF9: an in-message correction with exactly one target, confirmed.
 * - RF11: "keep N", "all my X except N", "keep the rest".
 * - A7: "it" / "them" / "the rest" after a payment to someone else, and "them"
 *   with several outputs, are never bound to a guess.
 * - WP2: "all my X" after another step is the holding, not the output.
 * - Questions (A1, A14): a trailing "?" or a yield question with an
 *   imperative is only a confirm of the solved plan; advice is refused.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { contextFor, installWallet, loadCorpus, runTurn, shape, uninstallWallet, type CorpusCase } from "../clarify/corpusHarness.js";
import type { TurnDecision } from "../clarify/index.js";
import { parseSentence } from "../clarify/slots.js";
import type { WorkStep } from "../clarify/types.js";
import { readGoals } from "../goal/index.js";
import { isPlatformError, type PlatformError } from "../../errors.js";

/* ------------------------------------------------------------ helpers */

const corpus = loadCorpus(fileURLToPath(new URL("./fixtures/clarify-corpus.json", import.meta.url)));
const contextOf = (wallet: string) => contextFor(corpus, { id: "t", category: "test", title: "t", wallet, turns: [] } as unknown as CorpusCase);

after(() => uninstallWallet());

/** One turn with a corpus wallet ("full": SOL and USDC on Solana, ETH and USDC on Base and Arbitrum). */
async function say(text: string, thread: TurnDecision["thread"] | null = null, wallet = "full") {
  installWallet(corpus, wallet);
  return runTurn(thread, { text }, contextOf(wallet));
}

function refusal(run: () => unknown): PlatformError {
  try {
    run();
  } catch (error) {
    if (isPlatformError(error)) return error;
    throw error;
  }
  assert.fail("expected a refusal");
}

const steps = (text: string): WorkStep[] => parseSentence(text, []).steps;
const one = (text: string): WorkStep => {
  const read = steps(text);
  assert.equal(read.length, 1, `${text}: ${JSON.stringify(read)}`);
  return read[0] as WorkStep;
};
/** A compact view of a step: kind, networks, tokens, amount, venue, recipient. */
function view(step: WorkStep): string {
  if (!step.kind && step.goal) return `goal:${step.goal.kind}`;
  const amount = step.amount?.v;
  const shown = !amount ? "?" : amount.t === "exact" ? amount.value : amount.t === "usd" ? `$${amount.value}` : `${amount.t}:${"bps" in amount ? amount.bps : ""}`;
  const network = step.network ? `@${step.network.v}` : "";
  const to = step.toNetwork ? `->${step.toNetwork.v}` : "";
  const fund = step.fundFrom ? ` from:${step.fundFrom.v}` : "";
  const tokens = `${step.from?.v.toUpperCase() ?? (step.usdFrom ? "$" : "?")}${step.to ? `>${step.to.v.toUpperCase()}` : ""}`;
  const venue = step.protocol ? ` [${step.protocol.v}]` : step.provider ? ` {${step.provider.v}}` : "";
  const recipient = step.recipient ? ` to ${step.recipient.v}` : "";
  return `${step.kind?.v}${network}${to} ${shown} ${tokens}${venue}${recipient}${fund}`;
}

/* ------------------------------------------------- WP1 venue categories */

describe("venue categories (WP1)", () => {
  for (const [text, expected] of [
    ["swap 1 sol to usdc on meteora", "swap 1 SOL>USDC [meteora]"],
    ["trade 50 usdc → eth on base on pancakeswap", "swap@base 50 USDC>ETH [pancakeswap-v3]"],
    ["swap 2 sol to usdc on jupiter", "swap 2 SOL>USDC [jupiter]"],
    ["swap 10 usdc to eth on base in uniswap", "swap@base 10 USDC>ETH [uniswap-v3]"],
    ["convert 1 sol into usdc at orca", "swap 1 SOL>USDC [orca]"],
  ] as const) {
    it(`"${text}" is a swap through the named DEX, never a deposit`, () => assert.equal(view(one(text)), expected));
  }

  it("a venue of both kinds takes its kind from the verb (jupiter: dex for swap, lending for deposit)", () => {
    const deposit = one("deposit 10 usdc on jupiter");
    assert.equal(deposit.kind?.v ?? deposit.goal?.op, "deposit");
    assert.equal(deposit.goal?.constraints.via, undefined);
    assert.equal(one("swap 10 usdc to sol on jupiter").protocol?.v, "jupiter");
  });

  it("a DEX named for a bridge is not read", () => {
    refusal(() => steps("bridge 10 usdc from base to arbitrum on uniswap"));
  });
});

/* ---------------------------------------- C11 possessive-whole limits */

describe("possessive-whole only for same-asset custody moves (C11)", () => {
  for (const text of ["turn my optimism usdt into usdc on base", "put my solana usdc into aave on base", "turn my base ETH into SOL on solana", "cash out my SOL", "dump my eth on base for usdc"]) {
    it(`"${text}" asks how much (no whole holding)`, () => {
      for (const step of steps(text).slice(0, 1)) {
        assert.equal(step.amount, undefined, view(step));
        assert.notEqual(step.possessive, true);
        if (step.goal) assert.notEqual(step.goal.spend.amount?.t, "max");
      }
    });
  }

  for (const text of ["stake my sol", "lend my usdc on arbitrum", "withdraw my usdc from aave on base", "move my arbitrum usdc to base"]) {
    it(`"${text}" keeps the whole holding (it stays the same asset, in the person's custody)`, () => {
      const step = steps(text)[0] as WorkStep;
      assert.ok(step.possessive === true || step.amount?.v.t === "position" || step.amount?.v.t === "balance", view(step));
    });
  }

  it("a payment of my X with no amount is never all of it", () => {
    for (const text of ["send my usdc to vitalik.eth on base", "pay toly.sns my sol", "bridge my usdc to arbitrum then send it to alice.eth"]) {
      const step = steps(text).find((entry) => entry.kind?.v === "transfer" && entry.amount?.v.t !== "previous");
      if (step) assert.equal(step.amount, undefined, `${text}: ${view(step)}`);
    }
  });
});

/* --------------------------------- AQ1 / RF3 networks and asset words */

describe("asset-network words and networks by adjacency (AQ1, RF3, F-1)", () => {
  for (const [text, expected] of [
    ["turn my base ETH into SOL on solana", "bridge@base->solana ? ETH>SOL"],
    ["swap 0.1 eth on base for sol on solana", "bridge@base->solana 0.1 ETH>SOL"],
    ["swap 50 usdc on arbitrum for sol on solana", "bridge@arbitrum->solana 50 USDC>SOL"],
    ["swap 200 usdc on base to eth on arbitrum", "bridge@base->arbitrum 200 USDC>ETH"],
    ["swap 0.05 eth on ethereum to usdc on polygon", "bridge@ethereum->polygon 0.05 ETH>USDC"],
    ["swap 100 usdc from base into sol", "bridge@base->solana 100 USDC>SOL"],
    ["turn 1 sol into eth on base", "bridge@solana->base 1 SOL>ETH"],
    ["get usdc on arbitrum using 1 sol", "bridge@solana->arbitrum 1 SOL>USDC"],
    ["get eth on arbitrum with 1 sol", "bridge@solana->arbitrum 1 SOL>ETH"],
    ["convert 30 usdc on polygon into jitosol", "bridge@polygon->solana 30 USDC>JITOSOL"],
  ] as const) {
    it(`"${text}" keeps both networks and the wanted token (a cross-network convert, never a plain bridge)`, () => assert.equal(view(one(text)), expected));
  }

  it("a network inferred from the token's only home carries the home-network rule", () => {
    const step = one("turn 1 sol into eth on base");
    assert.equal(step.network?.prov?.rule, "home-network");
  });

  it("one network for the whole convert still reads as a plain swap", () => {
    assert.equal(view(one("swap 1 eth on base to usdc on base")), "swap@base 1 ETH>USDC");
    assert.equal(view(one("swap 1 usdc to sol")), "swap 1 USDC>SOL");
  });

  it("an ellipsis network is copied only to pieces whose token is listed there", () => {
    const read = steps("swap 1 sol to usdc and 0.1 eth to usdc on base");
    assert.equal(read[0]?.network, undefined);
    assert.equal(read[1]?.network?.v, "base");
  });

  it("buy with a buy verb: the first network is the want side, the funding network the spend side (red-team A6)", () => {
    assert.equal(view(one("buy eth on base with usdc on arbitrum")), "bridge@arbitrum->base ? USDC>ETH");
  });
});

/* ------------------------------------------- RF4 fundFrom and venues */

describe("where the money is (RF4, fundFrom)", () => {
  for (const [text, expected] of [
    ["stake 0.2 eth from base with lido", "stake 0.2 ETH {lido} from:base"],
    ["stake 0.1 eth with rocket pool using eth on arbitrum", "stake 0.1 ETH {rocket-pool} from:arbitrum"],
    ["put 50 usdc in jupiter lend using my base usdc", "deposit 50 USDC [jupiter-lend] from:base"],
    ["deposit 20 usdc into kamino from arbitrum", "deposit 20 USDC [kamino] from:arbitrum"],
  ] as const) {
    // No network on the step: it runs where the venue is; the policy inserts the crossing from fundFrom (C.1 rule 2).
    it(`"${text}" runs at the venue and keeps where the money is`, () => assert.equal(view(one(text)), expected));
  }

  it("a venue on the said network runs there", () => {
    assert.equal(view(one("deposit 20 usdc from base into aave")), "deposit@base 20 USDC [aave-v3] from:base");
  });

  it("a trailing network after a venue belongs to that venue only (move a position)", () => {
    const [read] = readGoals("move my kamino position to aave on base");
    assert.equal(read?.goal.spend.from?.network, undefined);
    assert.equal(read?.goal.want.at?.network, "base");
  });

  it("plans the crossing end to end", async () => {
    const run = await say("stake 0.1 eth from base with lido");
    assert.ok(run.decision, run.error?.message);
    if (run.decision.status === "ready") assert.match(shape(run.decision.actions ?? []), /^bridge@base->ethereum .*\| stake@ethereum/u);
  });
});

/* ------------------------------------------------------ AQ2 N of it */

describe("N of it / them (AQ2)", () => {
  for (const [text, expected] of [
    ["swap 200 usdc to eth on base and bridge 0.05 of it to arbitrum", "bridge@base->arbitrum 0.05 ETH"],
    ["bridge 100 usdc from base to arbitrum and deposit 60 of them in aave", "deposit@arbitrum 60 USDC [aave-v3]"],
    ["swap 1 sol to usdc and then send 20 of it to carol.sns", "transfer@solana 20 USDC to carol.sns"],
    ["swap 1 sol to usdc, put 10 of it in kamino", "deposit@solana 10 USDC [kamino]"],
    ["swap 1 sol to usdc and after that send 10 usdc of it to carol.sns", "transfer@solana 10 USDC to carol.sns"],
  ] as const) {
    it(`"${text}" spends exactly that many of the previous output, where it lands`, () => {
      const read = steps(text);
      const last = read[read.length - 1] as WorkStep;
      assert.equal(view(last), expected);
      assert.ok(last.from?.by === "user" || last.from?.prov?.rule === "previous-output", JSON.stringify(last.from));
    });
  }

  it("a token that is not the previous output is refused", () => {
    const error = refusal(() => steps("swap 1 sol to usdc and send 10 eth of it to carol.sns"));
    assert.match(error.message, /delivers USDC/u);
  });

  it("an output whose network is unknown is not bound (the token is asked)", () => {
    const read = steps("swap 10 usdc to eth and bridge 0.05 of it to arbitrum");
    assert.equal(read[1]?.from, undefined);
  });

  it("N of a payment to someone else is refused", () => {
    refusal(() => steps("send 10 usdc to vitalik.eth on base and swap 5 of it to eth"));
  });
});

/* ------------------------------------------- AQ8 / AQ10 / AQ11 phrases */

describe("earn markers, worth, funding phrases (AQ8, AQ10, AQ11)", () => {
  it("an earn marker turns an acquire into earn", () => {
    for (const text of ["get me some yield on solana with 50 usdc", "get yield on base with 20 usdc", "get me interest on arbitrum with 30 usdc"]) {
      assert.equal(one(text).kind?.v, "deposit", text);
    }
  });

  it("\"<amount> <stable> worth of <token>\" is the exact frame (no order-only confirm)", () => {
    for (const text of ["buy 100 usdc worth of sol", "buy 50 usdt worth of eth on base", "get 20 usdc worth of sol"]) {
      const step = one(text);
      assert.equal(step.kind?.v, "swap", text);
      assert.notEqual(step.goalRead?.orderOnly, true, text);
    }
    // Without "worth" it stays the confirmed idiom.
    assert.equal(one("buy 100 usdc of eth on base").kind, undefined);
  });

  for (const [text, expected] of [
    ["i want sol on solana, pay with 100 usdc from base", "bridge@base->solana 100 USDC>SOL"],
    ["move 100 usdc from optimism to solana and receive sol", "bridge@optimism->solana 100 USDC>SOL"],
    ["use 50 usdc from arbitrum to buy sol", "bridge@arbitrum->solana 50 USDC>SOL"],
    ["i want my 1 sol as usdc on base", "bridge@solana->base 1 SOL>USDC"],
  ] as const) {
    it(`"${text}" attaches its funding phrase to the same step`, () => assert.equal(view(one(text)), expected));
  }

  it("\"use my solana usdc to buy eth on base\" asks how much (C11)", () => {
    const step = one("use my solana usdc to buy eth on base");
    assert.equal(step.amount, undefined);
  });
});

/* ------------------------------------------------ RF8 several payments */

describe("several payments (RF8, A13)", () => {
  it("a list of payments reads one payment per recipient", () => {
    assert.deepEqual(steps("send 3 usdc to vitalik.eth on base, 4 usdc to jesse.base.eth and 5 usdc to alice.eth on base").map(view), [
      "transfer@base 3 USDC to vitalik.eth",
      "transfer@base 4 USDC to jesse.base.eth",
      "transfer@base 5 USDC to alice.eth",
    ]);
    assert.deepEqual(steps("pay toly.sns 0.1 sol and vitalik.eth 1 usdc on base").map(view), ["transfer 0.1 SOL to toly.sns", "transfer@base 1 USDC to vitalik.eth"]);
  });

  it("\"N each to A and B\" is N per recipient (stated)", () => {
    for (const text of ["send 10 usdc each to alice.eth and bob.base.eth on base", "send 10 usdc to alice.eth and bob.base.eth each on base", "pay 10 usdc to alice.eth and bob.base.eth apiece on base"]) {
      const read = steps(text);
      assert.deepEqual(read.map(view), ["transfer@base 10 USDC to alice.eth", "transfer@base 10 USDC to bob.base.eth"], text);
      assert.equal(read[0]?.amount?.prov?.rule, "deliverEach");
    }
  });

  it("one amount for two recipients without \"each\" is refused (never split or doubled by a guess)", () => {
    for (const text of ["send 10 usdc to alice.eth and bob.base.eth", "pay 5 usdc to vitalik.eth and toly.sns", "send 1 sol to toly.sns and carol.sns"]) {
      assert.match(refusal(() => steps(text)).message, /each/u, text);
    }
  });

  it("parallel lists are refused (A13)", () => {
    for (const text of ["send alice.eth and bob.eth 10 and 20 usdc", "pay toly.sns and carol.sns 1 and 2 sol", "send vitalik.eth and alice.eth 5 and 6 usdc on base"]) {
      assert.match(refusal(() => steps(text)).message, /pair/u, text);
    }
  });

  it("\"the same to bob\" copies the payment before, confirmed (source C)", () => {
    const read = steps("send 10 usdc to alice.eth on base and the same to bob.base.eth");
    assert.equal(view(read[1] as WorkStep), "transfer@base 10 USDC to bob.base.eth");
    assert.equal(read[1]?.source, "C");
    assert.equal(read[1]?.amount?.prov?.rule, "same-as-previous");
  });

  it("\"the same\" to a recipient of the other family leaves its network open", () => {
    const read = steps("send 10 usdc to alice.eth on base and the same to toly.sns");
    assert.equal(read[1]?.network, undefined);
  });

  it("\"the same\" after a step that is not a payment is not read", () => {
    refusal(() => steps("swap 1 sol to usdc and the same to bob.base.eth"));
  });
});

/* -------------------------------------- RF9 in-message corrections */

describe("in-message corrections (RF9, red-team A12)", () => {
  for (const [text, value] of [
    ["swap 2 sol to usdc, no wait, 3 sol", "3"],
    ["swap 1 sol to usdc. actually make it 0.5", "0.5"],
    ["swap 1 sol to usdc, sorry i meant 2", "2"],
  ] as const) {
    it(`"${text}" applies the one amount it can change, confirmed`, () => {
      const step = one(text);
      assert.equal(step.amount?.v.t === "exact" ? step.amount.v.value : null, value);
      assert.equal(step.source, "C");
      assert.ok(step.readAs?.some((item) => item.rule === "correction:inMessage"));
    });
  }

  it("a network correction with one network", () => {
    assert.equal(one("deposit 10 usdc into aave on base, sorry i meant arbitrum").network?.v, "arbitrum");
  });

  it("a recipient correction with one recipient", () => {
    assert.equal(one("send 5 usdc to alice.eth on base, actually bob.base.eth").recipient?.v, "bob.base.eth");
  });

  it("two possible targets are refused", () => {
    for (const text of ["swap 2 sol to usdc and send 1 to alice.eth. actually make it 0.5", "bridge 10 usdc from base to arbitrum, sorry i meant optimism"]) {
      assert.match(refusal(() => steps(text)).message, /which/u, text);
    }
  });
});

/* ------------------------------------------------ RF11 keep / except */

describe("keep and except (RF11)", () => {
  it("\"all my X except N\" is all but N, wherever the number is said", () => {
    for (const text of ["swap all my sol except 2 to usdc", "swap all of my sol but 2 to usdc", "sell everything my sol except 1 for usdc"]) {
      const step = steps(text)[0] as WorkStep;
      assert.equal(step.goal?.spend.amount?.t, "allBut", text);
    }
  });

  it("\"... and keep 20 usdc\" limits the step", () => {
    const step = one("swap 100 usdc to eth on base and keep 20 usdc");
    assert.deepEqual(step.keep, [{ amount: { t: "exact", value: "20" }, asset: "USDC" }]);
  });

  it("\"keep N <token> and swap the rest\": all of that token but N (a token keeps it on the step)", () => {
    const step = one("keep 50 usdc on base and swap the rest to eth");
    assert.equal(step.amount?.v.t, "balance");
    assert.deepEqual(step.keep, [{ amount: { t: "exact", value: "50" }, asset: "USDC", network: "base" }]);
    assert.equal(step.source, "C");
  });

  it("a native token kept for gas asks the amount (the fee reserve is not counted twice)", () => {
    const step = one("keep 0.05 eth on base for gas and swap the rest to usdc");
    assert.equal(step.amount, undefined);
    assert.equal(step.from?.v.toUpperCase(), "ETH");
  });

  it("\"keep N and deposit the rest\" after a step asks how much, with the token bound", () => {
    const read = steps("bridge 200 usdc from base to arbitrum, keep 50 and deposit the rest into aave");
    assert.equal(read[1]?.amount, undefined);
    assert.equal(read[1]?.from?.v.toUpperCase(), "USDC");
    assert.equal(read[1]?.network?.v, "arbitrum");
  });

  it("\"keep the rest\" after an exact amount is nothing to do; anywhere else it is refused", () => {
    assert.equal(steps("bridge 30 usdc from arbitrum to base and swap 10 of them to eth and keep the rest").length, 2);
    refusal(() => steps("keep the rest and swap 1 sol to usdc"));
  });

  it("two keeps are refused", () => {
    refusal(() => steps("keep 1 sol and keep 2 usdc and swap the rest to eth"));
  });
});

/* ------------------------------- A7 third-party binding, WP2 holding */

describe("binding after a payment and with several outputs (A7, WP2)", () => {
  for (const text of [
    "send 10 usdc to vitalik.eth on base and swap it to eth",
    "pay alice.eth 10 usdc on base and deposit the rest into aave on base",
    "send 1 sol to toly.sns then stake it with jito",
  ]) {
    it(`"${text}" never spends money paid to someone else`, () => assert.match(refusal(() => steps(text)).message, /pays someone else/u));
  }

  for (const text of [
    "swap 1 sol to usdc and 1 sol to usdt then send them to toly.sns",
    "swap 1 sol to usdc and 0.1 eth to usdc on base, then bridge both to arbitrum",
    "swap 1 sol to usdc and 2 sol to jitosol, then send all of them to carol.sns",
  ]) {
    it(`"${text}": a plural reference with several outputs is refused`, () => assert.match(refusal(() => steps(text)).message, /does not guess/u));
  }

  it("\"them\" with one output binds it", () => {
    assert.equal(steps("swap 1 sol to usdc then send them to toly.sns")[1]?.amount?.v.t, "previous");
  });

  it("\"the rest\" paid to someone else after an own step is asked (I13)", () => {
    const read = steps("swap 1 sol to usdc and deposit 10 into kamino and send the rest to carol.sns");
    assert.equal(read[2]?.amount, undefined);
  });

  it("\"sell 1 sol, then stake the rest\" stakes the rest of the SOL, never the sale's stablecoin", () => {
    const read = steps("sell 1 sol, then stake the rest");
    const stake = read[1] as WorkStep;
    assert.equal(stake.from?.v, "SOL");
    assert.equal(stake.amount?.v.t, "balance");
    assert.deepEqual(stake.keep, [{ amount: { t: "exact", value: "1" }, asset: "SOL" }]);
    assert.equal(stake.source, "C");
  });

  it("\"all my X\" after another step is the holding (WP2)", () => {
    for (const text of ["swap all my sol to usdc and stake all my sol with jito", "swap 1 sol to usdc and deposit all my usdc into kamino", "bridge 10 usdc from base to arbitrum then swap half my eth to usdc on arbitrum"]) {
      const last = steps(text).at(-1) as WorkStep;
      assert.equal(last.amount?.v.t, "balance", text);
    }
  });
});

/* -------------------------------------------- questions (A1, A14) */

describe("questions and commands (A1, A14)", () => {
  for (const text of ["swap 0.01 eth to usdc on base?", "can you swap 1 sol to usdc?", "could you bridge 20 usdc from base to arbitrum?", "send 5 usdc to vitalik.eth on base??"]) {
    it(`"${text}" is read only as a confirm of the solved plan`, async () => {
      for (const step of steps(text)) assert.equal(step.questionForm, true);
      const run = await say(text);
      assert.ok(run.decision, run.error?.message);
      assert.notEqual(run.decision.status, "ready");
    });
  }

  for (const text of ["should i swap 1 eth to usdc on base?", "would swapping 1 sol to usdc be a good idea?", "what if i bridge 10 usdc from base to solana?", "is it safe to deposit into morpho?"]) {
    it(`"${text}" (advice or hypothetical) is refused`, () => assert.equal(refusal(() => steps(text)).code, "INTENT_UNSUPPORTED"));
  }

  it("a goal only the solver can place keeps the refusal (its expansion does not carry the confirm yet)", () => {
    for (const text of ["exit my aave position?", "swap all but 0.1 sol to usdc?", "consolidate my usdc on base?"]) refusal(() => steps(text));
  });

  it("a yield question with an imperative is a deposit into the best-ranked venue, confirmed", () => {
    for (const text of ["what's the best yield for my usdc? put it there", "what's the best yield for my usdc on base? put it there", "best yield for 200 usdc on arbitrum, go"]) {
      const step = one(text);
      assert.equal(step.kind?.v, "deposit", text);
      assert.equal(step.questionForm, true, text);
    }
  });

  it("the imperative must pass the never-drop check (A14)", () => {
    for (const text of ["what's the best yield for my usdc? don't put it there yet", "what's the best yield for my usdc? put it there tomorrow", "what's the best yield for my usdc? maybe put it there"]) {
      assert.equal(refusal(() => steps(text)).code, "INTENT_UNSUPPORTED", text);
    }
  });

  it("\"what is the cheapest way to <command>\" reads the command, confirmed", () => {
    const step = one("what's the cheapest way to send 50 usdc to alice.eth on base?");
    assert.equal(step.kind?.v, "transfer");
    assert.equal(step.questionForm, true);
  });

  it("a rate question keeps its read-only answer", () => {
    const error = refusal(() => steps("what's the best yield for usdc on base?"));
    assert.equal((error.details as { readOnly?: string } | undefined)?.readOnly, "venues");
  });
});
