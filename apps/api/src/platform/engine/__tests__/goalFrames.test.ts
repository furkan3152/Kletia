/**
 * The Goal reader's frames and lowering: every casual, terse, goal and
 * multi line of the intent eval corpus read as Goals (F1-F9), extra
 * phrases for the connectors and the fail-closed cases, the lowering of
 * one-to-one Goals into clarify slots, and the reader's acceptance bar
 * (casual, terse and multi at least 90% correct; the refuse family never
 * plans; every ready turn round-trips through the grammar).
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { validateGoal, type Goal, type Place } from "@kletia/core";
import { configureHoldingsReaders } from "../holdings.js";
import { configurePriceReader } from "../prices.js";
import { parseSentence } from "../clarify/slots.js";
import type { WorkStep } from "../clarify/types.js";
import { contextFor, installWallet, roundTripDifferences, runTurn, type CorpusCase } from "../clarify/corpusHarness.js";
import { classifyResult, evalPriceReader, loadEvalFixtures, loadIntentEval, runIntentEval } from "../goal/evalHarness.js";
import { configureGoalSteps, readGoals } from "../goal/index.js";

const evalPath = fileURLToPath(new URL("./fixtures/intent-eval.json", import.meta.url));
const corpus = loadIntentEval(evalPath);
const fixtures = loadEvalFixtures(evalPath, corpus);

after(() => {
  configureHoldingsReaders(null);
  configurePriceReader(null);
  configureGoalSteps(null);
});

function place(at: Place | undefined): string | undefined {
  if (!at) return undefined;
  const custody = at.custody.kind === "wallet" ? "" : at.custody.kind === "venue" ? `venue:${at.custody.protocol ?? ""}:${at.custody.category ?? ""}` : `position:${at.custody.protocol ?? ""}`;
  return [at.network ?? "", custody].filter(Boolean).join(" ") || "wallet";
}

/** A compact view of a Goal: kind/op spend[amount asset @place] want[...] holder via prefer after. */
function compact(goal: Goal): string {
  const asset = (sel: Goal["spend"]["asset"]) => (sel ? ("symbol" in sel ? sel.symbol : `~${sel.class}`) : undefined);
  const amount = (sel: Goal["spend"]["amount"]) =>
    sel ? (sel.t === "exact" || sel.t === "usd" ? `${sel.t}:${sel.value}` : sel.t === "portion" ? `portion:${sel.bps}` : sel.t === "allBut" ? `allBut:${sel.keep}` : sel.t) : undefined;
  const side = (sel: Goal["spend"]["amount"], sym: Goal["spend"]["asset"], at: Place | undefined) =>
    [amount(sel), asset(sym), at ? `@${place(at)}` : undefined].filter(Boolean).join(" ");
  const parts = [goal.kind + (goal.op ? `/${goal.op}` : ""), `spend[${side(goal.spend.amount, goal.spend.asset, goal.spend.from)}]`, `want[${side(goal.want.amount, goal.want.asset, goal.want.at)}]`];
  if (goal.holder.t !== "self") parts.push(`holder:${goal.holder.t}${"value" in goal.holder ? `=${goal.holder.value}` : ""}`);
  if (goal.constraints.via) parts.push(`via:${goal.constraints.via.join(",")}`);
  if (goal.constraints.prefer) parts.push(`prefer:${goal.constraints.prefer}`);
  if (goal.chain) parts.push(`after:${goal.chain.after}`);
  return parts.join(" ");
}

function readAll(say: string): (string | null)[] {
  return readGoals(say).map((read) => (read ? compact(read.goal) + (read.notes.orderOnly ? " [order]" : "") + (read.notes.possessive ? " [mine]" : "") : null));
}

