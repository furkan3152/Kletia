/**
 * Kelp: restake ETH for rsETH through the LRTDepositPool on Ethereum
 * (round 9, E1).
 *
 * Plan and prepare read: the pool's lrtConfig() equals the config pin, and
 * the config's rsETH(), getContract(LRT_DEPOSIT_POOL) and
 * getContract(LRT_ORACLE) equal the rsETH, pool and oracle pins
 * (VENUE_UNVERIFIED otherwise); the pool is not paused; the amount is at
 * least minAmountToDeposit() and within getAssetCurrentLimit(ETH); the
 * expected output is getRsETHAmountToMint(ETH, amount). The transaction is
 * depositETH(minRSETHAmountExpected, "") with value = amount, where the
 * minimum is exactly the guaranteed output (expected less
 * STAKE_TOLERANCE_BPS): the pool reverts below it, so the step is
 * `floor: "onchain"`. rsETH is minted to the sender. Proof: the landed call is
 * that depositETH with the recorded minimum and an rsETH mint of at least the
 * floor to the account.
 *
 * rsETH is restaked ETH (EigenLayer slashing risk); Kelp withdrawals go
 * through its own queue and are not supported by Kletia.
 */
import { decodeFunctionData, encodeFunctionData, getAddress, keccak256, parseAbi, toHex, zeroAddress, type Hex } from "viem";
import { PlatformError } from "../../../errors.js";
import { formatUnits, lessBps, sameAddress, transferred, withTimeout } from "../lending/common.js";
import type { ProtocolAdapter } from "../types.js";
import { client, createStakingAdapter, pinned, STAKE_TOLERANCE_BPS, type StakingVenue } from "./common.js";

/** Kelp's marker for native ETH in its asset-keyed reads. */
export const KELP_ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as const;
/** Kelp's referral id (none). */
const REFERRAL = "";

export const KELP_POOL_ABI = parseAbi([
  "function depositETH(uint256 minRSETHAmountExpected,string referralId) payable",
  "function lrtConfig() view returns (address)",
  "function paused() view returns (bool)",
  "function minAmountToDeposit() view returns (uint256)",
  "function getAssetCurrentLimit(address asset) view returns (uint256)",
  "function getRsETHAmountToMint(address asset,uint256 amount) view returns (uint256)",
]);
export const KELP_CONFIG_ABI = parseAbi([
  "function rsETH() view returns (address)",
  "function getContract(bytes32 key) view returns (address)",
]);
export const KELP_ORACLE_ABI = parseAbi(["function rsETHPrice() view returns (uint256)"]);

const LRT_DEPOSIT_POOL = keccak256(toHex("LRT_DEPOSIT_POOL"));
const LRT_ORACLE = keccak256(toHex("LRT_ORACLE"));

export function kelpDepositData(minimum: bigint): Hex {
  return encodeFunctionData({ abi: KELP_POOL_ABI, functionName: "depositETH", args: [minimum, REFERRAL] });
}

export const kelpVenue: StakingVenue = {
  protocol: "kelp",
  label: "Kelp",
  symbol: "rsETH",
  tokenRole: "lst-token",

  async ethValue(units) {
    const price = await withTimeout(client().readContract({ address: pinned("kelp", "rate-oracle"), abi: KELP_ORACLE_ABI, functionName: "rsETHPrice" }));
    return (units * price) / 10n ** 18n;
  },

  async quote({ amount }) {
    const pool = pinned("kelp", "deposit-target");
    const config = pinned("kelp", "config");
    const rseth = pinned("kelp", "lst-token");
    const oracle = pinned("kelp", "rate-oracle");
    const evm = client();
    const [reportedConfig, reportedToken, reportedPool, reportedOracle, paused, minimum, limit, expected] = await withTimeout(Promise.all([
      evm.readContract({ address: pool, abi: KELP_POOL_ABI, functionName: "lrtConfig" }),
      evm.readContract({ address: config, abi: KELP_CONFIG_ABI, functionName: "rsETH" }),
      evm.readContract({ address: config, abi: KELP_CONFIG_ABI, functionName: "getContract", args: [LRT_DEPOSIT_POOL] }),
      evm.readContract({ address: config, abi: KELP_CONFIG_ABI, functionName: "getContract", args: [LRT_ORACLE] }),
      evm.readContract({ address: pool, abi: KELP_POOL_ABI, functionName: "paused" }),
      evm.readContract({ address: pool, abi: KELP_POOL_ABI, functionName: "minAmountToDeposit" }),
      evm.readContract({ address: pool, abi: KELP_POOL_ABI, functionName: "getAssetCurrentLimit", args: [KELP_ETH] }),
      evm.readContract({ address: pool, abi: KELP_POOL_ABI, functionName: "getRsETHAmountToMint", args: [KELP_ETH, amount] }),
    ]));
    if (!sameAddress(reportedConfig, config) || !sameAddress(reportedToken, rseth) || !sameAddress(reportedPool, pool) || !sameAddress(reportedOracle, oracle)) {
      throw new PlatformError("VENUE_UNVERIFIED", "The Kelp deposit pool or its config no longer points at the pinned config, rsETH, pool and oracle. Kletia will not use it.", 422);
    }
    if (paused) throw new PlatformError("RESERVE_UNAVAILABLE", "Kelp deposits are paused right now; try again later.", 422);
    if (amount < minimum) {
      throw new PlatformError("AMOUNT_TOO_SMALL", `Kelp takes at least ${formatUnits(minimum, 18, "ETH")} per deposit; ${formatUnits(amount, 18, "ETH")} is below its minimum.`, 422);
    }
    if (amount > limit) {
      throw new PlatformError("RESERVE_UNAVAILABLE", `Kelp accepts at most ${formatUnits(limit, 18, "ETH")} more ETH right now; ${formatUnits(amount, 18, "ETH")} does not fit.`, 422);
    }
    const onchainMinimum = lessBps(expected, STAKE_TOLERANCE_BPS);
    return {
      to: pool,
      data: kelpDepositData(onchainMinimum),
      expected,
      onchainMinimum,
      warnings: ["rsETH is restaked ETH: it carries EigenLayer slashing risk on top of staking risk, and can trade below the value of the restaked ETH."],
    };
  },

  prove(step, receipt, account) {
    const rseth = pinned("kelp", "lst-token");
    let minimum: bigint;
    try {
      const decoded = decodeFunctionData({ abi: KELP_POOL_ABI, data: receipt.input as Hex });
      if (decoded.functionName !== "depositETH") return { failure: "The Kelp call is not depositETH." };
      minimum = decoded.args[0];
    } catch {
      return { failure: "The Kelp call is not depositETH." };
    }
    const floor = BigInt(step.minimumOutput?.amount ?? "0");
    if (minimum < floor) return { failure: `The Kelp call's minimum (${minimum}) is below the step's guaranteed rsETH (${floor}).` };
    const minted = transferred([receipt], rseth, zeroAddress, account);
    if (minted === 0n) return { failure: "rsETH minted nothing to the account." };
    return { minted, detail: `Kelp: ${formatUnits(receipt.value, 18, "ETH")} restaked; ${formatUnits(minted, 18, "rsETH")} minted to ${getAddress(account)} (on-chain minimum ${formatUnits(minimum, 18, "rsETH")}).` };
  },
};

export const kelpAdapter: ProtocolAdapter | null = createStakingAdapter(kelpVenue);
