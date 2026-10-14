/**
 * Clarifying questions as display data and cards: labels, the suggested
 * chip, two questions in one card, assumption chips, the announcement, the
 * values-free `onClarify` event and the copy rules.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSUMPTION_CHIPS_MAX,
  assumptionViews,
  clarifyEventOf,
  clarifyView,
} from "../dist/review.js";

const THREAD = { spec: "kletia.thread/v1", id: "th_aaaaaaaaaaaaaaaaaaaaaaaa", rev: 1, status: "needs_input", policy: "2026-10.1", steps: [], open: ["actions[0].amount"], corrections: [], turns: [], undo: [] };

/** B01, first turn. */
const b01 = {
  status: "needs_input",
  turn: "message",
  questions: [
    {
      id: "q.actions.0.amount", field: "actions[0].amount", kind: "amount", reason: "AMOUNT_MISSING", purpose: true,
      prompt: "How much SOL?", why: "You hold 2.5 SOL on Solana.",
      options: [
        // A purpose gap never carries a suggestion, even if a server marks one.
        { id: "all", label: "All · 2.49 SOL", detail: "Keeps 0.01 SOL for network fees", sentence: "swap 2.49 SOL to USDC on solana", recommended: true },
        { id: "half", label: "Half · 1.25 SOL", sentence: "swap 1.25 SOL to USDC on solana" },
      ],
      allowsText: true, placeholder: "Amount in SOL",
    },
  ],
  assumptions: [],
  draft: { summary: "Swap SOL to USDC on Solana", sentence: null, missing: ["actions[0].amount"], steps: [] },
  thread: THREAD,
};

/** D06: destination and amount in one card. */
const d06 = {
  ...b01,
  questions: [
    { id: "q.actions.0.toNetwork", field: "actions[0].toNetwork", kind: "choice", reason: "DESTINATION_MISSING", purpose: true, prompt: "Where should the USDC go?", why: "", options: ["arbitrum", "ethereum", "optimism", "polygon", "solana"].map((id) => ({ id, label: id, network: id })), allowsText: true },
    { id: "q.actions.0.amount", field: "actions[0].amount", kind: "amount", reason: "AMOUNT_MISSING", purpose: true, prompt: "How much USDC?", why: "You hold 120.40 USDC on Base.", options: [{ id: "all", label: "All · 120.40 USDC" }, { id: "half", label: "Half · 60.20 USDC" }], allowsText: true },
    { id: "q.extra", field: "x", kind: "choice", reason: "VENUE_MISSING", purpose: false, prompt: "Third?", why: "", options: [], allowsText: false },
  ],
  draft: { ...b01.draft, summary: "Bridge USDC from Base" },
};

/** I02-like means question: the venue default is suggested (one at most). */
const venue = {
  ...b01,
  questions: [{
    id: "q.actions.0.protocol", field: "actions[0].protocol", kind: "choice", reason: "VENUE_MISSING", purpose: false,
    prompt: "Where should 100 USDC earn yield on Base?", why: "Each venue has its own rate and risks; rates are variable.",
    options: [
      { id: "aave", label: "Aave V3", detail: "Aave V3 USDC", recommended: true },
      { id: "compound", label: "Compound V3", recommended: true },
      { id: "‮evil", label: "Morpho‮", detail: "x".repeat(300) },
    ],
    allowsText: false,
  }],
};

const plannedWithChips = {
  status: "planned",
  turn: "answer",
  intent: { id: "int_x" },
  sentence: "bridge 50 USDC from solana to base, then deposit it into aave on base",
  assumptions: [
    { id: "a.actions.0.protocol", field: "actions[1].protocol", label: "Aave V3", reason: "Kletia's default venue.", source: "default", material: false, alternatives: [{ id: "compound", label: "Compound V3" }] },
    { id: "a.actions.0.toNetwork", field: "actions[0].toNetwork", label: "Starts on Solana: bridges to Base first", reason: "Your departure is Solana.", source: "context", material: true, alternatives: ["arbitrum", "ethereum", "optimism", "polygon", "x5"].map((id) => ({ id, label: id, network: id === "x5" ? "nowhere" : id })) },
    { id: "a.3", field: "f", label: "Third", reason: "r", source: "default", material: false, alternatives: [] },
    { id: "a.4", field: "f", label: "Fourth", reason: "r", source: "default", material: true, alternatives: [] },
  ],
  thread: { ...THREAD, status: "ready", open: [] },
};

test("clarifyView: one question, its labels and why, no suggestion on a purpose gap, the announcement", () => {
  const view = clarifyView(b01);
  assert.equal(view.title, "One question");
  assert.equal(view.summary, "Swap SOL to USDC on Solana");
  assert.equal(view.questions.length, 1);
  const question = view.questions[0];
  assert.equal(question.prompt, "How much SOL?");
  assert.equal(question.why, "You hold 2.5 SOL on Solana.");
  assert.equal(question.placeholder, "Amount in SOL");
  assert.deepEqual(question.options.map((option) => [option.id, option.label, option.suggested]), [["all", "All · 2.49 SOL", false], ["half", "Half · 1.25 SOL", false]]);
  assert.equal(view.card.kind, "clarify");
  assert.equal(view.card.allowsText, true);
  assert.equal(view.card.options.some((option) => option.recommended), false);
  assert.equal(view.announcement, "Kletia has a question about Swap SOL to USDC on Solana: How much SOL? Two choices.");
});