/** [message, the Goal of each piece (null: the frames refuse the piece)]. The first block is every casual, terse, goal and multi corpus line. */
const FRAMES: readonly (readonly [string, readonly (string | null)[]])[] = [
  ["can you swap 1 SOL to USDC for me?", ["convert/swap spend[exact:1 SOL] want[USDC]"]],
  ["pls swap 1 sol into usdc", ["convert/swap spend[exact:1 sol] want[usdc]"]],
  ["i wanna swap 1 SOL for some USDC", ["convert/swap spend[exact:1 SOL] want[USDC]"]],
  ["I'd like to convert 1 SOL to USDC please", ["convert/swap spend[exact:1 SOL] want[USDC]"]],
  ["trade 1 SOL for USDC", ["convert/swap spend[exact:1 SOL] want[USDC]"]],
  ["exchange 1 SOL to USDC", ["convert/swap spend[exact:1 SOL] want[USDC]"]],
  ["turn 1 SOL into USDC", ["convert spend[exact:1 SOL] want[USDC]"]],
  ["change 1 SOL to USDC", ["convert spend[exact:1 SOL] want[USDC]"]],
  ["sell 1 SOL for USDC", ["convert/swap spend[exact:1 SOL] want[USDC]"]],
  ["sell 1 SOL", ["convert/swap spend[exact:1 SOL] want[]"]],
  ["buy USDC with 1 SOL", ["convert/swap spend[exact:1 SOL] want[USDC]"]],
  ["hey could you move 25 USDC from base over to solana", ["relocate spend[exact:25 USDC @base] want[@solana]"]],
  ["move 25 USDC from base to solana", ["relocate spend[exact:25 USDC @base] want[@solana]"]],
  ["transfer 25 USDC from base to solana", ["relocate spend[exact:25 USDC @base] want[@solana]"]],
  ["send 25 USDC from base to solana", ["relocate spend[exact:25 USDC @base] want[@solana]"]],
  ["ship 10 USDC from arbitrum to base", ["relocate spend[exact:10 USDC @arbitrum] want[@base]"]],
  ["get 10 USDC from arbitrum onto base", ["relocate spend[@arbitrum] want[exact:10 USDC @base]"]],
  ["port 10 USDC over from arbitrum to base", ["relocate/bridge spend[exact:10 USDC @arbitrum] want[@base]"]],
  ["I need to bridge 10 usdc arb to base", ["relocate/bridge spend[exact:10 usdc @arbitrum] want[@base]"]],
  ["yo send vitalik.eth 5 USDC on optimism", ["deliver/transfer spend[exact:5 USDC @optimism] want[@optimism] holder:name=vitalik.eth"]],
  ["pay jesse.base.eth 5 USDC", ["deliver/transfer spend[exact:5 USDC] want[] holder:name=jesse.base.eth"]],
  ["give toly.sns 0.1 SOL", ["deliver/transfer spend[exact:0.1 SOL] want[] holder:name=toly.sns"]],
  ["tip toly.sns 0.05 SOL", ["deliver/transfer spend[exact:0.05 SOL] want[] holder:name=toly.sns"]],
  ["put 100 USDC in aave on base", ["earn/deposit spend[exact:100 USDC @base] want[@base venue:aave-v3:lending]"]],
  ["lend 100 USDC on aave base", ["earn/deposit spend[exact:100 USDC @base] want[@base venue:aave-v3:lending]"]],
  ["supply 100 USDC to aave on base", ["earn/deposit spend[exact:100 USDC @base] want[@base venue:aave-v3:lending]"]],
  ["park 50 USDC in morpho on base", ["earn/deposit spend[exact:50 USDC @base] want[@base venue:morpho:lending]"]],
  ["earn yield on 100 USDC in aave on base", ["earn spend[exact:100 USDC @base] want[@base venue:aave-v3:lending]"]],
  ["take 50 USDC out of aave on base", ["exit spend[exact:50 USDC @base position:aave-v3] want[]"]],
  ["pull my 50 USDC out of aave on base", ["exit spend[exact:50 USDC @base position:aave-v3] want[]"]],
  ["redeem 50 USDC from aave on base", ["exit/withdraw spend[exact:50 USDC @base position:aave-v3] want[]"]],
  ["liquid stake 1 SOL with jito", ["earn/stake spend[exact:1 SOL] want[@venue:jito:staking]"]],
  ["stake 1 SOL for JitoSOL", ["earn/stake spend[exact:1 SOL] want[JitoSOL]"]],
  ["convert 1 SOL to jitosol", ["convert/swap spend[exact:1 SOL] want[jitosol]"]],
  ["Swap 1 SOL to USDC.", ["convert/swap spend[exact:1 SOL] want[USDC]"]],
  ["SWAP 1 SOL TO USDC", ["convert/swap spend[exact:1 SOL] want[USDC]"]],
  ["swap   1   SOL   to   USDC", ["convert/swap spend[exact:1 SOL] want[USDC]"]],
  ["please, swap 1 SOL to USDC on solana, thanks!", ["convert/swap spend[exact:1 SOL @solana] want[USDC @solana]"]],
  ["swap one SOL to USDC", ["convert/swap spend[exact:1 SOL] want[USDC]"]],
  ["swap ten USDC to SOL", ["convert/swap spend[exact:10 USDC] want[SOL]"]],
  ["bridge twenty five USDC from base to solana", ["relocate/bridge spend[exact:25 USDC @base] want[@solana]"]],
  ["1 sol -> usdc", ["convert spend[exact:1 sol] want[usdc]"]],
  ["1 SOL to USDC", ["convert spend[exact:1 SOL] want[USDC]"]],
  ["sol to usdc 1", ["convert spend[exact:1 sol] want[usdc]"]],
  ["1 sol for usdc", ["convert spend[exact:1 sol] want[usdc]"]],
  ["25 usdc base -> solana", ["relocate spend[exact:25 usdc @base] want[@solana]"]],
  ["25 usdc base to sol", ["relocate spend[exact:25 usdc @base] want[@solana]"]],
  ["25 usdc from base to arb", ["relocate spend[exact:25 usdc @base] want[@arbitrum]"]],
  ["usdc base>arb 25", ["relocate spend[exact:25 usdc @base] want[@arbitrum]"]],
  ["10 usdc arb→base", ["relocate spend[exact:10 usdc @arbitrum] want[@base]"]],
  ["5 usdc -> vitalik.eth op", ["deliver/transfer spend[exact:5 usdc @optimism] want[@optimism] holder:name=vitalik.eth"]],
  ["0.1 sol > toly.sns", ["deliver/transfer spend[exact:0.1 sol] want[] holder:name=toly.sns"]],
  ["aave 100 usdc base", ["earn spend[exact:100 usdc @base] want[@base venue:aave-v3:lending]"]],
  ["100 usdc -> aave", ["earn spend[exact:100 usdc] want[@venue:aave-v3:lending]"]],
  ["stake 1 sol", ["earn/stake spend[exact:1 sol] want[]"]],
  ["1 sol jito", ["earn spend[exact:1 sol] want[@venue:jito:staking]"]],
  ["swap sol usdc 1", ["convert/swap spend[exact:1 sol] want[usdc] [order]"]],
  ["eth->usdc 0.01 base", ["convert spend[exact:0.01 eth @base] want[usdc @base]"]],
  ["swap .5 sol to usdc", ["convert/swap spend[exact:0.5 sol] want[usdc]"]],
  ["swap 1.0 SOL to usdc", ["convert/swap spend[exact:1.0 SOL] want[usdc]"]],
  ["bridge 1,000 usdc base to solana", ["relocate/bridge spend[exact:1000 usdc @base] want[@solana]"]],
  ["put my USDC to work", ["earn/deposit spend[max USDC] want[] [mine]"]],
  ["earn yield on my idle USDC", ["earn spend[max USDC] want[] [mine]"]],
  ["earn yield on my USDC on base", ["earn spend[max USDC @base] want[@base] [mine]"]],
  ["make my USDC earn something", ["earn spend[max USDC] want[] [mine]"]],
  ["what's the best yield for my USDC? put it there", [null]],
  ["park my stables somewhere safe with yield", ["earn/deposit spend[max ~usd-stable] want[@venue::any] [mine]"]],
  ["earn on my SOL", ["earn spend[max SOL] want[] [mine]"]],
  ["make my SOL earn yield", ["earn spend[max SOL] want[] [mine]"]],
  ["stake my SOL", ["earn/stake spend[max SOL] want[] [mine]"]],
  ["stake my ETH", ["earn/stake spend[max ETH] want[] [mine]"]],
  ["get me 1 ETH on Base", ["acquire spend[] want[exact:1 ETH @base]"]],
  ["get me 0.01 ETH on arbitrum", ["acquire spend[] want[exact:0.01 ETH @arbitrum]"]],
  ["I want 100 USDC on Solana", ["acquire spend[] want[exact:100 USDC @solana]"]],
  ["I need 20 USDC on arbitrum", ["acquire spend[] want[exact:20 USDC @arbitrum]"]],
  ["I need USDC on polygon", ["acquire spend[] want[USDC @polygon]"]],
  ["get gas on Arbitrum", ["acquire spend[] want[~gas @arbitrum]"]],
  ["I need gas on optimism", ["acquire spend[] want[~gas @optimism]"]],
  ["top up gas on polygon", ["fuel spend[] want[~gas @polygon]"]],
  ["fund my polygon wallet with 5 USDC", ["relocate spend[exact:5 USDC] want[@polygon]"]],
  ["fund my arbitrum wallet with 20 USDC", ["relocate spend[exact:20 USDC] want[@arbitrum]"]],
  ["fund my sol wallet with 5 USDC", ["relocate spend[exact:5 USDC] want[@solana]"]],
  ["fund my arbitrum wallet", ["acquire spend[] want[@arbitrum]"]],
  ["rent: send 50 USDC to 0x1111111111111111111111111111111111111111 on base", ["deliver/transfer spend[exact:50 USDC @base] want[@base] holder:address=0x1111111111111111111111111111111111111111"]],
  ["groceries: pay 20 USDC to vitalik.eth on base", ["deliver/transfer spend[exact:20 USDC @base] want[@base] holder:name=vitalik.eth"]],
  ["bob: send 5 USDC", ["deliver spend[exact:5 USDC] want[]"]],
  ["on base: swap 1 ETH to USDC", [null]],
  ["put 30% of my SOL into USDC", ["convert spend[portion:3000 SOL] want[USDC]"]],
  ["put my SOL to work into USDC", [null]],
  ["I want mSOL", ["acquire spend[] want[mSOL]"]],
  ["consolidate to Base", ["consolidate spend[] want[@base]"]],
  ["consolidate all my USDC on base", ["consolidate spend[max USDC @base] want[@base]"]],
  ["move everything to base", ["consolidate spend[max] want[@base]"]],
  ["move everything from Solana to Arbitrum and earn yield", ["consolidate spend[max @solana] want[@arbitrum]","earn spend[previous] want[] after:0"]],
  ["move all my USDC from solana to base and put it in aave", ["relocate spend[max USDC @solana] want[@base]","earn/deposit spend[previous] want[@venue:aave-v3:lending] after:0"]],
  ["move my arbitrum USDC to base and earn yield", ["relocate spend[max USDC @arbitrum] want[@base] [mine]","earn spend[previous] want[] after:0"]],
  ["cash out my SOL", ["convert spend[max SOL] want[] [mine]"]],
  ["sell all my SOL", ["convert/swap spend[max SOL] want[]"]],
  ["dump my ETH on base for USDC", ["convert spend[max ETH @base] want[USDC @base] [mine]"]],
  ["go all in on SOL", ["convert spend[] want[SOL]"]],
  ["convert all my stablecoins to USDC", ["convert/swap spend[max ~usd-stable] want[USDC]"]],
  ["get rid of my USDbC", ["convert spend[max USDbC] want[] [mine]"]],
  ["I want JitoSOL", ["acquire spend[] want[JitoSOL]"]],
  ["get me some JitoSOL with half my SOL", ["convert spend[portion:5000 SOL] want[JitoSOL]"]],
  ["I want to hold ETH instead of USDC on base", ["convert spend[USDC @base] want[ETH @base]"]],
  ["exit my aave position", ["exit spend[max @position:aave-v3] want[] [mine]"]],
  ["close my aave position on base", ["exit spend[max @base position:aave-v3] want[] [mine]"]],
  ["take everything out of aave", ["exit spend[max @position:aave-v3] want[]"]],
  ["move my aave USDC to morpho", ["exit spend[max USDC @position:aave-v3] want[@venue:morpho:lending] [mine]"]],
  ["move my aave position into the best yield on base", ["exit spend[max @base position:aave-v3] want[@base venue::any] [mine]"]],
  ["pay vitalik.eth 5 USDC from whatever network is cheapest", ["deliver/transfer spend[exact:5 USDC] want[] holder:name=vitalik.eth prefer:cheapest"]],
  ["send 20 USDC to toly.sns", ["deliver/transfer spend[exact:20 USDC] want[] holder:name=toly.sns"]],
  ["send 10 USDC to toly.sns from base", ["deliver/transfer spend[exact:10 USDC @base] want[] holder:name=toly.sns"]],
  ["get 50 USDC on base from solana", ["relocate spend[@solana] want[exact:50 USDC @base]"]],
  ["get 10 USDC on base from solana", ["relocate spend[@solana] want[exact:10 USDC @base]"]],
  ["rebalance: half my USDC on base, half on arbitrum", [null]],
  ["save gas: what is cheapest way to get USDC onto solana", [null]],
  ["zap 50 USDC from arbitrum into morpho on base", ["earn spend[exact:50 USDC @arbitrum] want[@base venue:morpho:lending]"]],
  ["zap 20 USDC from arbitrum into morpho on base", ["earn spend[exact:20 USDC @arbitrum] want[@base venue:morpho:lending]"]],
  ["earn yield on 100 USDC", ["earn spend[exact:100 USDC] want[]"]],
  ["put 10 USDC to work on solana", ["earn/deposit spend[exact:10 USDC @solana] want[@solana]"]],
  ["lend my USDC on arbitrum", ["earn/deposit spend[max USDC @arbitrum] want[@arbitrum] [mine]"]],
  ["I want exposure to ETH with 50 USDC", ["convert spend[exact:50 USDC] want[ETH]"]],
  ["diversify: put 30% of my SOL into USDC", ["convert spend[portion:3000 SOL] want[USDC]"]],
  ["hedge half my SOL into stables", ["convert spend[portion:5000 SOL] want[~usd-stable]"]],
  ["withdraw my USDC from aave and send it to vitalik.eth", ["exit/withdraw spend[max USDC @position:aave-v3] want[] [mine]","deliver/transfer spend[previous] want[] holder:name=vitalik.eth after:0"]],
  ["swap 1 SOL to USDC and bridge it to base", ["convert/swap spend[exact:1 SOL] want[USDC]","relocate/bridge spend[previous] want[@base] after:0"]],
  ["swap 1 SOL to USDC, bridge to base, deposit into aave", ["convert/swap spend[exact:1 SOL] want[USDC]","relocate/bridge spend[previous] want[@base] after:0","earn/deposit spend[previous] want[@venue:aave-v3:lending] after:1"]],
  ["bridge 20 USDC from solana to base and deposit it into aave", ["relocate/bridge spend[exact:20 USDC @solana] want[@base]","earn/deposit spend[previous] want[@venue:aave-v3:lending] after:0"]],
  ["bridge 10 USDC from solana to base and deposit it into aave", ["relocate/bridge spend[exact:10 USDC @solana] want[@base]","earn/deposit spend[previous] want[@venue:aave-v3:lending] after:0"]],
  ["swap 10 USDC to SOL on solana, then stake it with jito", ["convert/swap spend[exact:10 USDC @solana] want[SOL @solana]","earn/stake spend[previous] want[@venue:jito:staking] after:0"]],
  ["withdraw all USDC from aave on base then bridge it to solana", ["exit/withdraw spend[max USDC @base position:aave-v3] want[]","relocate/bridge spend[previous] want[@solana] after:0"]],
  ["swap 1 SOL to USDC and send it to vitalik.eth", ["convert/swap spend[exact:1 SOL] want[USDC]","deliver/transfer spend[previous] want[] holder:name=vitalik.eth after:0"]],
  ["send 5 USDC to vitalik.eth and 5 USDC to jesse.base.eth on base", ["deliver/transfer spend[exact:5 USDC] want[] holder:name=vitalik.eth","deliver/transfer spend[exact:5 USDC @base] want[@base] holder:name=jesse.base.eth"]],
  ["swap 0.5 SOL to USDC and 0.5 SOL to JitoSOL", ["convert/swap spend[exact:0.5 SOL] want[USDC]","convert/swap spend[exact:0.5 SOL] want[JitoSOL]"]],
  ["bridge 10 USDC from base to arbitrum and 10 USDC from base to optimism", ["relocate/bridge spend[exact:10 USDC @base] want[@arbitrum]","relocate/bridge spend[exact:10 USDC @base] want[@optimism]"]],
  ["first swap 1 SOL to USDC, after that bridge it to arbitrum", ["convert/swap spend[exact:1 SOL] want[USDC]","relocate/bridge spend[previous] want[@arbitrum] after:0"]],
  ["swap 1 SOL to USDC; bridge it to base", ["convert/swap spend[exact:1 SOL] want[USDC]","relocate/bridge spend[previous] want[@base] after:0"]],
  ["swap 1 SOL to USDC. Then bridge the USDC to base.", ["convert/swap spend[exact:1 SOL] want[USDC]","relocate/bridge spend[previous USDC] want[@base] after:0"]],
  ["swap 1 SOL to USDC and then put it in kamino", ["convert/swap spend[exact:1 SOL] want[USDC]","earn/deposit spend[previous] want[@venue:kamino:lending] after:0"]],
  ["bridge 25 USDC from base to solana and swap it to SOL", ["relocate/bridge spend[exact:25 USDC @base] want[@solana]","convert/swap spend[previous] want[SOL] after:0"]],
  ["bridge 25 USDC to solana and buy SOL with it", ["relocate/bridge spend[exact:25 USDC] want[@solana]","convert/swap spend[previous] want[SOL] after:0"]],
  ["take my USDC out of aave, bridge to arbitrum and deposit into compound", ["exit spend[max USDC @position:aave-v3] want[] [mine]","relocate/bridge spend[previous] want[@arbitrum] after:0","earn/deposit spend[previous] want[@venue:compound-v3:lending] after:1"]],
  ["swap 10 USDC to ETH on base and bridge the ETH to arbitrum", ["convert/swap spend[exact:10 USDC @base] want[ETH @base]","relocate/bridge spend[previous ETH] want[@arbitrum] after:0"]],
  ["bridge 10 USDC from base to arbitrum, swap half to ETH", ["relocate/bridge spend[exact:10 USDC @base] want[@arbitrum]","convert/swap spend[portion:5000] want[ETH]"]],
  ["swap 1 SOL to USDC and deposit 5 USDC into kamino", ["convert/swap spend[exact:1 SOL] want[USDC]","earn/deposit spend[exact:5 USDC] want[@venue:kamino:lending]"]],
  // Connectors, recipients, venues and references beyond the corpus; then the fail-closed cases.
  ["swap 1 SOL to USDC instead of holding it", [null]],
  ["swap USDC to SOL instead of USDT", [null]],
  ["hold SOL instead of USDC", ["convert spend[USDC] want[SOL]"]],
  ["send 5 USDC to 0x1111111111111111111111111111111111111111 on arbitrum", ["deliver/transfer spend[exact:5 USDC @arbitrum] want[@arbitrum] holder:address=0x1111111111111111111111111111111111111111"]],
  ["send 0.1 SOL to 9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", ["deliver/transfer spend[exact:0.1 SOL] want[] holder:address=9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"]],
  ["send 5 USDC to my friend on base", ["deliver/transfer spend[exact:5 USDC @base] want[@base] holder:nickname"]],
  ["pay toly 1 SOL", ["deliver/transfer spend[exact:1 SOL] want[] holder:nickname"]],
  ["send 5 USDC to myself on solana", ["relocate spend[exact:5 USDC @solana] want[@solana]"]],
  ["send 10 USDC on base to 9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", ["deliver/transfer spend[exact:10 USDC @base] want[@base] holder:address=9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"]],
  ["bridge 10 USDC from base to solana to toly.sns", ["deliver/bridge spend[exact:10 USDC @base] want[@solana] holder:name=toly.sns"]],
  ["withdraw 20 USDC out of compound on arbitrum", ["exit/withdraw spend[exact:20 USDC @arbitrum position:compound-v3] want[]"]],
  ["take half out of morpho on base", ["exit spend[portion:5000 @base position:morpho] want[]"]],
  ["pull everything from kamino", ["exit spend[max @position:kamino] want[]"]],
  ["swap 1 SOL to USDC and then swap the proceeds to JitoSOL", ["convert/swap spend[exact:1 SOL] want[USDC]","convert/swap spend[previous] want[JitoSOL] after:0"]],
  ["bridge 25 USDC to solana then stake it with marinade", ["relocate/bridge spend[exact:25 USDC] want[@solana]","earn/stake spend[previous] want[@venue:marinade:staking] after:0"]],
  ["deposit 1 SOL into kamino", ["earn/deposit spend[exact:1 SOL] want[@venue:kamino:lending]"]],
  ["swap $50 of SOL to USDC", ["convert/swap spend[usd:50 SOL] want[USDC]"]],
  ["buy $20 of SOL", ["convert/swap spend[] want[usd:20 SOL]"]],
  ["swap all but 0.1 SOL to USDC", ["convert/swap spend[allBut:0.1 SOL] want[USDC]"]],
  ["swap 1k USDC to SOL", ["convert/swap spend[exact:1000 USDC] want[SOL]"]],
  ["swap 1 SLO to USDC", ["convert/swap spend[exact:1 SLO] want[USDC]"]],
  ["swap 1 SOL to DOGE", [null]],
  ["borrow 100 USDC against my ETH", [null]],
  ["swap 1 SOL to USDC and 2 SOL", ["convert/swap spend[exact:1 SOL] want[USDC]","convert/swap spend[exact:2 SOL] want[]"]],
  ["swap 1 SOL to USDC with 10x leverage", [null]],
  ["send 5 USDC to vitalik.eth and 0x1111111111111111111111111111111111111111", [null]],
  ["1 sol", [null]],
  ["base to solana", [null]],
  ["swap 1 SOL 2 SOL to USDC", [null]],
  ["swap 1 SOL to USDC to 0x1111111111111111111111111111111111111111", [null]],
];

