/**
 * ether.fi: stake ETH for weETH through the pinned DepositAdapter
 * (protocols design 3.10). The adapter deposits into the LiquidityPool for
 * eETH, wraps it into weETH (minted to the adapter) and transfers the weETH
 * to the sender.
 *
 * Plan and prepare read: the DepositAdapter's weETH(), eETH() and
 * liquidityPool() equal their pins and the LiquidityPool is not paused; the
 * expected output is weETH.getWeETHByeETH(amount), and prepare's dry run of
 * depositETHForWeETH(address(0)) from the account must return at least the
 * floor. Proof: weETH moves from the DepositAdapter to the account, at least
 * the floor. weETH is restaked ETH and carries slashing risk; the step says so.
 */
import { decodeFunctionResult, encodeFunctionData, getAddress, parseAbi, zeroAddress } from "viem";
import { PlatformError } from "../../../errors.js";
import { formatUnits, sameAddress, transferred, withTimeout } from "../lending/common.js";
import type { ProtocolAdapter } from "../types.js";
import { client, createStakingAdapter, pinned, type StakingVenue } from "./common.js";

export const ETHERFI_ADAPTER_ABI = parseAbi([
  "function depositETHForWeETH(address referral) payable returns (uint256)",
  "function weETH() view returns (address)",
  "function eETH() view returns (address)",
  "function liquidityPool() view returns (address)",
]);
export const ETHERFI_POOL_ABI = parseAbi(["function paused() view returns (bool)"]);
export const WEETH_ABI = parseAbi([
  "function getWeETHByeETH(uint256 eETHAmount) view returns (uint256)",
  "function getEETHByWeETH(uint256 weETHAmount) view returns (uint256)",
]);

/** eETH share rounding: the LiquidityPool credits the deposit less a wei or two. */
const EETH_ROUNDING_WEI = 2n;

function depositData() {
  return encodeFunctionData({ abi: ETHERFI_ADAPTER_ABI, functionName: "depositETHForWeETH", args: [zeroAddress] });
}

export const etherfiVenue: StakingVenue = {
  protocol: "etherfi",
  label: "ether.fi",
  symbol: "weETH",
  tokenRole: "lst-token",
  rateFunction: "getEETHByWeETH",

  async quote({ amount }) {
    const adapter = pinned("etherfi", "deposit-target");
    const pool = pinned("etherfi", "liquidity-pool");
    const weeth = pinned("etherfi", "lst-token");
    const eeth = pinned("etherfi", "underlying-token");
    const evm = client();
    const [reportedWeeth, reportedEeth, reportedPool, paused, expected] = await withTimeout(Promise.all([
      evm.readContract({ address: adapter, abi: ETHERFI_ADAPTER_ABI, functionName: "weETH" }),
      evm.readContract({ address: adapter, abi: ETHERFI_ADAPTER_ABI, functionName: "eETH" }),
      evm.readContract({ address: adapter, abi: ETHERFI_ADAPTER_ABI, functionName: "liquidityPool" }),
      evm.readContract({ address: pool, abi: ETHERFI_POOL_ABI, functionName: "paused" }),
      evm.readContract({ address: weeth, abi: WEETH_ABI, functionName: "getWeETHByeETH", args: [amount > EETH_ROUNDING_WEI ? amount - EETH_ROUNDING_WEI : 0n] }),
    ]));
    if (!sameAddress(reportedWeeth, weeth) || !sameAddress(reportedEeth, eeth) || !sameAddress(reportedPool, pool)) {
      throw new PlatformError("VENUE_UNVERIFIED", "The ether.fi DepositAdapter no longer points at the pinned weETH, eETH and LiquidityPool. Kletia will not use it.", 422);
    }
    if (paused) throw new PlatformError("RESERVE_UNAVAILABLE", "The ether.fi LiquidityPool is paused right now; try again later.", 422);
    return {
      to: adapter,
      data: depositData(),
      expected,
      warnings: [
        "weETH is restaked ETH: besides staking it carries slashing risk from the restaking operators it secures.",
        "weETH can trade below the value of the staked ETH.",
      ],
    };
  },

  checkSimulation(simulation, floor) {
    if (simulation.status !== "ok") return;
    const returned = decodeFunctionResult({ abi: ETHERFI_ADAPTER_ABI, functionName: "depositETHForWeETH", data: simulation.data });
    if (returned < floor) {
      throw new PlatformError("SIMULATION_FAILED", `ether.fi would mint ${formatUnits(returned, 18, "weETH")}, below the guaranteed ${formatUnits(floor, 18, "weETH")}; try again shortly.`, 422);
    }
  },

  prove(_step, receipt, account) {
    const adapter = pinned("etherfi", "deposit-target");
    const weeth = pinned("etherfi", "lst-token");
    if (receipt.input.toLowerCase() !== depositData().toLowerCase()) return { failure: "The DepositAdapter call is not depositETHForWeETH(address(0))." };
    const credited = transferred([receipt], weeth, adapter, account);
    if (credited === 0n) return { failure: "The DepositAdapter passed no weETH to the account." };
    return { minted: credited, detail: `ether.fi: ${formatUnits(receipt.value, 18, "ETH")} deposited; ${formatUnits(credited, 18, "weETH")} sent to ${getAddress(account)}.` };
  },
};

export const etherfiAdapter: ProtocolAdapter | null = createStakingAdapter(etherfiVenue);
