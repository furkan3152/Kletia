/**
 * The Goal reader's normaliser, lexer and amounts (intent engine v2 §3.2,
 * package P2): token tables for numerals, "1k", "1e-2", "1,000" / "1,5",
 * glued forms, arrows, fillers, venues, networks, holders and the NOISE that
 * makes a clause fail closed; the AmountSel round trip through render.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AmountSel } from "@kletia/core";
import {
  lex,
  normalizeClause,
  readNumber,
  renderAmount,
  spellNumbers,
  symbolTypoCandidates,
  toThreadAmount,
  type Token,
} from "../goal/index.js";
import { numberWordsValue, shiftDecimal } from "../goal/amounts.js";

/** A compact view of one token: #amount $asset ?typo ~class @network ^venue >recipient >>holder !verb :conn. */
function show(token: Token): string {
  switch (token.t) {
    case "AMOUNT": {
      const sel = token.sel;
      const detail = sel.t === "exact" || sel.t === "usd" ? `:${sel.value}` : sel.t === "portion" ? `:${sel.bps}` : sel.t === "allBut" ? `:${sel.keep}` : "";
      return `#${sel.t}${detail}`;
    }
    case "ASSET":
      return `$${token.symbol}${token.network ? `/${token.network}` : ""}`;
    case "ASSET?":
      return `?${token.raw}[${token.candidates.join(",")}]`;
    case "CLASS":
      return `~${token.cls}`;
    case "NETWORK":
      return `@${token.network}`;
    case "VENUE": {
      const venue = token.venue;
      if (venue.best) return "^best";
      return `^${[venue.lending, venue.provider && `p:${venue.provider}`, venue.dex && `dex:${venue.dex}`, venue.bridge && `bridge:${venue.bridge}`].filter(Boolean).join("|")}`;
    }
    case "ADDRESS":
    case "NAME":
      return `>${token.value}`;
    case "HOLDER":
      return `>>${token.holder}`;
    case "VERB":
      return `!${token.verb.kind}${token.verb.op ? `/${token.verb.op}` : ""}`;
    case "CONN":
      return `:${token.word}`;
    case "POSS":
      return "my";
    case "DET":
      return "the";
    case "REF":
      return "<it";
    case "WORK":
      return "+work";
    case "POSITION":
      return "pos";
    case "PREFER":
      return `*${token.prefer}`;
    case "WALLET":
      return "wallet";
    case "NOISE":
      return `x${token.raw}`;
    case "VAGUE":
      return `~amount:${token.raw}`;
    case "WEIGHTS":
      return `%${token.weights.join("/")}`;
  }
}

const read = (text: string) => lex(normalizeClause(text)).map(show).join(" ");