/** Phrases of the table that exercise each frame rule; each rule at least five times. */
const RULES: Readonly<Record<string, readonly string[]>> = {
  F1: ["turn 1 SOL into USDC", "1 sol -> usdc", "sol to usdc 1", "usdc base>arb 25", "buy USDC with 1 SOL", "swap sol usdc 1", "pay jesse.base.eth 5 USDC"],
  F2: ["change 1 SOL to USDC", "1 sol for usdc", "stake 1 SOL for JitoSOL", "hold SOL instead of USDC", "I want to hold ETH instead of USDC on base", "hedge half my SOL into stables"],
  F3: ["25 usdc base -> solana", "get 10 USDC from arbitrum onto base", "please, swap 1 SOL to USDC on solana, thanks!", "get 10 USDC on base from solana", "eth->usdc 0.01 base", "I need to bridge 10 usdc arb to base"],
  F4: ["yo send vitalik.eth 5 USDC on optimism", "5 usdc -> vitalik.eth op", "send 5 USDC to my friend on base", "pay toly 1 SOL", "send 0.1 SOL to 9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", "bridge 10 USDC from base to solana to toly.sns"],
  F5: ["put 100 USDC in aave on base", "lend 100 USDC on aave base", "take 50 USDC out of aave on base", "exit my aave position", "move my aave USDC to morpho", "1 sol jito", "pull everything from kamino"],
  F6: ["1 SOL to USDC", "25 usdc from base to arb", "aave 100 usdc base", "100 usdc -> aave", "0.1 sol > toly.sns", "ship 10 USDC from arbitrum to base", "consolidate to Base"],
  F7: ["send 5 USDC to vitalik.eth and 5 USDC to jesse.base.eth on base", "swap 0.5 SOL to USDC and 0.5 SOL to JitoSOL", "bridge 10 USDC from base to arbitrum and 10 USDC from base to optimism", "swap 1 SOL to USDC and 2 SOL", "first swap 1 SOL to USDC, after that bridge it to arbitrum"],
  F8: ["put my USDC to work", "earn on my SOL", "stake my SOL", "cash out my SOL", "lend my USDC on arbitrum", "close my aave position on base"],
  F9: ["swap 1 SOL to USDC and bridge it to base", "swap 1 SOL to USDC. Then bridge the USDC to base.", "swap 10 USDC to ETH on base and bridge the ETH to arbitrum", "swap 1 SOL to USDC and then swap the proceeds to JitoSOL", "swap 1 SOL to USDC, bridge to base, deposit into aave", "withdraw my USDC from aave and send it to vitalik.eth"],
};

