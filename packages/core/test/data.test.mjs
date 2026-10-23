// Data API CSV export (core/src/data.ts): RFC 4180 quoting, CRLF rows,
// formula-injection guard on text cells, numbers kept as numbers and unknown
// values as empty cells (never 0).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dataCsvCell, dataHistoryCsv, dataHoldingsCsv, dataPositionsCsv, LENDING_HEALTH_THRESHOLDS, toDataCsv } from "../dist/index.js";

describe("data CSV", () => {
  it("quotes commas, quotes and line breaks, doubling quotes", () => {
    assert.equal(dataCsvCell("plain"), "plain");
    assert.equal(dataCsvCell("a,b"), '"a,b"');
    assert.equal(dataCsvCell('say "hi"'), '"say ""hi"""');
    assert.equal(dataCsvCell("two\nlines"), '"two\nlines"');
    assert.equal(dataCsvCell("cr\rhere"), '"cr\rhere"');
  });

  it("neutralises text that a spreadsheet would run as a formula", () => {
    assert.equal(dataCsvCell("=HYPERLINK(\"x\")"), "\"'=HYPERLINK(\"\"x\"\")\"");
    assert.equal(dataCsvCell("+1"), "'+1");
    assert.equal(dataCsvCell("-2"), "'-2");
    assert.equal(dataCsvCell("@SUM(A1)"), "'@SUM(A1)");
    assert.equal(dataCsvCell("\tTab"), "'\tTab");
  });

  it("writes numbers and booleans as such and unknown values as empty cells", () => {
    assert.equal(dataCsvCell(-12.5), "-12.5");
    assert.equal(dataCsvCell(0), "0");
    assert.equal(dataCsvCell(Number.NaN), "");
    assert.equal(dataCsvCell(null), "");
    assert.equal(dataCsvCell(undefined), "");
    assert.equal(dataCsvCell(true), "true");
  });

  it("joins rows with CRLF after a header row", () => {
    assert.equal(toDataCsv(["a", "b"], [[1, "x,y"], [null, "z"]]), 'a,b\r\n1,"x,y"\r\n,z\r\n');
  });

  it("exports holdings, positions and history with their headers", () => {
    const value = { usd: null, source: "unpriced", asOf: null, reason: "No price source covers this asset." };
    const holdings = dataHoldingsCsv({ holdings: [{ account: "eip155:8453:0xabc", network: "base", asset: "eip155:8453/erc20:0x1", symbol: "=EVIL", amount: "1", formatted: "1", value }] });
    assert.equal(holdings.split("\r\n")[1], "eip155:8453:0xabc,base,eip155:8453/erc20:0x1,'=EVIL,1,,unpriced,,No price source covers this asset.");
    const positions = dataPositionsCsv({
      positions: [{ id: "base:aave-v3:usdc", account: "eip155:8453:0xabc", network: "base", protocol: "aave-v3", name: "Aave V3 USDC", kind: "supply", symbol: "USDC", amount: "5", value: { usd: 5, source: "adapter", asOf: "2026-10-23T00:00:00.000Z" }, apy: 0.04, inWallet: false }],
    });
    assert.equal(positions.split("\r\n")[1], "eip155:8453:0xabc,base,aave-v3,Aave V3 USDC,supply,USDC,5,5,0.04,false,adapter,2026-10-23T00:00:00.000Z,");
    const history = dataHistoryCsv({ entries: [{ kind: "intent", id: "int_1", at: "2026-10-23T00:00:00.000Z", status: "completed", title: "Swap, then bridge", networks: ["base", "solana"], intentId: "int_1", source: "kletia" }] });
    assert.equal(history.split("\r\n")[1], '2026-10-23T00:00:00.000Z,intent,int_1,completed,"Swap, then bridge",base solana,int_1');
  });

  it("flags health factors below 1.5 as warnings and below 1.1 as critical", () => {
    assert.deepEqual({ ...LENDING_HEALTH_THRESHOLDS }, { warning: 1.5, critical: 1.1 });
  });
});
