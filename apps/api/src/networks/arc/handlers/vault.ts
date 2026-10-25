/**
 * Vault and memo handlers.
 */
import {
  encodeFunctionData,
  formatUnits,
  getAddress,
  keccak256,
  type Address,
} from "viem";
import type { ParsedIntent } from "../../../shared/ai/parser.js";
import { ARC_MEMO_TRANSFER_ABI, ARC_VAULT_ABI } from "../abis.js";
import {
  ARC_CONTRACTS,
  ARC_LEGACY_VAULT_ADDRESS,
  ARC_VAULT_EXECUTION_MODE,
  ARC_VAULT_V2_RUNTIME_CODEHASH,
  arcPublicClient,
} from "../../../shared/config/networks.js";
import {
  ArcPlanError,
  assertArcAsset,
  assertKletiaProtocol,
  parsePositiveAmount,
  transactionResult,
} from "./plan.js";

export function assertArcVaultReserveForPlan(
  totalDeposited: bigint,
  vaultBalance: bigint,
  requestedInterest = 0n,
) {
  if (vaultBalance < totalDeposited) {
    throw new ArcPlanError(
      "ARC_VAULT_PRINCIPAL_RESERVE_INSUFFICIENT",
      "Arc Vault balance does not cover the total user principal; Kletia did not create a new vault transaction.",
      503,
    );
  }
  if (vaultBalance < totalDeposited + requestedInterest) {
    throw new ArcPlanError(
      "ARC_VAULT_WITHDRAWAL_RESERVE_INSUFFICIENT",
      "Arc Vault cannot cover the interest of this withdrawal without affecting other users' principal; transaction not created.",
      503,
    );
  }
}

