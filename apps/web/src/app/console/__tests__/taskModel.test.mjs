// Desk task rules: plan-failure routing, the wallets a plan still needs,
// SOURCE_REQUIRED candidates, serials and stamps. Run with
//   node --test apps/web/src/app/console/__tests__/*.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import {
  clockOf,
  fallbackSourceCandidates,
  fundSentence,
  missingWallets,
  namespacesOf,
  parseSourceDetails,
  routePlanFailure,
  serialOf,
  stampFor,
  taskStatusOf,
} from "../tasks/taskModel.ts";
import { buildHoldingsSnapshot, parsePortfolio } from "../state/holdings.ts";

const EVM = "0x4f183e308f24c81c05303821AD025812fBFd807D";
const bridge = {
  steps: [{ index: 0, network: "base", settlement: { destinationNetwork: "solana" } }],
  summary: { networks: ["base", "solana"] },
};
const swap = { steps: [{ index: 0, network: "solana" }], summary: { networks: ["solana"] } };

test("a plan needs a wallet for every network it touches, destinations included", () => {
  assert.deepEqual([...namespacesOf(bridge)].sort(), ["eip155", "solana"]);
  assert.deepEqual([...namespacesOf(swap)], ["solana"]);
  assert.deepEqual(missingWallets(bridge, { evm: false, solana: false }), ["eip155", "solana"]);
  assert.deepEqual(missingWallets(bridge, { evm: true, solana: false }), ["solana"]);
  assert.deepEqual(missingWallets(swap, { evm: true, solana: false }), ["solana"]);
  assert.deepEqual(missingWallets(swap, { evm: false, solana: true }), []);
});

test("SOURCE_REQUIRED, and the old 'Say where the funds come from' issue, ask where the money starts", () => {
  const context = { text: "bridge 25 USDC to solana", departure: "auto" };
  assert.deepEqual(routePlanFailure({ code: "SOURCE_REQUIRED", message: "No network holds 25 USDC.", status: 422 }, context), { kind: "source" });
  assert.deepEqual(
    routePlanFailure(
      { code: "INTENT_UNSUPPORTED", message: "x", status: 422, issues: [{ path: "text", message: "Say where the funds come from: bridge 25 USDC from base to solana." }] },
      context,
    ),
    { kind: "source" },
  );
  assert.deepEqual(routePlanFailure({ code: "SOURCE_UNREACHABLE", message: "x", status: 422 }, context), { kind: "unreachable" });
});

test("INTENT_UNSUPPORTED goes to a network engine only when Base, Arbitrum One or Arc is named or departs", () => {
  const unsupported = { code: "INTENT_UNSUPPORTED", message: "x", status: 422 };
  assert.deepEqual(
    routePlanFailure(unsupported, { text: "stake 100 WELL in the moonwell safety module on base", departure: "auto" }),
    { kind: "unsupported", route: { engine: "network", network: "base", why: "fallback" } },
  );
  assert.deepEqual(routePlanFailure(unsupported, { text: "do something clever", departure: "arc" }).route, {
    engine: "network",
    network: "arc",
    why: "fallback",
  });
  assert.equal(routePlanFailure(unsupported, { text: "do something clever", departure: "auto" }).route.engine, "offer");
  assert.equal(routePlanFailure(unsupported, { text: "do something on polygon", departure: "auto" }).route.engine, "none");
  assert.equal(routePlanFailure(unsupported, { text: "swap a meme coin on solana", departure: "base" }).route.engine, "none");
});

test("every other refusal is final; transport failures retry; a missing wallet shows the preview", () => {
  const context = { text: "send 5 USDC to me on base", departure: "base" };
  for (const code of ["SELF_TRANSFER", "SOLANA_RECIPIENT_NOT_WALLET", "CAPITAL_LANE_MIXED", "INSUFFICIENT_BALANCE", "POLICY_DENIED"]) {
    assert.deepEqual(routePlanFailure({ code, message: "x", status: 422 }, context), { kind: "refused" }, code);
  }
  assert.deepEqual(routePlanFailure({ code: "UNREACHABLE", message: "x", status: 0 }, context), { kind: "retry" });
  assert.deepEqual(routePlanFailure({ code: "RATE_LIMITED", message: "x", status: 429 }, context), { kind: "retry" });
  assert.deepEqual(routePlanFailure({ code: "UPSTREAM_UNAVAILABLE", message: "x", status: 503 }, context), { kind: "retry" });
  assert.deepEqual(routePlanFailure({ code: "ACCOUNT_REQUIRED", message: "x", status: 422 }, context), { kind: "needs-wallet" });
});

test("SOURCE_REQUIRED details are validated, funded networks first, junk dropped", () => {
  const parsed = parseSourceDetails({
    asset: "USDC",
    amount: "25",
    toNetwork: "solana",
    candidates: [
      { network: "base", balance: "3.10", enough: false },
      { network: "arbitrum", balance: "40.00", enough: true },
      { network: "nope", balance: "1", enough: true },
      { network: "base", balance: "99", enough: true },
      { network: "optimism", balance: "<script>", enough: "yes" },
    ],
  });
  assert.deepEqual(parsed, {
    asset: "USDC",
    amount: "25",
    candidates: [
      { network: "arbitrum", balance: "40.00", enough: true },
      { network: "base", balance: "3.10", enough: false },
      { network: "optimism", balance: null, enough: null },
    ],
  });
  assert.equal(parseSourceDetails(null), null);
  assert.equal(parseSourceDetails({ candidates: "base" }), null);
  assert.equal(parseSourceDetails({ asset: "<b>", amount: "1e9", candidates: [] }).asset, null);
});

test("without details the lane's networks are offered, the best funded first, balances never invented", () => {
  const holdings = buildHoldingsSnapshot({
    lane: "production",
    observedAt: "2026-10-14T12:00:00Z",
    portfolios: [
      parsePortfolio({
        account: `eip155:42161:${EVM}`,
        holdings: [{ asset: "a", symbol: "USDC", amount: "40000000", decimals: 6, formatted: "40", usd: 40 }],
      }),
    ],
  });
  const production = fallbackSourceCandidates("production", holdings);
  assert.equal(production.length, 6);
  assert.equal(production[0].network, "arbitrum");
  assert.ok(production.every((candidate) => candidate.balance === null && candidate.enough === null));
  assert.deepEqual(fallbackSourceCandidates("testnet", null).map((candidate) => candidate.network), ["arc", "arbitrum-sepolia", "solana-devnet"]);
});

test("serials, stamps and statuses", () => {
  assert.equal(serialOf("int_7f3ac21e"), "7F3A-C21E");
  assert.equal(serialOf("1b2c3d4e-0000-4000-8000-00000000a2c9"), "0000-A2C9");
  assert.equal(stampFor("review"), "planned");
  // Executing is "signed" only once a signature exists.
  assert.equal(stampFor("executing"), "planned");
  assert.equal(stampFor("executing", "none"), "planned");
  assert.equal(stampFor("executing", "signed"), "signed");
  assert.equal(stampFor("completed"), "settled");
  assert.equal(stampFor("paused"), "held");
  assert.equal(stampFor("failed"), "failed");
  assert.equal(taskStatusOf("idle"), null);
  assert.equal(taskStatusOf("executing"), "executing");
  assert.equal(fundSentence("base", "solana-devnet"), "bridge 25 USDC from base to solana devnet");
  assert.equal(clockOf(Date.UTC(2026, 9, 14, 12, 44)), "12:44 UTC");
  assert.equal(clockOf("2026-10-14T07:05:00.000Z"), "07:05 UTC");
  assert.equal(clockOf("not a date"), "");
});
