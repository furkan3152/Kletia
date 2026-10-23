import assert from "node:assert/strict";
import test from "node:test";
import {
  AMOUNT_UNITS,
  APPROXIMATION_WORDS,
  ASSETS,
  CLAUSE_FINAL_POLITENESS,
  CLOSED_CLASS_CATEGORIES,
  CLOSED_CLASS_REFUSAL_OF,
  CLOSED_CLASS_RULES,
  DIGIT_TOKENS,
  LOOKALIKE_FAMILIES,
  NETWORK_QUALIFIERS,
  NEVER_DROP,
  POLITE_OPENERS,
  PROVENANCE_RULE_PATTERN,
  QUESTION_OPENERS,
  REVIEWED_FILLERS,
  UNIT_WORDS,
  UNSUPPORTED_NETWORKS,
  isKnownSymbol,
  lookalikeFamilyOf,
  networkFromWord,
  scanClosedClass,
} from "../dist/index.js";

const normalised = (phrase) => phrase === phrase.toLowerCase().replace(/\s+/gu, " ").trim();
const fillerPhrases = REVIEWED_FILLERS.map((entry) => entry.phrase);

test("word lists: phrases are lowercase with single spaces, and no list repeats an entry", () => {
  const lists = {
    fillers: fillerPhrases,
    neverDrop: NEVER_DROP.map((entry) => entry.phrase),
    questionOpeners: QUESTION_OPENERS,
    politeOpeners: POLITE_OPENERS,
    units: Object.keys(UNIT_WORDS),
    unsupported: Object.keys(UNSUPPORTED_NETWORKS),
    qualifiers: Object.keys(NETWORK_QUALIFIERS),
    digits: DIGIT_TOKENS,
    politeness: CLAUSE_FINAL_POLITENESS,
  };
  for (const [name, list] of Object.entries(lists)) {
    assert.ok(list.length > 0, name);
    assert.equal(new Set(list).size, list.length, `${name} has no duplicates`);
    for (const phrase of list) assert.ok(normalised(phrase), `${name}: "${phrase}"`);
  }
  for (const list of [REVIEWED_FILLERS, NEVER_DROP, QUESTION_OPENERS, POLITE_OPENERS, LOOKALIKE_FAMILIES, DIGIT_TOKENS]) assert.ok(Object.isFrozen(list));
  assert.ok(Object.isFrozen(UNIT_WORDS) && Object.isFrozen(UNSUPPORTED_NETWORKS) && Object.isFrozen(NETWORK_QUALIFIERS) && Object.isFrozen(CLOSED_CLASS_RULES));
});

test("word lists: the filler list is disjoint from every other list (\"like\" only as a documented amount exception)", () => {
  const others = new Map();
  const add = (name, phrases) => phrases.forEach((phrase) => others.set(phrase, [...(others.get(phrase) ?? []), name]));
  add("neverDrop", NEVER_DROP.map((entry) => entry.phrase));
  add("questionOpeners", QUESTION_OPENERS);
  add("politeOpeners", POLITE_OPENERS);
  add("units", Object.keys(UNIT_WORDS));
  add("unsupported", Object.keys(UNSUPPORTED_NETWORKS));
  add("qualifiers", Object.keys(NETWORK_QUALIFIERS));
  add("digits", DIGIT_TOKENS);
  add("lookalikes", LOOKALIKE_FAMILIES.flatMap((family) => family.members.map((member) => member.toLowerCase())));
  const clashes = [];
  for (const filler of REVIEWED_FILLERS) {
    const lists = others.get(filler.phrase);
    if (!lists) continue;
    const neverDrop = NEVER_DROP.find((entry) => entry.phrase === filler.phrase);
    const documented = lists.length === 1 && lists[0] === "neverDrop" && neverDrop?.beforeAmount === true && filler.except?.includes("adjacent-amount");
    if (!documented) clashes.push(`${filler.phrase}: ${lists.join(", ")}`);
  }
  assert.deepEqual(clashes, []);
  // A filler is never a listed symbol, a network word or a venue word either.
  for (const phrase of fillerPhrases) {
    assert.equal(isKnownSymbol(phrase), false, `${phrase} is not a symbol`);
    assert.equal(networkFromWord(phrase), null, `${phrase} is not a network`);
  }
  for (const word of ["over", "worth", "maybe", "idk", "i guess", "not", "or", "each", "about", "around"]) {
    assert.ok(!fillerPhrases.includes(word), `${word} is never a filler`);
  }
  for (const word of CLAUSE_FINAL_POLITENESS) assert.ok(fillerPhrases.includes(word), `${word} is a filler`);
});