/** [what the person typed, the tokens]. */
const TABLE: readonly (readonly [string, string])[] = [
  ["swap 1 SOL to USDC","!convert/swap #exact:1 $SOL/solana :to $USDC"],
  ["1 sol -> usdc","#exact:1 $sol/solana :to $usdc"],
  ["1 sol => usdc","#exact:1 $sol/solana :to $usdc"],
  ["10 usdc arb→base","#exact:10 $usdc $arb/arbitrum :to @base"],
  ["usdc base>arb 25","$usdc @base :to $arb/arbitrum #exact:25"],
  ["0.1 sol > toly.sns","#exact:0.1 $sol/solana :to >toly.sns"],
  ["swap1 SOL to USDC","!convert/swap #exact:1 $SOL/solana :to $USDC"],
  ["swap 1SOL to USDC","!convert/swap #exact:1 $SOL/solana :to $USDC"],
  ["swap 50bucks of SOL to USDC","!convert/swap #usd:50 :of $SOL/solana :to $USDC"],
  ["swap 1k USDC to SOL","!convert/swap #exact:1000 $USDC :to $SOL/solana"],
  ["swap 0.5k USDC to ETH on base","!convert/swap #exact:500 $USDC :to $ETH :on @base"],
  ["swap 1e-2 ETH to USDC on base","!convert/swap #exact:0.01 $ETH :to $USDC :on @base"],
  ["bridge 1,000 usdc base to solana","!relocate/bridge #exact:1000 $usdc @base :to @solana"],
  ["swap 1,5 SOL to USDC","!convert/swap #exact:1.5 $SOL/solana :to $USDC"],
  ["swap .5 sol to usdc","!convert/swap #exact:0.5 $sol/solana :to $usdc"],
  ["swap 1.0 SOL to usdc","!convert/swap #exact:1.0 $SOL/solana :to $usdc"],
  ["swap twenty five USDC to SOL","!convert/swap #exact:25 $USDC :to $SOL/solana"],
  ["swap one hundred and five USDC to SOL","!convert/swap #exact:105 $USDC :to $SOL/solana"],
  ["swap two thousand five hundred USDC to SOL","!convert/swap #exact:2500 $USDC :to $SOL/solana"],
  ["swap a hundred USDC to SOL","!convert/swap #exact:100 $USDC :to $SOL/solana"],
  ["swap ninety nine thousand nine hundred ninety nine USDC to SOL","!convert/swap #exact:99999 $USDC :to $SOL/solana"],
  ["swap five five USDC to SOL","!convert/swap xfive #exact:5 $USDC :to $SOL/solana"],
  ["swap twenty twenty USDC to SOL","!convert/swap xtwenty #exact:20 $USDC :to $SOL/solana"],
  ["swap $50 of SOL to USDC","!convert/swap #usd:50 :of $SOL/solana :to $USDC"],
  ["swap 50 dollars of SOL to USDC","!convert/swap #usd:50 :of $SOL/solana :to $USDC"],
  ["swap 50 bucks of SOL to USDC","!convert/swap #usd:50 :of $SOL/solana :to $USDC"],
  ["swap 50 usd of SOL to USDC","!convert/swap #usd:50 :of $SOL/solana :to $USDC"],
  ["swap $1,000 of SOL to USDC","!convert/swap #usd:1000 :of $SOL/solana :to $USDC"],
  ["swap 30% of my SOL to USDC","!convert/swap #portion:3000 :of my $SOL/solana :to $USDC"],
  ["swap 30 percent of my SOL to USDC","!convert/swap #portion:3000 :of my $SOL/solana :to $USDC"],
  ["swap 33.33% of my SOL to USDC","!convert/swap #portion:3333 :of my $SOL/solana :to $USDC"],
  ["swap half my SOL to USDC","!convert/swap #portion:5000 my $SOL/solana :to $USDC"],
  ["swap a third of my SOL to USDC","!convert/swap #portion:3333 :of my $SOL/solana :to $USDC"],
  ["swap a quarter of my SOL to USDC","!convert/swap #portion:2500 :of my $SOL/solana :to $USDC"],
  ["swap two thirds of my SOL to USDC","!convert/swap #portion:6667 :of my $SOL/solana :to $USDC"],
  ["swap three quarters of my SOL to USDC","!convert/swap #portion:7500 :of my $SOL/solana :to $USDC"],
  ["swap all my SOL to USDC","!convert/swap #max my $SOL/solana :to $USDC"],
  ["swap everything I have in SOL to USDC","!convert/swap #max $SOL/solana :to $USDC"],
  ["swap all but 0.1 SOL to USDC","!convert/swap #allBut:0.1 $SOL/solana :to $USDC"],
  ["swap everything except 0.5 SOL to USDC","!convert/swap #allBut:0.5 $SOL/solana :to $USDC"],
  ["swap max SOL to USDC","!convert/swap #max $SOL/solana :to $USDC"],
  ["hey could you move 25 USDC from base over to solana","!relocate #exact:25 $USDC :from @base :to @solana"],
  ["yo send vitalik.eth 5 USDC on optimism","!deliver >vitalik.eth #exact:5 $USDC :on @optimism"],
  ["please, swap 1 SOL to USDC on solana, thanks!","!convert/swap #exact:1 $SOL/solana :to $USDC :on @solana"],
  ["can you swap 1 SOL to USDC for me?","!convert/swap #exact:1 $SOL/solana :to $USDC"],
  ["i wanna swap 1 SOL for some USDC","!convert/swap #exact:1 $SOL/solana :for $USDC"],
  ["I need to bridge 10 usdc arb to base","!relocate/bridge #exact:10 $usdc $arb/arbitrum :to @base"],
  ["I'd like to convert 1 SOL to USDC please","!convert/swap #exact:1 $SOL/solana :to $USDC"],
  ["ok so swap 1 SOL to USDC real quick","!convert/swap #exact:1 $SOL/solana :to $USDC"],
  ["first swap 1 SOL to USDC","!convert/swap #exact:1 $SOL/solana :to $USDC"],
  ["send 5 USDC to 0x1111111111111111111111111111111111111111 on arbitrum","!deliver #exact:5 $USDC :to >0x1111111111111111111111111111111111111111 :on @arbitrum"],
  ["send 0.1 SOL to 9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM","!deliver #exact:0.1 $SOL/solana :to >9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"],
  ["send 5 USDC to jesse.base.eth","!deliver #exact:5 $USDC :to >jesse.base.eth"],
  ["send 5 USDC to my other wallet","!deliver #exact:5 $USDC :to >>selfOther"],
  ["fund my arbitrum wallet with 20 USDC","!acquire my @arbitrum wallet :with #exact:20 $USDC"],
  ["fund my sol account","!acquire my $sol/solana wallet"],
  ["fund the arbitrum wallet","!acquire the @arbitrum xwallet"],
  ["send 5 USDC to myself on solana","!deliver #exact:5 $USDC :to >>self :on @solana"],
  ["send 5 USDC to my friend","!deliver #exact:5 $USDC :to >>nickname"],
  ["send 5 USDC to mom","!deliver #exact:5 $USDC :to >>nickname"],
  ["send 5 USDC to me","!deliver #exact:5 $USDC :to >>self"],
  ["pay jesse.base.eth 5 USDC","!deliver/transfer >jesse.base.eth #exact:5 $USDC"],
  ["give toly.sns 0.1 SOL","!deliver/transfer >toly.sns #exact:0.1 $SOL/solana"],
  ["tip toly.sns 0.05 SOL","!deliver/transfer >toly.sns #exact:0.05 $SOL/solana"],
  ["put 100 USDC in aave on base","!earn/deposit #exact:100 $USDC :in ^aave-v3 :on @base"],
  ["lend 100 USDC on aave base","!earn/deposit #exact:100 $USDC :on ^aave-v3 @base"],
  ["park 50 USDC in morpho on base","!earn/deposit #exact:50 $USDC :in ^morpho :on @base"],
  ["deposit 10 USDC into jupiter lend","!earn/deposit #exact:10 $USDC :into ^jupiter-lend"],
  ["deposit 50 USDC into spark on base","!earn/deposit #exact:50 $USDC :into ^spark :on @base"],
  ["deposit 50 USDC into compound v3 on arbitrum","!earn/deposit #exact:50 $USDC :into ^compound-v3 :on @arbitrum"],
  ["stake 1 SOL with jito","!earn/stake #exact:1 $SOL/solana :with ^p:jito"],
  ["liquid stake 1 SOL with jito","!earn/stake #exact:1 $SOL/solana :with ^p:jito"],
  ["stake 0.001 ETH with rocket pool","!earn/stake #exact:0.001 $ETH :with ^p:rocket-pool"],
  ["stake 0.001 ETH with lido","!earn/stake #exact:0.001 $ETH :with ^p:lido"],
  ["stake 1 SOL for JitoSOL","!earn/stake #exact:1 $SOL/solana :for $JitoSOL"],
  ["1 sol jito","#exact:1 $sol/solana ^p:jito"],
  ["swap 1 SOL to USDC via raydium","!convert/swap #exact:1 $SOL/solana :to $USDC :via ^dex:raydium"],
  ["swap 1 SOL to USDC using orca","!convert/swap #exact:1 $SOL/solana :to $USDC :using ^dex:orca"],
  ["bridge 20 USDC from base to optimism via across","!relocate/bridge #exact:20 $USDC :from @base :to @optimism :via ^bridge:across"],
  ["bridge 20 USDC from base to solana via debridge","!relocate/bridge #exact:20 $USDC :from @base :to @solana :via ^bridge:debridge-dln"],
  ["bridge 20 USDC from base to ethereum via lifi","!relocate/bridge #exact:20 $USDC :from @base :to @ethereum :via ^bridge:lifi"],
  ["take 50 USDC out of aave on base","!exit #exact:50 $USDC :out of ^aave-v3 :on @base"],
  ["pull my 50 USDC out of aave on base","!exit my #exact:50 $USDC :out of ^aave-v3 :on @base"],
  ["exit my aave position","!exit my ^aave-v3 pos"],
  ["close my aave position on base","!exit my ^aave-v3 pos :on @base"],
  ["move my aave position into the best yield on base","!relocate my ^aave-v3 pos :into ^best :on @base"],
  ["put my USDC to work","!earn/deposit my $USDC +work"],
  ["earn yield on my idle USDC","!earn my $USDC"],
  ["earn on my SOL","!earn my $SOL/solana"],
  ["make my SOL earn yield","!earn my $SOL/solana +work"],
  ["park my stables somewhere safe with yield","!earn/deposit my ~usd-stable ^best +work"],
  ["get me 1 ETH on Base","!acquire #exact:1 $ETH :on @base"],
  ["I want 100 USDC on Solana","!acquire #exact:100 $USDC :on @solana"],
  ["I need gas on optimism","!acquire ~gas :on @optimism"],
  ["top up gas on polygon","!fuel ~gas :on @polygon"],
  ["consolidate to Base","!consolidate :to @base"],
  ["cash out my SOL","!convert my $SOL/solana"],
  ["get rid of my USDbC","!convert my $USDbC"],
  ["go all in on SOL","!convert $SOL/solana"],
  ["convert all my stablecoins to USDC","!convert/swap #max my ~usd-stable :to $USDC"],
  ["I want to hold ETH instead of USDC on base","!acquire $ETH :instead of $USDC :on @base"],
  ["pay vitalik.eth 5 USDC from whatever network is cheapest","!deliver/transfer >vitalik.eth #exact:5 $USDC :from *cheapest"],
  ["bridge the USDC to base","!relocate/bridge the $USDC :to @base"],
  ["bridge it to base","!relocate/bridge <it :to @base"],
  ["swap the proceeds to SOL","!convert/swap <it :to $SOL/solana"],
  ["swap 1 SOL to USDC on eth mainnet","!convert/swap #exact:1 $SOL/solana :to $USDC :on @ethereum"],
  ["swap 1 POL to USDC on matic","!convert/swap #exact:1 $POL :to $USDC :on $matic/polygon"],
  ["send 1 op to vitalik.eth on op","!deliver #exact:1 $op/optimism :to >vitalik.eth :on $op/optimism"],
  ["swap 1 ARB to USDC on arb","!convert/swap #exact:1 $ARB/arbitrum :to $USDC :on $arb/arbitrum"],
  ["bridge 25 USDC to arbitrum one","!relocate/bridge #exact:25 $USDC :to @arbitrum"],
  ["bridge 25 USDC to solana devnet","!relocate/bridge #exact:25 $USDC :to @solana-devnet"],
  ["swap 1 SLO to USDC","!convert/swap #exact:1 ?SLO[SOL] :to $USDC"],
  ["swap 1 SOL to USCD","!convert/swap #exact:1 $SOL/solana :to ?USCD[USDC]"],
  ["swap 1 SOL to DOGE","!convert/swap #exact:1 $SOL/solana :to xDOGE"],
  ["borrow 100 USDC against my ETH","xborrow #exact:100 $USDC xagainst my $ETH"],
  ["don't swap 1 SOL to USDC","xdont !convert/swap #exact:1 $SOL/solana :to $USDC"],
  ["swap 1 SOL to USDC with 10x leverage","!convert/swap #exact:1 $SOL/solana :to $USDC :with x10x xleverage"],
  ["what's the price of ETH","xwhats the xprice :of $ETH"],
  ["swap 1 1INCH to USDC","!convert/swap #exact:1 x1INCH :to $USDC"],
  ["deposit $100 into aave on base","!earn/deposit #usd:100 :into ^aave-v3 :on @base"],
];

