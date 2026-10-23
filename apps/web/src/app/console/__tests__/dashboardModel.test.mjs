// The desk's Dashboard view model (dashboard/dashboardModel.ts): KPIs with
// unknown values kept unknown, health warnings worst first, allocation bars
// folded into "Other", position and yield rows, and the CSV file.
import assert from "node:assert/strict";
import test from "node:test";

import {
  allocationBars,
  csvFileName,
  dashboardCsv,
  dashboardKpis,
  dashboardWallets,
  healthWarnings,
  heldSymbols,
  positionRows,
  usdText,
  yieldRows,
} from "../dashboard/dashboardModel.ts";

const EVM = "0x4f183e308f24c81c05303821AD025812fBFd807D";
const ACCOUNT = `eip155:8453:${EVM}`;
const AS_OF = "2026-10-23T12:00:00.000Z";

function value(usd, extra = {}) {
  return { usd, source: usd === null ? "unpriced" : "usd-par", asOf: usd === null ? null : AS_OF, ...extra };
}

function portfolio(overrides = {}) {
  return {
    wallets: { evm: [EVM], solana: [], lane: "production" },
    accounts: [ACCOUNT],
    totals: { net: value(1200), wallet: value(1000), positions: value(250), debt: value(50), unpriced: 0, complete: true },
    change24h: { usd: null, pct: null, since: null, source: "snapshot", estimate: true, reason: "No reading of these wallets from about 24 hours ago yet." },
    pnl: { usd: null, pct: null, since: null, source: "snapshot", estimate: true },
    allocation: { byNetwork: [], byAsset: [], byProtocol: [] },
    holdings: [
      { account: ACCOUNT, network: "base", asset: "eip155:8453/erc20:0x1", symbol: "USDC", amount: "1000000000", formatted: "1000", value: value(1000) },
      { account: ACCOUNT, network: "base", asset: "eip155:8453/erc20:0x2", symbol: "ODD", amount: "1", formatted: "1", value: value(null, { reason: "No price source covers this asset." }) },
    ],
    positions: [
      { id: "base:aave-v3:usdc", account: ACCOUNT, network: "base", protocol: "aave-v3", name: "Aave V3 USDC", kind: "supply", symbol: "USDC", amount: "250", value: value(250), apy: 0.0412, inWallet: false },
      { id: "base:aave-v3:pool", account: ACCOUNT, network: "base", protocol: "aave-v3", name: "Aave V3 debt", kind: "borrow", symbol: "USD", amount: null, value: value(50), apy: null, inWallet: false },
    ],
    health: [
      { account: ACCOUNT, network: "base", protocol: "aave-v3", market: "m1", healthFactor: 1.3, status: "warning", source: "adapter", asOf: AS_OF },
      { account: ACCOUNT, network: "ethereum", protocol: "sparklend", market: "m2", healthFactor: 1.05, status: "critical", source: "adapter", asOf: AS_OF },
      { account: ACCOUNT, network: "solana", protocol: "kamino", market: "m3", healthFactor: null, status: "unknown", source: "adapter", asOf: null, reason: "Not read yet." },
    ],
    failures: [],
    asOf: AS_OF,
    ...overrides,
  };
}

test("wallet query needs a connected wallet and keeps the lane", () => {
  assert.equal(dashboardWallets(null, null, "production"), null);
  assert.deepEqual(dashboardWallets(EVM, null, "testnet"), { evm: EVM, lane: "testnet" });
});

test("KPIs keep an unknown change unknown with its reason, and count health warnings", () => {
  const [net, change, positions, health] = dashboardKpis(portfolio());
  assert.equal(net.value, "$1,200.00");
  assert.equal(change.value, "Unknown");
  assert.match(change.note, /24 hours/u);
  assert.equal(positions.value, "1");
  assert.equal(positions.note, "1 loan too");
  assert.equal(health.value, "2");
  assert.equal(health.tone, "warning");
  assert.match(health.note, /sparklend: health factor 1\.05/u);
});

