/**
 * Relay adapter: cross-network bridges and bridge-and-swap between Base,
 * Arbitrum One and Solana, plus same-network swaps on Base and Arbitrum.
 * A cross-network step settles only when Relay reports the fill and the
 * destination transaction is visible on the destination network.
 */
import { decodeFunctionData, erc20Abi, getAddress, type Hex } from "viem";
import {
  CHAINS,
  explorerTxUrl,
  formatAmount,
  fromBaseUnits,
  parseAccountId,
  type IntentStep,
  type NetworkKey,
  type StepEvidence,
  type TransactionRequest,
} from "@kletia/core";
import { assembleSolanaTransaction } from "../../../networks/solana/index.js";
import { PlatformError } from "../../errors.js";
import { assetAmount, assetFromRef, providerCurrency, sameAsset, type ResolvedAsset } from "../assets.js";
import { erc20CreditFromLogs, evmChainId, isEvmNetwork, readEvmReceiptStatus } from "../chains/evm.js";
import { assertSolanaTransactionOwner, readSolanaSignatureStatus, SOLANA_PROGRAM_IDS } from "../chains/solana.js";
import { decodeStepRef } from "../stepRef.js";
import { assertEvmBalance } from "./evm-transfer.js";
import {
  fetchRelayQuote,
  fetchRelayRequestByHash,
  fetchRelayStatus,
  type RelayCall,
  type RelayQuote,
  type RelayRequestState,
} from "./relay-client.js";
import type {
  AdapterAction,
  AdapterRoute,
  PlannedStep,
  PreparedPayload,
  ProtocolAdapter,
  SettlementResult,
  VerificationResult,
} from "./types.js";
import { stepOwner, verifyEvmReferences, verifySolanaReferences } from "./verification.js";

export const RELAY_NETWORKS: readonly NetworkKey[] = ["base", "arbitrum", "solana"];
const SAME_NETWORK_SWAP_NETWORKS: readonly NetworkKey[] = ["base", "arbitrum"];
const APPROVE_SELECTOR = "0x095ea7b3";
const MAX_TOTAL_IMPACT_PERCENT = 10;

function relayChainId(network: NetworkKey): number {
  const id = CHAINS[network].settlement.relayChainId;
  if (id === undefined) throw new PlatformError("NETWORK_UNSUPPORTED", `Relay does not serve ${CHAINS[network].name}.`, 422);
  return id;
}

function crossNetwork(route: Pick<AdapterRoute, "network" | "destinationNetwork">): boolean {
  return route.network !== route.destinationNetwork;
}

function title(action: Pick<AdapterAction, "kind" | "network" | "destinationNetwork" | "input" | "output" | "amount">): string {
  const amount = `${formatAmount(fromBaseUnits(action.amount, action.input.decimals))} ${action.input.symbol}`;
  if (!crossNetwork(action)) return `Swap ${amount} for ${action.output.symbol} on ${CHAINS[action.network].name}`;
  const base = `Bridge ${amount} from ${CHAINS[action.network].name} to ${CHAINS[action.destinationNetwork].name}`;
  return action.output.symbol.toUpperCase() === action.input.symbol.toUpperCase() ? base : `${base} as ${action.output.symbol}`;
}

async function quote(action: AdapterAction, slippageBps: number): Promise<RelayQuote> {
  return fetchRelayQuote({
    user: action.account.address,
    recipient: action.recipient.address,
    originChainId: relayChainId(action.network),
    destinationChainId: relayChainId(action.destinationNetwork),
    originCurrency: providerCurrency(action.input),
    destinationCurrency: providerCurrency(action.output),
    amount: action.amount,
    slippageBps,
  });
}

function quoteWarnings(result: RelayQuote): string[] {
  const warnings: string[] = [];
  const impact = result.totalImpactPercent;
  if (impact !== null && impact < -MAX_TOTAL_IMPACT_PERCENT) {
    throw new PlatformError(
      "PRICE_IMPACT_TOO_HIGH",
      `Fees and price impact would cost ${Math.abs(impact).toFixed(2)}% of the amount; routes above ${MAX_TOTAL_IMPACT_PERCENT}% are refused.`,
      422,
    );
  }
  if (impact !== null && impact < -1) warnings.push(`Fees and price impact total ${Math.abs(impact).toFixed(2)}% of the amount.`);
  return warnings;
}

