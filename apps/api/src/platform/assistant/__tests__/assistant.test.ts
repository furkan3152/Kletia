/**
 * The assistant engine offline: routing, time windows, the question reader,
 * the grounding check, the model steps with scripted providers (what is
 * sent, when a worded answer is kept or replaced), the eval corpus' gates and
 * the data API port (kinds, coverage, paging, periods, tracking off).
 *
 *   cd apps/api && node --import tsx --test src/platform/assistant/__tests__/assistant.test.ts
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { assistantRouteOf, type DataTransaction, type DataTransactionPage } from "@kletia/core";
import { scriptedProvider } from "../../engine/reading/scripted.js";
import { ReadingTransportError } from "../../engine/reading/provider.js";
import { assistantTransaction, dataApiPort, HISTORY_READ, periodFor, TRACKING_OFF } from "../dataPort.js";
import { assistantGates, fixtureAccess, fixturePort, fixtureReader, loadAssistantCorpus, runAssistantEval, walletSetOf } from "../evalHarness.js";
import { checkGrounding } from "../grounding.js";
import { AssistantModel, assistantModelConfigFromEnv, maskQuestion, validateModelQuery } from "../model.js";
import { parseQuestion } from "../parse.js";
import { ask } from "../service.js";
import { resolveWindow, windowPhrase } from "../windows.js";

const corpus = loadAssistantCorpus(fileURLToPath(new URL("./fixtures/assistant-corpus.json", import.meta.url)));
const NOW = Date.parse(corpus.now);
const alice = corpus.wallets.alice!;
const ON = { config: { switch: "on" as const, profiles: [{ model: "vendor/model", provider: "Pinned" }] }, log: () => undefined };

function askAlice(question: string, model: ConstructorParameters<typeof AssistantModel>[0] | null = null) {
  return ask({
    question,
    set: walletSetOf(alice),
    port: fixturePort(corpus, alice),
    model: model ? { model: new AssistantModel(model), scope: { scope: "test" } } : null,
    modelUnavailable: "off",
    now: NOW,
  });
}

describe("assistant routing", () => {
  it("routes questions about the person's data, portfolio requests and market questions; leaves instructions to the reader", () => {
    const cases: [string, ReturnType<typeof assistantRouteOf>][] = [
      ["how much did I spend on fees last month?", "portfolio-question"],
      ["what's my biggest position", "portfolio-question"],
      ["did I bridge to Solana this week", "portfolio-question"],
      ["show my trades on base", "portfolio-question"],
      ["my balance on arbitrum", "portfolio-question"],
      ["rebalance my portfolio to 60/40 ETH/USDC", "portfolio-action"],
      ["sell my worst performer", "portfolio-action"],
      ["move my idle stables to the best yield", "portfolio-action"],
      ["close everything risky", "portfolio-action"],
      ["what's the price of ETH", "market-question"],
      ["swap 1 SOL to USDC", null],
      ["sell all my SOL", null],
      ["put my idle stables to work", null],
      ["exit all my lending positions", null],
      ["what's the best yield for my USDC? put it there", null],
      ["hello", null],
    ];
    for (const [text, route] of cases) assert.equal(assistantRouteOf(text), route, text);
  });
});

describe("assistant windows", () => {
  it("reads window phrases and resolves them in UTC with Monday weeks", () => {
    assert.deepEqual(windowPhrase("fees last month")?.spec, { name: "last_month" });
    assert.deepEqual(windowPhrase("swaps in the last 10 days")?.spec, { name: "last_days", days: 10 });
    assert.deepEqual(windowPhrase("what did i do recently")?.spec, { name: "last_days", days: 30, assumed: true });
    assert.deepEqual(windowPhrase("fees in september")?.spec, { name: "month", month: 8 });
    const week = resolveWindow({ name: "this_week" }, NOW);
    assert.deepEqual([week.from, week.label], ["2026-10-19T00:00:00.000Z", "this week (since 19 Oct 2026)"]);
    const month = resolveWindow({ name: "last_month" }, NOW);
    assert.deepEqual([month.from, month.to, month.label], ["2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z", "September 2026"]);
    assert.equal(resolveWindow({ name: "month", month: 11 }, NOW).label, "December 2025", "a later month is last year's");
  });
});

describe("assistant question reader", () => {
  it("reads subjects, aggregates and filters", () => {
    const fees = parseQuestion("how much did I pay in bridge fees on base this month", "portfolio-question");
    assert.deepEqual(fees?.query, { subject: "fees", filter: { kinds: ["bridge"], networks: ["base"] }, aggregate: "total" });
    const bridged = parseQuestion("did I bridge to solana this week?", "portfolio-question");
    assert.deepEqual(bridged?.query, { subject: "transactions", filter: { kinds: ["bridge"], destinations: ["solana"] }, aggregate: "exists" });
    assert.deepEqual(parseQuestion("what's my biggest position", "portfolio-question")?.query, { subject: "holdings", filter: {}, aggregate: "top", limit: 1 });
    assert.equal(parseQuestion("explain my situation", "portfolio-question"), null);
  });
});

describe("assistant grounding", () => {
  const facts = [{ id: "f1", label: "Fees paid in September 2026", value: "$1.40", number: 1.4, unit: "usd" as const, source: "chain" as const, asOf: null }];
  it("accepts text built from the facts and refuses anything else", () => {
    assert.ok(checkGrounding("You paid $1.40 in fees in September 2026.", facts).ok);
    assert.deepEqual(checkGrounding("You paid $1.45 in fees.", facts).problems, ["number 1.45"]);
    assert.deepEqual(checkGrounding("You paid $1.40, mostly in ETH.", facts).problems, ["asset ETH"]);
    assert.deepEqual(checkGrounding("You paid $1.40 in October.", facts).problems, ["month October"]);
    assert.ok(checkGrounding("You paid $1.40 from 0x4f1859Ae1Ed5a8e1d1BE7d7df3F1A47De5BC6e5C.", facts).problems.includes("address"));
    assert.ok(checkGrounding("See https://example.com for $1.40.", facts).problems.includes("link"));
  });
});

describe("assistant model steps", () => {
  it("stays off without the switch, a key, models or a pinned provider", () => {
    assert.equal(assistantModelConfigFromEnv({}).offReason, "switch_off");
    assert.equal(assistantModelConfigFromEnv({ KLETIA_ASSISTANT: "on" }).offReason, "key_missing");
    assert.equal(assistantModelConfigFromEnv({ KLETIA_ASSISTANT: "on", OPENROUTER_API_KEY: "k", KLETIA_ASSISTANT_MODELS: "a/b" }).offReason, "provider_unpinned");
    const on = assistantModelConfigFromEnv({ KLETIA_ASSISTANT: "on", OPENROUTER_API_KEY: "k", KLETIA_ASSISTANT_MODELS: "a/b", KLETIA_ASSISTANT_PROFILES: '{"a/b":{"provider":"P","temperature":0}}' });
    assert.deepEqual(on, { switch: "on", profiles: [{ model: "a/b", provider: "P", temperature: 0 }] });
  });

  it("keeps a worded answer only when every number matches the facts, and never sends an address", async () => {
    const good = scriptedProvider(() => JSON.stringify({ text: "Last month (September 2026) you paid $1.40 in fees across 4 transactions." }));
    const kept = await askAlice("How much did I spend on fees last month?", { ...ON, provider: good });
    assert.deepEqual([kept.wording, kept.text], ["model", "Last month (September 2026) you paid $1.40 in fees across 4 transactions."]);
    const sent = good.calls[0]!;
    assert.equal(sent.purpose, "answer");
    assert.doesNotMatch(sent.user, /0x[0-9a-f]{6}|DRpb/iu, "no address leaves Kletia");
    assert.match(sent.user, /"value":"\$1\.40"/u);
    const invented = scriptedProvider(() => JSON.stringify({ text: "You paid $14.00 in fees last month." }));
    const replaced = await askAlice("How much did I spend on fees last month?", { ...ON, provider: invented });
    assert.deepEqual([replaced.wording, replaced.text], ["template", "You paid $1.40 in fees in September 2026, over 4 transactions."]);
    const down = scriptedProvider(() => {
      throw new ReadingTransportError("http_500", 500);
    });
    assert.equal((await askAlice("How much did I spend on fees last month?", { ...ON, provider: down })).wording, "template");
  });

  it("reads a question the parser cannot through the model, checked against the query shape", async () => {
    const provider = scriptedProvider((call) => (call.purpose === "reading"
      ? JSON.stringify({ subject: "holdings", aggregate: "top", window: null, days: null, month: null, kinds: [], assets: [], networks: [], protocols: [], by: null })
      : JSON.stringify({ text: "nothing grounded here: 42" })));
    const answer = await askAlice(`what slaps hardest among my stuff at ${alice.evm[0]}`, { ...ON, provider });
    assert.equal(answer.status, "answered");
    assert.equal(answer.understoodBy, "model");
    assert.match(answer.text, /SOL on Solana, worth \$377\.55/u);
    assert.match(provider.calls[0]!.user, /<wallet>/u);
    assert.equal(validateModelQuery('{"subject":"holdings","aggregate":"top","assets":["NOTATOKEN"]}'), null);
    assert.equal(validateModelQuery('{"subject":"drop tables"}'), null);
    assert.equal(maskQuestion("send to vitalik.eth or 0x4f1859Ae1Ed5a8e1d1BE7d7df3F1A47De5BC6e5C"), "send to <wallet> or <wallet>");
  });

  it("says plainly that a question needs the model when it is off", async () => {
    const answer = await askAlice("explain my situation");
    assert.equal(answer.status, "needs-model");
    assert.match(answer.text, /not available here/u);
  });
});

describe("assistant eval corpus", () => {
  it("passes every gate on the deterministic path", async () => {
    const rows = await runAssistantEval(corpus);
    const failed = rows.filter((row) => !row.correct).map((row) => `${row.question.id}: ${row.misses.join("; ")}`);
    const gates = assistantGates(rows);
    assert.ok(gates.every((gate) => gate.ok), `${JSON.stringify(gates)}\n${failed.join("\n")}`);
  });
});

describe("assistant data API port", () => {
  const set = walletSetOf(alice);

  it("folds the data API's kinds into the assistant's and keeps the History id, the arrival network and who paid the fee", async () => {
    const page = await fixturePort(corpus, alice).transactions(set, { from: null });
    const byHash = (prefix: string) => page.transactions.find((tx) => tx.hash.startsWith(prefix))!;
    const out = byHash("0x7431000");
    assert.deepEqual([out.id, out.kind, out.detail, out.destination, out.fee?.usd], ["base:0x7431000000000000000000000000000000000000000000000000000000000000", "bridge", "bridge-out", null, 0.4]);
    const arrival = page.transactions.find((tx) => tx.detail === "bridge-in" && tx.network === "solana")!;
    assert.deepEqual([arrival.kind, arrival.destination, arrival.fee], ["bridge", "solana", null], "a relayed arrival: the wallet paid nothing");
    assert.deepEqual([byHash("0x74314").kind, byHash("0x74314").status], ["failed", "failed"]);
    assert.equal(page.transactions.find((tx) => tx.detail === "receive")?.kind, "transfer");
    assert.equal(page.complete, true);
    const claim = assistantTransaction({ ...(page.transactions[0] as unknown as DataTransaction), id: "base:0x1", network: "base", hash: "0x1", account: set.accounts[0]!, time: corpus.now, block: null, kind: "contract-call", status: "success", legs: [], fee: null, counterparty: null, protocol: null, method: "claimRewards", kletiaIntentId: null, kletiaReceiptId: null, source: "alchemy", explorerUrl: "" }, "alchemy");
    assert.deepEqual([claim.kind, claim.fee?.usd, claim.fee?.reason], ["claim", null, "Alchemy does not report fees; ETHERSCAN_API_KEY on the API reads them."]);
  });

  it("names the missing provider variables instead of an empty history", async () => {
    const dave = corpus.wallets.dave!;
    const answer = await ask({ question: "How much did I spend on fees last month?", set: walletSetOf(dave), port: fixturePort(corpus, dave), model: null, modelUnavailable: "off", now: NOW });
    assert.equal(answer.status, "unknown");
    assert.ok(answer.gaps.some((gap) => /ETHERSCAN_API_KEY or ALCHEMY_API_KEY/u.test(gap) && /EVM wallet 1 on Base/u.test(gap)), answer.gaps.join("\n"));
    assert.doesNotMatch(JSON.stringify([answer.text, answer.gaps]), /0x78731D3C/iu, "accounts are labelled, never printed");
  });

  it("answers history with the desk step while tracking is off, and still reads holdings", async () => {
    const carol = corpus.wallets.carol!;
    const port = fixturePort(corpus, carol);
    const page = await port.transactions(walletSetOf(carol), { from: null });
    assert.deepEqual([page.coverage, page.reason], ["none", TRACKING_OFF]);
    assert.match(TRACKING_OFF, /Portfolio, then History, then "Turn on tracking"/u);
    assert.equal((await port.pnl(walletSetOf(carol), { by: "asset" })).total.usd, null);
    assert.equal((await port.summary(walletSetOf(carol))).holdings.length, 2);
  });

  it("reads a window page by page and says when it stopped early", async () => {
    const reader = fixtureReader(corpus, alice);
    let calls = 0;
    const endless = { ...reader, async transactions(): Promise<DataTransactionPage> {
      calls += 1;
      const base = await reader.transactions(fixtureAccess(alice).scope, { limit: 1 });
      return { ...base, cursor: "more" };
    } };
    const page = await dataApiPort(fixtureAccess(alice), endless, () => NOW).transactions(set, { from: null });
    assert.equal(calls, HISTORY_READ.pages);
    assert.deepEqual([page.truncated, page.complete], [true, false]);
  });

  it("maps a window to the history service's nearest period and says when it is wider", () => {
    const day = 86_400_000;
    assert.deepEqual(periodFor(new Date(NOW - 30 * day).toISOString(), undefined, NOW), { period: "30d", label: "the last 30 days", range: "30d", exact: true });
    assert.deepEqual(periodFor(new Date(NOW - 23 * day).toISOString(), undefined, NOW), { period: "30d", label: "the last 30 days", range: "30d", exact: false });
    assert.equal(periodFor(new Date(NOW - 40 * day).toISOString(), new Date(NOW - 10 * day).toISOString(), NOW).period, "all");
    assert.deepEqual(periodFor(null, undefined, NOW), { period: "all", label: "all time", range: "all", exact: true });
  });
});