describe("goal frames", () => {
  it(`reads ${FRAMES.length} messages into the expected Goals`, () => {
    assert.ok(FRAMES.length >= 150, `${FRAMES.length} phrases`);
    for (const [say, expected] of FRAMES) assert.deepEqual(readAll(say), expected, say);
  });

  it("covers every casual, terse, goal and multi corpus line", () => {
    const table = new Set(FRAMES.map(([say]) => say));
    for (const prompt of corpus.prompts) {
      if (["casual", "terse", "goal", "multi"].includes(prompt.family)) assert.ok(table.has(prompt.say), `${prompt.id} is in the frame table`);
    }
  });

  it("exercises each frame rule at least five times", () => {
    const table = new Map(FRAMES.map(([say, goals]) => [say, goals]));
    for (const [rule, phrases] of Object.entries(RULES)) {
      assert.ok(phrases.length >= 5, rule);
      for (const phrase of phrases) {
        const goals = table.get(phrase);
        assert.ok(goals, `${rule}: "${phrase}" is in the table`);
        assert.ok(goals.some((goal) => goal !== null), `${rule}: "${phrase}" reads`);
      }
    }
  });

  it("produces only valid, serialisable Goals with frame confidence", () => {
    for (const [say] of FRAMES) {
      for (const read of readGoals(say)) {
        if (!read) continue;
        assert.equal(read.goal.confidence, "frame", say);
        const result = validateGoal(JSON.parse(JSON.stringify(read.goal)));
        assert.ok(result.ok, `${say}: ${result.ok ? "" : JSON.stringify(result.issues)}`);
      }
    }
  });

  it("is deterministic", () => {
    for (const [say] of FRAMES) assert.deepEqual(readAll(say), readAll(say), say);
  });
});

