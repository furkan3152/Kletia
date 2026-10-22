// Explorer links exist only for something on-chain (GAPS 3.2): a quote
// binding or a provider quote id in quote evidence is never a transaction,
// so no "View on Basescan" button appears before a signature. Run with
//   node --test apps/web/src/shared/platform/__tests__/*.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { sourceEvidence, stepExplorerLinks } from "../intentLinks.ts";

const HASH = `0x${"ab".repeat(32)}`;
const at = "2026-10-22T20:00:00.000Z";
const step = (evidence, references = []) => ({ id: "s1", network: "base", evidence, references });

test("a prepared step with only quote evidence has no explorer link", () => {
  const prepared = step([
    { kind: "quote", network: "base", observedAt: at, reference: "cd".repeat(32), detail: "Prepared 2 transaction(s) with Aerodrome." },
    { kind: "quote", network: "base", observedAt: at, reference: "relay-request-0123456789abcdef", detail: "Settlement request prepared." },
    { kind: "note", network: "base", observedAt: at, detail: "Prepared." },
    { kind: "balance", network: "base", observedAt: at, reference: "ef".repeat(32) },
  ]);
  assert.deepEqual(stepExplorerLinks(prepared), []);
  assert.equal(sourceEvidence(prepared), undefined);
});

test("transactions, receipts, settlements and submitted references are linked", () => {
  const sent = step([{ kind: "transaction", network: "base", observedAt: at, reference: HASH.slice(2) }], [HASH.slice(2)]);
  const links = stepExplorerLinks(sent);
  assert.equal(links.length, 1);
  assert.match(links[0].url, /^https:\/\/basescan\.org\/tx\//u);
  assert.equal(sourceEvidence(sent)?.kind, "transaction");
  const settled = step([{ kind: "settlement", network: "solana", observedAt: at, reference: "5".repeat(88) }]);
  assert.match(stepExplorerLinks(settled)[0]?.label ?? "", /^Settlement on /u);
  const submittedOnly = step([], [HASH.slice(2)]);
  assert.equal(stepExplorerLinks(submittedOnly).length, 1);
});
