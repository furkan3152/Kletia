/**
 * Solana transfers: native SOL (System program) and SPL / Token-2022 tokens
 * with idempotent recipient token-account creation, on mainnet and devnet.
 */
import { CHAINS, formatAmount, fromBaseUnits } from "@kletia/core";
import {
  assertSolanaWalletRecipient,
  buildSolanaTransfer,
  isSolanaNetworkKey,
  readMintProgram,
} from "../../../networks/solana/index.js";
import { PlatformError } from "../../errors.js";
import { assetAmount, assetFromRef, sameAsset } from "../assets.js";
import { assertSolanaTransactionOwner, confirmSimulation, SOLANA_PROGRAM_IDS } from "../chains/solana.js";
import { nativeUsdPrice } from "../prices.js";
import { shortAddress } from "../util.js";
import type { AdapterAction, PlannedStep, PreparedPayload, ProtocolAdapter, VerificationResult } from "./types.js";
import { verifySolanaReferences } from "./verification.js";

const BASE_FEE_SOL = 0.00002;

function title(action: Pick<AdapterAction, "amount" | "input" | "recipient" | "network">): string {
  return `Send ${formatAmount(fromBaseUnits(action.amount, action.input.decimals))} ${action.input.symbol} to ${shortAddress(action.recipient.address)} on ${CHAINS[action.network].name}`;
}

/** Network fee only; recipient token-account rent (if any) is disclosed as a warning. */
async function feeUsd(action: Pick<AdapterAction, "network">): Promise<number | undefined> {
  const price = await nativeUsdPrice(action.network);
  return price === null ? undefined : BASE_FEE_SOL * price;
}

export const solanaTransferAdapter: ProtocolAdapter = {
  id: "spl-token",
  protocols: ["spl-token", "system-transfer"],
  label: "Solana transfer",

  supports(route) {
    return (
      route.kind === "transfer" &&
      isSolanaNetworkKey(route.network) &&
      route.destinationNetwork === route.network &&
      sameAsset(route.input, route.output)
    );
  },

  async plan(action): Promise<PlannedStep> {
    if (!isSolanaNetworkKey(action.network)) {
      throw new PlatformError("NETWORK_UNSUPPORTED", "Solana transfers run on solana or solana-devnet.", 422);
    }
    // Refuse non-wallet recipients and fee-charging mints at planning, not only at prepare.
    await Promise.all([
      assertSolanaWalletRecipient(action.network, action.recipient.address),
      action.input.isNative ? null : readMintProgram(action.network, action.input.address as string),
    ]);
    const amount = assetAmount(action.input, action.amount);
    const fees = await feeUsd(action);
    const warnings = action.input.isNative
      ? []
      : ["Creates the recipient's token account if it does not exist (about 0.002 SOL rent, paid by the sender)."];
    if (!action.input.verified) warnings.push(`${action.input.symbol} is not a verified token.`);
    return {
      protocol: action.input.isNative ? "system-transfer" : "spl-token",
      title: title(action),
      mode: "wallet",
      input: amount,
      expectedOutput: amount,
      minimumOutput: amount,
      ...(fees !== undefined ? { feesUsd: fees } : {}),
      estimatedSeconds: 10,
      settlement: { kind: "same-network" },
      warnings,
      transactionCount: 1,
      slippageBps: action.slippageBps,
    };
  },

  async prepare({ action }): Promise<PreparedPayload> {
    if (!isSolanaNetworkKey(action.network)) {
      throw new PlatformError("NETWORK_UNSUPPORTED", "Solana transfers run on solana or solana-devnet.", 422);
    }
    const prepared = await buildSolanaTransfer({
      network: action.network,
      from: action.account.address,
      to: action.recipient.address,
      mint: action.input.isNative ? "SOL" : (action.input.address as string),
      amount: action.amount,
      decimals: action.input.decimals,
    });
    const simulation = await confirmSimulation(action.network, prepared.transaction, prepared.simulation);
    if (simulation && !simulation.ok) {
      throw new PlatformError(
        "SIMULATION_FAILED",
        `The transfer would fail on-chain (${simulation.error.slice(0, 160)}). Check the balance of the sending account.`,
        422,
      );
    }
    const info = assertSolanaTransactionOwner(prepared.transaction, action.account.address);
    const program = action.input.isNative
      ? SOLANA_PROGRAM_IDS.system
      : info.programs.find((id) => id === SOLANA_PROGRAM_IDS.token || id === SOLANA_PROGRAM_IDS.token2022);
    if (!program) throw new PlatformError("TRANSFER_BUILD_FAILED", "The transfer transaction has no token program.", 500);
    const description = title(action);
    const amount = assetAmount(action.input, action.amount);
    const fees = await feeUsd(action);
    return {
      transactions: [
        {
          vm: "svm",
          network: action.network,
          feePayer: action.account.address,
          transaction: prepared.transaction,
          encoding: "base64",
          lastValidBlockHeight: prepared.lastValidBlockHeight,
          description,
        },
      ],
      records: [{ vm: "svm", network: action.network, feePayer: action.account.address, to: program, description }],
      input: amount,
      expectedOutput: amount,
      minimumOutput: amount,
      ...(fees !== undefined ? { feesUsd: fees } : {}),
      warnings: simulation ? [] : ["Simulation was unavailable; the wallet will simulate before signing."],
    };
  },

  async verify(context): Promise<VerificationResult> {
    const { step } = context;
    if (!step.input || !step.recipient) {
      return { status: "failed", evidence: [], failure: { code: "STEP_INVALID", message: "Transfer step is missing input or recipient." } };
    }
    const asset = assetFromRef(step.input);
    const recipient = step.recipient.slice(step.recipient.lastIndexOf(":") + 1);
    const expected = BigInt(step.input.amount);
    const { result } = await verifySolanaReferences(context, (observations) => {
      const credited = observations.reduce((total, observation) => {
        const delta = asset.isNative
          ? observation.lamportDeltas.get(recipient)
          : observation.tokenDeltas.get(`${recipient}:${asset.address}`);
        return total + (delta ?? 0n);
      }, 0n);
      if (credited < expected) {
        return {
          failure: {
            code: "REFERENCE_MISMATCH",
            message: `The transaction did not credit ${step.input?.formatted} ${asset.symbol} to the recipient.`,
          },
        };
      }
    });
    return result.status === "confirmed" ? { ...result, actualOutput: step.input } : result;
  },
};
