// Tool copy for people, not integrators (GAPS section 4): the x402 panel opens with a plain-English
// explanation before its controls, and the Solana lending rates panel says which venues its table
// covers instead of implying Jupiter Lend is listed. Run with
//   node --test apps/web/src/networks/base/__tests__/toolCopy.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\s+/gu, " ");

test("the x402 panel explains what x402 is and that searching spends nothing", () => {
  const source = read("../components/x402/X402ServiceRouter.tsx");
  const intro = source.indexOf("charge a few cents per request");
  assert.ok(intro > 0, "plain-English intro");
  assert.ok(intro < source.indexOf("<input"), "the intro comes before the controls");
  assert.match(source, /Searching is free and never spends anything/u);
  assert.match(source, /only ever happens when you approve it in your wallet/u);
  assert.doesNotMatch(source, /Buyer mode \/ read only/u);
});

test("the Solana lending rates panel names Kamino as its source and says where Jupiter Lend's rate appears", () => {
  const source = read("../../solana/components/SolanaYields.tsx");
  assert.match(source, /Live lending rates from Kamino's main market/u);
  assert.match(source, /Jupiter Lend is not in this table yet/u);
});