test("clarifyView: two independent questions in one card, at most two", () => {
  const view = clarifyView(d06);
  assert.equal(view.title, "Two quick details");
  assert.equal(view.questions.length, 2);
  assert.equal(view.card.questions.length, 2);
  assert.equal(view.card.id, "q.actions.0.toNetwork", "the first question mirrors the card's fields");
  assert.deepEqual(view.questions[0].options.map((option) => option.network), ["arbitrum", "ethereum", "optimism", "polygon", "solana"]);
  assert.match(view.announcement, /^Kletia has two questions about Bridge USDC from Base: /u);
});

test("clarifyView: a means question suggests at most one option; text is cleaned and bounded", () => {
  const view = clarifyView(venue);
  const options = view.questions[0].options;
  assert.deepEqual(options.map((option) => option.suggested), [true, false, false]);
  assert.equal(view.card.options.filter((option) => option.recommended).length, 1);
  assert.equal(options[2].label, "Morpho");
  assert.ok(options[2].detail.length <= 96);
  assert.equal(view.announcement.endsWith("Three choices."), true);
});

test("assumption chips: material first, at most three, alternatives bounded, networks checked", () => {
  const chips = assumptionViews(plannedWithChips.assumptions);
  assert.equal(chips.length, ASSUMPTION_CHIPS_MAX);
  assert.deepEqual(chips.map((chip) => chip.id), ["a.actions.0.toNetwork", "a.4", "a.actions.0.protocol"]);
  assert.equal(chips[0].alternatives.length, 4);
  assert.ok(chips[0].alternatives.every((option) => option.suggested === false));
  const view = clarifyView(plannedWithChips);
  assert.equal(view.card, null);
  assert.equal(view.summary, plannedWithChips.sentence);
  assert.match(view.announcement, /^Kletia assumed: Starts on Solana: bridges to Base first, Your departure is Solana; Fourth, r\.$/u);
  assert.equal(clarifyView({ status: "cancelled", turn: "control", thread: THREAD }).assumptions.length, 0);
});

test("clarifyEventOf: count, reasons, kinds and purpose, never values", () => {
  const event = clarifyEventOf(d06);
  assert.deepEqual(event, {
    count: 2,
    reasons: ["DESTINATION_MISSING", "AMOUNT_MISSING"],
    questions: [
      { reason: "DESTINATION_MISSING", kind: "choice", purpose: true },
      { reason: "AMOUNT_MISSING", kind: "amount", purpose: true },
    ],
  });
  const text = JSON.stringify(clarifyEventOf(b01));
  for (const value of ["SOL", "2.49", "How much", "swap", "th_"]) assert.equal(text.includes(value), false, value);
  assert.equal(clarifyEventOf(plannedWithChips), null);
});

test("copy rules: the widget's own clarify copy has no em dashes and says network, never chain", () => {
  for (const response of [b01, d06, venue, plannedWithChips]) {
    const view = clarifyView(response);
    for (const text of [view.title, view.announcement.replace(/: .*$/u, "")]) {
      assert.equal(/—/u.test(text), false, text);
      assert.equal(/\bchain\b/iu.test(text), false, text);
    }
  }
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

test("ClarifyCard: a labelled group, radios with a roving tab stop, numbers, Suggested in words, free text and Not now", async (t) => {
  const s = await server(t);
  if (!s) return;
  const html = s.render(s.h(s.widget.ClarifyCard, { question: clarifyView(venue).card, onAnswer: () => undefined, onDismiss: () => undefined }));
  assert.ok(/role="group" aria-labelledby="[^"]+"/u.test(html));
  assert.ok(html.includes('role="radiogroup"'));
  assert.equal((html.match(/role="radio"/gu) ?? []).length, 3);
  assert.equal((html.match(/tabindex="0"/gu) ?? []).length, 1, "one tab stop per question");
  assert.ok(html.includes('data-suggested="true"'));
  assert.ok(html.includes(">Suggested<"));
  assert.ok(html.includes("Not now"));
  assert.equal(html.includes("<input"), false, "no free text where the question allows none");

  const two = s.render(s.h(s.widget.ClarifyCard, { question: clarifyView(d06).card, onAnswer: () => undefined, onDismiss: () => undefined }));
  assert.ok(two.includes("Two quick details"));
  assert.ok(two.includes("1 of 2") && two.includes("2 of 2"));
  assert.equal((two.match(/role="radiogroup"/gu) ?? []).length, 2);
  assert.equal((two.match(/<input/gu) ?? []).length, 2);
  assert.ok(two.includes('placeholder="Type your answer"'));

  const pending = s.render(s.h(s.widget.ClarifyCard, { question: clarifyView(b01).card, pending: "all", onAnswer: () => undefined, onDismiss: () => undefined }));
  assert.ok(pending.includes('aria-checked="true"'));
  assert.ok(pending.includes("Sending…"));
  assert.ok(/<button[^>]*disabled=""[^>]*>Not now<\/button>/u.test(pending), "nothing else can be pressed while an answer is sent");
});

test("AssumptionChips: Kletia assumed, material marked in words, alternatives behind a disclosure", async (t) => {
  const s = await server(t);
  if (!s) return;
  const html = s.render(s.h(s.widget.AssumptionChips, { assumptions: plannedWithChips.assumptions, onChange: () => undefined }));
  assert.ok(html.includes("Kletia assumed"));
  assert.ok(html.includes(">Material<"));
  assert.ok(html.includes('aria-expanded="false"'));
  assert.equal((html.match(/class="kw-assume-chip"/gu) ?? []).length + (html.match(/class="kw-assume-chip" data-material/gu) ?? []).length >= 3, true);
  assert.equal(s.render(s.h(s.widget.AssumptionChips, { assumptions: [], onChange: () => undefined })), "");
});
