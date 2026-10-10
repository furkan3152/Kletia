import { formatUnits, type Address } from "viem";
import { arcPublicClient } from "../../shared/config/networks.js";
import { ARC_ERC20_ABI, ARC_LENDING_ABI, ARC_STAKING_ABI } from "./abis.js";
import { ARC_LEGACY_DEFI_CONTRACTS } from "./executionEnvironment.js";

/** Keep historical balances visible when the active deployment changes. */
export async function readLegacyArcDefiPositions(
  user: Address,
  blockNumber: bigint,
  active: Readonly<{ swap: Address; staking: Address; lending: Address }>,
  reader: Pick<typeof arcPublicClient, "readContract"> = arcPublicClient,
) {
  const moved = (kind: keyof typeof active) => active[kind].toLowerCase() !== ARC_LEGACY_DEFI_CONTRACTS[kind].toLowerCase();
  const [lp, staking, lending] = await Promise.all([
    moved("swap") ? reader.readContract({ address: ARC_LEGACY_DEFI_CONTRACTS.swap, abi: ARC_ERC20_ABI, functionName: "balanceOf", args: [user], blockNumber }) : null,
    moved("staking") ? Promise.all([
      reader.readContract({ address: ARC_LEGACY_DEFI_CONTRACTS.staking, abi: ARC_STAKING_ABI, functionName: "getStakerInfo", args: [user], blockNumber }),
      reader.readContract({ address: ARC_LEGACY_DEFI_CONTRACTS.staking, abi: ARC_STAKING_ABI, functionName: "pendingRewards", args: [user], blockNumber }),
    ]) : null,
    moved("lending") ? Promise.all([
      reader.readContract({ address: ARC_LEGACY_DEFI_CONTRACTS.lending, abi: ARC_LENDING_ABI, functionName: "collateralBalance", args: [user], blockNumber }),
      reader.readContract({ address: ARC_LEGACY_DEFI_CONTRACTS.lending, abi: ARC_LENDING_ABI, functionName: "getBorrowedBalance", args: [user], blockNumber }),
      reader.readContract({ address: ARC_LEGACY_DEFI_CONTRACTS.lending, abi: ARC_LENDING_ABI, functionName: "getSuppliedBalance", args: [user], blockNumber }),
    ]) : null,
  ]);
  return {
    exitProtocol: "kletia legacy",
    ...(lp === null ? {} : { swap: { address: ARC_LEGACY_DEFI_CONTRACTS.swap, lpTokenBalance: formatUnits(lp, 18) } }),
    ...(staking === null ? {} : { staking: {
      address: ARC_LEGACY_DEFI_CONTRACTS.staking,
      stakedAmount: formatUnits(staking[0][0], 18),
      pendingUnstake: formatUnits(staking[0][3], 18),
      pendingRewards: formatUnits(staking[1], 18),
      cooldownRemaining: Number(staking[0][5]),
    } }),
    ...(lending === null ? {} : { lending: {
      address: ARC_LEGACY_DEFI_CONTRACTS.lending,
      collateralKLET: formatUnits(lending[0], 18),
      borrowedUSDC: formatUnits(lending[1], 18),
      suppliedUSDC: formatUnits(lending[2], 18),
    } }),
  };
}
