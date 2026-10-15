/**
 * Stader: stake ETH for ETHx through the StaderStakePoolsManager on Ethereum.
 *
 * Plan and prepare read: the manager's staderConfig() equals the config pin,
 * and the config's getETHxToken() and getStakePoolManager() equal the ETHx
 * and manager pins (VENUE_UNVERIFIED otherwise); the manager is not paused
 * and its vault is healthy (deposit() requires both); the amount lies within
 * the config's getMinDepositAmount() / getMaxDepositAmount(); the expected
 * output is previewDeposit(amount). The transaction is deposit(account) with
 * value = amount, so ETHx is minted to the acting account; prepare's dry run
 * must return at least the floor. Proof: the manager's
 * Deposited(caller = account, owner = account, assets = value, shares) and an
 * ETHx mint of at least the floor to the account.
 */
import { decodeFunctionResult, encodeFunctionData, getAddress, parseAbi, zeroAddress, type Abi, type Address } from "viem";
import { PlatformError } from "../../../errors.js";
import { formatUnits, sameAddress, transferred, withTimeout } from "../lending/common.js";
import type { ProtocolAdapter } from "../types.js";
import { evmEvents } from "../verification.js";
import { client, createStakingAdapter, pinned, type StakingVenue } from "./common.js";

export const STADER_MANAGER_ABI = parseAbi([
  "function deposit(address receiver) payable returns (uint256)",
  "function staderConfig() view returns (address)",
  "function paused() view returns (bool)",
  "function isVaultHealthy() view returns (bool)",
  "function previewDeposit(uint256 assets) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "event Deposited(address indexed caller,address indexed owner,uint256 assets,uint256 shares)",
]);
export const STADER_CONFIG_ABI = parseAbi([
  "function getETHxToken() view returns (address)",
  "function getStakePoolManager() view returns (address)",
  "function getMinDepositAmount() view returns (uint256)",
  "function getMaxDepositAmount() view returns (uint256)",
]);

function depositData(account: Address) {
  return encodeFunctionData({ abi: STADER_MANAGER_ABI, functionName: "deposit", args: [account] });
}

export const staderVenue: StakingVenue = {
  protocol: "stader",
  label: "Stader",
  symbol: "ETHx",
  tokenRole: "lst-token",
  // ETHx has no rate of its own: the manager converts shares to ETH.
  rateFunction: "convertToAssets",
  rateRole: "deposit-target",

  async quote({ owner, amount }) {
    const manager = pinned("stader", "deposit-target");
    const config = pinned("stader", "config");
    const ethx = pinned("stader", "lst-token");
    const evm = client();
    const [reportedConfig, reportedEthx, reportedManager, paused, healthy, minimum, maximum, expected] = await withTimeout(Promise.all([
      evm.readContract({ address: manager, abi: STADER_MANAGER_ABI, functionName: "staderConfig" }),
      evm.readContract({ address: config, abi: STADER_CONFIG_ABI, functionName: "getETHxToken" }),
      evm.readContract({ address: config, abi: STADER_CONFIG_ABI, functionName: "getStakePoolManager" }),
      evm.readContract({ address: manager, abi: STADER_MANAGER_ABI, functionName: "paused" }),
      evm.readContract({ address: manager, abi: STADER_MANAGER_ABI, functionName: "isVaultHealthy" }),
      evm.readContract({ address: config, abi: STADER_CONFIG_ABI, functionName: "getMinDepositAmount" }),
      evm.readContract({ address: config, abi: STADER_CONFIG_ABI, functionName: "getMaxDepositAmount" }),
      evm.readContract({ address: manager, abi: STADER_MANAGER_ABI, functionName: "previewDeposit", args: [amount] }),
    ]));
    if (!sameAddress(reportedConfig, config) || !sameAddress(reportedEthx, ethx) || !sameAddress(reportedManager, manager)) {
      throw new PlatformError("VENUE_UNVERIFIED", "The Stader manager or its config no longer points at the pinned config, ETHx and manager. Kletia will not use it.", 422);
    }
    if (paused) throw new PlatformError("RESERVE_UNAVAILABLE", "Stader deposits are paused right now; try again later.", 422);
    if (!healthy) throw new PlatformError("RESERVE_UNAVAILABLE", "Stader reports its vault as unhealthy and refuses deposits right now; try again later.", 422);
    if (amount < minimum) {
      throw new PlatformError("AMOUNT_TOO_SMALL", `Stader takes at least ${formatUnits(minimum, 18, "ETH")} per deposit; ${formatUnits(amount, 18, "ETH")} is below its minimum.`, 422);
    }
    if (amount > maximum) {
      throw new PlatformError("RESERVE_UNAVAILABLE", `Stader accepts at most ${formatUnits(maximum, 18, "ETH")} per deposit; ${formatUnits(amount, 18, "ETH")} does not fit.`, 422);
    }
    return { to: manager, data: depositData(owner), expected, warnings: ["ETHx can trade below the value of the staked ETH."] };
  },

  checkSimulation(simulation, floor) {
    if (simulation.status !== "ok") return;
    const returned = decodeFunctionResult({ abi: STADER_MANAGER_ABI, functionName: "deposit", data: simulation.data });
    if (returned < floor) {
      throw new PlatformError("SIMULATION_FAILED", `Stader would mint ${formatUnits(returned, 18, "ETHx")}, below the guaranteed ${formatUnits(floor, 18, "ETHx")}; try again shortly.`, 422);
    }
  },

  prove(_step, receipt, account) {
    const manager = pinned("stader", "deposit-target");
    const ethx = pinned("stader", "lst-token");
    if (receipt.input.toLowerCase() !== depositData(getAddress(account)).toLowerCase()) {
      return { failure: "The Stader call is not deposit(account): ETHx must be minted to the staking account." };
    }
    const minted = transferred([receipt], ethx, zeroAddress, account);
    if (minted === 0n) return { failure: "ETHx minted nothing to the account." };
    const deposited = evmEvents([receipt], { address: manager, abi: STADER_MANAGER_ABI as Abi, eventName: "Deposited" })
      .some((event) => {
        const args = event.args as { caller?: string; owner?: string; assets?: bigint; shares?: bigint };
        return sameAddress(args.caller, account) && sameAddress(args.owner, account) && args.assets === receipt.value && args.shares === minted;
      });
    if (!deposited) return { failure: "The Stader manager emitted no Deposited event for the account, amount and minted ETHx." };
    return { minted, detail: `Stader: ${formatUnits(receipt.value, 18, "ETH")} deposited; ${formatUnits(minted, 18, "ETHx")} minted to ${getAddress(account)}.` };
  },
};

export const staderAdapter: ProtocolAdapter | null = createStakingAdapter(staderVenue);
