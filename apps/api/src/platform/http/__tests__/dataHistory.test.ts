/**
 * Wallet history (docs/platform/data.md, "Transactions"): provider parsing
 * on recorded and constructed fixtures (historyFixtures.ts), the classifier
 * per kind, FIFO cost basis, and Kamino loans in the lending read.
 *
 *   cd apps/api && node --import tsx --test src/platform/http/__tests__/dataHistory.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { CHAINS, formatAccountId, getAsset, type DataTransaction, type DataTxKind, type NetworkKey } from "@kletia/core";
import { alchemyTransactions } from "../../data/chain/alchemy.js";
import { completeEvmPage, etherscanProvider, etherscanTransactions } from "../../data/chain/etherscan.js";
import { heliusTransaction } from "../../data/chain/helius.js";
import { historyProviderFor } from "../../data/chain/providers.js";
import { rpcTransaction, solanaRpcProvider } from "../../data/chain/solanaRpc.js";
import type { RawTransfer, RawTx } from "../../data/chain/types.js";
import { classifyTransaction, netLegs } from "../../data/classify.js";
import { costBasisKey, fifoCostBasis, pnlRows } from "../../data/costBasis.js";
import { configureHistoryFetch, configureLendingReaders, readLendingAccounts, resetHistoricalPrices } from "../../data/index.js";
import { enrichTransactions } from "../../data/transactions.js";
import { fixture, fixtureFetcher } from "./historyFixtures.js";

const ME = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
const FRIEND = "0x4f183e308f24c81c05303821ad025812fbfd807d";
const BASE_ACCOUNT = formatAccountId(CHAINS.base, ME);
const TRADER = "FHpcNSe6tb2n15bAdq4BkeYWGyZKFD7yLYrH92ng7wCT";
const HOT_WALLET = "H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS";
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

const env = { ...process.env };

beforeEach(() => {
  configureHistoryFetch(fixtureFetcher());
  resetHistoricalPrices();
  process.env.ETHERSCAN_API_KEY = "test-key";
});

afterEach(() => {
  configureHistoryFetch(null);
  for (const name of ["ETHERSCAN_API_KEY", "ALCHEMY_API_KEY", "HELIUS_API_KEY"]) {
    if (env[name] === undefined) delete process.env[name];
    else process.env[name] = env[name];
  }
});

/* ------------------------------------------------------------ providers */

describe("Etherscan V2 (constructed from the documented schema)", () => {
  const rows = fixture<{ responses: Record<"txlist" | "tokentx" | "txlistinternal", { result: never[] }> }>("etherscan-base").responses;
  const txs = () => etherscanTransactions("base", BASE_ACCOUNT, ME, { txlist: rows.txlist.result, tokentx: rows.tokentx.result, txlistinternal: rows.txlistinternal.result });

  it("groups normal, token and internal rows by hash, newest first, with the fee the wallet paid", () => {
    const list = txs();
    assert.equal(list.length, 8);
    assert.deepEqual(list.map((tx) => Number.parseInt(tx.hash.slice(-2), 16)), [8, 7, 6, 5, 4, 3, 2, 1]);
    const swapBack = list[0]!;
    assert.equal(swapBack.transfers.length, 2, "100 USDC out and 0.04 ETH back through an internal transfer");
    assert.equal(swapBack.fee, "0.000001");
    assert.equal(swapBack.method, "swap");
    const received = list[7]!;
    assert.equal(received.fee, null, "a received token transfer has no fee for this wallet");
    assert.equal(received.feeKnown, false);
    assert.equal(list[1]!.status, "failed");
  });

  it("keeps rows at the lowest common block for the next page", () => {
    const tx = (hash: string, block: number) => ({ hash, block }) as RawTx;
    const page = completeEvmPage([tx("a", 30), tx("b", 20), tx("c", 10)], [[{ block: 30 }, { block: 20 }], [{ block: 25 }, { block: 10 }]], 2, undefined);
    assert.deepEqual(page.txs.map((row) => row.hash), ["a"], "list 1 stopped at block 20: blocks 20 and below may still miss transfers");
    assert.equal(page.more, true);
    const skipped = completeEvmPage([tx("a", 30), tx("b", 30)], [[{ block: 30 }]], 2, { block: 30, skip: ["a"] });
    assert.deepEqual(skipped.txs.map((row) => row.hash), ["b"]);
  });

  it("fails closed on the recorded answer to a missing key, with Etherscan's reason", async () => {
    process.env.ETHERSCAN_API_KEY = "invalid-key";
    await assert.rejects(etherscanProvider.page({ id: BASE_ACCOUNT, network: "base", address: ME }, undefined, 50), (error: { code?: string; message?: string }) => {
      assert.equal(error.code, "HISTORY_PROVIDER_UNAVAILABLE");
      assert.match(error.message ?? "", /Missing\/Invalid API Key/u);
      return true;
    });
  });

  it("is chosen per network, and fails closed without a key with the variables to set", () => {
    assert.equal(historyProviderFor("base").provider?.id, "etherscan");
    delete process.env.ETHERSCAN_API_KEY;
    const missing = historyProviderFor("ethereum");
    assert.equal(missing.provider, null);
    assert.ok(missing.provider === null && missing.status === "not-configured" && missing.env?.includes("ETHERSCAN_API_KEY"));
    process.env.ALCHEMY_API_KEY = "test-key";
    assert.equal(historyProviderFor("ethereum").provider?.id, "alchemy");
    assert.equal(historyProviderFor("arc").provider, null, "no provider covers Arc Testnet");
    assert.equal(historyProviderFor("solana").provider?.id, "solana-rpc");
    process.env.HELIUS_API_KEY = "test-key";
    assert.equal(historyProviderFor("solana").provider?.id, "helius");
  });
});

