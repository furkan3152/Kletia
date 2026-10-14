// The desk's pure model, with the six tests of its first prototype, plus the board, accounts, departure line and
// composer rules. Run with
//   node --test apps/web/src/app/console/__tests__/*.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { NETWORK_KEYS } from "@kletia/core";

import {
  accountsForLane,
  composerVerdict,
  COMPOSER_LIMIT,
  departureCaption,
  departureLine,
  departureOptions,
  departureRequestFields,
  departureRowLabel,
  healthReadings,
  journeyEnds,
  laneOf,
  LEGACY_NETWORKS,
  networksNamedIn,
  offeredNetworks,
  parseDeparture,
  routeSubmission,
} from "../state/deskModel.ts";
import { parsePortfolio } from "../state/holdings.ts";

const EVM = "0x4f183e308f24c81c05303821AD025812fBFd807D";
const SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

// --- The prototype's six tests (unchanged assertions) ----------------------

test("the departure picker offers Auto plus all nine registry networks", () => {
  const options = departureOptions();
  assert.equal(options.production.length + options.testnet.length, 9);
  assert.deepEqual(options.production.map((o) => o.key), ["base", "arbitrum", "ethereum", "optimism", "polygon", "solana"]);
  assert.deepEqual(options.testnet.map((o) => o.key), ["arc", "arbitrum-sepolia", "solana-devnet"]);
});
test("a network whose RPC is down is disabled with a reason; a missing wallet is only a hint", () => {
  const options = departureOptions({ health: { polygon: { ok: false } }, wallets: { evm: true, solana: false } });
  const polygon = options.production.find((o) => o.key === "polygon");
  const solana = options.production.find((o) => o.key === "solana");
  assert.equal(polygon.disabled, true);
  assert.match(polygon.disabledReason, /No service/u);
  assert.equal(solana.disabled, false);
  assert.match(solana.walletHint, /Solana wallet/u);
});
test("planner accounts follow the lane and departure, not the wallet's current chain", () => {
  assert.deepEqual(accountsForLane({ evm: EVM, solana: SOL }, "production", "auto"), [`eip155:8453:${EVM}`, `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${SOL}`]);
  assert.deepEqual(accountsForLane({ evm: EVM, solana: SOL }, "production", "polygon"), [`eip155:137:${EVM}`, `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${SOL}`]);
  assert.deepEqual(accountsForLane({ evm: EVM, solana: SOL }, laneOf("arbitrum-sepolia"), "arbitrum-sepolia"), [`eip155:421614:${EVM}`, `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:${SOL}`]);
  assert.equal(laneOf("solana-devnet"), "testnet");
  assert.equal(laneOf("auto"), "production");
});
test("network words are read from the registry, OP Mainnet and Polygon included", () => {
  assert.deepEqual(networksNamedIn("swap 10 USDC to WETH on polygon"), ["polygon"]);
  assert.deepEqual(networksNamedIn("send 5 USDC to vitalik.eth on op mainnet"), ["optimism"]);
  assert.deepEqual(networksNamedIn("bridge 25 USDC from base to solana"), ["base", "solana"]);
});
test("platform first; only INTENT_UNSUPPORTED can fall back to a network engine", () => {
  assert.deepEqual(routeSubmission({ text: "swap 1 SOL to USDC" }), { engine: "platform" });
  assert.deepEqual(routeSubmission({ text: "stake 100 WELL in the moonwell safety module on base", platformError: "INTENT_UNSUPPORTED" }), { engine: "network", network: "base", why: "fallback" });
  assert.deepEqual(routeSubmission({ text: "stake 1 USDC in kletia staking", departure: "arc", platformError: "INTENT_UNSUPPORTED" }), { engine: "network", network: "arc", why: "fallback" });
  assert.equal(routeSubmission({ text: "send 5 USDC to x", platformError: "SOLANA_RECIPIENT_NOT_WALLET" }).engine, "none");
  assert.equal(routeSubmission({ text: "swap 10 USDC to WETH on polygon", platformError: "INTENT_UNSUPPORTED" }).why, "network-without-engine");
  assert.equal(routeSubmission({ text: "stake 2 SOL somewhere on solana", platformError: "INTENT_UNSUPPORTED" }).why, "solana");
  assert.equal(routeSubmission({ text: "launch a token called KLT", platformError: "INTENT_UNSUPPORTED" }).engine, "offer");
  assert.deepEqual(routeSubmission({ text: "anything", enginePin: "base" }), { engine: "network", network: "base", why: "tool" });
});
test("journey ends come from the first step and the last destination", () => {
  const intent = { steps: [{ index: 1, network: "solana", kind: "deposit" }, { index: 0, network: "base", kind: "bridge", settlement: { destinationNetwork: "solana" } }] };
  assert.deepEqual(journeyEnds(intent), { from: "base", to: "solana" });
});

