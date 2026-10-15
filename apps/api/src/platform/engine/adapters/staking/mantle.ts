/**
 * Mantle LSP: stake ETH for mETH through the Mantle Staking contract on
 * Ethereum (protocols design 3.3, A16).
 *
 * Plan and prepare read: the Staking contract's mETH() and pauser() equal
 * their pins (VENUE_UNVERIFIED otherwise); the pauser's isStakingPaused() is
 * false and the staking allowlist is off; the amount is at least
 * minimumStakeBound(); mETH.totalSupply() + expected stays within
 * maximumMETHSupply(); the expected output is ethToMETH(amount). The
 * transaction is stake(minMETHAmount) with value = amount, where
 * minMETHAmount is exactly the guaranteed output (expected less
 * STAKE_TOLERANCE_BPS): the contract itself reverts below it, so the step is
 * `floor: "onchain"`. mETH is minted to the sender. Proof: the Staking
 * contract's Staked(staker = account, ethAmount = value, mETHAmount = minted)
 * and an mETH mint of at least the floor to the account.
 */
import { decodeFunctionData, encodeFunctionData, getAddress, parseAbi, zeroAddress, type Abi, type Hex } from "viem";
import { PlatformError } from "../../../errors.js";
import { formatUnits, lessBps, sameAddress, transferred, withTimeout } from "../lending/common.js";
import type { ProtocolAdapter } from "../types.js";
import { evmEvents } from "../verification.js";
import { client, createStakingAdapter, pinned, STAKE_TOLERANCE_BPS, type StakingVenue } from "./common.js";

export const MANTLE_STAKING_ABI = parseAbi([
  "function stake(uint256 minMETHAmount) payable",
  "function mETH() view returns (address)",
  "function pauser() view returns (address)",
  "function isStakingAllowlist() view returns (bool)",
  "function minimumStakeBound() view returns (uint256)",
  "function maximumMETHSupply() view returns (uint256)",
  "function ethToMETH(uint256 ethAmount) view returns (uint256)",
  "function mETHToETH(uint256 mETHAmount) view returns (uint256)",
  "event Staked(address indexed staker,uint256 ethAmount,uint256 mETHAmount)",
]);
export const MANTLE_PAUSER_ABI = parseAbi(["function isStakingPaused() view returns (bool)"]);
export const METH_ABI = parseAbi(["function totalSupply() view returns (uint256)"]);

function stakeData(minimum: bigint) {
  return encodeFunctionData({ abi: MANTLE_STAKING_ABI, functionName: "stake", args: [minimum] });
}

export const mantleVenue: StakingVenue = {
  protocol: "mantle-lsp",
  label: "Mantle",
  symbol: "mETH",
  tokenRole: "lst-token",
  // mETH has no rate of its own: the Staking contract converts it to ETH.
  rateFunction: "mETHToETH",
  rateRole: "deposit-target",

  async quote({ amount }) {
    const staking = pinned("mantle-lsp", "deposit-target");
    const meth = pinned("mantle-lsp", "lst-token");
    const pauser = pinned("mantle-lsp", "pauser");
    const evm = client();
    const [reportedMeth, reportedPauser, paused, allowlist, minimum, maximumSupply, supply, expected] = await withTimeout(Promise.all([
      evm.readContract({ address: staking, abi: MANTLE_STAKING_ABI, functionName: "mETH" }),
      evm.readContract({ address: staking, abi: MANTLE_STAKING_ABI, functionName: "pauser" }),
      evm.readContract({ address: pauser, abi: MANTLE_PAUSER_ABI, functionName: "isStakingPaused" }),
      evm.readContract({ address: staking, abi: MANTLE_STAKING_ABI, functionName: "isStakingAllowlist" }),
      evm.readContract({ address: staking, abi: MANTLE_STAKING_ABI, functionName: "minimumStakeBound" }),
      evm.readContract({ address: staking, abi: MANTLE_STAKING_ABI, functionName: "maximumMETHSupply" }),
      evm.readContract({ address: meth, abi: METH_ABI, functionName: "totalSupply" }),
      evm.readContract({ address: staking, abi: MANTLE_STAKING_ABI, functionName: "ethToMETH", args: [amount] }),
    ]));
    if (!sameAddress(reportedMeth, meth) || !sameAddress(reportedPauser, pauser)) {
      throw new PlatformError("VENUE_UNVERIFIED", "The Mantle Staking contract no longer points at the pinned mETH and pauser. Kletia will not use it.", 422);
    }
    if (paused) throw new PlatformError("RESERVE_UNAVAILABLE", "Mantle staking is paused right now; try again later.", 422);
    if (allowlist) throw new PlatformError("RESERVE_UNAVAILABLE", "Mantle staking is limited to allowlisted stakers right now; try again later.", 422);
    if (amount < minimum) {
      throw new PlatformError("AMOUNT_TOO_SMALL", `Mantle takes at least ${formatUnits(minimum, 18, "ETH")} per stake; ${formatUnits(amount, 18, "ETH")} is below its minimum.`, 422);
    }
    if (supply + expected > maximumSupply) {
      const room = maximumSupply > supply ? maximumSupply - supply : 0n;
      throw new PlatformError("RESERVE_UNAVAILABLE", `mETH is close to its supply cap: at most ${formatUnits(room, 18, "mETH")} can be minted right now.`, 422);
    }
    const onchainMinimum = lessBps(expected, STAKE_TOLERANCE_BPS);
    return {
      to: staking,
      data: stakeData(onchainMinimum),
      expected,
      onchainMinimum,
      warnings: ["mETH can trade below the value of the staked ETH."],
    };
  },

  prove(_step, receipt, account) {
    const staking = pinned("mantle-lsp", "deposit-target");
    const meth = pinned("mantle-lsp", "lst-token");
    let minimum: bigint;
    try {
      const decoded = decodeFunctionData({ abi: MANTLE_STAKING_ABI, data: receipt.input as Hex });
      if (decoded.functionName !== "stake") return { failure: "The Mantle call is not stake(minMETHAmount)." };
      minimum = decoded.args[0];
    } catch {
      return { failure: "The Mantle call is not stake(minMETHAmount)." };
    }
    // Kletia always encodes the guaranteed output; a zero minimum is a call it did not build.
    if (minimum === 0n) return { failure: "The Mantle call carries no on-chain minimum." };
    const minted = transferred([receipt], meth, zeroAddress, account);
    if (minted === 0n) return { failure: "mETH minted nothing to the account." };
    if (minted < minimum) return { failure: `mETH minted ${minted} base units, below the call's own minimum ${minimum}.` };
    const staked = evmEvents([receipt], { address: staking, abi: MANTLE_STAKING_ABI as Abi, eventName: "Staked" })
      .some((event) => {
        const args = event.args as { staker?: string; ethAmount?: bigint; mETHAmount?: bigint };
        return sameAddress(args.staker, account) && args.ethAmount === receipt.value && args.mETHAmount === minted;
      });
    if (!staked) return { failure: "The Mantle Staking contract emitted no Staked event for the account, amount and minted mETH." };
    return { minted, detail: `Mantle: ${formatUnits(receipt.value, 18, "ETH")} staked; ${formatUnits(minted, 18, "mETH")} minted to ${getAddress(account)} (on-chain minimum ${formatUnits(minimum, 18, "mETH")}).` };
  },
};

export const mantleAdapter: ProtocolAdapter | null = createStakingAdapter(mantleVenue);
