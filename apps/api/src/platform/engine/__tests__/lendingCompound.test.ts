/**
 * Compound V3 (Comet) adapter against in-process contract state: exact
 * approvals and never-MAX supplies, refusal of accounts with an open borrow,
 * pause flags, MAX withdrawals, and outcome proofs that catch a supply that
 * only repaid debt or a withdrawal that opened a borrow.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { decodeFunctionData, erc20Abi, zeroAddress, type Abi, type Hex } from "viem";
import type { CometVenue, EvmTransactionRequest, IntentGraph } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { aaveV3Adapter } from "../adapters/aaveV3.js";
import { COMET_ABI, compoundV3Adapter } from "../adapters/lending/compoundV3.js";
import { erc4626Adapter } from "../adapters/lending/erc4626.js";
import { moonwellAdapter } from "../adapters/lending/moonwell.js";
import { configurePlatform, createIntent, prepareStep, submitStep } from "../service.js";
import { MemoryIntentStore } from "../store.js";
import {
  ACCOUNT,
  eventLog,
  installLendingChain,
  landPrepared,
  MAX,
  mockToken,
  revertWith,
  setAllowance,
  setBalance,
  tokenAddress,
  transferLog,
  venue,
  type LendingChain,
  type TokenState,
} from "./lendingChain.js";
import { EVM_ADDRESS } from "./helpers.js";

let chain: LendingChain;

beforeEach(() => {
  chain = installLendingChain();
  configurePlatform({ store: new MemoryIntentStore(), adapters: [aaveV3Adapter, compoundV3Adapter, erc4626Adapter, moonwellAdapter] });
});
afterEach(() => chain.restore());

interface CometOptions {
  network?: "base" | "ethereum";
  position?: bigint;
  borrowed?: bigint;
  supplyPaused?: boolean;
  withdrawPaused?: boolean;
  cash?: bigint;
  baseToken?: string;
  withdraw?: (args: readonly unknown[]) => unknown;
}

interface CometMarket {
  readonly comet: CometVenue;
  readonly usdc: TokenState;
  readonly token: string;
}

function mockComet(options: CometOptions = {}): CometMarket {
  const network = options.network ?? "base";
  const comet = venue<CometVenue>(`${network}:compound-v3:usdc`);
  const token = tokenAddress(network, "USDC");
  const usdc = mockToken(chain, token, { symbol: "USDC", decimals: 6 });
  setBalance(usdc, comet.target, options.cash ?? 10n ** 15n);
  chain.contract(comet.target, [...COMET_ABI, ...erc20Abi.filter((item) => item.type === "function" && item.name === "symbol")] as unknown as Abi, {
    baseToken: () => options.baseToken ?? token,
    decimals: () => 6,
    symbol: () => "cUSDCv3",
    isSupplyPaused: () => options.supplyPaused ?? false,
    isWithdrawPaused: () => options.withdrawPaused ?? false,
    balanceOf: () => options.position ?? 0n,
    borrowBalanceOf: () => options.borrowed ?? 0n,
    getUtilization: () => 900_000_000_000_000_000n,
    getSupplyRate: () => 1_268_391_679n,
    totalSupply: () => 10n ** 13n,
    supply: () => undefined,
    withdraw: (args) => (options.withdraw ? options.withdraw(args) : undefined),
  });
  return { comet, usdc, token };
}

function accounts(network: "base" | "ethereum" = "base"): string[] {
  return [`eip155:${network === "base" ? 8453 : 1}:${EVM_ADDRESS}`];
}

async function planError(text: string, network: "base" | "ethereum" = "base"): Promise<PlatformError> {
  try {
    await createIntent({ text, accounts: accounts(network) });
  } catch (error) {
    assert.ok(error instanceof PlatformError, String(error));
    return error;
  }
  assert.fail(`"${text}" planned but should have been refused`);
}

async function prepared(graph: IntentGraph): Promise<EvmTransactionRequest[]> {
  const { payload } = await prepareStep(graph.id, "s1");
  return payload.transactions as EvmTransactionRequest[];
}

const decode = (abi: Abi, transaction: EvmTransactionRequest | undefined) => decodeFunctionData({ abi, data: transaction?.data as Hex });
const comet = COMET_ABI as unknown as Abi;

describe("Compound V3 supply", () => {
  it("approves exactly, supplies the exact amount (never MAX) and proves Supply plus the position mint", async () => {
    const market = mockComet();
    setBalance(market.usdc, ACCOUNT, 1_000_000_000n);
    const graph = await createIntent({ text: "deposit 250 USDC into compound on base", accounts: accounts() });
    const step = graph.steps[0];
    assert.equal(step?.protocol, "compound-v3");
    assert.equal(step?.venue, "base:compound-v3:usdc");
    assert.equal(step?.minimumOutput?.symbol, "cUSDCv3");
    assert.equal(step?.minimumOutput?.amount, "249999998");
    assert.match(step?.warnings?.join(" ") ?? "", /4\.0\d% APY at planning/u, "rate from getSupplyRate(getUtilization())");
    const transactions = await prepared(graph);
    assert.equal(transactions.length, 2);
    assert.deepEqual(decode(erc20Abi as unknown as Abi, transactions[0]).args, [market.comet.target, 250_000_000n]);
    const supply = decode(comet, transactions[1]);
    assert.equal(supply.functionName, "supply");
    assert.deepEqual(supply.args, [market.token, 250_000_000n]);
    const done = await submitStep(graph.id, "s1", landPrepared(chain, transactions, [[], [
      transferLog(market.token, ACCOUNT, market.comet.target, 250_000_000n),
      eventLog(market.comet.target, comet, "Supply", { from: ACCOUNT, dst: ACCOUNT, amount: 250_000_000n }),
      transferLog(market.comet.target, zeroAddress, ACCOUNT, 249_999_999n),
    ]]));
    assert.equal(done.steps[0]?.status, "settled", JSON.stringify(done.steps[0]?.failure));
    assert.equal(done.steps[0]?.actualOutput?.amount, "249999999", "the credited position (present value)");
  });

  it("fails the step when the supply only repaid a borrow (Supply without a position mint)", async () => {
    const market = mockComet();
    setBalance(market.usdc, ACCOUNT, 1_000_000_000n);
    setAllowance(market.usdc, ACCOUNT, market.comet.target, 1_000_000_000n);
    const graph = await createIntent({ text: "deposit 250 USDC into compound on base", accounts: accounts() });
    const transactions = await prepared(graph);
    assert.equal(transactions.length, 1);
    assert.ok(chain.calls.some((entry) => entry.direct && entry.functionName === "supply"), "simulated before signing");
    const done = await submitStep(graph.id, "s1", landPrepared(chain, transactions, [[
      transferLog(market.token, ACCOUNT, market.comet.target, 250_000_000n),
      eventLog(market.comet.target, comet, "Supply", { from: ACCOUNT, dst: ACCOUNT, amount: 250_000_000n }),
    ]]));
    assert.equal(done.steps[0]?.status, "failed");
    assert.equal(done.steps[0]?.failure?.code, "SUPPLY_REPAID_DEBT");
  });

  it("refuses accounts with an open borrow, paused supply and a base token that is not the pin", async () => {
    mockComet({ borrowed: 5_000_000n });
    const borrow = await planError("deposit 250 USDC into compound on base");
    assert.equal(borrow.code, "VENUE_BORROW_OPEN");
    assert.match(borrow.message, /owes 5 USDC/u);
    mockComet({ supplyPaused: true });
    assert.equal((await planError("deposit 250 USDC into compound on base")).code, "RESERVE_UNAVAILABLE");
    mockComet({ baseToken: "0x2222222222222222222222222222222222222222" });
    assert.equal((await planError("deposit 250 USDC into compound on base")).code, "VENUE_UNVERIFIED");
  });
});

describe("Compound V3 withdraw", () => {
  it("closes the position with withdraw(base, MAX) and proves Withdraw, the burn and the payout", async () => {
    const market = mockComet({ position: 98_736_358n });
    const graph = await createIntent({ text: "withdraw all USDC from compound on base", accounts: accounts() });
    assert.equal(graph.steps[0]?.input?.amount, "98736358");
    assert.equal(graph.steps[0]?.minimumOutput?.amount, "98736356");
    const transactions = await prepared(graph);
    assert.deepEqual(decode(comet, transactions[0]).args, [market.token, MAX]);
    const done = await submitStep(graph.id, "s1", landPrepared(chain, transactions, [[
      eventLog(market.comet.target, comet, "Withdraw", { src: ACCOUNT, to: ACCOUNT, amount: 98_736_400n }),
      transferLog(market.comet.target, ACCOUNT, zeroAddress, 98_736_400n),
      transferLog(market.token, market.comet.target, ACCOUNT, 98_736_400n),
    ]]));
    assert.equal(done.steps[0]?.status, "settled", JSON.stringify(done.steps[0]?.failure));
    assert.equal(done.steps[0]?.actualOutput?.amount, "98736400");
  });

  it("fails an exact withdrawal whose burn does not cover the amount (Comet opened a borrow)", async () => {
    const market = mockComet({ position: 100_000_000n });
    const graph = await createIntent({ text: "withdraw 60 USDC from compound on base", accounts: accounts() });
    const transactions = await prepared(graph);
    assert.deepEqual(decode(comet, transactions[0]).args, [market.token, 60_000_000n]);
    const done = await submitStep(graph.id, "s1", landPrepared(chain, transactions, [[
      eventLog(market.comet.target, comet, "Withdraw", { src: ACCOUNT, to: ACCOUNT, amount: 60_000_000n }),
      transferLog(market.comet.target, ACCOUNT, zeroAddress, 10_000_000n),
      transferLog(market.token, market.comet.target, ACCOUNT, 60_000_000n),
    ]]));
    assert.equal(done.steps[0]?.failure?.code, "OUTCOME_NOT_PROVEN");
    assert.match(done.steps[0]?.failure?.message ?? "", /borrowed/u);
  });

  it("refuses amounts above the balance, paused withdrawals, missing cash and reverting simulations", async () => {
    mockComet({ position: 10_000_000n });
    assert.equal((await planError("withdraw 60 USDC from compound on base")).code, "INSUFFICIENT_BALANCE");
    mockComet({ position: 100_000_000n, withdrawPaused: true });
    assert.equal((await planError("withdraw 60 USDC from compound on base")).code, "RESERVE_UNAVAILABLE");
    mockComet({ position: 100_000_000n, cash: 1_000_000n });
    assert.equal((await planError("withdraw 60 USDC from compound on base")).code, "VENUE_ILLIQUID");
    mockComet({ position: 100_000_000n, withdraw: () => { throw revertWith(comet, "NotCollateralized"); } });
    const reverted = await planError("withdraw 60 USDC from compound on base");
    assert.equal(reverted.code, "SIMULATION_FAILED");
    assert.match(reverted.message, /NotCollateralized/u);
  });

  it("runs on Ethereum through the chain-attested client", async () => {
    const market = mockComet({ network: "ethereum", position: 5_000_000n });
    const graph = await createIntent({ text: "withdraw all USDC from compound on ethereum", accounts: accounts("ethereum") });
    assert.equal(graph.steps[0]?.venue, "ethereum:compound-v3:usdc");
    const transactions = await prepared(graph);
    assert.equal(transactions[0]?.chainId, 1);
    assert.equal(transactions[0]?.to, market.comet.target);
  });
});
