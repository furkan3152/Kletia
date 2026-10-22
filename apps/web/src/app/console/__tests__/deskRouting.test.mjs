// Where a console sentence goes: read-only rate questions are answered from
// the venue list without a wallet or an engine; goal sentences the planner
// understood never fall back to a network engine; the starters never put a
// literal placeholder in the composer; and "1-9 choose" works from the
// composer. Run with
//   node --test apps/web/src/app/console/__tests__/*.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { fillStarterAddress, STARTERS } from "../content/starters.ts";
import { isRateQuestion, networksNamedIn, routeSubmission } from "../state/deskModel.ts";
import { composerChoice, OTHER_OPTION_ID } from "../tasks/questionModel.ts";
import { routePlanFailure } from "../tasks/taskModel.ts";

test("read-only rate questions are recognised; transactions that mention a rate are not", () => {
  for (const text of [
    "compare yield",
    "show live Aave rates",
    "what is the best USDC rate on base",
    "Compare best yield for USDC among Aave, Moonwell, and Compound on Base Mainnet without preparing a transaction",
    "Show the live USDC supply and variable borrow rates from Aave V3 on Arbitrum without preparing a transaction",
    "Compare USDC borrow rates and available liquidity across Aave, Moonwell, and Compound on Base Mainnet without preparing a transaction",
  ]) {
    assert.equal(isRateQuestion(text), true, text);
  }
  for (const text of [
    "Supply 10 USDC to Aave V3 on Arbitrum One after checking the live reserve and rate",
    "put my USDC to work",
    "deposit 100 USDC into aave on base",
    "swap 1 SOL to USDC",
    "get me 0.01 ETH on arbitrum",
    "send 5 USDC to vitalik.eth",
  ]) {
    assert.equal(isRateQuestion(text), false, text);
  }
});

test("a rate question is read from the venue list even when an engine tool is pinned", () => {
  assert.deepEqual(routeSubmission({ text: "compare yield" }), { engine: "rates" });
  assert.deepEqual(routeSubmission({ text: "show live Aave rates", enginePin: "arbitrum" }), { engine: "rates" });
  // Any other pinned sentence still goes to its engine.
  assert.deepEqual(routeSubmission({ text: "Stake 100 WELL in the Moonwell Safety Module on Base Mainnet", enginePin: "base" }), { engine: "network", network: "base", why: "tool" });
  assert.deepEqual(routeSubmission({ text: "get me 0.01 ETH on arbitrum" }), { engine: "platform" });
});

const unsupported = (message, issue = "Not supported.") => ({ code: "INTENT_UNSUPPORTED", message, status: 422, issues: [{ path: "text", message: issue }] });

test("a goal the planner understood but could not route never goes to a network engine", () => {
  const context = { text: "get me 0.01 ETH on arbitrum", departure: "auto" };
  assert.deepEqual(routePlanFailure(unsupported("Kletia found no route for this with your holdings.", "No route."), context), { kind: "understood" });
  assert.deepEqual(routePlanFailure(unsupported("Kletia could not read your holdings for this request right now.", "Holdings unavailable."), { text: "consolidate to base", departure: "auto" }), { kind: "understood" });
  assert.deepEqual(routePlanFailure(unsupported("say which asset", "Ambiguous reference."), context), { kind: "understood" });
  // A sentence the planner cannot express still may go to the engine of the network it names.
  assert.deepEqual(routePlanFailure(unsupported('"compare" is not a supported action.'), { text: "compare borrow cost on base", departure: "auto" }), {
    kind: "unsupported",
    route: { engine: "network", network: "base", why: "fallback" },
  });
  // ...and is a neutral note when no engine serves it.
  assert.equal(routePlanFailure(unsupported('"asdfgh" is not a supported action.'), { text: "asdfgh on solana", departure: "auto" }).route.engine, "none");
});

test("starters never put a literal <address> into the composer", () => {
  const evm = "0x4f183e308f24c81c05303821AD025812fBFd807D";
  const solana = "86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY";
  assert.equal(fillStarterAddress("send 1 USDC to <address> on arc", { evm, solana: null }), `send 1 USDC to ${evm} on arc`);
  assert.equal(fillStarterAddress("send 0.1 SOL to <address> on solana devnet", { evm, solana }), `send 0.1 SOL to ${solana} on solana devnet`);
  assert.equal(fillStarterAddress("send 1 USDC to <address> on arc", { evm: null, solana }), "send 1 USDC on arc");
  assert.equal(fillStarterAddress("send 0.1 SOL to <address> on solana devnet", { evm, solana: null }), "send 0.1 SOL on solana devnet");
  assert.equal(fillStarterAddress("swap 1 SOL to USDC", { evm: null, solana: null }), "swap 1 SOL to USDC");
  for (const starter of STARTERS) {
    assert.ok(!fillStarterAddress(starter.sentence, { evm: null, solana: null }).includes("<"), starter.id);
    assert.ok(!fillStarterAddress(starter.sentence, { evm, solana }).includes("<"), starter.id);
  }
});