describe("goal lexer: token tables", () => {
  it(`reads ${TABLE.length} phrases into the expected tokens`, () => {
    for (const [input, expected] of TABLE) assert.equal(read(input), expected, input);
  });

  it("keeps spans that point at the typed words", () => {
    const text = normalizeClause("swap 25 USDC from base to solana");
    for (const token of lex(text)) {
      const [start, end] = token.span;
      assert.ok(start >= 0 && end <= text.length && start < end, JSON.stringify(token));
    }
    const amount = lex(text).find((token) => token.t === "AMOUNT");
    assert.ok(amount);
    assert.equal(text.slice(amount.span[0], amount.span[1]), "25");
  });

  it("never reads an unknown word as anything but NOISE (fail closed)", () => {
    for (const word of ["borrow", "leverage", "short", "long", "unstake", "mint", "approve", "cancel", "undo", "yes", "not", "never", "bitcoin", "dydx", "airdrop"]) {
      const tokens = lex(normalizeClause(`${word} 1 SOL`));
      assert.ok(tokens.some((token) => token.t === "NOISE"), word);
    }
  });

  it("keeps addresses, names and CAIP ids byte for byte", () => {
    const evm = "0x52908400098527886E0F7030069857D2E4169EE7";
    const sol = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    assert.equal(read(`send 1 USDC to ${evm}`), `!deliver #exact:1 $USDC :to >${evm}`);
    assert.equal(read(`send 1 SOL to ${sol}.`), `!deliver #exact:1 $SOL/solana :to >${sol}`);
    assert.equal(normalizeClause(`send 1 SOL to ${sol}`), `send 1 SOL to ${sol}`);
  });
});

