/**
 * Renzo: restake ETH for ezETH through the RestakeManager on Ethereum
 * (round 9, E1).
 *
 * Plan and prepare read: the RestakeManager's ezETH() and renzoOracle()
 * equal their pins (VENUE_UNVERIFIED otherwise) and it is not paused. The
 * expected output is what Renzo itself mints: the oracle's
 * calculateMintAmount(totalTVL, amount, ezETH.totalSupply()), with totalTVL
 * from the RestakeManager's calculateTVLs(). The transaction is
 * depositETH() with value = amount; Renzo takes no on-chain minimum, so the
 * guarantee (expected less STAKE_TOLERANCE_BPS) is held by the proof only
 * (`floor: "claimed"`) and prepare's dry run must succeed. ezETH is minted to
 * the sender. Proof: the landed call is exactly depositETH() and ezETH minted
 * at least the floor to the account.
 *
 * ezETH is restaked ETH (EigenLayer slashing risk); Renzo withdrawals go
 * through its own queue and are not supported by Kletia.
 */
import { encodeFunctionData, erc20Abi, getAddress, parseAbi, zeroAddress } from "viem";
import { PlatformError } from "../../../errors.js";
import { formatUnits, sameAddress, transferred, withTimeout } from "../lending/common.js";
import type { ProtocolAdapter } from "../types.js";
import { client, createStakingAdapter, pinned, type StakingVenue } from "./common.js";

export const RENZO_MANAGER_ABI = parseAbi([
  "function depositETH() payable",
  "function ezETH() view returns (address)",
  "function renzoOracle() view returns (address)",
  "function paused() view returns (bool)",
  "function calculateTVLs() view returns (uint256[][] operatorDelegatorTokenTVLs,uint256[] operatorDelegatorTVLs,uint256 totalTVL)",
]);
export const RENZO_ORACLE_ABI = parseAbi([
  "function calculateMintAmount(uint256 currentValueInProtocol,uint256 newValueAdded,uint256 existingEzETHSupply) view returns (uint256)",
]);

export const RENZO_DEPOSIT_DATA = encodeFunctionData({ abi: RENZO_MANAGER_ABI, functionName: "depositETH" });

/** Renzo's total value locked (ETH) and the ezETH supply, as Renzo prices the token. */
async function tvlAndSupply(): Promise<readonly [bigint, bigint]> {
  const evm = client();
  const [tvls, supply] = await withTimeout(Promise.all([
    evm.readContract({ address: pinned("renzo", "deposit-target"), abi: RENZO_MANAGER_ABI, functionName: "calculateTVLs" }),
    evm.readContract({ address: pinned("renzo", "lst-token"), abi: erc20Abi, functionName: "totalSupply" }),
  ]));
  return [tvls[2], supply];
}

export const renzoVenue: StakingVenue = {
  protocol: "renzo",
  label: "Renzo",
  symbol: "ezETH",
  tokenRole: "lst-token",

  async ethValue(units) {
    const [tvl, supply] = await tvlAndSupply();
    if (supply === 0n) throw new PlatformError("VENUE_UNVERIFIED", "Renzo reports no ezETH supply; its rate cannot be read.", 422);
    return (units * tvl) / supply;
  },

  async quote({ amount }) {
    const manager = pinned("renzo", "deposit-target");
    const ezeth = pinned("renzo", "lst-token");
    const oracle = pinned("renzo", "rate-oracle");
    const evm = client();
    const [reportedToken, reportedOracle, paused, [tvl, supply]] = await Promise.all([
      withTimeout(evm.readContract({ address: manager, abi: RENZO_MANAGER_ABI, functionName: "ezETH" })),
      withTimeout(evm.readContract({ address: manager, abi: RENZO_MANAGER_ABI, functionName: "renzoOracle" })),
      withTimeout(evm.readContract({ address: manager, abi: RENZO_MANAGER_ABI, functionName: "paused" })),
      tvlAndSupply(),
    ]);
    if (!sameAddress(reportedToken, ezeth) || !sameAddress(reportedOracle, oracle)) {
      throw new PlatformError("VENUE_UNVERIFIED", "The Renzo RestakeManager no longer points at the pinned ezETH and oracle. Kletia will not use it.", 422);
    }
    if (paused) throw new PlatformError("RESERVE_UNAVAILABLE", "Renzo deposits are paused right now; try again later.", 422);
    const expected = await withTimeout(evm.readContract({ address: oracle, abi: RENZO_ORACLE_ABI, functionName: "calculateMintAmount", args: [tvl, amount, supply] }));
    return {
      to: manager,
      data: RENZO_DEPOSIT_DATA,
      expected,
      warnings: [
        "ezETH is restaked ETH: it carries EigenLayer slashing risk on top of staking risk, and can trade below the value of the restaked ETH.",
        "Renzo's deposit takes no minimum output: the guaranteed ezETH is checked by Kletia after the transaction, not enforced by the contract.",
      ],
    };
  },

  prove(_step, receipt, account) {
    if (receipt.input.toLowerCase() !== RENZO_DEPOSIT_DATA.toLowerCase()) {
      return { failure: "The Renzo call is not depositETH(): ezETH must be minted to the staking account." };
    }
    const minted = transferred([receipt], pinned("renzo", "lst-token"), zeroAddress, account);
    if (minted === 0n) return { failure: "ezETH minted nothing to the account." };
    return { minted, detail: `Renzo: ${formatUnits(receipt.value, 18, "ETH")} restaked; ${formatUnits(minted, 18, "ezETH")} minted to ${getAddress(account)}.` };
  },
};

export const renzoAdapter: ProtocolAdapter | null = createStakingAdapter(renzoVenue);