describe("Alchemy transfers (constructed from the documented schema)", () => {
  it("joins the from- and to-side transfers by hash; fees stay unknown", () => {
    const data = fixture<{ fromAddress: { result: { transfers: never[] } }; toAddress: { result: { transfers: never[] } } }>("alchemy-ethereum");
    const txs = alchemyTransactions("ethereum", formatAccountId(CHAINS.ethereum, ME), ME, [...data.fromAddress.result.transfers, ...data.toAddress.result.transfers]);
    assert.equal(txs.length, 2);
    assert.deepEqual(txs[0]!.transfers.map((transfer) => [transfer.token.symbol, transfer.amount]), [["ETH", "0.25"]]);
    assert.deepEqual(txs[1]!.transfers.map((transfer) => [transfer.token.symbol, transfer.amount]), [["USDC", "1200"]]);
    assert.ok(txs.every((tx) => tx.fee === null && tx.feeKnown === false && tx.source === "alchemy"));
  });
});

describe("Helius enhanced transactions (constructed from the documented schema)", () => {
  it("keeps the wallet's transfers, the programs invoked (inner included) and the type as a hint", () => {
    const body = fixture<{ body: never[] }>("helius-solana").body;
    const account = formatAccountId(CHAINS.solana, HOT_WALLET);
    const txs = body.map((tx) => heliusTransaction("solana", account, HOT_WALLET, tx)!);
    const swap = txs[3]!;
    assert.equal(swap.hint, "SWAP");
    assert.ok(swap.programs.includes("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"), "inner instruction programs count");
    assert.deepEqual(swap.transfers.map((transfer) => [transfer.token.address, transfer.amount]), [[null, "1"], ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "150"]]);
    assert.equal(swap.fee, "0.000005");
    assert.equal(txs[1]!.status, "failed");
  });
});