test("word lists: every never-drop entry names rules that exist, ending with its category's refusal", () => {
  assert.deepEqual([...CLOSED_CLASS_CATEGORIES].sort(), [...new Set(NEVER_DROP.map((entry) => entry.category))].sort(), "every category has entries");
  for (const entry of NEVER_DROP) {
    assert.ok(entry.rules.length >= 1, `${entry.phrase} names a rule`);
    for (const rule of entry.rules) assert.ok(CLOSED_CLASS_RULES[rule], `${entry.phrase}: rule ${rule} exists`);
    assert.equal(entry.rules.at(-1), `refuse:${CLOSED_CLASS_REFUSAL_OF[entry.category]}`, `${entry.phrase} ends with its refusal`);
  }
  for (const [id, rule] of Object.entries(CLOSED_CLASS_RULES)) {
    assert.equal(rule.id, id);
    assert.match(id, PROVENANCE_RULE_PATTERN, `${id} fits slot provenance`);
    assert.ok(rule.what.length > 0 && rule.what.length <= 120, id);
  }
  // Every unit has its rule, and the listed examples are present.
  for (const unit of AMOUNT_UNITS) assert.ok(CLOSED_CLASS_RULES[`unit:${unit}`], unit);
  const phrases = new Set(NEVER_DROP.map((entry) => entry.phrase));
  for (const word of ["not", "dont", "never", "without", "except", "cancel", "never mind", "should", "maybe", "idk", "if", "tomorrow", "or", "either", "up to", "at least", "over", "under", "around", "~", "each", "per", "?"]) {
    assert.ok(phrases.has(word), `${word} is never dropped`);
  }
  assert.ok(APPROXIMATION_WORDS.includes("around") && APPROXIMATION_WORDS.includes("like"));
});

test("word lists: units map to known units and decimal factors; the m-ambiguity is flagged", () => {
  for (const [word, unit] of Object.entries(UNIT_WORDS)) {
    assert.ok(AMOUNT_UNITS.includes(unit.unit), `${word}: ${unit.unit}`);
    assert.match(unit.factor, /^(?:0|[1-9]\d*)(?:\.\d+)?$/u, word);
  }
  assert.equal(UNIT_WORDS.k.factor, "1000");
  assert.equal(UNIT_WORDS.million.factor, "1000000");
  assert.equal(UNIT_WORDS.cents.needs, "usd");
  assert.equal(UNIT_WORDS.bps.needs, "holding");
  assert.equal(UNIT_WORDS.sats.asset, "BTC");
  assert.equal(UNIT_WORDS.lamports.asset, "SOL");
  assert.equal(UNIT_WORDS.m.ambiguousBeforeM, true);
  for (const word of Object.keys(UNIT_WORDS)) assert.equal(isKnownSymbol(word), false, `${word} is not a symbol`);
});

test("word lists: unsupported networks never name a supported network or a listed symbol; common words are flagged", () => {
  for (const [phrase, entry] of Object.entries(UNSUPPORTED_NETWORKS)) {
    assert.equal(networkFromWord(phrase), null, `${phrase} is not a Kletia network`);
    assert.equal(isKnownSymbol(phrase), false, `${phrase} is not a listed symbol`);
    assert.ok(entry.name.length > 0);
  }
  for (const word of ["era", "ink", "scroll", "blast", "sonic", "mantle", "ton", "nova"]) assert.equal(UNSUPPORTED_NETWORKS[word]?.commonWord, true, word);
  for (const [word, qualifier] of Object.entries(NETWORK_QUALIFIERS)) {
    for (const before of qualifier.supportedAfter) {
      // "eth mainnet" is a network word the reader adds; every other pair names a network today.
      const network = networkFromWord(`${before} ${word}`) ?? networkFromWord(before) ?? (before === "eth" ? "ethereum" : null);
      assert.ok(network, `${before} ${word} names a network`);
    }
  }
  assert.equal(networkFromWord("arbitrum sepolia"), "arbitrum-sepolia");
  assert.equal(networkFromWord("solana devnet"), "solana-devnet");
});

