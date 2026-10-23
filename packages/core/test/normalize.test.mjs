import assert from "node:assert/strict";
import test from "node:test";
import { normalizeMessage, screenText, SPELLED_NUMBER_WORDS } from "../dist/index.js";

// The reader's first pass (intent design A.2 L0): Unicode forms, invisible and direction characters, arrows, quotes,
// dashes, "…", emoji and repeated punctuation; homoglyph letters are reported, never read.

test("screenText reads arrows (with an emoji variation selector) as \"to\"", () => {
  assert.equal(screenText("50 usdc base➡️solana").text, "50 usdc base to solana");
  assert.equal(screenText("1 sol → usdc").text, "1 sol to usdc");
  assert.equal(screenText("1 sol ⟶ usdc").text, "1 sol to usdc");
});

test("screenText removes and counts emoji, never reading them", () => {
  assert.deepEqual(screenText("swap 1 sol to usdc 💸💸"), { text: "swap 1 sol to usdc", emoji: 2 });
  assert.deepEqual(screenText("🚀 stake 2 sol 👍🏽"), { text: "stake 2 sol", emoji: 2 });
  assert.equal(screenText("swap 1 sol to usdc").emoji, 0);
});

test("screenText removes invisible, direction and control characters", () => {
  assert.equal(screenText("swap​ 1 sol‮ to usdc⁦").text, "swap 1 sol to usdc");
  assert.equal(screenText("swap 1\u0007 sol\tto\nusdc").text, "swap 1 sol to usdc");
});

test("screenText tidies quotes, dashes, ellipses and repeated punctuation, keeping question marks", () => {
  assert.equal(screenText("“swap” 1 sol — to usdc").text, "\"swap\" 1 sol - to usdc");
  assert.equal(screenText("bridge 20 usdc… then swap").text, "bridge 20 usdc then swap");
  assert.equal(screenText("bridge 20 usdc... then swap").text, "bridge 20 usdc then swap");
  assert.equal(screenText("swap 1 sol to usdc, thx!!").text, "swap 1 sol to usdc, thx!");
  assert.equal(screenText("swap 1 sol to usdc??").text, "swap 1 sol to usdc??");
});

test("screenText applies NFKC (fullwidth digits and letters become plain)", () => {
  assert.equal(screenText("swap １ ＳＯＬ to usdc").text, "swap 1 SOL to usdc");
});

test("screenText reports a word with letters outside the Latin script (homoglyphs)", () => {
  assert.equal(screenText("swap 1 sol to USDС").nonLatin, "USDС");
  assert.equal(screenText("swap 1 ЕТН to usdc").nonLatin, "ЕТН");
  assert.equal(screenText("swap 1 sοl to usdc").nonLatin, "sοl");
  assert.equal(screenText("swap 1 sol to usdc").nonLatin, undefined);
  // Latin letters with diacritics are Latin.
  assert.equal(screenText("send 5 usdc to café.eth").nonLatin, undefined);
});

test("screenText keeps addresses, names and numbers byte for byte", () => {
  const text = "send 1,000.5 usdc to 0x000000000000000000000000000000000000dEaD and 9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM and vitalik.eth";
  assert.equal(screenText(text).text, text);
});

test("normalizeMessage keeps a number word before a portion word (\"two thirds\")", () => {
  assert.equal(normalizeMessage("swap two thirds of my sol to usdc"), "swap two thirds of my sol to usdc");
  assert.equal(normalizeMessage("swap three quarters of my eth to usdc"), "swap three quarters of my eth to usdc");
  assert.equal(normalizeMessage("send two usdc to bob.eth"), "send 2 usdc to bob.eth");
  assert.equal(normalizeMessage("swap one half sol"), "swap one half sol");
  assert.equal(SPELLED_NUMBER_WORDS.two, "2");
});