describe("plain Solana RPC (recorded 2026-10-24)", () => {
  it("reads balance deltas net of the fee, and names the other side of a plain transfer", async () => {
    const page = await solanaRpcProvider.page({ id: formatAccountId(CHAINS.solana, HOT_WALLET), network: "solana", address: HOT_WALLET }, undefined, 50);
    assert.equal(page.txs.length, 4);
    assert.equal(page.more, false);
    const [sol, token] = page.txs;
    assert.equal(sol!.transfers.length, 1);
    assert.equal(sol!.transfers[0]!.token.address, null);
    assert.equal(sol!.transfers[0]!.from, HOT_WALLET, "an exchange hot wallet sending SOL");
    assert.ok(sol!.transfers[0]!.to, "the System transfer names the recipient");
    assert.equal(token!.transfers[0]!.token.address !== null, true, "an SPL transferChecked");
    assert.equal(sol!.fee !== null, true);
  });

  it("classifies the recorded trader's pump.fun AMM swap, and a Relay deposit it only paid the fee of", async () => {
    const page = await solanaRpcProvider.page({ id: formatAccountId(CHAINS.solana, TRADER), network: "solana", address: TRADER }, undefined, 50);
    const kinds = page.txs.map((tx) => classifyTransaction(tx));
    // The Relay deposit moved another wallet's USDC: this wallet only paid the fee, so nothing was bridged from it.
    assert.deepEqual(kinds.map((tx) => tx.kind), ["swap", "contract-call"]);
    assert.equal(page.txs[1]!.fee, "0.00001");
    assert.equal(kinds[0]!.protocol?.label, "Pump.fun Amm");
    assert.equal(kinds[1]!.protocol?.id, "relay");
  });

  it("prices legs at the time with DefiLlama (recorded) and never prices unlisted tokens", async () => {
    const page = await solanaRpcProvider.page({ id: formatAccountId(CHAINS.solana, TRADER), network: "solana", address: TRADER }, undefined, 50);
    const [swap] = await enrichTransactions(page.txs);
    const sol = swap!.legs.find((leg) => leg.asset.address === null)!;
    assert.equal(sol.priceSource, "defillama");
    assert.ok(sol.usdAtTime !== null && sol.usdAtTime > 0);
    const unlisted = swap!.legs.find((leg) => leg.asset.id === null);
    if (unlisted) {
      assert.equal(unlisted.usdAtTime, null);
      assert.match(unlisted.reason ?? "", /Unlisted token/u);
    }
    assert.equal(swap!.explorerUrl, CHAINS.solana.explorer.tx.replace("{hash}", swap!.hash));
  });

  it("parses one recorded transaction straight from its JSON", () => {
    const call = fixture<{ calls: { response: { result: never } }[] }>("solana-rpc-transfers").calls[1]!;
    const tx = rpcTransaction("solana", formatAccountId(CHAINS.solana, HOT_WALLET), HOT_WALLET, call.response.result)!;
    assert.equal(tx.source, "solana-rpc");
    assert.equal(classifyTransaction(tx).kind, "send");
  });
});

/* ----------------------------------------------------------- classifier */

function raw(input: Partial<RawTx> & { readonly transfers?: readonly RawTransfer[] }, network: NetworkKey = "base"): RawTx {
  const owner = CHAINS[network].vm === "evm" ? ME : TRADER;
  return {
    network,
    account: formatAccountId(CHAINS[network], owner),
    owner,
    hash: "0x01",
    time: Date.parse("2026-10-20T10:00:00Z"),
    block: 1,
    status: "success",
    from: owner,
    to: null,
    method: null,
    transfers: [],
    fee: null,
    feeKnown: true,
    programs: [],
    hint: null,
    source: "etherscan",
    ...input,
  };
}

const token = (address: string | null, symbol: string): RawTransfer["token"] => ({ symbol, address, decimals: 6 });
const out = (address: string | null, symbol: string, amount: string, to: string): RawTransfer => ({ token: token(address, symbol), from: ME, to, amount });
const inn = (address: string | null, symbol: string, amount: string, from: string): RawTransfer => ({ token: token(address, symbol), from, to: ME, amount });