// --- Board ------------------------------------------------------------------

test("the board offers 9 networks where today's switcher offers 4, the test yard collapsed unless a testnet is the departure", () => {
  const board = departureOptions();
  assert.equal(NETWORK_KEYS.length, 9);
  assert.equal(board.production.length, 6, "six production networks first");
  assert.equal(board.testnet.length, 3, "three test networks in the yard");
  assert.equal(board.auto.key, "auto");
  assert.equal(board.yardCollapsed, true);
  assert.equal(departureOptions({ current: "base" }).yardCollapsed, true);
  assert.equal(departureOptions({ current: "arc" }).yardCollapsed, false);
  assert.equal(departureOptions({ current: "solana-devnet" }).yardCollapsed, false);
  for (const option of [...board.production, ...board.testnet]) {
    assert.equal(option.disabled, false, `${option.key} is enabled without health data`);
    assert.equal(option.status, "unknown");
  }
});

test("a network the deployment does not offer is disabled; latency marks a running network as delayed", () => {
  const offered = offeredNetworks([{ key: "base" }, { key: "solana" }, { key: "not-a-network" }]);
  assert.deepEqual(offered, ["base", "solana"]);
  const health = healthReadings([
    { network: "base", ok: true, latencyMs: 96 },
    { network: "solana", ok: true, latencyMs: 2400 },
    { network: "ethereum", ok: false, latencyMs: 0 },
    { network: "nowhere", ok: true, latencyMs: 1 },
  ]);
  const board = departureOptions({ health, offered });
  const byKey = Object.fromEntries([...board.production, ...board.testnet].map((option) => [option.key, option]));
  assert.equal(byKey.base.status, "running");
  assert.equal(byKey.solana.status, "delayed");
  assert.equal(byKey.solana.disabled, false, "delayed is information, not a refusal");
  assert.equal(byKey.ethereum.status, "not-offered");
  assert.match(byKey.ethereum.disabledReason, /Not available on this deployment/u);
  assert.equal(byKey.arc.disabled, true);
  assert.equal(healthReadings(null).base, undefined);
  assert.equal(offeredNetworks(undefined), null);
});