test("word lists: look-alike families hold every listed member and resolve typed spellings", () => {
  const members = LOOKALIKE_FAMILIES.flatMap((family) => family.members);
  assert.equal(new Set(members.map((member) => member.toUpperCase())).size, members.length, "a symbol belongs to one family");
  for (const family of LOOKALIKE_FAMILIES) {
    for (const note of Object.keys(family.notes)) assert.ok(family.members.includes(note), `${family.id}: note for a member (${note})`);
  }
  // Every listed ETH-, SOL-, USDC- and USDT-like symbol of the registry is in its family.
  const listed = new Set(ASSETS.map((asset) => asset.symbol));
  for (const symbol of ["ETH", "WETH", "wstETH", "weETH", "rETH", "mETH", "ETHx", "cbETH", "sfrxETH", "SOL", "JitoSOL", "JupSOL", "mSOL", "USDC", "USDbC", "USDT", "USDT0"]) {
    assert.ok(listed.has(symbol), `${symbol} is listed`);
    assert.ok(lookalikeFamilyOf(symbol), `${symbol} is in a family`);
  }
  assert.equal(lookalikeFamilyOf("steth")?.id, "eth");
  assert.equal(lookalikeFamilyOf("WSOL")?.id, "sol");
  assert.equal(lookalikeFamilyOf("usdc.e")?.id, "usdc");
  assert.equal(lookalikeFamilyOf("usdce")?.id, "usdc");
  assert.equal(lookalikeFamilyOf("usdt0")?.id, "usdt");
  assert.equal(lookalikeFamilyOf("AERO"), null);
  assert.equal(lookalikeFamilyOf("BONK"), null);
});

test("word lists: digit tokens are the registry words with digits", () => {
  for (const token of ["usdt0", "aave v3", "uniswap v3", "cctp v2", "l1", "1inch", "v3"]) assert.ok(DIGIT_TOKENS.includes(token), token);
  for (const token of DIGIT_TOKENS) assert.match(token, /\d/u, token);
  for (const symbol of ASSETS.map((asset) => asset.symbol.toLowerCase()).filter((symbol) => /\d/u.test(symbol))) assert.ok(DIGIT_TOKENS.includes(symbol), symbol);
});

test("word lists: the closed-class scan finds every red-team word with its span", () => {
  const scan = (text) => scanClosedClass(text).map((hit) => `${hit.category}:${hit.phrase}`);
  const cases = [
    ["dont swap 1 eth to usdc on base", ["negation:dont"]],
    ["should i swap 1 eth to usdc on base", ["question:should i"]],
    ["swap 1 eth to usdc on base tomorrow", ["condition:tomorrow"]],
    ["bridge 100 usdc to arbitrum or optimism", ["disjunction:or"]],
    ["swap 1 eth to usdc, but not on base", ["negation:but not"]],
    ["what if i swap 1 eth to usdc", ["question:what if"]],
    ["never mind, swap 1 eth to usdc", ["cancellation:never mind"]],
    ["bridge 10 usdc from base to arbitrum nova", ["network:arbitrum nova"]],
    ["bridge 10 usdc from arbitrum to base sepolia", ["network:base sepolia"]],
    ["swap 0.1 sol to usdc on solana testnet", ["network:solana testnet"]],
    ["bridge 1.5 million usdc from base to arbitrum", ["unit:million"]],
    ["send 50 cents of usdc to vitalik.eth on base", ["unit:cents"]],
    ["send 1.5 k usdc to vitalik.eth on base", ["unit:k"]],
    ["send 1.5k usdc to vitalik.eth on base", ["unit:k"]],
    ["swap over 100 usdc to eth on base", ["limit:over"]],
    ["swap up to 100 usdc to eth on base", ["limit:up to"]],
    ["swap 0.01 eth to usdc on base?", ["question:?"]],
    ["swap like 2 sol into usdc", ["approximation:like"]],
    ["stake around 3 sol with jito", ["approximation:around"]],
    ["send 10 usdc each to alice.eth and bob.eth", ["each:each"]],
    ["get at least 0.05 eth on base", ["limit:at least"]],
    ["bridge 50 usdc to scroll", ["network:scroll"]],
  ];
  for (const [text, expected] of cases) assert.deepEqual(scan(text), expected, text);
  const clean = [
    "swap 1 sol to usdc then bridge it to base",
    "stake 2 sol with jito",
    "i like eth",
    "swap a ton of usdc to eth",
    "bridge 100 usdc to arbitrum sepolia",
    "swap 1 sol to usdc on solana devnet",
    "send 0.1 sol to 5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp3m",
    "deposit 100 usdc into aave on base mainnet",
    "send 5 usdc to bob.base.eth",
  ];
  for (const text of clean) assert.deepEqual(scan(text), [], text);
  const [hit] = scanClosedClass("swap over 100 usdc to eth");
  assert.deepEqual({ start: hit.start, end: hit.end }, { start: 5, end: 9 });
  assert.ok(hit.rules.includes("connector:over"));
  assert.match("move 25 usdc from base over to solana", CLOSED_CLASS_RULES["connector:over"].context);
  assert.doesNotMatch("swap over 100 usdc to eth", CLOSED_CLASS_RULES["connector:over"].context);
});
