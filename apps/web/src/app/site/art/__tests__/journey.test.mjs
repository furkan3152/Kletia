// The journey map's pure parts: layouts for 1 to 6 stops, ETA and countdown
// text, custody stamps, how legs are drawn, "where your money is now" in
// plain sentences and the live region's arrival announcements. Journeys are
// built by core's buildJourney from the P2e fixture (Solana USDC, Relay to
// Base, Aave V3), captured live in packages/core. Run with
//   node --test apps/web/src/app/site/art/__tests__/journey.test.mjs
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildJourney, CUSTODY_STATES } from "@kletia/core";
import { journeyModel } from "@kletia/widget/review";

import {
  countdownText,
  CUSTODY_STAMPS,
  custodyStamp,
  etaText,
  horizontalFrom,
  isOverdue,
  JOURNEY_HORIZONTAL_MIN_PX,
  journeyAnnouncement,
  journeyLayout,
  legDrawing,
  legLeaving,
  placeOf,
  whereMoneyIs,
} from "../journeyFormat.ts";
import { STATUS_TONES, toneFor } from "../../ui/statusTones.ts";

const AT = "2026-10-14T13:40:00.000Z";
const EMPTY_EVM = "0xde4bd9c9350682d24a10f5a4e4129cc4ba770d5e";
const EMPTY_SOL = "CmScyaDDQjK7wgsCc2GWjWew68ZZLVzFpidArohV58Rw";
const USDC_BASE = "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ETH_BASE = "eip155:8453/slip44:60";
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501";

const FIXTURE = fileURLToPath(new URL("../../../../../../../packages/core/test/fixtures/journey/p2-empty.json", import.meta.url));
const { graph, preview } = JSON.parse(readFileSync(FIXTURE, "utf8"));

const native = (amount) => ({ amount: String(amount), at: AT });
const fee = (network, asset, amount, certainty = "estimated") => ({
  network,
  asset: { asset, symbol: asset.includes("501") ? "SOL" : "ETH", decimals: asset.includes("501") ? 9 : 18 },
  amount: String(amount),
  certainty,
});

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

const landed = () => ({ ...graph.steps[0].minimumOutput, amount: "99950000", formatted: "99.95" });

/** Leg 1 landed (observed); leg 2 per `second` (failed, or skipped after a stop). */
function afterLegOne(second) {
  const later = {
    ...graph,
    status: second === "skipped" ? "partially_completed" : "failed",
    steps: graph.steps.map((step) =>
      step.id === "s1"
        ? { ...step, status: "settled", actualOutput: landed(), references: ["5".repeat(88)] }
        : second === "skipped"
          ? { ...step, status: "skipped" }
          : { ...step, status: "failed", failure: { code: "RESERVE_UNAVAILABLE", message: "Aave V3 USDC on Base is at its supply cap." } },
    ),
  };
  return buildJourney(later, preview, facts(), AT);
}

test("layouts for 1 to 6 stops: horizontal from 720 px with 150 px per station, vertical below and beyond 6", () => {
  assert.equal(JOURNEY_HORIZONTAL_MIN_PX, 720);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(horizontalFrom), [720, 720, 720, 720, 750, 900]);
  assert.equal(horizontalFrom(7), null);
  assert.equal(horizontalFrom(0), null);
  for (const stops of [1, 2, 3, 4, 5, 6]) {
    assert.deepEqual(journeyLayout(stops, 1440), { orientation: "horizontal", columns: stops }, `${stops} stops at 1440`);
    assert.deepEqual(journeyLayout(stops, 390), { orientation: "vertical", columns: 1 }, `${stops} stops at 390`);
    assert.equal(journeyLayout(stops, 719).orientation, "vertical");
  }
  assert.equal(journeyLayout(4, 720).orientation, "horizontal");
  assert.equal(journeyLayout(6, 899).orientation, "vertical", "six cards need 900 px");
  assert.equal(journeyLayout(6, 900).orientation, "horizontal");
  assert.equal(journeyLayout(8, 2000).orientation, "vertical", "long journeys run as a strip");
  assert.equal(journeyLayout(3, null).orientation, "vertical", "unmeasured maps never overflow a phone");
  assert.equal(journeyLayout(3, Number.NaN).orientation, "vertical");
});

