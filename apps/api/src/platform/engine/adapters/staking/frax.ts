/**
 * Frax Ether: stake ETH for sfrxETH through the frxETHMinter on Ethereum.
 * submitAndDeposit mints frxETH 1:1 for the ETH to the minter, deposits it
 * into the sfrxETH vault and mints sfrxETH to the recipient.
 *
 * Plan and prepare read: the minter's submitPaused() is false; its
 * frxETHToken() and sfrxETHToken() equal the frxETH and sfrxETH pins, and
 * sfrxETH.asset() is frxETH (VENUE_UNVERIFIED otherwise); the expected output
 * is sfrxETH.previewDeposit(amount). The transaction is
 * submitAndDeposit(account) with value = amount; prepare's dry run must
 * return at least the floor. Proof: the minter's
 * ETHSubmitted(sender = account, recipient = minter, sent_amount = value), the
 * vault's Deposit(caller = minter, owner = account, assets = value, shares =
 * minted) and an sfrxETH mint of at least the floor to the account.
 * Positions value sfrxETH in frxETH, which the minter issues 1:1 for ETH.
 */
import { decodeFunctionResult, encodeFunctionData, getAddress, parseAbi, zeroAddress, type Abi, type Address } from "viem";
import { PlatformError } from "../../../errors.js";
import { formatUnits, sameAddress, transferred, withTimeout } from "../lending/common.js";
import type { ProtocolAdapter } from "../types.js";
import { evmEvents } from "../verification.js";
import { client, createStakingAdapter, pinned, type StakingVenue } from "./common.js";

export const FRAX_MINTER_ABI = parseAbi([
  "function submitAndDeposit(address recipient) payable returns (uint256 shares)",
  "function submitPaused() view returns (bool)",
  "function frxETHToken() view returns (address)",
  "function sfrxETHToken() view returns (address)",
  "event ETHSubmitted(address indexed sender,address indexed recipient,uint256 sent_amount,uint256 withheld_amt)",
]);
export const SFRXETH_ABI = parseAbi([
  "function asset() view returns (address)",
  "function previewDeposit(uint256 assets) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "event Deposit(address indexed caller,address indexed owner,uint256 assets,uint256 shares)",
]);

function depositData(account: Address) {
  return encodeFunctionData({ abi: FRAX_MINTER_ABI, functionName: "submitAndDeposit", args: [account] });
}

export const fraxVenue: StakingVenue = {
  protocol: "frax-ether",
  label: "Frax",
  symbol: "sfrxETH",
  tokenRole: "lst-token",
  // sfrxETH -> frxETH (ERC-4626), valued 1:1 in ETH as the minter issues it.
  rateFunction: "convertToAssets",
  // policy/feeds.ts prices no sfrxETH (UNPRICED_SYMBOLS): noUnstakeWarning offers no swap exit for it.

  async quote({ owner, amount }) {
    const minter = pinned("frax-ether", "deposit-target");
    const frxeth = pinned("frax-ether", "underlying-token");
    const sfrxeth = pinned("frax-ether", "lst-token");
    const evm = client();
    const [paused, reportedFrxeth, reportedSfrxeth, vaultAsset, expected] = await withTimeout(Promise.all([
      evm.readContract({ address: minter, abi: FRAX_MINTER_ABI, functionName: "submitPaused" }),
      evm.readContract({ address: minter, abi: FRAX_MINTER_ABI, functionName: "frxETHToken" }),
      evm.readContract({ address: minter, abi: FRAX_MINTER_ABI, functionName: "sfrxETHToken" }),
      evm.readContract({ address: sfrxeth, abi: SFRXETH_ABI, functionName: "asset" }),
      evm.readContract({ address: sfrxeth, abi: SFRXETH_ABI, functionName: "previewDeposit", args: [amount] }),
    ]));
    if (!sameAddress(reportedFrxeth, frxeth) || !sameAddress(reportedSfrxeth, sfrxeth) || !sameAddress(vaultAsset, frxeth)) {
      throw new PlatformError("VENUE_UNVERIFIED", "The frxETHMinter or the sfrxETH vault no longer points at the pinned frxETH and sfrxETH. Kletia will not use it.", 422);
    }
    if (paused) throw new PlatformError("RESERVE_UNAVAILABLE", "Frax Ether minting is paused right now; try again later.", 422);
    return {
      to: minter,
      data: depositData(owner),
      expected,
      warnings: ["sfrxETH is valued in frxETH, which Frax mints 1:1 for ETH; both can trade below the value of the staked ETH."],
    };
  },

  checkSimulation(simulation, floor) {
    if (simulation.status !== "ok") return;
    const returned = decodeFunctionResult({ abi: FRAX_MINTER_ABI, functionName: "submitAndDeposit", data: simulation.data });
    if (returned < floor) {
      throw new PlatformError("SIMULATION_FAILED", `Frax would mint ${formatUnits(returned, 18, "sfrxETH")}, below the guaranteed ${formatUnits(floor, 18, "sfrxETH")}; try again shortly.`, 422);
    }
  },

  prove(_step, receipt, account) {
    const minter = pinned("frax-ether", "deposit-target");
    const sfrxeth = pinned("frax-ether", "lst-token");
    if (receipt.input.toLowerCase() !== depositData(getAddress(account)).toLowerCase()) {
      return { failure: "The Frax call is not submitAndDeposit(account): sfrxETH must be minted to the staking account." };
    }
    const submitted = evmEvents([receipt], { address: minter, abi: FRAX_MINTER_ABI as Abi, eventName: "ETHSubmitted" })
      .some((event) => {
        const args = event.args as { sender?: string; recipient?: string; sent_amount?: bigint };
        return sameAddress(args.sender, account) && sameAddress(args.recipient, minter) && args.sent_amount === receipt.value;
      });
    if (!submitted) return { failure: "The frxETHMinter emitted no ETHSubmitted event for the account and amount." };
    const minted = transferred([receipt], sfrxeth, zeroAddress, account);
    if (minted === 0n) return { failure: "sfrxETH minted nothing to the account." };
    const deposited = evmEvents([receipt], { address: sfrxeth, abi: SFRXETH_ABI as Abi, eventName: "Deposit" })
      .some((event) => {
        const args = event.args as { caller?: string; owner?: string; assets?: bigint; shares?: bigint };
        return sameAddress(args.caller, minter) && sameAddress(args.owner, account) && args.assets === receipt.value && args.shares === minted;
      });
    if (!deposited) return { failure: "The sfrxETH vault emitted no Deposit from the minter for the account, amount and minted sfrxETH." };
    return { minted, detail: `Frax: ${formatUnits(receipt.value, 18, "ETH")} submitted; ${formatUnits(minted, 18, "sfrxETH")} minted to ${getAddress(account)}.` };
  },
};

export const fraxAdapter: ProtocolAdapter | null = createStakingAdapter(fraxVenue);