const question = (overrides = {}) => ({
  id: "q.actions.0.network",
  kind: "clarify",
  prompt: "Which network?",
  options: [
    { id: "base", label: "Base", network: "base" },
    { id: "solana", label: "Solana", network: "solana" },
  ],
  allowsText: false,
  ...overrides,
});

test("1-9 typed into the empty composer chooses the card's chip with the same number", () => {
  assert.deepEqual(composerChoice(question(), 1), { optionId: "base", label: "Base" });
  assert.deepEqual(composerChoice(question(), 2), { optionId: "solana", label: "Solana" });
  assert.equal(composerChoice(question(), 3), null);
  assert.equal(composerChoice(question(), 0), null);
  // An amount question takes the digit as text.
  assert.equal(composerChoice(question({ allowsText: true, questions: [{ id: "q.actions.0.amount", kind: "amount", options: [] }] }), 1), null);
  // Two questions in one card: the digits stay text.
  assert.equal(composerChoice(question({ questions: [{ id: "a", kind: "network", options: [] }, { id: "b", kind: "asset", options: [] }] }), 1), null);
  // "Other…" only expands the card.
  const many = question({ options: ["a", "b", "c", "d", "e", "f"].map((id) => ({ id, label: id.toUpperCase() })) });
  assert.equal(composerChoice(many, 4)?.optionId, "d");
  assert.equal(composerChoice(many, 5), null);
  assert.equal(OTHER_OPTION_ID, "desk:other");
});

test("every spelling of a test network is read from a sentence", () => {
  assert.deepEqual(networksNamedIn("send 0.001 ETH on arbitrum sepolia"), ["arbitrum-sepolia"]);
  assert.deepEqual(networksNamedIn("send 0.1 SOL on solana devnet"), ["solana-devnet"]);
  assert.deepEqual(networksNamedIn("bridge 5 USDC from arb sepolia to base"), ["arbitrum-sepolia", "base"]);
});

test("'Review and sign' that lands on another venue says so (and that the ticket number changed)", async () => {
  const { venueChangeNote } = await import("../tasks/taskModel.ts");
  const plan = (protocol) => ({ steps: [{ index: 0, protocol }] });
  assert.equal(venueChangeNote(plan("uniswap-v3"), plan("uniswap-v3")), null);
  assert.equal(venueChangeNote(null, plan("aerodrome")), null);
  const note = venueChangeNote(plan("uniswap-v3"), plan("aerodrome"));
  assert.match(note, /now uses Aerodrome instead of Uniswap V3/u);
  assert.match(note, /ticket number changed/u);
});

test("demo accounts read as demo accounts, never as the user's wallet", async () => {
  const { PREVIEW_ACCOUNT_IDS } = await import("@kletia/core");
  const { demoHolderLabel, isDemoAccount, labelDemoJourney } = await import("../tasks/demoAccounts.ts");
  const demo = PREVIEW_ACCOUNT_IDS[0];
  const address = demo.slice(demo.lastIndexOf(":") + 1);
  assert.equal(isDemoAccount(demo), true);
  assert.equal(isDemoAccount(`eip155:42161:${address}`), demo.startsWith("eip155:"));
  assert.equal(isDemoAccount("eip155:8453:0x4f183e308f24c81c05303821AD025812fBFd807D"), false);
  assert.equal(isDemoAccount(null), false);
  assert.equal(demoHolderLabel("Your Base wallet"), "Demo Base wallet (not yours)");
  assert.equal(demoHolderLabel("Aave V3 USDC"), "Aave V3 USDC");
  const journey = {
    stops: [
      { id: "start:s1", holder: { account: demo, own: true, label: "Your Base wallet" } },
      { id: "out:s1", holder: { account: "eip155:8453:0x4f183e308f24c81c05303821AD025812fBFd807D", own: true, label: "Your Base wallet" } },
    ],
  };
  const labelled = labelDemoJourney(journey);
  assert.deepEqual(labelled.stops.map((stop) => stop.holder.label), ["Demo Base wallet (not yours)", "Your Base wallet"]);
  const own = { stops: [journey.stops[1]] };
  assert.equal(labelDemoJourney(own), own);
});