describe("goal normaliser", () => {
  const CASES: readonly (readonly [string, string])[] = [
    ["hey could you move 25 USDC from base over to solana", "move 25 USDC from base over to solana"],
    ["please, swap 1 SOL to USDC on solana, thanks!", "swap 1 SOL to USDC on solana"],
    ["can you swap 1 SOL to USDC for me?", "swap 1 SOL to USDC"],
    ["yo send vitalik.eth 5 USDC", "send vitalik.eth 5 USDC"],
    ["I need to bridge 10 usdc arb to base", "bridge 10 usdc arb to base"],
    ["I'd like to convert 1 SOL to USDC please", "convert 1 SOL to USDC"],
    ["i wanna swap 1 SOL for some USDC", "swap 1 SOL for some USDC"],
    ["ok so just swap 1 SOL to USDC real quick", "swap 1 SOL to USDC"],
    ["1 sol -> usdc", "1 sol to usdc"],
    ["1 sol => usdc", "1 sol to usdc"],
    ["10 usdc arb→base", "10 usdc arb to base"],
    ["usdc base>arb 25", "usdc base to arb 25"],
    ["0.1 sol > toly.sns", "0.1 sol to toly.sns"],
    ["swap1 SOL to USDC", "swap 1 SOL to USDC"],
    ["swap 1SOL to USDC", "swap 1 SOL to USDC"],
    ["swap 50bucks of SOL", "swap 50 bucks of SOL"],
    ["swap 1k USDC to SOL", "swap 1k USDC to SOL"],
    ["bridge 1,000 usdc base to solana", "bridge 1,000 usdc base to solana"],
    ["swap 1,5 SOL to USDC", "swap 1,5 SOL to USDC"],
    ["rebalance: half my USDC on base, half on arbitrum", "rebalance half my USDC on base half on arbitrum"],
    ["Swap 1 SOL To USDC On Solana.", "Swap 1 SOL To USDC On Solana"],
    ["send 5 USDC to vitalik.eth.", "send 5 USDC to vitalik.eth"],
    ["please", ""],
    ["hey", ""],
  ];
  it("drops fillers and punctuation, keeps every word that carries meaning", () => {
    for (const [input, expected] of CASES) assert.equal(normalizeClause(input), expected, input);
  });

  it("does not unglue known symbols, addresses or exponent forms", () => {
    assert.equal(normalizeClause("swap 1e-2 ETH"), "swap 1e-2 ETH");
    assert.equal(normalizeClause("send 0x1111111111111111111111111111111111111111"), "send 0x1111111111111111111111111111111111111111");
    assert.equal(normalizeClause("swap 2 cbBTC"), "swap 2 cbBTC");
  });
});

