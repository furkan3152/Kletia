/**
 * The journey in the widget: the shared view model (severity order,
 * folding, copy, the observed glyph), the prompt card and the vertical
 * route. Journeys are built by core's `buildJourney` from the P2e fixture
 * (captured live, copied from packages/core) with hand-written facts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildJourney } from "@kletia/core";
import {
  JOURNEY_CERTAINTY_INFO,
  JOURNEY_HANDLE_IT_OPTION,
  SEVERITY_SIGNS,
  consequenceFactsKey,
  journeyModel,
  journeyPromptView,
  validJourneyAnswers,
} from "../dist/review.js";

const AT = "2026-10-14T13:40:00.000Z";
const EMPTY_EVM = "0xde4bd9c9350682d24a10f5a4e4129cc4ba770d5e";
const EMPTY_SOL = "CmScyaDDQjK7wgsCc2GWjWew68ZZLVzFpidArohV58Rw";
const USDC_BASE = "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ETH_BASE = "eip155:8453/slip44:60";
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501";

const { graph, preview } = JSON.parse(readFileSync(new URL("./fixtures/journey-p2-empty.json", import.meta.url), "utf8"));

const native = (amount) => ({ amount: String(amount), at: AT });
const fee = (network, asset, amount, certainty = "estimated") => ({ network, asset: { asset, symbol: asset.includes("501") ? "SOL" : "ETH", decimals: asset.includes("501") ? 9 : 18 }, amount: String(amount), certainty });

function facts(overrides = {}) {
  return {
    at: AT,
    reads: "live",
    native: { [`base:${EMPTY_EVM}`]: native(10n ** 16n), [`solana:${EMPTY_SOL}`]: native(10n ** 9n) },
    gasPrice: {},
    solanaRent: { walletLamports: "650240", tokenAccountLamports: "1488440", at: AT },
    tokenAccounts: {},
    prices: {
      [USDC_BASE]: { usd: 1, source: "usd-par", at: AT },
      [USDC_SOL]: { usd: 1, source: "usd-par", at: AT },
      [ETH_BASE]: { usd: 2480, source: "jupiter", at: AT },
      [SOL]: { usd: 106, source: "jupiter", at: AT },
    },
    venues: {},
    policy: null,
    allowances: [],
    fees: { s1: fee("solana", SOL, 105_000), s2: fee("base", ETH_BASE, "1649511814328", "simulated-assumed-funds") },
    exitFees: {},
    gasOptions: { s1: { topup: true, gasLeg: null } },
    funding: {},
    ...overrides,
  };
}

/** P2e with no ETH on Base: R1 blocks leg 2 (top-up recommended, bring gas, nothing else). */
const blocked = () => buildJourney(graph, preview, facts({ native: { [`base:${EMPTY_EVM}`]: native(0), [`solana:${EMPTY_SOL}`]: native(10n ** 9n) }, exitFees: { base: "500000000000" } }), AT);
const fine = () => buildJourney(graph, preview, facts(), AT);
/** Leg 1 landed (observed), leg 2 failed: the money waits at the arrival stop. */
function failedLater() {
  const landed = { ...graph.steps[0].minimumOutput, amount: "99950000", formatted: "99.95" };
  const later = {
    ...graph,
    status: "partially_completed",
    steps: graph.steps.map((step) => step.id === "s1"
      ? { ...step, status: "settled", actualOutput: landed, references: ["5".repeat(88)] }
      : { ...step, status: "failed", failure: { code: "PREPARE_FAILED", message: "Aave refused the supply." } }),
  };
  return buildJourney(later, preview, facts(), AT);
}

test("SEVERITY_SIGNS: block octagon, act diamond, warn triangle, info circle, each with a word", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(SEVERITY_SIGNS).map(([severity, sign]) => [severity, [sign.tone, sign.shape]])),
    { block: ["danger", "octagon"], act: ["warning", "diamond"], warn: ["warning", "triangle"], info: ["info", "circle"] },
  );
  for (const sign of Object.values(SEVERITY_SIGNS)) {
    assert.ok(sign.word.length > 0 && sign.spoken.length > 0);
    assert.ok(Object.isFrozen(sign), "safety signage is not themable");
  }
  assert.ok(Object.isFrozen(SEVERITY_SIGNS));
});