/** A compact view of a step's slots (what the policy receives). */
function slots(step: WorkStep): string {
  if (step.goal) return `goal:${step.goal.kind}`;
  const amount = step.amount?.v;
  const shown = amount ? (amount.t === "exact" || amount.t === "usd" ? `${amount.t}:${amount.value}` : `${amount.t}:${amount.bps}`) : "";
  return [
    step.kind?.v ?? "?",
    step.network ? `@${step.network.v}` : "",
    step.toNetwork ? `->${step.toNetwork.v}` : "",
    shown,
    step.from ? step.from.v : step.usdFrom ? "$" : "",
    step.to ? `->${step.to.v}` : step.usdTo ? "->$" : "",
    step.recipient ? `to:${step.recipient.v}` : step.nickname ? "to:nickname" : "",
    step.protocol ? `[${step.protocol.v}]` : "",
    step.provider ? `{${step.provider.v}}` : "",
    step.buy ? "buy" : "",
  ].filter(Boolean).join(" ");
}

const parse = (say: string) => parseSentence(say, []).steps.map(slots);

describe("goal lowering into clarify slots", () => {
  const CASES: readonly (readonly [string, readonly string[]])[] = [
    ["turn 1 SOL into USDC", ["swap exact:1 SOL ->USDC"]],
    ["hey could you move 25 USDC from base over to solana", ["bridge @base ->solana exact:25 USDC"]],
    ["get 10 USDC from arbitrum onto base", ["bridge @arbitrum ->base exact:10 USDC"]],
    ["yo send vitalik.eth 5 USDC on optimism", ["transfer @optimism exact:5 USDC to:vitalik.eth"]],
    ["pay toly 1 SOL", ["transfer exact:1 SOL to:nickname"]],
    ["send 10 USDC on base to 9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", ["bridge @base ->solana exact:10 USDC to:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"]],
    ["lend 100 USDC on aave base", ["deposit @base exact:100 USDC [aave-v3]"]],
    ["aave 100 usdc base", ["deposit @base exact:100 usdc [aave-v3]"]],
    ["1 sol jito", ["stake exact:1 SOL {jito}"]],
    ["stake 1 SOL for JitoSOL", ["stake exact:1 SOL {jito}"]],
    ["take 50 USDC out of aave on base", ["withdraw @base exact:50 USDC [aave-v3]"]],
    // No asset named: the solver reads the positions and withdraws what is there (a goal step).
    ["take everything out of aave", ["goal:exit"]],
    ["put my USDC to work", ["deposit balance:10000 USDC"]],
    ["swap $50 of SOL to USDC", ["swap usd:50 SOL ->USDC"]],
    ["buy $20 of SOL", ["swap exact:20 $ ->SOL buy"]],
    ["hedge half my SOL into stables", ["swap balance:5000 SOL ->$"]],
    ["swap 1k USDC to SOL", ["swap exact:1000 USDC ->SOL"]],
    ["swap 1 SOL to", ["swap exact:1 SOL"]],
    ["swap to USDC", ["swap ->USDC"]],
    ["move my aave USDC to morpho", ["withdraw position:10000 USDC [aave-v3]", "deposit previous:10000 USDC [morpho]"]],
    ["zap 20 USDC from arbitrum into morpho on base", ["bridge @arbitrum ->base exact:20 USDC", "deposit @base previous:10000 USDC [morpho]"]],
    ["send 5 USDC to vitalik.eth and 5 USDC to jesse.base.eth on base", ["transfer @base exact:5 USDC to:vitalik.eth", "transfer @base exact:5 USDC to:jesse.base.eth"]],
    ["send 5 USDC to vitalik.eth and 10 to jesse.base.eth on base", ["transfer @base exact:5 USDC to:vitalik.eth", "transfer @base exact:10 USDC to:jesse.base.eth"]],
    ["first swap 1 SOL to USDC, after that bridge it to arbitrum", ["swap exact:1 SOL ->USDC", "bridge ->arbitrum previous:10000"]],
    ["swap 1 SOL to USDC, bridge to base, deposit into aave", ["swap exact:1 SOL ->USDC", "bridge ->base previous:10000", "deposit previous:10000 [aave-v3]"]],
    ["swap 1 SOL to USDC. Then bridge the USDC to base.", ["swap exact:1 SOL ->USDC", "bridge ->base previous:10000 USDC"]],
    ["bridge 10 USDC from base to arbitrum, swap half to ETH", ["bridge @base ->arbitrum exact:10 USDC", "swap previous:5000 ->ETH"]],
    ["please, swap 1 SOL to USDC on solana, thanks!", ["swap @solana exact:1 SOL ->USDC"]],
    ["bridge twenty five USDC from base to solana", ["bridge @base ->solana exact:25 USDC"]],
  ];
  it("lowers one-to-one Goals to the slots the strict reader would give", () => {
    for (const [say, expected] of CASES) assert.deepEqual(parse(say), expected, say);
  });

  it("refuses what only the solver can place while goal steps are off, and keeps it as a goal step when on", () => {
    configureGoalSteps(false);
    for (const say of ["consolidate to Base", "get me 1 ETH on Base", "earn on my SOL", "swap all but 0.1 SOL to USDC", "I need gas on optimism"]) {
      assert.throws(() => parseSentence(say, []), (error: Error & { code?: string }) => error.code === "INTENT_UNSUPPORTED", say);
    }
    configureGoalSteps(true);
    try {
      assert.deepEqual(parse("consolidate to Base"), ["goal:consolidate"]);
      assert.deepEqual(parse("get me 1 ETH on Base"), ["goal:acquire"]);
      // The earn kind of the moved output (lending or staking) is the solver's choice (D5): a goal step after the bridge.
      assert.deepEqual(parse("move my arbitrum USDC to base and earn yield"), ["bridge @arbitrum ->base balance:10000 USDC", "goal:earn"]);
      const step = parseSentence("earn on my SOL", []).steps[0] as WorkStep;
      assert.equal(step.goal?.kind, "earn");
      assert.deepEqual(step.goalRead, { lowered: false, possessive: true });
      assert.equal(step.kind, undefined);
    } finally {
      configureGoalSteps(null);
    }
  });

  it("never turns an unknown word, a negation or an unsupported action into steps", () => {
    for (const say of [
      "don't swap 1 SOL to USDC", "borrow 100 USDC against my ETH", "swap 1 SOL to USDC with 10x leverage", "unstake my JitoSOL",
      "send 5 USDC to vitalik.eth and 0x1111111111111111111111111111111111111111", "swap 1 SOL to USDC to 0x1111111111111111111111111111111111111111",
      "1 sol", "base to solana", "please", "hey", "yes", "undo", "swap 1 SOL 2 SOL to USDC", "swap five five USDC to SOL",
    ]) {
      assert.throws(() => parseSentence(say, []), (error: Error & { code?: string }) => error.code === "INTENT_UNSUPPORTED", say);
    }
    // "stake my JitoSOL" reads as an earn goal; the solver finds no staking route for an LST and refuses it (clarifyGoals.test.ts).
    assert.equal((parseSentence("stake my JitoSOL", []).steps[0] as WorkStep).goal?.kind, "earn");
  });

  it("flags an unknown symbol one edit from a listed one (ASSET_TYPO) and reports rewritten amounts", () => {
    const typo = parseSentence("swap 1 SLO to USDC", []).steps[0] as WorkStep;
    assert.deepEqual(typo.assetTypo, { field: "from", raw: "SLO", candidates: ["SOL"] });
    const terse = parseSentence("1 slo -> usdc", []).steps[0] as WorkStep;
    assert.deepEqual(terse.assetTypo, { field: "from", raw: "slo", candidates: ["SOL"] });
    assert.equal((parseSentence("swap 1 SOL to USDC", []).steps[0] as WorkStep).assetTypo, undefined);
    assert.deepEqual(parseSentence("swap 1k USDC to SOL", []).corrections, [{ field: "actions[0].amount", from: "1k", to: "1000", material: true }]);
    assert.deepEqual(parseSentence("swap 1,5 SOL to USDC", []).corrections, [{ field: "actions[0].amount", from: "1,5", to: "1.5", material: true }]);
  });

  it("marks a role filled by word order alone (D12)", () => {
    const step = parseSentence("swap sol usdc 1", []).steps[0] as WorkStep;
    assert.deepEqual(step.goalRead, { lowered: true, orderOnly: true });
  });
});

