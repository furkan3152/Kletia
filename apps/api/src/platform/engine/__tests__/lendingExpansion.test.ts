/**
 * Round 7 lending venue expansion (protocols design 3.2, package P3): every
 * new YIELD_VENUES row resolves by slug, target and receipt; the adapters
 * read each new venue's identity back (Comet baseToken for the USDT0 / USDT
 * comets, the pinned Morpho factory for the Ethereum v1.0 and OP / Polygon
 * v1.1 vaults, the aToken for the new Aave reserves including the Arbitrum
 * Sepolia testnet market) and refuse a mismatch; and Ethereum USDT with a
 * partial allowance plans a reset-to-zero before the exact approval on
 * every lending adapter that takes it (Aave, Morpho), so the approve never
 * reverts on-chain.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { decodeFunctionData, erc20Abi, zeroAddress, type Abi, type Hex } from "viem";
import {
  findAssetBySymbol,
  findYieldVenue,
  getYieldVenue,
  MORPHO_FACTORIES,
  type AaveReserveVenue,
  type CometVenue,
  type Erc4626Venue,
  type EvmTransactionRequest,
  type IntentGraph,
  type NetworkKey,
} from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { aaveV3Adapter, DATA_PROVIDER_ABI, POOL_ABI } from "../adapters/aaveV3.js";
import { COMET_ABI, compoundV3Adapter } from "../adapters/lending/compoundV3.js";
import { erc4626Adapter, FACTORY_ABI, VAULT_ABI } from "../adapters/lending/erc4626.js";
import { moonwellAdapter } from "../adapters/lending/moonwell.js";
import { configurePlatform, createIntent, prepareStep } from "../service.js";
import { MemoryIntentStore } from "../store.js";
import { EVM_ADDRESS } from "./helpers.js";
import {
  ACCOUNT,
  installLendingChain,
  MAX,
  mockToken,
  setAllowance,
  setBalance,
  tokenAddress,
  venue,
  type LendingChain,
  type TokenState,
} from "./lendingChain.js";

let chain: LendingChain;

beforeEach(() => {
  chain = installLendingChain();
  configurePlatform({ store: new MemoryIntentStore(), adapters: [aaveV3Adapter, compoundV3Adapter, erc4626Adapter, moonwellAdapter] });
});
afterEach(() => chain.restore());

const RAY = 10n ** 27n;
const E18 = 10n ** 18n;

const CHAIN_IDS: Partial<Record<NetworkKey, number>> = {
  base: 8453,
  arbitrum: 42161,
  ethereum: 1,
  optimism: 10,
  polygon: 137,
  "arbitrum-sepolia": 421614,
};

function accounts(network: NetworkKey): string[] {
  return [`eip155:${CHAIN_IDS[network]}:${EVM_ADDRESS}`];
}

async function planError(text: string, network: NetworkKey): Promise<PlatformError> {
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

/* ------------------------------------------------------------- registry */