test("ETA, countdown and overdue text", () => {
  assert.equal(etaText(0.2), "about 1 s");
  assert.equal(etaText(20), "about 20 s");
  assert.equal(etaText(89), "about 89 s");
  assert.equal(etaText(90), "about 2 min");
  assert.equal(etaText(3600), "about 1 h");
  assert.equal(etaText(3900), "about 1 h 5 min");
  assert.equal(etaText(-1), null);
  assert.equal(etaText(Number.NaN), null);
  assert.equal(etaText(undefined), null);
  assert.equal(countdownText(12, false), "about 12 s left");
  assert.equal(countdownText(0, false), "arriving now");
  assert.equal(countdownText(12, true), "taking longer than usual");
  assert.equal(countdownText(null, false), null);
  const start = Date.parse(AT);
  assert.equal(isOverdue(start, 20, start + 49_000), false, "short legs get 30 s of slack");
  assert.equal(isOverdue(start, 20, start + 51_000), true);
  assert.equal(isOverdue(start, 600, start + 899_000), false, "half again the expected time");
  assert.equal(isOverdue(start, 600, start + 901_000), true);
  assert.equal(isOverdue(null, 20, start), false);
  assert.equal(isOverdue(start, null, start + 1e9), false, "unknown expectations are never overdue");
});

test("custody stamps name every custody state in words", () => {
  for (const custody of CUSTODY_STATES) {
    assert.ok(CUSTODY_STAMPS[custody] && CUSTODY_STAMPS[custody].length <= 16, custody);
    assert.equal(custodyStamp(custody), CUSTODY_STAMPS[custody]);
  }
  assert.equal(custodyStamp("venue", "Aave V3 USDC"), "At Aave V3 USDC");
  assert.equal(custodyStamp("provider"), "In transit");
  assert.equal(custodyStamp("refund-due"), "Refund due");
  assert.equal(custodyStamp("bogus"), "Unknown");
});

test("legs: cross-network legs are a dashed interchange transfer until they arrive; Solana runs on the SVM gauge", () => {
  const svm = (network) => network === "solana";
  assert.deepEqual(legDrawing({ crossNetwork: true, status: "ready" }, "solana", svm), { style: "transfer", dashed: true, gauge: "svm", moving: false, done: false });
  assert.deepEqual(legDrawing({ crossNetwork: true, status: "settling" }, "solana", svm), { style: "transfer", dashed: true, gauge: "svm", moving: true, done: false });
  assert.deepEqual(legDrawing({ crossNetwork: true, status: "settled" }, "solana", svm), { style: "transfer", dashed: false, gauge: "svm", moving: false, done: true });
  assert.deepEqual(legDrawing({ crossNetwork: false, status: "awaiting signature" }, "base", svm), { style: "line", dashed: false, gauge: "standard", moving: false, done: false });
  const model = journeyModel(buildJourney(graph, preview, facts(), AT));
  assert.equal(legLeaving("out:s1", model.legs), 2);
  assert.equal(legLeaving("out:s2", model.legs), null);
});

