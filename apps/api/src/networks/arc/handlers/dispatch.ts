/**
 * Dispatches an Arc action to its handler.
 */
import { getAddress } from "viem";
import type { ParsedIntent } from "../../../shared/ai/parser.js";
import {
  ArcPlanError,
  type ArcTransactionResult,
  simulateArcTransaction,
} from "./plan.js";
import {
  handleClaimRewards,
  handleClaimUnstaked,
  handleStake,
  handleSwap,
  handleUnstake,
} from "./swapStake.js";
import { handleMemo, handleVault } from "./vault.js";
import {
  handleAddLiquidity,
  handleLendingBorrow,
  handleLendingDeposit,
  handleLendingRepay,
  handleLendingWithdraw,
  handleRemoveLiquidity,
} from "./liquidity.js";

export async function dispatchArcAction(
  intent: ParsedIntent,
  userAddress: string,
): Promise<ArcTransactionResult> {
  const user = getAddress(userAddress);
  const action = String(intent.action || "").toLowerCase();

  let result: ArcTransactionResult;
  switch (action) {
    case "swap":
      result = await handleSwap(intent, user);
      break;
    case "stake":
      result = handleStake(intent);
      break;
    case "unstake":
      result = await handleUnstake(intent, user);
      break;
    case "claim_rewards":
      result = await handleClaimRewards(intent, user);
      break;
    case "claim_unstaked":
      result = await handleClaimUnstaked(intent, user);
      break;
    case "vault_deposit":
      result = await handleVault(intent, false, user);
      break;
    case "vault_withdraw":
      result = await handleVault(intent, true, user);
      break;
    case "vault_legacy_withdraw":
      result = await handleVault(intent, true, user, true);
      break;
    case "memo_send":
      result = handleMemo(intent);
      break;
    case "add_liquidity":
      result = await handleAddLiquidity(intent);
      break;
    case "remove_liquidity":
      result = await handleRemoveLiquidity(intent, user);
      break;
    case "lending_deposit":
      result = handleLendingDeposit(intent);
      break;
    case "lending_withdraw":
      result = await handleLendingWithdraw(intent, user);
      break;
    case "lending_borrow":
      result = handleLendingBorrow(intent);
      break;
    case "lending_repay":
      result = handleLendingRepay(intent);
      break;
    default:
      throw new ArcPlanError(
        "UNSUPPORTED_ACTION",
        `Action "${action}" is not supported on Arc Testnet.`,
      );
  }

  return simulateArcTransaction(result, user);
}