/** Rows of design 3.2 (A6-A14): venue id, network, protocol, asset symbol, target, receipt. */
const NEW_ROWS: readonly { id: string; network: NetworkKey; asset: string; target: string; receipt?: string }[] = [
  { id: "ethereum:aave-v3:usdt", network: "ethereum", asset: "USDT", target: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2", receipt: "0x23878914EFE38d27C4D67Ab83ed1b93A74D4086a" },
  { id: "ethereum:aave-v3:wsteth", network: "ethereum", asset: "wstETH", target: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2", receipt: "0x0B925eD163218f6662a35e0f0371Ac234f9E9371" },
  { id: "ethereum:aave-v3:cbbtc", network: "ethereum", asset: "cbBTC", target: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2", receipt: "0x5c647cE0Ae10658ec44FA4E11A51c96e94efd1Dd" },
  { id: "arbitrum:aave-v3:usdt0", network: "arbitrum", asset: "USDT0", target: "0x794a61358D6845594F94dc1DB02A252b5b4814aD", receipt: "0x6ab707Aca953eDAeFBc4fD23bA73294241490620" },
  { id: "arbitrum:aave-v3:wsteth", network: "arbitrum", asset: "wstETH", target: "0x794a61358D6845594F94dc1DB02A252b5b4814aD", receipt: "0x513c7E3a9c69cA3e22550eF58AC1C0088e918FFf" },
  { id: "optimism:aave-v3:usdt", network: "optimism", asset: "USDT", target: "0x794a61358D6845594F94dc1DB02A252b5b4814aD", receipt: "0x6ab707Aca953eDAeFBc4fD23bA73294241490620" },
  { id: "optimism:aave-v3:wsteth", network: "optimism", asset: "wstETH", target: "0x794a61358D6845594F94dc1DB02A252b5b4814aD", receipt: "0xc45A479877e1e9Dfe9FcD4056c699575a1045dAA" },
  { id: "polygon:aave-v3:usdt0", network: "polygon", asset: "USDT0", target: "0x794a61358D6845594F94dc1DB02A252b5b4814aD", receipt: "0x6ab707Aca953eDAeFBc4fD23bA73294241490620" },
  { id: "polygon:aave-v3:wsteth", network: "polygon", asset: "wstETH", target: "0x794a61358D6845594F94dc1DB02A252b5b4814aD", receipt: "0xf59036CAEBeA7dC4b86638DFA2E3C97dA9FcCd40" },
  { id: "base:aave-v3:wsteth", network: "base", asset: "wstETH", target: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5", receipt: "0x99CBC45ea5bb7eF3a5BC08FB1B7E56bB2442Ef0D" },
  { id: "base:aave-v3:cbeth", network: "base", asset: "cbETH", target: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5", receipt: "0xcf3D55c10DB69f28fD1A75Bd73f3D8A2d9c595ad" },
  { id: "arbitrum-sepolia:aave-v3:usdc", network: "arbitrum-sepolia", asset: "USDC", target: "0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff", receipt: "0x460b97BD498E1157530AEb3086301d5225b91216" },
  { id: "arbitrum:compound-v3:usdt0", network: "arbitrum", asset: "USDT0", target: "0xd98Be00b5D27fc98112BdE293e487f8D4cA57d07" },
  { id: "optimism:compound-v3:usdt", network: "optimism", asset: "USDT", target: "0x995E394b8B2437aC8Ce61Ee0bC610D617962B214" },
  { id: "polygon:compound-v3:usdt0", network: "polygon", asset: "USDT0", target: "0xaeB318360f27748Acb200CE616E389A6C9409a07" },
  { id: "ethereum:compound-v3:wsteth", network: "ethereum", asset: "wstETH", target: "0x3D0bb1ccaB520A66e607822fC55BC921738fAFE3" },
  { id: "ethereum:morpho:steakhouse-usdc", network: "ethereum", asset: "USDC", target: "0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB" },
  { id: "ethereum:morpho:steakhouse-usdt", network: "ethereum", asset: "USDT", target: "0xbEef047a543E45807105E51A8BBEFCc5950fcfBa" },
  { id: "ethereum:morpho:steakhouse-eth", network: "ethereum", asset: "WETH", target: "0xBEEf050ecd6a16c4e7bfFbB52Ebba7846C4b8cD4" },
  { id: "optimism:morpho:gauntlet-usdc-prime", network: "optimism", asset: "USDC", target: "0xC30ce6A5758786e0F640cC5f881Dd96e9a1C5C59" },
  { id: "polygon:morpho:compound-usdc", network: "polygon", asset: "USDC", target: "0x781FB7F6d845E3bE129289833b04d43Aa8558c42" },
  { id: "polygon:morpho:compound-usdt", network: "polygon", asset: "USDT0", target: "0xfD06859A671C21497a2EB8C5E3fEA48De924D6c8" },
];

describe("lending expansion: registry rows", () => {
  it("every new row resolves by id, slug, target and receipt on its own network only", () => {
    for (const row of NEW_ROWS) {
      const found = getYieldVenue(row.id);
      assert.ok(found, `${row.id} is a YIELD_VENUES row`);
      assert.equal(found.network, row.network);
      assert.equal(found.asset, row.asset, `${row.id} asset`);
      assert.ok(found.actions.includes("deposit") && found.actions.includes("withdraw"), `${row.id} deposits and withdraws`);
      assert.ok("target" in found && found.target.toLowerCase() === row.target.toLowerCase(), `${row.id} target`);
      assert.ok(findAssetBySymbol(row.network, row.asset)?.address, `${row.asset} is a pinned ERC-20 on ${row.network}`);
      assert.equal(findYieldVenue(row.network, found.slug, found.protocol)?.id, row.id, `${row.id} by slug`);
      const receipt = row.receipt ?? row.target;
      assert.ok("receipt" in found && found.receipt.address.toLowerCase() === receipt.toLowerCase(), `${row.id} receipt`);
      // A shared Pool (Aave) resolves to its first reserve by target; the receipt is unique per reserve.
      assert.equal(findYieldVenue(row.network, receipt, found.protocol)?.id, row.id, `${row.id} by receipt`);
      for (const other of Object.keys(CHAIN_IDS) as NetworkKey[]) {
        if (other === row.network) continue;
        assert.notEqual(findYieldVenue(other, receipt, found.protocol)?.id, row.id, `${row.id} never resolves on ${other}`);
      }
    }
  });

  it("existing defaults stay first per (network, protocol, asset)", () => {
    assert.equal(findYieldVenue("ethereum", "steakhouse-prime-usdc", "morpho")?.id, "ethereum:morpho:steakhouse-prime-usdc");
    assert.equal(findYieldVenue("ethereum", "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2", "aave-v3")?.id, "ethereum:aave-v3:usdc");
  });

  it("Morpho rows carry the factory pinned for their generation", () => {
    const expected: Record<string, string> = {
      "ethereum:morpho:steakhouse-usdc": "0xA9c3D3a366466Fa809d1Ae982Fb2c46E5fC41101",
      "ethereum:morpho:steakhouse-usdt": "0xA9c3D3a366466Fa809d1Ae982Fb2c46E5fC41101",
      "ethereum:morpho:steakhouse-eth": "0xA9c3D3a366466Fa809d1Ae982Fb2c46E5fC41101",
      "optimism:morpho:gauntlet-usdc-prime": "0x3Bb6A6A0Bc85b367EFE0A5bAc81c5E52C892839a",
      "polygon:morpho:compound-usdc": "0xa9c87daB340631C34BB738625C70499e29ddDC98",
      "polygon:morpho:compound-usdt": "0xa9c87daB340631C34BB738625C70499e29ddDC98",
    };
    for (const [id, factory] of Object.entries(expected)) {
      const vault = venue<Erc4626Venue>(id);
      assert.equal(vault.factory.toLowerCase(), factory.toLowerCase(), id);
      assert.equal(MORPHO_FACTORIES[vault.network]?.[vault.generation]?.toLowerCase(), factory.toLowerCase(), `${id} generation ${vault.generation}`);
    }
  });
});

/* ----------------------------------------------------------------- Aave */

function mockAave(id: string, options: { decimals: number; symbol: string; reportedAToken?: string; paused?: boolean }): { reserve: AaveReserveVenue; underlying: TokenState } {
  const reserve = venue<AaveReserveVenue>(id);
  const underlying = mockToken(chain, tokenAddress(reserve.network, reserve.asset), { symbol: options.symbol, decimals: options.decimals });
  mockToken(chain, reserve.receipt.address, { symbol: `a${options.symbol}`, decimals: options.decimals, totalSupply: 10n ** BigInt(options.decimals + 6) });
  chain.contract(reserve.dataProvider, DATA_PROVIDER_ABI as unknown as Abi, {
    getReserveTokensAddresses: () => [options.reportedAToken ?? reserve.receipt.address, zeroAddress, zeroAddress],
    getReserveConfigurationData: () => [BigInt(options.decimals), 7500n, 7800n, 10500n, 1000n, true, true, false, true, false],
    getPaused: () => options.paused ?? false,
    getReserveCaps: () => [0n, 0n],
  });
  chain.contract(reserve.target, POOL_ABI as unknown as Abi, {
    getReserveData: () => ({
      configuration: 0n,
      liquidityIndex: RAY,
      currentLiquidityRate: (30n * RAY) / 1000n,
      variableBorrowIndex: RAY,
      currentVariableBorrowRate: 0n,
      currentStableBorrowRate: 0n,
      lastUpdateTimestamp: 1,
      id: 1,
      aTokenAddress: reserve.receipt.address,
      stableDebtTokenAddress: zeroAddress,
      variableDebtTokenAddress: zeroAddress,
      interestRateStrategyAddress: zeroAddress,
      accruedToTreasury: 0n,
      unbacked: 0n,
      isolationModeTotalDebt: 0n,
    }),
    getVirtualUnderlyingBalance: () => 10n ** BigInt(options.decimals + 9),
    getUserAccountData: () => [0n, 0n, 0n, 0n, 0n, MAX],
    supply: () => undefined,
    withdraw: (args) => args[1],
  });
  return { reserve, underlying };
}

describe("lending expansion: Aave V3", () => {
  it("Ethereum USDT with a partial allowance resets to zero, approves exactly, then supplies", async () => {
    const { reserve, underlying } = mockAave("ethereum:aave-v3:usdt", { decimals: 6, symbol: "USDT" });
    setBalance(underlying, ACCOUNT, 500_000_000n);
    setAllowance(underlying, ACCOUNT, reserve.spender, 5n);
    const graph = await createIntent({ text: "deposit 100 USDT into aave on ethereum", accounts: accounts("ethereum") });
    assert.equal(graph.steps[0]?.venue, "ethereum:aave-v3:usdt");
    const transactions = await prepared(graph);
    assert.equal(transactions.length, 3, "reset, approve, supply");
    const reset = decode(erc20Abi as unknown as Abi, transactions[0]);
    const approve = decode(erc20Abi as unknown as Abi, transactions[1]);
    assert.equal(transactions[0]?.to.toLowerCase(), tokenAddress("ethereum", "USDT").toLowerCase());
    assert.equal(reset.functionName, "approve");
    assert.equal(String(reset.args?.[0]).toLowerCase(), reserve.spender.toLowerCase());
    assert.equal(reset.args?.[1], 0n);
    assert.match(transactions[0]?.description ?? "", /to zero/u);
    assert.equal(approve.functionName, "approve");
    assert.equal(String(approve.args?.[0]).toLowerCase(), reserve.spender.toLowerCase());
    assert.equal(approve.args?.[1], 100_000_000n, "exact amount, never MAX");
    const supply = decode(POOL_ABI as unknown as Abi, transactions[2]);
    assert.equal(supply.functionName, "supply");
    assert.equal(supply.args?.[1], 100_000_000n);
  });

  it("Ethereum USDT with no allowance approves once (no reset)", async () => {
    const { underlying } = mockAave("ethereum:aave-v3:usdt", { decimals: 6, symbol: "USDT" });
    setBalance(underlying, ACCOUNT, 500_000_000n);
    const graph = await createIntent({ text: "deposit 100 USDT into aave on ethereum", accounts: accounts("ethereum") });
    const transactions = await prepared(graph);
    assert.equal(transactions.length, 2, "approve, supply");
    assert.equal(decode(erc20Abi as unknown as Abi, transactions[0]).args?.[1], 100_000_000n);
  });

  it("USDT0 on Arbitrum (typed as USDT) never resets: only Ethereum USDT needs it", async () => {
    const { reserve, underlying } = mockAave("arbitrum:aave-v3:usdt0", { decimals: 6, symbol: "USD₮0" });
    setBalance(underlying, ACCOUNT, 500_000_000n);
    setAllowance(underlying, ACCOUNT, reserve.spender, 5n);
    const graph = await createIntent({ text: "deposit 100 USDT into aave on arbitrum", accounts: accounts("arbitrum") });
    assert.equal(graph.steps[0]?.venue, "arbitrum:aave-v3:usdt0");
    const transactions = await prepared(graph);
    assert.equal(transactions.length, 2, "approve, supply");
  });

  it("refuses a new reserve whose data provider reports another aToken", async () => {
    mockAave("polygon:aave-v3:wsteth", { decimals: 18, symbol: "wstETH", reportedAToken: "0x000000000000000000000000000000000000dEaD" });
    const error = await planError("deposit 1 wstETH into aave on polygon", "polygon");
    assert.equal(error.code, "VENUE_UNVERIFIED");
  });

  it("plans a supply on the Arbitrum Sepolia testnet market (Circle test USDC)", async () => {
    const { reserve, underlying } = mockAave("arbitrum-sepolia:aave-v3:usdc", { decimals: 6, symbol: "USDC" });
    setBalance(underlying, ACCOUNT, 5_000_000n);
    const graph = await createIntent({ text: "deposit 1 USDC into aave on arbitrum sepolia", accounts: accounts("arbitrum-sepolia") });
    const step = graph.steps[0];
    assert.equal(step?.network, "arbitrum-sepolia");
    assert.equal(step?.venue, "arbitrum-sepolia:aave-v3:usdc");
    const transactions = await prepared(graph);
    assert.equal(transactions.length, 2);
    assert.ok(transactions.every((transaction) => transaction.chainId === 421614), "testnet chain id on every transaction");
    assert.equal(transactions[1]?.to.toLowerCase(), reserve.target.toLowerCase());
  });
});

/* ------------------------------------------------------------- Compound */

function mockComet(id: string, options: { symbol: string; decimals: number; baseToken?: string }): { comet: CometVenue; underlying: TokenState } {
  const comet = venue<CometVenue>(id);
  const token = tokenAddress(comet.network, comet.asset);
  const underlying = mockToken(chain, token, { symbol: options.symbol, decimals: options.decimals });
  setBalance(underlying, comet.target, 10n ** BigInt(options.decimals + 9));
  chain.contract(comet.target, [...COMET_ABI, ...erc20Abi.filter((item) => item.type === "function" && item.name === "symbol")] as unknown as Abi, {
    baseToken: () => options.baseToken ?? token,
    decimals: () => options.decimals,
    symbol: () => `c${options.symbol}v3`,
    isSupplyPaused: () => false,
    isWithdrawPaused: () => false,
    balanceOf: () => 0n,
    borrowBalanceOf: () => 0n,
    getUtilization: () => 880_000_000_000_000_000n,
    getSupplyRate: () => 1_268_391_679n,
    totalSupply: () => 10n ** BigInt(options.decimals + 7),
    supply: () => undefined,
    withdraw: () => undefined,
  });
  return { comet, underlying };
}

describe("lending expansion: Compound V3", () => {
  for (const [id, network, text] of [
    ["arbitrum:compound-v3:usdt0", "arbitrum", "deposit 100 USDT into compound on arbitrum"],
    ["optimism:compound-v3:usdt", "optimism", "deposit 100 USDT into compound on optimism"],
    ["polygon:compound-v3:usdt0", "polygon", "deposit 100 USDT into compound on polygon"],
  ] as const) {
    it(`${id}: baseToken read back, exact approval, supply`, async () => {
      const { comet, underlying } = mockComet(id, { symbol: "USDT", decimals: 6 });
      setBalance(underlying, ACCOUNT, 500_000_000n);
      const graph = await createIntent({ text, accounts: accounts(network) });
      assert.equal(graph.steps[0]?.venue, id);
      assert.ok(chain.calls.some((call) => call.to === comet.target.toLowerCase() && call.functionName === "baseToken"), "baseToken identity read");
      const transactions = await prepared(graph);
      assert.equal(transactions.length, 2);
      assert.equal(decode(erc20Abi as unknown as Abi, transactions[0]).args?.[1], 100_000_000n);
      assert.equal(decode(COMET_ABI as unknown as Abi, transactions[1]).functionName, "supply");
    });
  }

  it("refuses a USDT0 comet whose baseToken is not the pinned USDT0", async () => {
    mockComet("polygon:compound-v3:usdt0", { symbol: "USDT", decimals: 6, baseToken: "0x000000000000000000000000000000000000dEaD" });
    const error = await planError("deposit 100 USDT into compound on polygon", "polygon");
    assert.equal(error.code, "VENUE_UNVERIFIED");
  });

  it("plans the Ethereum wstETH comet", async () => {
    const { underlying } = mockComet("ethereum:compound-v3:wsteth", { symbol: "wstETH", decimals: 18 });
    setBalance(underlying, ACCOUNT, 5n * E18);
    const graph = await createIntent({ text: "deposit 1 wstETH into compound on ethereum", accounts: accounts("ethereum") });
    assert.equal(graph.steps[0]?.venue, "ethereum:compound-v3:wsteth");
  });
});

/* --------------------------------------------------------------- Morpho */

function mockVault(id: string, options: { symbol: string; decimals: number; confirmed?: boolean }): { vault: Erc4626Venue; underlying: TokenState } {
  const vault = venue<Erc4626Venue>(id);
  const token = tokenAddress(vault.network, vault.asset);
  const underlying = mockToken(chain, token, { symbol: options.symbol, decimals: options.decimals });
  const unit = 10n ** BigInt(options.decimals);
  chain.contract(vault.factory, FACTORY_ABI as unknown as Abi, {
    isVaultV2: () => false,
    isMetaMorpho: ([target]) => (options.confirmed ?? true) && String(target).toLowerCase() === vault.target.toLowerCase(),
  });
  chain.contract(vault.target, [...VAULT_ABI, ...erc20Abi.filter((item) => item.type === "function" && item.name === "symbol")] as unknown as Abi, {
    asset: () => token,
    decimals: () => 18,
    symbol: () => "steak",
    totalAssets: () => 1_000_000n * unit,
    balanceOf: () => 0n,
    convertToAssets: ([shares]) => ((shares as bigint) * unit) / E18,
    previewDeposit: ([assets]) => ((assets as bigint) * E18) / unit,
    previewRedeem: ([shares]) => ((shares as bigint) * unit) / E18,
    previewWithdraw: ([assets]) => ((assets as bigint) * E18) / unit + 1n,
    maxDeposit: () => 1_000_000n * unit,
    maxWithdraw: () => 0n,
    receiveSharesGate: () => zeroAddress,
    sendSharesGate: () => zeroAddress,
    receiveAssetsGate: () => zeroAddress,
    sendAssetsGate: () => zeroAddress,
    deposit: ([assets]) => ((assets as bigint) * E18) / unit,
  });
  return { vault, underlying };
}

describe("lending expansion: Morpho vaults", () => {
  it("Ethereum Steakhouse USDT (v1.0 factory) with a partial allowance resets, approves exactly, deposits", async () => {
    const { vault, underlying } = mockVault("ethereum:morpho:steakhouse-usdt", { symbol: "USDT", decimals: 6 });
    setBalance(underlying, ACCOUNT, 500_000_000n);
    setAllowance(underlying, ACCOUNT, vault.spender, 7n);
    const graph = await createIntent({ text: "deposit 100 USDT into morpho steakhouse-usdt on ethereum", accounts: accounts("ethereum") });
    assert.equal(graph.steps[0]?.venue, "ethereum:morpho:steakhouse-usdt");
    assert.ok(
      chain.calls.some((call) => call.to === vault.factory.toLowerCase() && call.functionName === "isMetaMorpho"),
      "the v1.0 factory confirms the vault",
    );
    const transactions = await prepared(graph);
    assert.equal(transactions.length, 3, "reset, approve, deposit");
    assert.equal(decode(erc20Abi as unknown as Abi, transactions[0]).args?.[1], 0n);
    assert.equal(decode(erc20Abi as unknown as Abi, transactions[1]).args?.[1], 100_000_000n);
    const deposit = decode(VAULT_ABI as unknown as Abi, transactions[2]);
    assert.equal(deposit.functionName, "deposit");
    assert.equal(String(deposit.args?.[1]).toLowerCase(), ACCOUNT.toLowerCase());
  });

  for (const [id, network, text, symbol] of [
    ["ethereum:morpho:steakhouse-usdc", "ethereum", "deposit 100 USDC into morpho steakhouse-usdc on ethereum", "USDC"],
    ["optimism:morpho:gauntlet-usdc-prime", "optimism", "deposit 100 USDC into morpho on optimism", "USDC"],
    ["polygon:morpho:compound-usdc", "polygon", "deposit 100 USDC into morpho on polygon", "USDC"],
    ["polygon:morpho:compound-usdt", "polygon", "deposit 100 USDT into morpho on polygon", "USDT"],
  ] as const) {
    it(`${id}: the pinned factory confirms the vault and the deposit plans`, async () => {
      const { vault, underlying } = mockVault(id, { symbol, decimals: 6 });
      setBalance(underlying, ACCOUNT, 500_000_000n);
      const graph = await createIntent({ text, accounts: accounts(network) });
      assert.equal(graph.steps[0]?.venue, id);
      assert.ok(chain.calls.some((call) => call.to === vault.factory.toLowerCase() && call.functionName === "isMetaMorpho"));
    });
  }

  it("refuses a vault its pinned factory does not confirm", async () => {
    mockVault("optimism:morpho:gauntlet-usdc-prime", { symbol: "USDC", decimals: 6, confirmed: false });
    const error = await planError("deposit 100 USDC into morpho on optimism", "optimism");
    assert.equal(error.code, "VENUE_UNVERIFIED");
  });
});