test("a row reads like a sentence; testnets never print dollars; a missing balance is not called empty", () => {
  const base = parsePortfolio({
    account: `eip155:8453:${EVM}`,
    network: "base",
    holdings: [
      { asset: "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6, amount: "120400000", formatted: "120.4", usd: 120.4, isNative: false },
      { asset: "eip155:8453/slip44:60", symbol: "ETH", decimals: 18, amount: "2000000000000000", formatted: "0.002", usd: 7.1, isNative: true },
    ],
  });
  const arc = parsePortfolio({ account: `eip155:5042002:${EVM}`, holdings: [{ symbol: "USDC", decimals: 6, amount: "10000000", formatted: "10", usd: 10, isNative: false }] });
  const board = departureOptions({ holdings: { base, arc }, health: { base: { ok: true, latencyMs: 90 } } });
  const row = board.production.find((option) => option.key === "base");
  assert.equal(departureRowLabel(row), "Base, production, 120.4 USDC and 0.002 ETH, about 128 dollars, running");
  const yard = board.testnet.find((option) => option.key === "arc");
  assert.equal(departureRowLabel(yard), "Arc Testnet, test yard, 10 USDC, status unknown");
  const unread = board.production.find((option) => option.key === "polygon");
  assert.equal(departureRowLabel(unread), "Polygon PoS, production, status unknown");
});

test("the chip caption: Kletia picks, most funds, the balance here, empty here, test yard", () => {
  const base = parsePortfolio({ account: `eip155:8453:${EVM}`, holdings: [{ symbol: "USDC", decimals: 6, amount: "127500000", formatted: "127.5", usd: 127.5 }] });
  const empty = parsePortfolio({ account: `eip155:10:${EVM}`, holdings: [] });
  assert.equal(departureCaption({ departure: "auto", holdings: null, walletsConnected: false, mostFundedNetwork: null }), "Kletia picks");
  assert.equal(departureCaption({ departure: "auto", holdings: null, walletsConnected: true, mostFundedNetwork: "base" }), "most funds: Base");
  assert.equal(departureCaption({ departure: "base", holdings: base, walletsConnected: true, mostFundedNetwork: "base" }), "$127.50 here");
  assert.equal(departureCaption({ departure: "optimism", holdings: empty, walletsConnected: true, mostFundedNetwork: "base" }), "empty here");
  assert.equal(departureCaption({ departure: "arc", holdings: null, walletsConnected: true, mostFundedNetwork: "base" }), "test yard");
  const unpriced = parsePortfolio({ account: `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${SOL}`, holdings: [{ symbol: "BONK", decimals: 5, amount: "100000000", formatted: "1000", usd: null }] });
  assert.equal(departureCaption({ departure: "solana", holdings: unpriced, walletsConnected: true, mostFundedNetwork: null }), "1000 BONK here");
  assert.equal(departureCaption({ departure: "polygon", holdings: null, walletsConnected: false, mostFundedNetwork: null }), "", "nothing read yet: no caption");
});

// --- Accounts and requests -----------------------------------------------------

test("accounts are homed on the departure's EVM chain only when it is on the lane; missing wallets add nothing", () => {
  assert.deepEqual(accountsForLane({ evm: EVM }, "production", "arc"), [`eip155:8453:${EVM}`], "a testnet departure never homes a production plan");
  assert.deepEqual(accountsForLane({ solana: SOL }, "testnet", "arc"), [`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:${SOL}`]);
  assert.deepEqual(accountsForLane({ evm: EVM, solana: SOL }, "testnet", "solana-devnet"), [`eip155:5042002:${EVM}`, `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:${SOL}`]);
  assert.deepEqual(accountsForLane({ evm: EVM }, "production", "solana"), [`eip155:8453:${EVM}`]);
  assert.deepEqual(accountsForLane({}, "production", "auto"), []);
});

test("a departure becomes sourceNetwork (and defaultNetwork for a fixed network); stored values are parsed strictly", () => {
  assert.deepEqual(departureRequestFields("auto"), { sourceNetwork: "auto" });
  assert.deepEqual(departureRequestFields("polygon"), { sourceNetwork: "polygon", defaultNetwork: "polygon" });
  assert.equal(parseDeparture("auto"), "auto");
  assert.equal(parseDeparture("arbitrum-sepolia"), "arbitrum-sepolia");
  for (const value of ["", "Auto", "BASE", "mainnet", null, undefined, 8453, "__proto__"]) {
    assert.equal(parseDeparture(value), null, String(value));
  }
});

test("only Base, Arbitrum One and Arc have network engines; the offer lists exactly them", () => {
  assert.deepEqual([...LEGACY_NETWORKS], ["base", "arbitrum", "arc"]);
  assert.deepEqual(routeSubmission({ text: "launch a token called KLT", platformError: "INTENT_UNSUPPORTED" }), { engine: "offer", networks: LEGACY_NETWORKS });
  assert.deepEqual(routeSubmission({ text: "launch a token on arbitrum", platformError: "INTENT_UNSUPPORTED" }), { engine: "network", network: "arbitrum", why: "fallback" });
  assert.equal(routeSubmission({ text: `send 5 USDC to ${SOL}`, platformError: "INTENT_UNSUPPORTED" }).why, "solana", "a Solana address never reaches an EVM engine");
  assert.equal(routeSubmission({ text: "bridge 25 USDC from base to solana", platformError: "SOURCE_UNREACHABLE" }).why, "refused");
  assert.deepEqual(routeSubmission({ text: "swap on base", platformError: "INTENT_UNSUPPORTED", departure: "polygon" }), { engine: "network", network: "base", why: "fallback" });
});

// --- Ticket departure line ------------------------------------------------------

test("the ticket prints the departure the plan actually uses, for every chosen value", () => {
  const bridge = { index: 0, network: "base", settlement: { destinationNetwork: "solana" } };
  const swap = { index: 1, network: "solana" };
  const plan = (departure) => ({ steps: [bridge, swap], interpretation: { departure } });
  assert.deepEqual(departureLine({ requested: "auto", intent: plan({ network: "base", chosen: "auto", bridged: true }), holding: "120.40 USDC" }), {
    text: "Departs Base · picked by Kletia: 120.40 USDC there",
    tone: "plain",
    action: "change",
  });
  assert.equal(departureLine({ requested: "auto", intent: plan({ network: "base", chosen: "auto" }) }).text, "Departs Base · picked by Kletia");
  assert.equal(departureLine({ requested: "base", intent: { steps: [swap], interpretation: { departure: { network: "solana", chosen: "request" } } } }).text, "Departs Solana, as you chose");
  assert.equal(departureLine({ requested: "base", intent: plan({ network: "base", chosen: "request", bridged: true }) }).text, "Departs Base, as you chose · Kletia adds a bridge to Solana first");
  assert.deepEqual(departureLine({ requested: "arbitrum", intent: plan({ network: "base", chosen: "text" }) }), {
    text: "Departs Base · your sentence names it (the departure said Arbitrum)",
    tone: "notice",
    action: null,
  });
  assert.equal(departureLine({ requested: "auto", intent: plan({ network: "base", chosen: "inferred" }) }).text, "Departs Base");
});

test("an API without interpretation.departure never hides a plan that starts elsewhere", () => {
  const solanaFirst = { steps: [{ index: 0, network: "solana" }], interpretation: {} };
  assert.deepEqual(departureLine({ requested: "base", intent: solanaFirst }), {
    text: "This plan starts on Solana, not Base.",
    tone: "notice",
    action: "start-from-requested",
  });
  assert.equal(departureLine({ requested: "solana", intent: solanaFirst }).text, "Departs Solana");
  assert.equal(departureLine({ requested: "auto", intent: solanaFirst }).text, "Departs Solana");
  assert.equal(departureLine({ requested: "auto", intent: { steps: [] } }), null);
});

// --- Composer -------------------------------------------------------------------

test("the composer refuses empty, over-long and secret sentences before anything leaves the browser", () => {
  assert.deepEqual(composerVerdict("   "), { kind: "empty" });
  assert.deepEqual(composerVerdict("a".repeat(COMPOSER_LIMIT + 1)), { kind: "too-long", limit: 500 });
  assert.equal(composerVerdict(`swap 1 SOL to USDC ${"x".repeat(COMPOSER_LIMIT - 30)}`).kind, "sentence");
  assert.deepEqual(composerVerdict(`import key 0x${"ab".repeat(32)}`), { kind: "secret" });
  assert.deepEqual(composerVerdict("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"), { kind: "secret" });
  assert.deepEqual(composerVerdict("seed phrase: alpha beta gamma delta epsilon zeta eta theta"), { kind: "secret" });
});

test("template placeholders block the submit and are selected; desk commands open views; anything else is planned", () => {
  const text = "Acquire exactly 0.001 ETH gas on Arbitrum through Across, spending at most [EDIT MAX USDC] Base USDC";
  const verdict = composerVerdict(text);
  assert.equal(verdict.kind, "placeholder");
  assert.equal(verdict.placeholder, "[EDIT MAX USDC]");
  assert.equal(text.slice(verdict.start, verdict.end), "[EDIT MAX USDC]");
  assert.equal(composerVerdict("send 1 USDC to <address> on arc").placeholder, "<address>");
  assert.deepEqual(composerVerdict("Show my portfolio"), { kind: "command", view: "holdings" });
  assert.deepEqual(composerVerdict("  show   my balances "), { kind: "command", view: "holdings" });
  assert.deepEqual(composerVerdict("show my activity"), { kind: "command", view: "activity" });
  assert.deepEqual(composerVerdict("open tools"), { kind: "command", view: "tools" });
  assert.deepEqual(composerVerdict("show my portfolio on base"), { kind: "sentence", text: "show my portfolio on base" });
  assert.deepEqual(composerVerdict(" swap 1 SOL to USDC "), { kind: "sentence", text: "swap 1 SOL to USDC" });
});
