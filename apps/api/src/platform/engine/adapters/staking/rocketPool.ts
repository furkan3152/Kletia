/**
 * Rocket Pool: stake ETH for rETH through the deposit pool resolved from
 * RocketStorage.
 *
 * Plan and prepare resolve rocketDepositPool, rocketTokenRETH and
 * rocketDAOProtocolSettingsDeposit through the pinned RocketStorage; the
 * deposit pool and rETH must equal their pins (VENUE_UNVERIFIED otherwise:
 * Rocket Pool upgrades by re-pointing storage). Deposits must be enabled and
 * the amount between the protocol minimum and the pool's maximum; the
 * expected output applies the deposit fee: getRethValue(amount - amount *
 * fee / 1e18). The transaction is deposit() with value = amount; proof: the
 * deposit pool's DepositReceived(account, amount) and an rETH mint of at
 * least the floor to the account.
 */
import { encodeFunctionData, encodePacked, getAddress, keccak256, parseAbi, zeroAddress, type Abi, type Address } from "viem";
import { PlatformError } from "../../../errors.js";
import { formatUnits, sameAddress, transferred, withTimeout } from "../lending/common.js";
import type { ProtocolAdapter } from "../types.js";
import { evmEvents } from "../verification.js";
import { client, createStakingAdapter, pinned, type StakingVenue } from "./common.js";

export const ROCKET_STORAGE_ABI = parseAbi(["function getAddress(bytes32 key) view returns (address)"]);
export const ROCKET_DEPOSIT_POOL_ABI = parseAbi([
  "function deposit() payable",
  "function getMaximumDepositAmount() view returns (uint256)",
  "event DepositReceived(address indexed from,uint256 amount,uint256 time)",
]);
export const ROCKET_SETTINGS_ABI = parseAbi([
  "function getDepositEnabled() view returns (bool)",
  "function getMinimumDeposit() view returns (uint256)",
  "function getDepositFee() view returns (uint256)",
]);
export const RETH_ABI = parseAbi([
  "function getRethValue(uint256 ethAmount) view returns (uint256)",
  "function getEthValue(uint256 rethAmount) view returns (uint256)",
]);

const CALC_BASE = 10n ** 18n;

/** RocketStorage key of a network contract: keccak256(abi.encodePacked("contract.address", name)). */
export function rocketKey(name: string): `0x${string}` {
  return keccak256(encodePacked(["string", "string"], ["contract.address", name]));
}

async function resolve(name: string): Promise<Address> {
  return getAddress(await withTimeout(client().readContract({ address: pinned("rocket-pool", "storage"), abi: ROCKET_STORAGE_ABI, functionName: "getAddress", args: [rocketKey(name)] })));
}

export const rocketPoolVenue: StakingVenue = {
  protocol: "rocket-pool",
  label: "Rocket Pool",
  symbol: "rETH",
  tokenRole: "lst-token",
  rateFunction: "getEthValue",

  async quote({ amount }) {
    const [depositPool, reth, settings] = await Promise.all([resolve("rocketDepositPool"), resolve("rocketTokenRETH"), resolve("rocketDAOProtocolSettingsDeposit")]);
    if (!sameAddress(depositPool, pinned("rocket-pool", "deposit-target")) || !sameAddress(reth, pinned("rocket-pool", "lst-token"))) {
      throw new PlatformError(
        "VENUE_UNVERIFIED",
        `RocketStorage now resolves the deposit pool to ${depositPool} and rETH to ${reth}, not the reviewed pins. Kletia will not use them until the registry is re-reviewed.`,
        422,
      );
    }
    const evm = client();
    const [enabled, minimum, fee, maximum] = await withTimeout(Promise.all([
      evm.readContract({ address: settings, abi: ROCKET_SETTINGS_ABI, functionName: "getDepositEnabled" }),
      evm.readContract({ address: settings, abi: ROCKET_SETTINGS_ABI, functionName: "getMinimumDeposit" }),
      evm.readContract({ address: settings, abi: ROCKET_SETTINGS_ABI, functionName: "getDepositFee" }),
      evm.readContract({ address: depositPool, abi: ROCKET_DEPOSIT_POOL_ABI, functionName: "getMaximumDepositAmount" }),
    ]));
    if (!enabled) throw new PlatformError("RESERVE_UNAVAILABLE", "Rocket Pool deposits are disabled right now; try again later.", 422);
    if (amount < minimum) {
      throw new PlatformError("AMOUNT_TOO_SMALL", `Rocket Pool takes at least ${formatUnits(minimum, 18, "ETH")} per deposit; ${formatUnits(amount, 18, "ETH")} is below its minimum.`, 422);
    }
    if (amount > maximum) {
      throw new PlatformError("RESERVE_UNAVAILABLE", `The Rocket Pool deposit pool accepts at most ${formatUnits(maximum, 18, "ETH")} right now; ${formatUnits(amount, 18, "ETH")} does not fit.`, 422);
    }
    if (fee >= CALC_BASE) throw new PlatformError("VENUE_UNVERIFIED", "The Rocket Pool deposit fee reads 100% or more. Kletia will not use it.", 422);
    const net = amount - (amount * fee) / CALC_BASE;
    const expected = await withTimeout(evm.readContract({ address: reth, abi: RETH_ABI, functionName: "getRethValue", args: [net] }));
    const percent = Number((fee * 1_000_000n) / CALC_BASE) / 10_000;
    return {
      to: depositPool,
      data: encodeFunctionData({ abi: ROCKET_DEPOSIT_POOL_ABI, functionName: "deposit" }),
      expected,
      warnings: [
        ...(fee > 0n ? [`Rocket Pool keeps a ${percent}% deposit fee; the rETH shown is after it.`] : []),
        "rETH can trade below the value of the staked ETH.",
      ],
    };
  },

  prove(_step, receipt, account) {
    const depositPool = pinned("rocket-pool", "deposit-target");
    const reth = pinned("rocket-pool", "lst-token");
    if (receipt.input.toLowerCase() !== encodeFunctionData({ abi: ROCKET_DEPOSIT_POOL_ABI, functionName: "deposit" })) {
      return { failure: "The deposit pool call is not deposit()." };
    }
    const received = evmEvents([receipt], { address: depositPool, abi: ROCKET_DEPOSIT_POOL_ABI as Abi, eventName: "DepositReceived" })
      .some((event) => {
        const args = event.args as { from?: string; amount?: bigint };
        return sameAddress(args.from, account) && args.amount === receipt.value;
      });
    if (!received) return { failure: "The deposit pool emitted no DepositReceived event for the account and amount." };
    const minted = transferred([receipt], reth, zeroAddress, account);
    if (minted === 0n) return { failure: "rETH minted nothing to the account." };
    return { minted, detail: `Rocket Pool: ${formatUnits(receipt.value, 18, "ETH")} deposited; ${formatUnits(minted, 18, "rETH")} minted to ${getAddress(account)}.` };
  },
};

export const rocketPoolAdapter: ProtocolAdapter | null = createStakingAdapter(rocketPoolVenue);