test("a negative change reads as a loss and an unknown total says why", () => {
  const kpis = dashboardKpis(portfolio({
    change24h: { usd: -12.5, pct: -0.0103, since: AS_OF, source: "snapshot", estimate: true },
    totals: { net: value(null, { reason: "Nothing could be read." }), wallet: value(null), positions: value(null), debt: value(null), unpriced: 0, complete: false },
  }));
  assert.equal(kpis[1].value, "-$12.50 (-1.03%)");
  assert.equal(kpis[1].tone, "down");
  assert.equal(kpis[0].value, "Unknown");
  assert.equal(kpis[0].note, "Nothing could be read.");
  assert.equal(usdText({ usd: 0 }), "$0.00", "a real zero is still shown as zero");
});

test("health warnings are critical first, unknown rows are not warnings", () => {
  assert.deepEqual(healthWarnings(portfolio().health).map((row) => row.status), ["critical", "warning"]);
});

test("allocation bars scale to the largest slice and fold the tail into Other", () => {
  const slices = Array.from({ length: 8 }, (_, index) => ({ key: `k${index}`, label: `L${index}`, usd: 80 - index * 10, share: (80 - index * 10) / 360 }));
  const bars = allocationBars(slices, 6);
  assert.equal(bars.length, 7);
  assert.equal(bars[0].length, 1);
  assert.equal(bars[1].length, 70 / 80);
  assert.deepEqual([bars[6].key, bars[6].label, bars[6].usd], ["other", "Other (2)", 30]);
  assert.deepEqual(allocationBars([]), []);
});

test("position rows: largest first, debts negative, unknown APY and amount spelled out", () => {
  const rows = positionRows(portfolio().positions);
  assert.deepEqual(rows.map((row) => [row.name, row.value, row.apy, row.amount]), [
    ["Aave V3 USDC", "$250.00", "4.12%", "250 USDC"],
    ["Aave V3 debt", "-$50.00", "Unknown", "Unknown"],
  ]);
  assert.equal(rows[1].debt, true);
});

test("yield rows put held assets first and only offer Move here where Kletia deposits", () => {
  const yields = [
    { venue: "a", protocol: "fluid", network: "base", name: "Fluid WETH", asset: "WETH", apy: 0.09, apyBasis: "share-price", supplied: null, utilization: null, executable: true, depositText: "Deposit [EDIT AMOUNT] WETH into Fluid WETH on Base", source: "lending-metrics", asOf: AS_OF },
    { venue: "b", protocol: "aave-v3", network: "base", name: "Aave V3 USDC", asset: "USDC", apy: 0.05, apyBasis: "rate", supplied: null, utilization: null, executable: true, depositText: "Deposit [EDIT AMOUNT] USDC into Aave V3 USDC on Base", source: "lending-metrics", asOf: AS_OF },
    { venue: "c", protocol: "jupiter-lend", network: "solana", name: "Jupiter Lend SOL", asset: "SOL", apy: null, apyBasis: "unavailable", supplied: null, utilization: null, executable: false, depositText: "Deposit [EDIT AMOUNT] SOL into Jupiter Lend SOL on Solana", source: "adapter", asOf: null, reason: "The venue's rate could not be read." },
  ];
  const rows = yieldRows(yields, heldSymbols(portfolio()));
  assert.deepEqual(rows.map((row) => row.key), ["b", "a", "c"]);
  assert.equal(rows[0].moveText, "Deposit [EDIT AMOUNT] USDC into Aave V3 USDC on Base");
  assert.equal(rows[1].note, "Realised share-price growth");
  assert.equal(rows[2].apy, "Unknown");
  assert.equal(rows[2].moveText, null);
});

test("the CSV file uses core's columns and the reading's date", () => {
  assert.equal(csvFileName("positions", AS_OF), "kletia-positions-2026-10-23.csv");
  const csv = dashboardCsv("holdings", portfolio());
  assert.match(csv, /^account,network,asset,symbol,amount,usd,source,as_of,reason\r\n/u);
  assert.ok(csv.includes(",ODD,1,,unpriced,,No price source covers this asset.\r\n"));
});