describe("goal amounts", () => {
  it("reads number forms and reports rewrites", () => {
    assert.deepEqual(readNumber("12"), { value: "12" });
    assert.deepEqual(readNumber("12.50"), { value: "12.50" });
    assert.deepEqual(readNumber(".5"), { value: "0.5", raw: ".5" });
    assert.deepEqual(readNumber("1,000"), { value: "1000", raw: "1,000" });
    assert.deepEqual(readNumber("1,250.5"), { value: "1250.5", raw: "1,250.5" });
    assert.deepEqual(readNumber("1,5"), { value: "1.5", raw: "1,5" });
    assert.deepEqual(readNumber("1k"), { value: "1000", raw: "1k", rewritten: true });
    assert.deepEqual(readNumber("0.5k"), { value: "500", raw: "0.5k", rewritten: true });
    assert.deepEqual(readNumber("1e-2"), { value: "0.01", raw: "1e-2", rewritten: true });
    assert.deepEqual(readNumber("2.5e3"), { value: "2500", raw: "2.5e3", rewritten: true });
    // Design A.2 (WP7): "1.000" keeps its typed form (asked); European "1.234.567" and "1.000,50" read with a chip.
    assert.deepEqual(readNumber("1.000"), { value: "1.000", raw: "1.000" });
    assert.deepEqual(readNumber("1.234.567"), { value: "1234567", raw: "1.234.567", rewritten: true });
    assert.deepEqual(readNumber("1.000,50"), { value: "1000.50", raw: "1.000,50", rewritten: true });
    for (const bad of ["0", "0.0", "1,23,4", "abc", "1e99", "-1", "", "1..2", "0k", "01.000.000", "1.00.000"]) assert.equal(readNumber(bad), null, bad);
  });

  it("shifts decimals exactly", () => {
    assert.equal(shiftDecimal("1", 3), "1000");
    assert.equal(shiftDecimal("1.25", 1), "12.5");
    assert.equal(shiftDecimal("1", -2), "0.01");
    assert.equal(shiftDecimal("12.5", -3), "0.0125");
    assert.equal(shiftDecimal("0.5", 3), "500");
  });

  it("spells number words up to 999,999 and refuses malformed runs", () => {
    const words = (text: string) => numberWordsValue(text.split(" "));
    assert.equal(words("twenty five"), 25);
    assert.equal(words("one hundred and five"), 105);
    assert.equal(words("a hundred"), 100);
    assert.equal(words("two thousand five hundred"), 2500);
    assert.equal(words("nine hundred ninety nine thousand nine hundred ninety nine"), 999_999);
    assert.equal(words("nineteen"), 19);
    for (const bad of ["five five", "twenty twenty", "twenty fifteen", "hundred hundred", "thousand thousand", "zero", "and", "five and"]) assert.equal(words(bad), null, bad);
    assert.equal(spellNumbers("bridge twenty five USDC", 2), "bridge 25 USDC");
    assert.equal(spellNumbers("swap ten USDC", 2), "swap ten USDC");
    assert.equal(spellNumbers("swap ten USDC"), "swap 10 USDC");
    assert.equal(spellNumbers("swap five five USDC", 2), "swap five five USDC");
    assert.equal(spellNumbers("buy a hundred USDC worth", 2), "buy 100 USDC worth");
    assert.equal(spellNumbers("send a SOL"), "send a SOL");
  });

  it("flags only unknown symbols one edit from a listed one", () => {
    assert.deepEqual(symbolTypoCandidates("SLO"), ["SOL"]);
    assert.deepEqual(symbolTypoCandidates("USCD"), ["USDC"]);
    assert.deepEqual(symbolTypoCandidates("SOL"), []);
    assert.deepEqual(symbolTypoCandidates("DOGE"), []);
    assert.deepEqual(symbolTypoCandidates("ab"), []);
  });

  it("round-trips every AmountSel through render and the lexer", () => {
    const sels: AmountSel[] = [
      { t: "exact", value: "1" }, { t: "exact", value: "0.5" }, { t: "exact", value: "1250.125" }, { t: "exact", value: "999999" },
      { t: "usd", value: "50" }, { t: "usd", value: "12.5" },
      { t: "max" }, { t: "previous" }, { t: "allBut", keep: "0.1" }, { t: "allBut", keep: "2" },
    ];
    for (let bps = 1; bps <= 10_000; bps += 1) {
      if (bps % 97 === 0 || [1, 50, 100, 2500, 3333, 5000, 6667, 7500, 9999, 10_000].includes(bps)) sels.push({ t: "portion", bps });
    }
    for (const sel of sels) {
      const text = renderAmount(sel);
      const tokens = lex(normalizeClause(`swap ${text} SOL`));
      const back = tokens.find((token) => token.t === "AMOUNT" || token.t === "REF");
      assert.ok(back, `${JSON.stringify(sel)} -> "${text}"`);
      if (sel.t === "previous") assert.equal(back.t, "REF", text);
      else assert.deepEqual(back.t === "AMOUNT" ? back.sel : null, sel, `${JSON.stringify(sel)} -> "${text}"`);
    }
  });

  it("lowers amounts to the clarify layer's ThreadAmount", () => {
    const balance = { share: "balance" as const, previousExists: false };
    assert.deepEqual(toThreadAmount({ t: "exact", value: "1000" }, { ...balance, raw: "1,000" }), { t: "exact", value: "1000", raw: "1,000" });
    assert.deepEqual(toThreadAmount({ t: "usd", value: "50" }, balance), { t: "exact", value: "50", usd: true });
    assert.deepEqual(toThreadAmount({ t: "portion", bps: 5000 }, balance), { t: "balance", bps: 5000 });
    assert.deepEqual(toThreadAmount({ t: "max" }, { share: "position", previousExists: false }), { t: "position", bps: 10_000 });
    assert.deepEqual(toThreadAmount({ t: "portion", bps: 5000 }, { share: "previous", previousExists: true }), { t: "previous", bps: 5000 });
    assert.equal(toThreadAmount({ t: "portion", bps: 5000 }, { share: "previous", previousExists: false }), null);
    assert.equal(toThreadAmount({ t: "previous" }, balance), null);
    assert.deepEqual(toThreadAmount({ t: "previous" }, { ...balance, previousExists: true }), { t: "previous", bps: 10_000 });
    assert.equal(toThreadAmount({ t: "allBut", keep: "0.1" }, balance), null);
  });
});