test("a partially completed bridge then deposit says 99.95 USDC in your Base wallet", () => {
  const journey = afterLegOne("skipped");
  const model = journeyModel(journey);
  assert.ok(model.outcome, "the journey is over: it says where the money is");
  const lines = whereMoneyIs(journey, model);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].sentence, "99.95 USDC in your Base wallet");
  assert.equal(lines[0].certainty, "observed");
  assert.equal(lines[0].spoken, "observed on-chain");
  assert.ok(lines[0].account?.toLowerCase().endsWith(EMPTY_EVM), "the full account is kept for the title");
  assert.ok(lines[0].accountShort && lines[0].accountShort.includes("…"), "the account is shortened, the full value kept");
  // A failed second leg: the money waits at the arrival stop, in the same words.
  const failed = afterLegOne("failed");
  const waiting = whereMoneyIs(failed, journeyModel(failed));
  assert.equal(waiting[0]?.sentence, "99.95 USDC in your Base wallet");
  // Before departure nothing is claimed.
  const planned = buildJourney(graph, preview, facts(), AT);
  assert.deepEqual(whereMoneyIs(planned, journeyModel(planned)), []);
});

test("places in words: only the user's own wallet is 'your'", () => {
  const stop = (custody, holderLabel) => ({ custody, networkName: "Base", holderLabel });
  assert.equal(placeOf(stop("wallet", "Your Base wallet"), true), "in your Base wallet");
  assert.equal(placeOf(stop("wallet", "0x0000…dEaD"), false), "in 0x0000…dEaD on Base");
  assert.equal(placeOf(stop("venue", "Aave V3 USDC"), true), "at Aave V3 USDC on Base");
  assert.equal(placeOf(stop("provider", "Relay (in transit)"), true), "with Relay (in transit)");
  assert.equal(placeOf(stop("third-party", "vitalik.eth"), false), "paid to vitalik.eth on Base");
  assert.equal(placeOf(stop("refund-due", "Relay"), true), "due back as a refund on Base");
  assert.match(placeOf(stop("unknown", "?"), true), /cannot confirm/u);
});

test("the live region announces arrival once, and a new blocker, never a repeat", () => {
  const planned = journeyModel(buildJourney(graph, preview, facts(), AT));
  const arrivedJourney = afterLegOne("failed");
  const arrived = journeyModel(arrivedJourney);
  assert.equal(journeyAnnouncement(null, planned), null, "the first render says nothing");
  assert.equal(journeyAnnouncement(planned, planned), null, "the same stop says nothing");
  assert.equal(journeyAnnouncement(planned, arrived, arrivedJourney), "Arrived: 99.95 USDC in your Base wallet.");
  assert.equal(journeyAnnouncement(arrived, arrived, arrivedJourney), null);
  const blocked = journeyModel(
    buildJourney(graph, preview, facts({ native: { [`base:${EMPTY_EVM}`]: native(0), [`solana:${EMPTY_SOL}`]: native(10n ** 9n) }, exitFees: { base: "500000000000" } }), AT),
  );
  assert.ok(blocked.blockers.length > 0, "no ETH on Base blocks leg 2");
  assert.match(journeyAnnouncement(planned, blocked), /^Kletia needs an answer before the next signature: /u);
  assert.equal(journeyAnnouncement(blocked, blocked), null);
});

test("statusTones maps the journey severities to tones with the sign words", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(STATUS_TONES["journey-severity"]).map(([key, entry]) => [key, [entry.tone, entry.label]])),
    { block: ["danger", "Stop"], act: ["warning", "Act"], warn: ["warning", "Warning"], info: ["info", "Info"] },
  );
  assert.equal(toneFor("journey-severity", "bogus").tone, "neutral");
});

test("the journey stylesheet stops the train under reduced motion and the map module prints no em dash", () => {
  const dir = fileURLToPath(new URL("..", import.meta.url));
  const css = readFileSync(join(dir, "journey.css"), "utf8");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.kla-jm__train\s*\{\s*animation:\s*none;/u);
  assert.match(css, /\[data-kl-paused\] \.kla-jm__train/u, "off-screen maps pause the train");
  for (const file of readdirSync(dir).filter((name) => /^(JourneyMap\.tsx|journeyFormat\.ts|journey\.css)$/u.test(name))) {
    assert.ok(!readFileSync(join(dir, file), "utf8").includes("—"), `${file} has no em dash`);
  }
});