describe("classifier", () => {
  const cases: [DataTxKind, RawTx][] = [];
  const AUSDC = "0x4e65fe4dba92790696d040ac24aa414708f5c0ab";
  const POOL = "0xa238dd80c259a72e81d7e4664a9801593f98d1c5";
  const KYBER = "0x6131b5fae19ea4f9d964eac0408e4408b66337b5";
  const SPOKE = "0x09aea4b2242abc8bb4bb78d537a67a245a7bec64";
  const ZERO = "0x0000000000000000000000000000000000000000";
  cases.push(["send", raw({ to: FRIEND, transfers: [out(null, "ETH", "0.5", FRIEND)] })]);
  cases.push(["receive", raw({ from: FRIEND, transfers: [inn(BASE_USDC, "USDC", "10", FRIEND)] })]);
  cases.push(["swap", raw({ to: KYBER, method: "swap", transfers: [out(null, "ETH", "0.1", KYBER), inn(BASE_USDC, "USDC", "250", KYBER)] })]);
  cases.push(["bridge-out", raw({ to: SPOKE, method: "depositV3", transfers: [out(BASE_USDC, "USDC", "200", SPOKE)] })]);
  cases.push(["bridge-in", raw({ from: "0x1111111111111111111111111111111111111111", to: SPOKE, method: "fillRelay", transfers: [inn(BASE_USDC, "USDC", "199", SPOKE)] })]);
  cases.push(["deposit", raw({ to: POOL, method: "supply", transfers: [out(BASE_USDC, "USDC", "500", AUSDC), inn(AUSDC, "aBasUSDC", "500", ZERO)] })]);
  cases.push(["withdraw", raw({ to: POOL, method: null, transfers: [out(AUSDC, "aBasUSDC", "100", ZERO), inn(BASE_USDC, "USDC", "100", AUSDC)] })]);
  cases.push(["borrow", raw({ to: POOL, method: "borrow", transfers: [inn(BASE_USDC, "USDC", "50", AUSDC)] })]);
  cases.push(["repay", raw({ to: POOL, method: "repay", transfers: [out(BASE_USDC, "USDC", "50", AUSDC)] })]);
  cases.push(["approve", raw({ to: BASE_USDC, method: "approve" })]);
  cases.push(["stake", raw({ to: "0xae7ab96520de3a18e5e111b5eaab095312d7fe84", method: "submit", transfers: [out(null, "ETH", "1", "0xae7ab96520de3a18e5e111b5eaab095312d7fe84"), inn("0xae7ab96520de3a18e5e111b5eaab095312d7fe84", "stETH", "1", ZERO)] }, "ethereum")]);
  cases.push(["unstake", raw({ to: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0", method: "unwrap", transfers: [out("0xae7ab96520de3a18e5e111b5eaab095312d7fe84", "stETH", "1", "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0")] }, "ethereum")]);
  cases.push(["perp", raw({ to: "0x7de39ff2e232a2203196788d37e234cf8f1b83f1", method: "multicall", transfers: [out("0xaf88d065e77c8cc2239327c5edb3a432268e5831", "USDC", "100", "0x31ef83a530fde1b38ee9a18093a333d8bbbc40d5")] }, "arbitrum")]);
  cases.push(["order", raw({ to: "0x9008d19f58aabd9ed0d60971565aa8510560ab41", method: "settle", transfers: [out(BASE_USDC, "USDC", "100", "0x9008d19f58aabd9ed0d60971565aa8510560ab41")] })]);
  cases.push(["prediction", raw({ to: "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e", method: "fillOrder", transfers: [out("0x2791bca1f2de4661ed88a30c99a7a9449aa84174", "USDC.e", "20", "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e")] }, "polygon")]);
  cases.push(["contract-call", raw({ to: "0x2222222222222222222222222222222222222222", method: "claim" })]);
  cases.push(["failed", raw({ to: KYBER, method: "swap", status: "failed", transfers: [out(null, "ETH", "0.1", KYBER)] })]);
  cases.push(["unknown", raw({ from: null, to: null })]);

  for (const [kind, tx] of cases) {
    it(`reads a ${kind}`, () => assert.equal(classifyTransaction(tx).kind, kind));
  }

  it("names the registry protocol and the counterparty", () => {
    const swap = classifyTransaction(cases[2]![1]);
    assert.equal(swap.protocol?.id, "kyberswap");
    assert.equal(swap.counterparty, KYBER);
    const send = classifyTransaction(cases[0]![1]);
    assert.equal(send.protocol, null);
    assert.equal(send.counterparty, FRIEND);
  });

  it("reads Solana stakes, Jupiter swaps and transfers by their programs", () => {
    const solana = (programs: string[], transfers: RawTransfer[], hint: string | null = null) => raw({ programs, transfers, hint, from: TRADER }, "solana");
    const mint = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";
    const sol = (amount: string, direction: "in" | "out"): RawTransfer => ({ token: { symbol: "SOL", address: null, decimals: 9 }, from: direction === "out" ? TRADER : "x", to: direction === "out" ? "x" : TRADER, amount });
    const jito = (amount: string, direction: "in" | "out"): RawTransfer => ({ token: { symbol: "", address: mint, decimals: 9 }, from: direction === "out" ? TRADER : "x", to: direction === "out" ? "x" : TRADER, amount });
    assert.equal(classifyTransaction(solana(["SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy"], [sol("2", "out"), jito("1.7", "in")])).kind, "stake");
    assert.equal(classifyTransaction(solana(["SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy"], [jito("1.7", "out"), sol("2", "in")])).kind, "unstake");
    assert.equal(classifyTransaction(solana(["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"], [sol("1", "out"), jito("0.8", "in")])).kind, "swap");
    assert.equal(classifyTransaction(solana(["j1o2qRpjcyUwEvwtcfhEQefh773ZgjxcVRry7LDqg5X"], [sol("1", "out")])).kind, "order");
    assert.equal(classifyTransaction(solana(["dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH"], [])).kind, "perp");
    assert.equal(classifyTransaction(solana(["SomeUnknownProgram1111111111111111111111111"], [], "STAKE_SOL")).kind, "stake", "a Helius type names the kind when no registry program matched");
  });

  it("nets the legs per token (a self-transfer nets to nothing)", () => {
    const legs = netLegs([out(null, "ETH", "1", ME), inn(null, "ETH", "1", ME), out(BASE_USDC, "USDC", "1.5", FRIEND), inn(BASE_USDC, "USDC", "0.25", FRIEND)], ME, (a, b) => a === b);
    assert.deepEqual(legs.map((leg) => [leg.token.symbol, leg.amount, leg.direction]), [["USDC", "1.25", "out"]]);
  });
});

/* ----------------------------------------------------------- cost basis */

function tx(kind: DataTxKind, time: string, legs: [string, string, "in" | "out", number | null][], extra: Partial<DataTransaction> = {}): DataTransaction {
  const asset = (symbol: string) => {
    const id = symbol === "ETH" ? "eip155:8453/slip44:60" : `eip155:8453/erc20:${BASE_USDC}`;
    return { symbol, address: symbol === "ETH" ? null : BASE_USDC, decimals: getAsset(id)?.decimals ?? 18, id: getAsset(id)?.id ?? null };
  };
  return {
    id: `base:${time}`,
    network: "base",
    hash: time,
    account: BASE_ACCOUNT,
    time,
    block: 1,
    kind,
    status: "success",
    legs: legs.map(([symbol, amount, direction, usd]) => ({ asset: asset(symbol), amount, direction, usdAtTime: usd, priceSource: usd === null ? null : "defillama" })),
    fee: null,
    counterparty: FRIEND,
    protocol: null,
    method: null,
    kletiaIntentId: null,
    kletiaReceiptId: null,
    source: "etherscan",
    explorerUrl: "",
    ...extra,
  };
}

const own = (address: string) => address.toLowerCase() === ME;

describe("FIFO cost basis", () => {
  it("takes the oldest lots first and realizes the difference", () => {
    const pools = fifoCostBasis([
      tx("receive", "2026-10-01T00:00:00.000Z", [["ETH", "1", "in", 2000]]),
      tx("swap", "2026-10-02T00:00:00.000Z", [["USDC", "3000", "out", 3000], ["ETH", "1", "in", 3000]]),
      tx("swap", "2026-10-03T00:00:00.000Z", [["ETH", "1.5", "out", 6000], ["USDC", "6000", "in", 6000]]),
    ], own, null);
    const eth = pools.get("ETH")!;
    // 1 ETH at 2000 and 0.5 ETH at 3000/ETH sold for 6000: 6000 - 2000 - 1500.
    assert.equal(eth.realized, 2500);
    const rows = pnlRows(pools, (key) => (key === "ETH" ? 4000 : 1));
    const row = rows.find((entry) => entry.key === "ETH")!;
    assert.equal(row.openQuantity, 0.5);
    assert.equal(row.costBasisUsd, 1500);
    assert.equal(row.unrealizedUsd, 500);
    assert.equal(rows.find((entry) => entry.key === "USDC")!.realizedUsd, null, "3000 USDC went out that the history never acquired");
  });

  it("counts only disposals inside the period, but consumes lots before it", () => {
    const pools = fifoCostBasis([
      tx("receive", "2026-10-01T00:00:00.000Z", [["ETH", "2", "in", 4000]]),
      tx("send", "2026-10-02T00:00:00.000Z", [["ETH", "1", "out", 2500]]),
      tx("send", "2026-10-20T00:00:00.000Z", [["ETH", "1", "out", 3000]]),
    ], own, Date.parse("2026-10-10T00:00:00Z"));
    assert.equal(pools.get("ETH")!.realized, 1000);
  });

  it("leaves moves between the set's wallets, bridges and deposits out, and makes missing prices unknown", () => {
    const pools = fifoCostBasis([
      tx("receive", "2026-10-01T00:00:00.000Z", [["ETH", "1", "in", null]]),
      tx("send", "2026-10-02T00:00:00.000Z", [["ETH", "0.5", "out", 1500]], { counterparty: ME }),
      tx("bridge-out", "2026-10-03T00:00:00.000Z", [["ETH", "0.2", "out", 600]]),
      tx("send", "2026-10-04T00:00:00.000Z", [["ETH", "0.5", "out", 1500]]),
    ], own, null);
    const eth = pools.get("ETH")!;
    assert.equal(eth.realizedKnown, false, "the lot's price at the time was unknown");
    const row = pnlRows(pools, () => 3000).find((entry) => entry.key === "ETH")!;
    assert.equal(row.openQuantity, 0.5, "the own-wallet move and the bridge kept their lots");
    assert.equal(row.costBasisUsd, null);
    assert.equal(row.unrealizedUsd, null);
    assert.match(row.reason ?? "", /price at the time/u);
  });

  it("disposes of the fees paid and pools USDC across networks", () => {
    const fee = { asset: { symbol: "ETH", address: null, decimals: 18, id: "eip155:8453/slip44:60" as never }, amount: "0.01", usd: 30 };
    const pools = fifoCostBasis([
      tx("receive", "2026-10-01T00:00:00.000Z", [["ETH", "1", "in", 2000]]),
      tx("approve", "2026-10-02T00:00:00.000Z", [], { fee }),
    ], own, null);
    assert.equal(pools.get("ETH")!.realized, 10, "0.01 ETH bought at 2000 spent when worth 30");
    assert.equal(costBasisKey({ network: "solana" }, { symbol: "USDC", address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6, id: null }).key, "USDC");
  });
});

/* ----------------------------------------------------------------- kamino */

describe("Kamino loans in the lending read", () => {
  afterEach(() => configureLendingReaders(null));

  it("reads the recorded obligations (no debt: no health row), and flags a loan by its liquidation limit", async () => {
    const recorded = fixture<{ user: string; body: never[] }>("kamino-obligations");
    const account = formatAccountId(CHAINS.solana, recorded.user);
    configureLendingReaders({ kaminoObligations: async (market) => (market === "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF" ? recorded.body : []) });
    const clean = await readLendingAccounts([account]);
    assert.equal(clean.health.length, 0);
    const collateral = clean.debts.find((position) => position.kind === "supply")!;
    assert.equal(collateral.name, "Kamino Main collateral");
    assert.equal(collateral.value.source, "kamino-api");
    assert.ok((collateral.value.usd ?? 0) > 0);

    // Constructed from the recorded shape: the same obligation with debt near its liquidation limit.
    const borrowed = (recorded.body as { refreshedStats: Record<string, string> }[]).map((obligation) => ({
      ...obligation,
      refreshedStats: { ...obligation.refreshedStats, userTotalBorrow: "3800", userTotalBorrowBorrowFactorAdjusted: "3800", borrowLiquidationLimit: "4088.1353539070017696" },
    }));
    configureLendingReaders({ kaminoObligations: async (market) => (market === "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF" ? borrowed : []) });
    const loan = await readLendingAccounts([account]);
    assert.equal(loan.health.length, 1);
    assert.equal(loan.health[0]!.status, "critical");
    assert.equal(loan.health[0]!.healthFactor, 1.0758);
    assert.equal(loan.debts.find((position) => position.kind === "borrow")!.value.usd, 3800);
  });

  it("reports an unreadable market as unknown, never as no debt", async () => {
    configureLendingReaders({ kaminoObligations: async () => { throw new Error("down"); } });
    const result = await readLendingAccounts([formatAccountId(CHAINS.solana, TRADER)]);
    assert.ok(result.health.length > 0 && result.health.every((row) => row.status === "unknown"));
    assert.ok(result.failures.length > 0);
  });
});
