import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { previewDigest } from "@kletia/core";
import { cli, send, stubServer } from "./helpers.mjs";

const EVM = "0x5eed00000000000000000000000000000000c0de";
const USDC_BASE = "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const USDC_ARB = "eip155:42161/erc20:0xaf88d065e77c8cc2239327c5edb3a432268e5831";

async function preview(intentId) {
  const row = (network, asset, expected, worst, usd, certainty, role = "you") => ({
    network, account: `${network === "base" ? "eip155:8453" : "eip155:42161"}:${EVM}`, asset, symbol: "USDC", decimals: 6, listed: true,
    expected: { amount: "0", formatted: expected, ...(usd === null ? {} : { usd }) }, worst: { amount: "0", formatted: worst, ...(usd === null ? {} : { usd }) }, certainty, steps: ["s1"], role,
  });
  const body = {
    spec: "kletia.preview/v1", intentId, computedAt: "2026-10-09T13:40:12.418Z", stage: "refresh", basis: "partial", digest: "",
    rows: [row("base", USDC_BASE, "-100", "-100", -100, "simulated"), row("arbitrum", USDC_ARB, "99.965772", "99.465943", null, "venue-minimum")],
    payments: [],
    fees: [
      { stepId: "s1", network: "base", kind: "network", label: "Base network fee", usd: 0.0016, paid: "on-top", certainty: "simulated" },
      { stepId: "s1", network: "base", kind: "venue", label: "Relay relayer fee", formatted: "0.034228", asset: { asset: USDC_BASE, symbol: "USDC", decimals: 6 }, usd: 0.03, paid: "deducted", certainty: "quoted" },
    ],
    approvals: [{ stepId: "s1", network: "base", token: { asset: USDC_BASE, symbol: "USDC", decimals: 6 }, spender: "0x4cd00e387622c35bddb9b4c962c136462338bc31", spenderLabel: "Relay depository", amount: "100000000", formatted: "100", leftAfter: "0" }],
    steps: [{ stepId: "s1", network: "base", kind: "bridge", status: "simulated", at: "x", deltas: [], payments: [], fees: [], approvals: [], issues: [{ code: "PREVIEW_ALLOWANCE_LEFT", severity: "warn", message: "No allowance is left." }] }],
    totals: { youPayUsd: 100.0, youGetUsd: { expected: null, worst: null }, paidToOthersUsd: { expected: 0, worst: 0 }, networkFeesUsd: 0.0016, venueFeesUsd: 0.03, extraCostsUsd: 0, costUsd: { expected: null, worst: null }, priceDifferenceUsd: null, unpriced: [USDC_ARB] },
    arrival: { network: "arbitrum", seconds: 16 },
    needs: [{ network: "arbitrum", account: `eip155:42161:${EVM}`, asset: { asset: "eip155:42161/slip44:60", symbol: "ETH", decimals: 18 }, amount: "8000000000000", formatted: "0.000008", reason: "gas-on-arrival", have: "0" }],
    warnings: ["Step 2 was simulated with funds that arrive later."],
  };
  return { ...body, digest: await previewDigest(body) };
}

let api;
before(async () => {
  api = await stubServer(async (request, res) => {
    const route = `${request.method} ${request.path}`;
    if (route === "POST /v1/intents/int_fare/preview" || route === "GET /v1/intents/int_fare/preview") return send(res, 200, { preview: await preview("int_fare") });
    if (route === "POST /v1/intents") {
      return send(res, 200, {
        intent: { spec: "kletia.intent/v1", id: "int_dry", status: "planned", request: { accounts: request.body.accounts }, summary: { title: "Bridge 100 USDC from Base to Arbitrum", signaturesRequired: 1, totalFeesUsd: 0.03, estimatedSeconds: 16 }, warnings: [], steps: [] },
        ...(request.url.searchParams.get("preview") === "true" ? { preview: await preview("int_dry") } : {}),
      });
    }
    return false;
  });
});
after(() => api.close());

test("kletia preview prints the fare table (snapshot): certainty column, n/p for unpriced values", async () => {
  const result = await cli(["preview", "int_fare", "--refresh-quotes"], { base: api.base });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(api.requests.at(-1).url.search, "?quotes=refresh");
  const expected = [
    "Fare breakdown: stage refresh, basis partial, computed 2026-10-09 13:40:12Z",
    `digest ${(await preview("int_fare")).digest}`,
    "",
    "network   account      asset  expected    worst       worst usd  certainty      role",
    "base      0x5eed…c0de  USDC   -100        -100        -$100.00   simulated      you",
    "arbitrum  0x5eed…c0de  USDC   +99.965772  +99.465943  n/p        venue-minimum  you",
    "",
    "Fees:",
    "step  fee                amount         usd     paid      certainty",
    "s1    Base network fee   -              <$0.01  on-top    simulated",
    "s1    Relay relayer fee  0.034228 USDC  $0.03   deducted  quoted",
    "",
    "Approvals:",
    "step  network  amount    spender           address      left after",
    "s1    base     100 USDC  Relay depository  0x4cd0…bc31  0",
    "",
    "You pay $100.00, get n/p (at least n/p); others get $0.00 (at least $0.00).",
    "Cost n/p (worst n/p): network <$0.01, venue $0.03, extra $0.00, price difference n/p.",
    `Unpriced (n/p): ${USDC_ARB}`,
    "Arrives on arbitrum in about 16s.",
    "Needs 0.000008 ETH on arbitrum (gas-on-arrival), has 0.",
    "s1: warn  PREVIEW_ALLOWANCE_LEFT  No allowance is left.",
    "warning: Step 2 was simulated with funds that arrive later.",
  ].join("\n");
  assert.equal(result.stdout.trimEnd(), expected);
  const json = await cli(["preview", "int_fare", "--json", "--last"], { base: api.base });
  assert.equal(api.requests.at(-1).method, "GET");
  assert.equal(JSON.parse(json.stdout).spec, "kletia.preview/v1");
});

test("kletia plan --preview asks for ?preview=true and prints the fare under the plan; it never prepares", async () => {
  const result = await cli(["plan", "bridge 100 USDC from base to arbitrum", "--account", `base:${EVM}`, "--preview"], { base: api.base });
  assert.equal(result.code, 0, result.stderr);
  assert.match(api.requests.at(-1).url.search, /dryRun=true&preview=true/u);
  assert.match(result.stdout, /Bridge 100 USDC from Base to Arbitrum/u);
  assert.match(result.stdout, /Fare breakdown: stage refresh/u);
  assert.equal(api.requests.some((request) => request.path.endsWith("/prepare")), false);
  const json = await cli(["plan", "bridge 100 USDC from base to arbitrum", "--account", `base:${EVM}`, "--preview", "--json"], { base: api.base });
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.intent.id, "int_dry");
  assert.equal(parsed.preview.intentId, "int_dry");
});