export async function handleVault(
  intent: ParsedIntent,
  withdraw: boolean,
  user: Address,
  legacyMigration = false,
) {
  if (legacyMigration && (!withdraw || ARC_VAULT_EXECUTION_MODE !== "vault_v2")) {
    throw new ArcPlanError(
      "ARC_VAULT_LEGACY_MIGRATION_INACTIVE",
      "Legacy Vault withdrawal is available only while the application is in Vault V2 migration mode.",
      409,
    );
  }
  const vaultAddress = legacyMigration
    ? ARC_LEGACY_VAULT_ADDRESS
    : ARC_CONTRACTS.Vault;
  const vaultMode = legacyMigration ? "legacy_v1" : ARC_VAULT_EXECUTION_MODE;
  const action = legacyMigration
    ? "Arc legacy vault migration withdrawal"
    : withdraw
      ? "Arc vault withdrawal"
      : "Arc vault deposit";
  assertKletiaProtocol(intent, action);
  assertArcAsset(intent.tokenIn, ["USDC"], action, "tokenIn");
  assertArcAsset(intent.tokenOut, ["USDC"], action, "tokenOut");
  const amount = withdraw
    ? 0n
    : parsePositiveAmount(intent.amount, "Arc vault deposit");
  const observedBlock = await arcPublicClient.getBlockNumber();
  const [totalDeposited, vaultBalance, pendingInterest, vaultCode, position] = await Promise.all([
    arcPublicClient.readContract({
      address: vaultAddress,
      abi: ARC_VAULT_ABI,
      functionName: "totalDeposited",
      blockNumber: observedBlock,
    }),
    arcPublicClient.getBalance({
      address: vaultAddress,
      blockNumber: observedBlock,
    }),
    withdraw
      ? arcPublicClient.readContract({
          address: vaultAddress,
          abi: ARC_VAULT_ABI,
          functionName: "pendingInterest",
          args: [user],
          blockNumber: observedBlock,
        })
      : Promise.resolve(0n),
    vaultMode === "vault_v2"
      ? arcPublicClient.getCode({
          address: vaultAddress,
          blockNumber: observedBlock,
        })
      : Promise.resolve(undefined),
    withdraw
      ? arcPublicClient.readContract({
          address: vaultAddress,
          abi: ARC_VAULT_ABI,
          functionName: "deposits",
          args: [user],
          blockNumber: observedBlock,
        })
      : Promise.resolve(null),
  ]);
  if (withdraw && (position === null || position[0] <= 0n)) {
    throw new ArcPlanError(
      legacyMigration ? "ARC_NO_LEGACY_VAULT_POSITION" : "ARC_NO_VAULT_POSITION",
      legacyMigration
        ? "This wallet has no legacy Arc Vault principal to migrate."
        : "This wallet has no active Arc Vault principal to withdraw.",
    );
  }
  if (vaultMode === "vault_v2") {
    if (
      !vaultCode ||
      vaultCode === "0x" ||
      keccak256(vaultCode).toLowerCase() !== ARC_VAULT_V2_RUNTIME_CODEHASH
    ) {
      throw new ArcPlanError(
        "ARC_VAULT_V2_RUNTIME_MISMATCH",
        "Arc Vault V2 runtime bytecode does not match deployment evidence; transaction not created.",
        503,
      );
    }
    const reserve = await arcPublicClient.readContract({
      address: vaultAddress,
      abi: ARC_VAULT_ABI,
      functionName: "reserveStatus",
      blockNumber: observedBlock,
    });
    if (!reserve[5] || reserve[0] < reserve[3]) {
      throw new ArcPlanError(
        "ARC_VAULT_V2_INSOLVENT",
        "Arc Vault V2 does not cover total principal and interest obligations; transaction not created.",
        503,
      );
    }
  } else {
    assertArcVaultReserveForPlan(
      totalDeposited,
      vaultBalance,
      pendingInterest,
    );
  }
  const resultAction = legacyMigration
    ? "vault_legacy_withdraw"
    : withdraw
      ? "vault_withdraw"
      : "vault_deposit";
  return transactionResult(resultAction, {
    name:
      vaultMode === "vault_v2"
        ? "Kletia Arc Vault V2"
        : legacyMigration
          ? "Kletia Arc Vault Legacy Migration"
          : "Kletia Arc Vault Legacy",
    router: vaultAddress,
    calldata: encodeFunctionData({
      abi: ARC_VAULT_ABI,
      functionName: withdraw ? "withdraw" : "deposit",
    }),
    value: withdraw ? "0" : amount.toString(),
    amountInWei: amount.toString(),
    isNativeIn: !withdraw,
    expectedOutput: withdraw
      ? `Full Arc vault principal and ${formatUnits(pendingInterest, 18)} USDC accrued yield; ${vaultMode} reserve checked at block ${observedBlock.toString()}`
      : `${formatUnits(amount, 18)} USDC vault deposit`,
  });
}

export function handleMemo(intent: ParsedIntent) {
  assertKletiaProtocol(intent, "Arc memo transfer");
  assertArcAsset(intent.tokenIn, ["USDC"], "Arc memo transfer", "tokenIn");
  const amount = parsePositiveAmount(intent.amount, "Arc memo transfer");
  let recipient: Address;
  try {
    recipient = getAddress(String(intent.recipient || intent.tokenOut || ""));
  } catch {
    throw new ArcPlanError(
      "ARC_INVALID_RECIPIENT",
      "A valid EVM recipient address is required for memo transfer.",
    );
  }
  const memo = String(intent.memo || intent.name || "").trim();
  const memoBytes = new TextEncoder().encode(memo).length;
  if (!memo || memoBytes > 256) {
    throw new ArcPlanError(
      "ARC_INVALID_MEMO",
      "Memo cannot be empty and must be at most 256 bytes in UTF-8.",
    );
  }

  return transactionResult("memo_send", {
    name: "Kletia Arc Memo Transfer",
    router: ARC_CONTRACTS.MemoTransfer,
    calldata: encodeFunctionData({
      abi: ARC_MEMO_TRANSFER_ABI,
      functionName: "transferWithMemo",
      args: [recipient, memo],
    }),
    value: amount.toString(),
    amountInWei: amount.toString(),
    isNativeIn: true,
    expectedOutput: `${formatUnits(amount, 18)} USDC to ${recipient} with memo`,
  });
}
