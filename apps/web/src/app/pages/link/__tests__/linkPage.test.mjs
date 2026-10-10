// The intent link page's pure parts: what a visitor may choose (and what the
// address bar may prefill), bounds, link states, and the accounts the page
// sends. Run with
//   node --test apps/web/src/app/pages/link/__tests__/*.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import {
  boundRows,
  checkAmount,
  fundingOptions,
  httpsOnly,
  indicativeFare,
  linkSentence,
  linkSerial,
  linkState,
  namespacesFor,
  readPrefill,
  ticketNetworks,
  visitorAccounts,
} from "../linkModel.ts";

const USDC_BASE = { asset: "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6 };
const tip = {
  id: "lk_814f101fc50e69eca8015dc4",
  status: "active",
  activatesAt: null,
  expiresAt: "2099-01-01T00:00:00.000Z",
  destination: { network: "base", asset: USDC_BASE, actions: [{ kind: "transfer", network: "base", label: "Transfer your amount of USDC on Base" }] },
  fixed: { recipients: [{ network: "base", address: "0x2211d1d0020daea8039e46cf1367962070d77da9", name: "jesse.base.eth" }], contracts: [] },
  funding: { networks: ["base", "arbitrum", "solana"], assets: ["USDC"], amount: { mode: "input", bounds: { USDC: { min: "1", max: "500", default: "20" } } } },
};
const pay = {
  ...tip,
  destination: { ...tip.destination, actions: [{ kind: "transfer", network: "base", label: "Transfer 25 USDC on Base" }] },
  funding: { ...tip.funding, amount: { mode: "deliver" } },
};

test("the visitor chooses only among the publisher's networks and assets", () => {
  const options = fundingOptions(tip);
  assert.deepEqual(options.map((option) => option.key), ["base:USDC", "arbitrum:USDC", "solana:USDC"]);
  assert.ok(options.every((option) => option.decimals === 6));
  assert.deepEqual(ticketNetworks(tip), ["base", "arbitrum", "solana"]);
});

test("amounts must sit inside the bounds, with the asset's decimals at most", () => {
  const bounds = tip.funding.amount.bounds.USDC;
  assert.deepEqual(checkAmount("25", bounds, 6, "USDC"), { ok: true, value: "25" });
  assert.deepEqual(checkAmount(" 007.5 ", bounds, 6, "USDC"), { ok: true, value: "7.5" });
  assert.deepEqual(checkAmount("500", bounds, 6, "USDC"), { ok: true, value: "500" });
  assert.match(checkAmount("500.000001", bounds, 6, "USDC").message, /maximum of 500/u);
  assert.match(checkAmount("0.99", bounds, 6, "USDC").message, /minimum of 1/u);
  assert.match(checkAmount("1.0000001", bounds, 6, "USDC").message, /6 decimals at most/u);
  for (const raw of ["", "1e3", "-5", "0x10", "1,5", "1.2.3", "NaN"]) assert.equal(checkAmount(raw, bounds, 6, "USDC").ok, false, raw);
});

test("the address bar may prefill a choice and an amount, never a recipient, and says what it ignored", () => {
  assert.deepEqual(readPrefill("?from=arbitrum&asset=usdc&amount=250", tip), { optionKey: "arbitrum:USDC", amount: "250", ignored: [] });
  const ignored = readPrefill("?from=ethereum&amount=9999&recipient=0xdead&contract=0xbeef", tip);
  assert.equal(ignored.optionKey, null);
  assert.equal(ignored.amount, null);
  assert.equal(ignored.ignored.length, 2);
  assert.ok(!JSON.stringify(ignored).includes("0xdead"));
  const deliver = readPrefill("?amount=30", pay);
  assert.equal(deliver.amount, null);
  assert.match(deliver.ignored[0], /fixed amount/u);
});

test("every link state but active refuses new intents, and says why", () => {
  const now = Date.parse("2026-10-09T12:00:00Z");
  assert.equal(linkState({ ...tip }, now).usable, true);
  const pending = linkState({ ...tip, status: "pending", activatesAt: "2026-10-09T12:12:00Z" }, now);
  assert.equal(pending.usable, false);
  assert.equal(pending.title, "Activates in 12 min");
  assert.equal(pending.tone, "held");
  for (const [status, title, tone] of [["paused", "Paused by the publisher", "held"], ["exhausted", "All uses taken", "void"], ["suspended", "Suspended by Kletia", "void"], ["deleted", "Withdrawn", "void"]]) {
    const state = linkState({ ...tip, status }, now);
    assert.equal(state.usable, false, status);
    assert.equal(state.title, title);
    assert.equal(state.tone, tone);
  }
  const expired = linkState({ ...tip, expiresAt: "2026-10-01T00:00:00Z" }, now);
  assert.equal(expired.title, "Expired");
  assert.equal(linkState({ ...tip, status: "suspended", expiresAt: "2026-10-01T00:00:00Z" }, now).title, "Suspended by Kletia", "a suspension outranks expiry");
});

test("bounds printed on the ticket", () => {
  assert.deepEqual(boundRows(tip), [{ label: "USDC", value: "1 to 500" }, { label: "Arrives on", value: "Base" }]);
  assert.deepEqual(boundRows(pay).slice(0, 2), [{ label: "Delivers", value: "Transfer 25 USDC" }, { label: "To", value: "jesse.base.eth" }]);
  assert.equal(linkSentence(pay), "Transfer 25 USDC on Base");
  assert.equal(linkSerial(tip.id), "L-814F·101F");
});

test("the page links only https addresses", () => {
  assert.equal(httpsOnly("https://example.com/a"), "https://example.com/a");
  for (const url of ["http://example.com", "javascript:alert(1)", "data:text/html,x", "https://u:p@example.com", "//example.com", null]) assert.equal(httpsOnly(url), null, String(url));
});

test("one visitor account per virtual machine, placed where that machine signs first", () => {
  const intent = {
    steps: [
      { index: 0, network: "solana", mode: "wallet" },
      { index: 1, network: "base", mode: "wallet" },
      { index: 2, network: "base", mode: "settlement" },
    ],
  };
  assert.deepEqual(namespacesFor(intent), ["solana", "eip155"]);
  const accounts = visitorAccounts(["solana", "eip155"], "solana", intent, { evm: "0x4f183e308f24c81c05303821AD025812fBFd807D", solana: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" });
  assert.deepEqual(accounts, [
    "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    "eip155:8453:0x4f183e308f24c81c05303821AD025812fBFd807D",
  ]);
  assert.deepEqual(visitorAccounts(["eip155"], "arbitrum", { steps: [{ index: 0, network: "arbitrum", mode: "wallet" }] }, { evm: "0x4f183e308f24c81c05303821AD025812fBFd807D", solana: null }), ["eip155:42161:0x4f183e308f24c81c05303821AD025812fBFd807D"]);
  assert.deepEqual(visitorAccounts(["solana"], "base", intent, { evm: null, solana: null }), [], "no wallet, no account");
});

test("indicativeFare: the stand-in account's balances never reach the page; route numbers and real blocks stay", () => {
  const preview = {
    spec: "kletia.preview/v1",
    basis: "unavailable",
    digest: "sha256:00",
    warnings: ["Step 2 was simulated with 99.68 USDC that LI.FI delivers to you on Base; it will be simulated again before you sign it.", "PREVIEW_GAS_ON_ARRIVAL: you need about 0.0000025 ETH on Base to sign step 2."],
    needs: [{ network: "base", account: "eip155:8453:0x000000000000000000000000000000000000c0de", reason: "input-balance", amount: "25000000", formatted: "25", have: "0" }],
    steps: [
      {
        stepId: "s1",
        status: "failed",
        issues: [
          { code: "INSUFFICIENT_BALANCE", severity: "warn", message: "Step 1: The account holds 0 base units of the input; 25000000 is needed." },
          { code: "SIMULATION_FAILED", severity: "warn", message: "Step 1: The transaction would fail on-chain (execution reverted: ERC20: transfer amount exceeds balance)." },
          { code: "PREVIEW_INVARIANT", severity: "block", message: "Step 1 pays an address the plan does not name." },
        ],
      },
    ],
  };
  const shown = indicativeFare(preview);
  assert.equal(shown.basis, "quoted");
  assert.deepEqual(shown.needs, []);
  assert.deepEqual(shown.warnings, [preview.warnings[0]]);
  assert.deepEqual(shown.steps[0].issues.map((issue) => issue.code), ["PREVIEW_INVARIANT"]);
  assert.equal(preview.needs.length, 1, "the quote itself is not changed");
  assert.equal(indicativeFare({ ...preview, basis: "partial" }).basis, "partial");
});