function amounts(action: AdapterAction, result: RelayQuote) {
  const outUsd = result.currencyOut.amountUsd;
  const ratio = outUsd !== null && result.currencyOut.amount !== "0"
    ? Number(result.currencyOut.minimumAmount) / Number(result.currencyOut.amount)
    : null;
  return {
    input: assetAmount(action.input, action.amount, result.currencyIn.amountUsd ?? undefined),
    expectedOutput: assetAmount(action.output, result.currencyOut.amount, outUsd ?? undefined),
    minimumOutput: assetAmount(
      action.output,
      result.currencyOut.minimumAmount,
      outUsd !== null && ratio !== null && Number.isFinite(ratio) ? outUsd * ratio : undefined,
    ),
  };
}

function sameAddress(a: string, b: string): boolean {
  return a.startsWith("0x") ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Validates Relay's EVM calls against the step before anything reaches a wallet. */
function evmTransactions(action: AdapterAction, calls: readonly RelayCall[], description: string): TransactionRequest[] {
  if (!isEvmNetwork(action.network)) throw new PlatformError("NETWORK_UNSUPPORTED", "Not an EVM network.", 422);
  const network = action.network;
  const chainId = evmChainId(network);
  const amount = BigInt(action.amount);
  const evmCalls = calls.map((call) => {
    if (call.kind !== "evm") throw new PlatformError("RELAY_QUOTE_INVALID", "Relay returned a Solana call for an EVM origin.", 502);
    return call;
  });
  return evmCalls.map((call, index) => {
    if (call.chainId !== chainId) throw new PlatformError("RELAY_QUOTE_INVALID", "Relay call targets another chain.", 502);
    if (call.from.toLowerCase() !== action.account.address.toLowerCase()) {
      throw new PlatformError("RELAY_QUOTE_INVALID", "Relay call is not sent by the step account.", 502);
    }
    const isApprove = call.data.toLowerCase().startsWith(APPROVE_SELECTOR);
    if (isApprove) {
      if (action.input.isNative || !action.input.address || call.to.toLowerCase() !== action.input.address.toLowerCase()) {
        throw new PlatformError("RELAY_QUOTE_INVALID", "Relay approval targets an unexpected token.", 502);
      }
      const decoded = decodeFunctionData({ abi: erc20Abi, data: call.data as Hex });
      if (decoded.functionName !== "approve") throw new PlatformError("RELAY_QUOTE_INVALID", "Unexpected approval call.", 502);
      const [spender, approved] = decoded.args;
      const next = evmCalls[index + 1];
      if (!next || next.to.toLowerCase() !== spender.toLowerCase()) {
        throw new PlatformError("RELAY_QUOTE_INVALID", "Relay approval spender is not the contract it then calls.", 502);
      }
      if (approved > amount) throw new PlatformError("RELAY_QUOTE_INVALID", "Relay approval exceeds the step amount.", 502);
      if (call.value !== "0") throw new PlatformError("RELAY_QUOTE_INVALID", "Approval must not carry value.", 502);
    } else if (action.input.isNative ? BigInt(call.value) > amount : call.value !== "0") {
      throw new PlatformError("RELAY_QUOTE_INVALID", "Relay call value does not match the step amount.", 502);
    }
    return {
      vm: "evm" as const,
      network,
      chainId,
      from: getAddress(call.from),
      to: getAddress(call.to),
      data: call.data,
      value: call.value,
      ...(call.gas ? { gas: call.gas } : {}),
      description: isApprove ? `Approve ${action.input.symbol} for Relay` : description,
    };
  });
}

async function solanaTransactions(
  action: AdapterAction,
  calls: readonly RelayCall[],
  description: string,
): Promise<{ transactions: TransactionRequest[]; programs: string[] }> {
  if (action.network !== "solana") throw new PlatformError("NETWORK_UNSUPPORTED", "Relay Solana deposits run on Solana mainnet.", 422);
  const transactions: TransactionRequest[] = [];
  const programs: string[] = [];
  for (const call of calls) {
    if (call.kind !== "svm") throw new PlatformError("RELAY_QUOTE_INVALID", "Relay returned an EVM call for a Solana origin.", 502);
    const prepared = await assembleSolanaTransaction({
      network: "solana",
      feePayer: action.account.address,
      instructions: call.instructions,
      addressLookupTables: call.addressLookupTables,
    });
    if (!prepared.simulation.ok && prepared.simulation.error !== "Simulation unavailable") {
      throw new PlatformError(
        "SIMULATION_FAILED",
        `The Relay deposit would fail on-chain (${(prepared.simulation.error ?? "simulation error").slice(0, 160)}). Check the balance of the sending account.`,
        422,
      );
    }
    assertSolanaTransactionOwner(prepared.transaction, action.account.address);
    const primary = [...call.instructions].reverse().find((instruction) => instruction.programId !== SOLANA_PROGRAM_IDS.computeBudget);
    if (!primary) throw new PlatformError("RELAY_QUOTE_INVALID", "Relay deposit has no program instruction.", 502);
    programs.push(primary.programId);
    transactions.push({
      vm: "svm",
      network: "solana",
      feePayer: action.account.address,
      transaction: prepared.transaction,
      encoding: "base64",
      lastValidBlockHeight: prepared.lastValidBlockHeight,
      description,
    });
  }
  return { transactions, programs };
}

function settlementFailure(state: RelayRequestState): SettlementResult | null {
  if (state.status === "refund") {
    return {
      status: "failed",
      evidence: [],
      failure: { code: "SETTLEMENT_REFUNDED", message: "Relay refunded the deposit on the origin network." },
    };
  }
  if (state.status === "failure") {
    return {
      status: "failed",
      evidence: [],
      failure: { code: "SETTLEMENT_FAILED", message: "Relay could not fill the request." },
    };
  }
  return null;
}

async function destinationConfirmed(
  network: NetworkKey,
  hash: string,
  output: ResolvedAsset | null,
  recipient: string,
): Promise<{ confirmed: boolean; credited: bigint | null }> {
  if (isEvmNetwork(network)) {
    if (!/^0x[0-9a-fA-F]{64}$/u.test(hash)) return { confirmed: false, credited: null };
    const receipt = await readEvmReceiptStatus(network, hash);
    if (receipt.status !== "success") return { confirmed: false, credited: null };
    const credited = output && !output.isNative && output.address
      ? erc20CreditFromLogs(receipt.logs, output.address, recipient)
      : null;
    return { confirmed: true, credited: credited !== null && credited > 0n ? credited : null };
  }
  if (network === "solana") {
    return { confirmed: (await readSolanaSignatureStatus("solana", hash)) === "success", credited: null };
  }
  return { confirmed: false, credited: null };
}

export const relayAdapter: ProtocolAdapter = {
  id: "relay",
  protocols: ["relay"],
  label: "Relay",

  supports(route) {
    if (!RELAY_NETWORKS.includes(route.network) || !RELAY_NETWORKS.includes(route.destinationNetwork)) return false;
    if (route.kind === "bridge") return crossNetwork(route);
    if (route.kind === "swap") {
      return !crossNetwork(route) && SAME_NETWORK_SWAP_NETWORKS.includes(route.network) && !sameAsset(route.input, route.output);
    }
    return false;
  },

  async plan(action): Promise<PlannedStep> {
    const result = await quote(action, action.slippageBps);
    const warnings = quoteWarnings(result);
    if (!action.output.verified) warnings.push(`${action.output.symbol} is not a verified token.`);
    const cross = crossNetwork(action);
    return {
      protocol: "relay",
      title: title(action),
      mode: "wallet",
      ...amounts(action, result),
      ...(result.feesUsd !== null ? { feesUsd: result.feesUsd } : {}),
      estimatedSeconds: cross ? Math.max(result.timeEstimateSeconds, 5) + 15 : 15,
      settlement: cross
        ? { kind: "cross-network", destinationNetwork: action.destinationNetwork, expectedSeconds: Math.max(result.timeEstimateSeconds, 5) }
        : { kind: "same-network" },
      warnings,
      quoteId: result.requestId,
      transactionCount: result.calls.length,
      slippageBps: action.slippageBps,
    };
  },

  async prepare({ step, action }): Promise<PreparedPayload> {
    const slippageBps = decodeStepRef(step.quoteRef)?.slippageBps ?? action.slippageBps;
    if (isEvmNetwork(action.network)) {
      await assertEvmBalance(action.network, action.account.address, action.input.address, BigInt(action.amount), action.input.symbol, action.input.decimals);
    }
    const result = await quote(action, slippageBps);
    const warnings = quoteWarnings(result);
    const description = title(action);
    let transactions: TransactionRequest[];
    let records: PreparedPayload["records"];
    if (isEvmNetwork(action.network)) {
      transactions = evmTransactions(action, result.calls, description);
      records = transactions.map((transaction) => ({
        vm: "evm" as const,
        network: action.network,
        to: transaction.vm === "evm" ? transaction.to : "",
        description: transaction.description,
      }));
    } else {
      const built = await solanaTransactions(action, result.calls, description);
      transactions = built.transactions;
      records = built.transactions.map((transaction, index) => ({
        vm: "svm" as const,
        network: action.network,
        feePayer: action.account.address,
        to: built.programs[index] as string,
        description: transaction.description,
      }));
    }
    return {
      transactions,
      records,
      ...amounts(action, result),
      ...(result.feesUsd !== null ? { feesUsd: result.feesUsd } : {}),
      ...(crossNetwork(action) ? { trackingId: result.requestId } : {}),
      quoteId: result.requestId,
      warnings,
    };
  },

  async verify(context): Promise<VerificationResult> {
    if (context.step.chain.startsWith("eip155:")) return verifyEvmReferences(context);
    const input = context.step.input ? assetFromRef(context.step.input) : null;
    const owner = stepOwner(context.step);
    const { result } = await verifySolanaReferences(context, (observations) => {
      if (!input || input.isNative || !context.step.input) return;
      const debited = observations.reduce(
        (total, observation) => total - (observation.tokenDeltas.get(`${owner}:${input.address}`) ?? 0n),
        0n,
      );
      if (debited < BigInt(context.step.input.amount)) {
        return {
          failure: { code: "REFERENCE_MISMATCH", message: `The deposit did not debit ${context.step.input.formatted} ${input.symbol} from the step account.` },
        };
      }
    });
    return result;
  },

  async poll(step: IntentStep): Promise<SettlementResult> {
    const destination = step.settlement?.destinationNetwork;
    if (!destination || destination === step.network) return { status: "settled", evidence: [] };
    const deposit = step.references?.[step.references.length - 1];
    const recipient = step.recipient ? parseAccountId(step.recipient) : null;
    const output = step.minimumOutput ? assetFromRef(step.minimumOutput) : null;
    let state: RelayRequestState | null = deposit ? await fetchRelayRequestByHash(deposit).catch(() => null) : null;
    if (state && recipient && state.recipient && !sameAddress(state.recipient, recipient.address)) {
      return {
        status: "failed",
        evidence: [],
        failure: { code: "SETTLEMENT_MISMATCH", message: "The Relay request for this deposit pays a different recipient." },
      };
    }
    if (!state && step.settlement?.trackingId) state = await fetchRelayStatus(step.settlement.trackingId);
    if (!state) return { status: "settling", evidence: [] };
    const failure = settlementFailure(state);
    if (failure) return failure;
    if (state.status !== "success") {
      return { status: "settling", evidence: [], ...(state.requestId !== step.settlement?.trackingId ? { trackingId: state.requestId } : {}) };
    }
    const observedAt = new Date().toISOString();
    for (const hash of state.destinationTxHashes) {
      const check = await destinationConfirmed(destination, hash, output, recipient?.address ?? "").catch(() => ({
        confirmed: false,
        credited: null,
      }));
      if (!check.confirmed) continue;
      const evidence: StepEvidence = {
        kind: "settlement",
        network: destination,
        reference: hash,
        url: explorerTxUrl(destination, hash),
        observedAt,
        detail: `Relay fill confirmed on ${CHAINS[destination].name} (request ${state.requestId.slice(0, 10)}…).`,
      };
      const reported = state.outputAmount !== null && output &&
        (state.outputCurrency === null || sameAddress(state.outputCurrency, output.isNative ? state.outputCurrency : (output.address as string)))
        ? state.outputAmount
        : null;
      const amount = check.credited !== null ? check.credited.toString() : reported;
      return {
        status: "settled",
        evidence: [evidence],
        ...(amount && output ? { actualOutput: assetAmount(output, amount) } : {}),
      };
    }
    return { status: "settling", evidence: [] };
  },
};