test("observed has its own glyph (a filled square) next to the fare's certainties", () => {
  assert.equal(JOURNEY_CERTAINTY_INFO.observed.shape, "square");
  assert.equal(JOURNEY_CERTAINTY_INFO.observed.label, "observed");
  assert.equal(JOURNEY_CERTAINTY_INFO["venue-minimum"].shape, "diamond");
});

test("journeyModel: stops and legs in reading order with words for every amount, holder and custody", () => {
  const model = journeyModel(fine());
  assert.equal(model.header.title, "Itinerary");
  assert.match(model.header.line, /^2 legs · Solana → Base/u);
  assert.deepEqual(model.route.map((item) => (item.type === "stop" ? item.stop.id : `leg ${item.leg.number}`)), ["start:s1", "leg 1", "transit:s1", "out:s1", "leg 2", "out:s2"]);
  const start = model.stops[0];
  assert.equal(start.kindLabel, "Start");
  assert.equal(start.networkName, "Solana");
  assert.equal(start.custodyLabel, "In your wallet");
  assert.equal(start.holdings[0].expected, "100 USDC");
  assert.equal(start.holdings[0].usd, "$100.00");
  assert.equal(start.holdings[0].usdSource, "par");
  const arrival = model.stops.find((stop) => stop.id === "out:s1");
  assert.equal(arrival.holdings[0].certainty, "venue-minimum");
  assert.equal(arrival.holdings[0].atLeast, "99.4563 USDC");
  assert.equal(arrival.holdings[0].roleText, "Spent by leg 2");
  assert.match(arrival.heading, /^Arrival: Base, Your Base wallet, 99\.956.* USDC, the venue's committed minimum, at least 99\.4563 USDC, In your wallet/u);
  const transit = model.stops.find((stop) => stop.id === "transit:s1");
  assert.equal(transit.custody, "provider");
  assert.match(transit.custodyLabel, /holds it$/u);
  const leg1 = model.legs[0];
  assert.match(leg1.line, /^Relay · about \d+ s/u);
  assert.match(leg1.refund, /refunds up to 100 USDC to your Solana wallet/u);
  assert.equal(model.stops.filter((stop) => stop.here).map((stop) => stop.id).join(), fine().now.stopIds.join());
  assert.equal(model.outcome, null, "no outcome before departure");
  assert.match(model.nowLine, /^You are here: your Solana wallet\. Next: leg 1 needs your signature\.$/u);
});

test("journeyModel: severity order, blocks never folded, the rest folded as core decided", () => {
  const journey = blocked();
  const model = journeyModel(journey);
  const all = [...model.notices.expanded, ...model.notices.folded];
  assert.equal(all.length, journey.consequences.length);
  const order = ["block", "act", "warn", "info"];
  for (let index = 1; index < model.notices.expanded.length; index += 1) {
    assert.ok(order.indexOf(model.notices.expanded[index - 1].severity) <= order.indexOf(model.notices.expanded[index].severity), "expanded in severity order");
  }
  const block = model.notices.expanded.find((notice) => notice.id === "gas-to-continue:out:s1");
  assert.ok(block, "the blocker is expanded");
  assert.equal(block.sign.shape, "octagon");
  assert.equal(block.blocking, true);
  assert.ok(block.source.startsWith("Facts: "));
  assert.deepEqual(model.blockers.map((notice) => notice.id), ["gas-to-continue:out:s1"]);
  assert.deepEqual(model.prompts, ["gas-to-continue:out:s1"]);
  for (const notice of model.notices.folded) assert.notEqual(notice.severity, "block");
  const collapsed = new Set(journey.consequences.filter((entry) => entry.collapsed).map((entry) => entry.id));
  for (const notice of model.notices.folded) assert.ok(collapsed.has(notice.id));

  const answered = journeyModel(journey, { answered: { "gas-to-continue:out:s1": "bring-gas" } });
  assert.equal(answered.blockers.length, 0);
  assert.equal(answered.prompts.length, 0);
  assert.match(answered.notices.expanded.find((notice) => notice.id === "gas-to-continue:out:s1").answer, /^I will bring ETH/u);
  // An answer that is not one of the options answers nothing.
  assert.equal(journeyModel(journey, { answered: { "gas-to-continue:out:s1": "made-up" } }).blockers.length, 1);
});

test("journeyModel: a failed later leg says where the money is, observed, and waits for a decision", () => {
  const model = journeyModel(failedLater());
  assert.ok(model.outcome);
  assert.equal(model.outcome.title, "Your money is here");
  const line = model.outcome.lines[0];
  assert.equal(line.certainty, "observed");
  assert.equal(line.certaintyInfo.shape, "square");
  assert.match(line.sentence, /^99\.95 USDC in your Base wallet 0xde4b…0d5e/u);
  assert.equal(model.nowLine, "Kletia waits for your decision before anything else is signed.");
  assert.equal(model.legs[1].failure, "Aave refused the supply.");
  assert.ok(model.prompts.includes("if-stopped:out:s1"), "the act with a recommendation is asked");
});

test("journeyModel: copy is cleaned and only https links survive", () => {
  const journey = fine();
  const hostile = {
    ...journey,
    stops: journey.stops.map((stop, index) => (index === 0 ? { ...stop, holder: { ...stop.holder, label: "Your‮wallet" }, evidence: { reference: "x", url: "javascript:alert(1)" } } : stop)),
    legs: journey.legs.map((leg) => ({ ...leg, tracking: { url: "http://relay.link/x", label: "Track" } })),
    consequences: [...journey.consequences, { id: "refund-path:x", kind: "refund-path", severity: "info", stopId: null, legIds: [], title: "T", detail: "D", certainty: "quoted", facts: {}, source: "", collapsed: false, options: [{ id: "track", label: "Track", effect: "", costUsd: null, recommended: false, action: { type: "link", url: "javascript:void(0)" } }] }],
  };
  const model = journeyModel(hostile);
  assert.equal(model.stops[0].holderLabel, "Your wallet");
  assert.equal(model.stops[0].evidenceUrl, null);
  assert.ok(model.legs.every((leg) => leg.tracking === null));
  const link = model.notices.expanded.find((notice) => notice.id === "refund-path:x");
  assert.equal(link.options[0].url, null);
  const text = JSON.stringify(journeyModel(blocked()));
  assert.equal(/—/u.test(text.replace(/"(detail|title|effect|label|refund|source)":"[^"]*"/gu, "")), false, "no em dashes in the widget's own copy");
});

test("journeyPromptView: question, options with effects, the default suggested, no free text, I will handle it last", () => {
  const journey = blocked();
  const r1 = journey.consequences.find((entry) => entry.id === "gas-to-continue:out:s1");
  const card = journeyPromptView(r1);
  assert.equal(card.kind, "journey");
  assert.equal(card.allowsText, false);
  assert.equal(card.prompt, r1.prompt.question);
  assert.deepEqual(card.options.map((option) => option.id), ["gas-topup", "bring-gas"]);
  assert.equal(card.options[0].recommended, true);
  assert.equal(card.options[1].recommended, undefined);
  assert.equal(card.options[0].detail, r1.options[0].effect);
  assert.match(card.note, /^Facts: /u);
  // An act prompt without a do-it-yourself option gets "I will handle it", last.
  const act = { ...r1, severity: "act", options: [r1.options[0]], prompt: { question: "Add gas?", defaultOptionId: "gas-topup" } };
  const actCard = journeyPromptView(act);
  assert.equal(actCard.options.at(-1).id, JOURNEY_HANDLE_IT_OPTION);
  assert.equal(actCard.options.at(-1).label, "I will handle it");
  // The consequence's own "ok" goes last even when listed first.
  const ok = { id: "ok", label: "I will handle it", effect: "Nothing changes.", costUsd: null, recommended: false, action: { type: "acknowledge" } };
  assert.equal(journeyPromptView({ ...r1, options: [ok, ...r1.options] }).options.at(-1).id, "ok");
  assert.equal(journeyPromptView({ ...r1, prompt: undefined }), null);
  assert.equal(journeyPromptView({ ...r1, severity: "info" }), null);
});

test("validJourneyAnswers: an answer is asked again when its facts changed or its option is gone", () => {
  const journey = blocked();
  const r1 = journey.consequences.find((entry) => entry.id === "gas-to-continue:out:s1");
  const memory = { [r1.id]: { option: "bring-gas", facts: consequenceFactsKey(r1) } };
  assert.deepEqual(validJourneyAnswers(journey, memory), { [r1.id]: "bring-gas" });
  const worse = { ...journey, consequences: journey.consequences.map((entry) => (entry.id === r1.id ? { ...entry, facts: { ...entry.facts, need: "9999999999999" } } : entry)) };
  assert.deepEqual(validJourneyAnswers(worse, memory), {});
  assert.deepEqual(validJourneyAnswers(journey, { [r1.id]: { option: "gone", facts: consequenceFactsKey(r1) } }), {});
  assert.deepEqual(validJourneyAnswers(null, memory), {});
});

/* ---------------------------------------------------------- rendering */

async function server(t) {
  try {
    const [{ renderToStaticMarkup }, react, widget] = await Promise.all([import("react-dom/server"), import("react"), import("../dist/index.js")]);
    return { render: (element) => renderToStaticMarkup(element), h: react.createElement, widget };
  } catch {
    t.skip("react-dom is not installed");
    return null;
  }
}

test("JourneyRoute: an ordered list of stops with spoken headings, signs with words, the prompt as radios, the rest folded", async (t) => {
  const s = await server(t);
  if (!s) return;
  const journey = blocked();
  const html = s.render(s.h(s.widget.JourneyRoute, { journey, answered: {}, onAnswer: () => undefined }));
  assert.ok(html.includes('class="kw-journey"'));
  assert.ok(html.includes('aria-live="off"'));
  assert.ok(html.includes("<ol class=\"kw-jr-route\">"));
  assert.ok((html.match(/<h5 class="kw-jr-stop-h">/gu) ?? []).length === journey.stops.length);
  assert.ok(html.includes("Start: Solana"), "stops are headings spoken in words");
  assert.ok(html.includes("You are here"));
  assert.ok(html.includes("Before you sign · one question"));
  assert.ok(html.includes('role="radiogroup"'));
  assert.ok(html.includes('role="radio"'));
  assert.ok(html.includes("Suggested"));
  assert.equal(html.includes("Not now"), false, "a blocker cannot be dismissed");
  // The notice keeps its sign while its question is asked right under it.
  assert.ok(/<span class="kw-sev" data-severity="block">.*Stop.*<\/span>/u.test(html));
  assert.ok(html.indexOf('data-severity="block"') < html.indexOf("kw-jr-prompt"));
  if (journey.consequences.some((entry) => entry.collapsed)) assert.ok(/More about this route \(\d+\)/u.test(html));
  // Answered: no card, the notice prints the answer.
  const answered = s.render(s.h(s.widget.JourneyRoute, { journey, answered: { "gas-to-continue:out:s1": "bring-gas" }, onAnswer: () => undefined }));
  assert.equal(answered.includes('role="radiogroup"'), false);
  assert.ok(answered.includes("Your answer: I will bring ETH"));
  assert.ok(/role="note" data-severity="block"/u.test(answered));
  // While a clarify question is open, the journey's prompt waits.
  const held = s.render(s.h(s.widget.JourneyRoute, { journey, answered: {}, onAnswer: () => undefined, holdPrompt: true }));
  assert.equal(held.includes('role="radiogroup"'), false);
  // Over: where the money is now, with the observed square.
  const over = s.render(s.h(s.widget.JourneyRoute, { journey: failedLater(), answered: {}, onAnswer: () => undefined }));
  assert.ok(over.includes("Your money is here"));
  assert.ok(over.includes("observed on-chain"));
  assert.ok(over.includes('<rect x="1.5" y="1.5" width="9" height="9"'));
});