describe("goal reader acceptance", () => {
  it("casual, terse and multi are at least 90% correct, the refuse family never plans, nothing crashes", async () => {
    const families = ["casual", "terse", "multi", "refuse"];
    const results = await runIntentEval(corpus, fixtures, { filter: (prompt) => families.includes(prompt.family) });
    const byId = new Map(results.map((result) => [result.id, result]));
    for (const family of families) {
      const prompts = corpus.prompts.filter((prompt) => prompt.family === family);
      const classes = prompts.map((prompt) => classifyResult(prompt, byId.get(prompt.id) as never));
      const correct = classes.filter((entry) => entry === "plan_ok" || entry === "ask_ok" || entry === "refuse_ok").length;
      assert.ok(!classes.includes("crashed"), family);
      if (family === "refuse") assert.equal(correct, prompts.length, "refuse family");
      else assert.ok(correct * 10 >= prompts.length * 9, `${family}: ${correct}/${prompts.length}`);
    }
  });

  it("every ready casual, terse and multi turn round-trips through the grammar", async () => {
    configurePriceReader(evalPriceReader());
    let checked = 0;
    for (const prompt of corpus.prompts) {
      if (!["casual", "terse", "multi"].includes(prompt.family)) continue;
      const entry = { id: prompt.id, category: "eval", title: prompt.id, wallet: prompt.wallet ?? "full", turns: [], ...(prompt.request ? { request: prompt.request } : {}) } as unknown as CorpusCase;
      installWallet(fixtures, entry.wallet);
      const ctx = contextFor(fixtures, entry);
      const result = await runTurn(null, { text: prompt.say }, ctx);
      const decision = result.decision;
      if (decision?.status !== "ready" || !decision.sentence) continue;
      assert.deepEqual(roundTripDifferences(decision.actions ?? [], decision.sentence, ctx), [], `${prompt.id}: "${decision.sentence}"`);
      checked += 1;
    }
    assert.ok(checked >= 70, `round-tripped ${checked} ready turns`);
  });
});
