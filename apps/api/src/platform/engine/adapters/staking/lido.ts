/**
 * Lido: stake ETH for wstETH on Ethereum in one transaction (protocols
 * design 3.10). Sending ETH to wstETH (`receive()`) submits it to stETH and
 * wraps the stETH shares, minting wstETH to the sender.
 *
 * Plan and prepare read: wstETH.stETH() and the Lido Locator's lido() equal
 * the stETH pin; staking is not paused; the current stake limit covers the
 * amount; the expected output is getWstETHByStETH(amount). The transaction is
 * exactly {to: wstETH, value: amount, data: 0x}. Proof: stETH emits
 * Submitted(sender = wstETH, amount) and wstETH mints at least the floor to
 * the account.
 */
import { getAddress, parseAbi, zeroAddress, type Abi } from "viem";
import { formatUnits, sameAddress, transferred, withTimeout } from "../lending/common.js";
import { evmEvents } from "../verification.js";
import { PlatformError } from "../../../errors.js";
import type { ProtocolAdapter } from "../types.js";
import { client, createStakingAdapter, pinned, type StakingVenue } from "./common.js";

export const STETH_ABI = parseAbi([
  "function isStakingPaused() view returns (bool)",
  "function getCurrentStakeLimit() view returns (uint256)",
  "event Submitted(address indexed sender,uint256 amount,address referral)",
]);
export const WSTETH_ABI = parseAbi([
  "function stETH() view returns (address)",
  "function getWstETHByStETH(uint256 stETHAmount) view returns (uint256)",
  "function getStETHByWstETH(uint256 wstETHAmount) view returns (uint256)",
]);
export const LIDO_LOCATOR_ABI = parseAbi(["function lido() view returns (address)"]);

export const lidoVenue: StakingVenue = {
  protocol: "lido",
  label: "Lido",
  symbol: "wstETH",
  tokenRole: "deposit-target",
  rateFunction: "getStETHByWstETH",

  async quote({ amount }) {
    const wsteth = pinned("lido", "deposit-target");
    const steth = pinned("lido", "lst-token");
    const locator = pinned("lido", "locator");
    const evm = client();
    const [wrapped, lido, paused, limit, expected] = await withTimeout(Promise.all([
      evm.readContract({ address: wsteth, abi: WSTETH_ABI, functionName: "stETH" }),
      evm.readContract({ address: locator, abi: LIDO_LOCATOR_ABI, functionName: "lido" }),
      evm.readContract({ address: steth, abi: STETH_ABI, functionName: "isStakingPaused" }),
      evm.readContract({ address: steth, abi: STETH_ABI, functionName: "getCurrentStakeLimit" }),
      evm.readContract({ address: wsteth, abi: WSTETH_ABI, functionName: "getWstETHByStETH", args: [amount] }),
    ]));
    if (!sameAddress(wrapped, steth) || !sameAddress(lido, steth)) {
      throw new PlatformError("VENUE_UNVERIFIED", `Lido's wstETH or Locator no longer points at the pinned stETH ${steth}. Kletia will not use it.`, 422);
    }
    if (paused) throw new PlatformError("RESERVE_UNAVAILABLE", "Lido staking is paused right now; try again later.", 422);
    if (limit < amount) {
      throw new PlatformError(
        "RESERVE_UNAVAILABLE",
        `Lido accepts at most ${formatUnits(limit, 18, "ETH")} right now (its stake limit refills over time); ${formatUnits(amount, 18, "ETH")} does not fit.`,
        422,
      );
    }
    return { to: wsteth, data: "0x", expected, warnings: ["wstETH can trade below the value of the staked ETH."] };
  },

  prove(_step, receipt, account) {
    const wsteth = pinned("lido", "deposit-target");
    const steth = pinned("lido", "lst-token");
    const submitted = evmEvents([receipt], { address: steth, abi: STETH_ABI as Abi, eventName: "Submitted" })
      .some((event) => {
        const args = event.args as { sender?: string; amount?: bigint };
        return sameAddress(args.sender, wsteth) && args.amount === receipt.value;
      });
    if (!submitted || receipt.input !== "0x") return { failure: "stETH emitted no Submitted event from wstETH for the staked amount." };
    const minted = transferred([receipt], wsteth, zeroAddress, account);
    if (minted === 0n) return { failure: "wstETH minted nothing to the account." };
    return { minted, detail: `Lido: ${formatUnits(receipt.value, 18, "ETH")} submitted; ${formatUnits(minted, 18, "wstETH")} minted to ${getAddress(account)}.` };
  },
};

export const lidoAdapter: ProtocolAdapter | null = createStakingAdapter(lidoVenue);
