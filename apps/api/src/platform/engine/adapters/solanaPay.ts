/**
 * Solana Pay transfer requests (https://docs.solanapay.com/spec): a payment
 * named "via solana pay" is an ordinary SOL / SPL transfer that also carries
 * a unique reference key, so the payer's wallet transaction can be found by
 * that key (getSignaturesForAddress) and verified by it.
 *
 * - The reference is derived from the intent and step ids (sha256, read as a
 *   32-byte public key nobody holds a secret for); every prepare of the step
 *   carries the same one, returned as the payload's `trackingId`.
 * - `encodeSolanaPayTransferUrl` builds the matching `solana:` transfer URL
 *   (recipient, amount, spl-token, reference, label, message, memo) and
 *   `parseSolanaPayTransferUrl` reads one back with the spec's checks.
 * - The transaction is the transfer adapter's (System transfer or SPL
 *   TransferChecked with idempotent recipient token-account creation), with
 *   the reference appended to the transfer instruction as a read-only
 *   account. Verification requires a landed System / Token transfer
 *   instruction naming the reference and the full amount credited to the
 *   recipient.
 */
import { createHash } from "node:crypto";
import { CHAINS, formatAmount, fromBaseUnits, isSolanaAddress, type IntentStep } from "@kletia/core";
import { address, getAddressDecoder } from "@solana/kit";
import { assertSolanaWalletRecipient, buildSolanaTransfer, isSolanaNetworkKey, readMintProgram, solanaRpc, type SolanaNetworkKey } from "../../../networks/solana/index.js";
import { rpcAbortSignal } from "../../../networks/solana/rpc.js";
import { PlatformError } from "../../errors.js";
import { assetAmount, assetFromRef, sameAsset } from "../assets.js";
import { assertSolanaTransactionOwner, confirmSimulation, SOLANA_PROGRAM_IDS } from "../chains/solana.js";
import { nativeUsdPrice } from "../prices.js";
import { shortAddress } from "../util.js";
import type { AdapterAction, PlannedStep, PreparedPayload, ProtocolAdapter, VerificationResult } from "./types.js";
import { verifySolanaReferences } from "./verification.js";

const BASE_FEE_SOL = 0.00002;
const REFERENCE_DOMAIN = "kletia/solana-pay/reference/v1";
const AMOUNT_PATTERN = /^\d+(?:\.\d+)?$/u;
const URL_FIELD_MAX_LENGTH = 256;

/** The step's reference key: sha256(domain, intent id, step id) read as a public key. */
export function solanaPayReference(intentId: string, stepId: string): string {
  const digest = createHash("sha256").update(`${REFERENCE_DOMAIN}:${intentId}:${stepId}`).digest();
  return String(getAddressDecoder().decode(digest));
}

export interface SolanaPayTransferRequest {
  readonly recipient: string;
  /** Decimal amount in whole units ("1.5"); absent: the wallet asks the payer. */
  readonly amount?: string;
  /** SPL mint; absent for native SOL. */
  readonly splToken?: string;
  readonly references: readonly string[];
  readonly label?: string;
  readonly message?: string;
  readonly memo?: string;
}

function refuse(message: string): PlatformError {
  return new PlatformError("INTENT_UNSUPPORTED", message, 422);
}

function checkedText(field: string, value: string | undefined): string | undefined {
  if (value !== undefined && value.length > URL_FIELD_MAX_LENGTH) throw refuse(`The Solana Pay ${field} is longer than ${URL_FIELD_MAX_LENGTH} characters.`);
  return value;
}

/** Builds a `solana:` transfer request URL (spec field order; text fields percent-encoded). */
export function encodeSolanaPayTransferUrl(request: SolanaPayTransferRequest): string {
  if (!isSolanaAddress(request.recipient)) throw refuse("A Solana Pay recipient must be a Solana address.");
  if (request.splToken !== undefined && !isSolanaAddress(request.splToken)) throw refuse("A Solana Pay spl-token must be a mint address.");
  if (request.references.some((reference) => !isSolanaAddress(reference))) throw refuse("Every Solana Pay reference must be a Solana address.");
  if (request.amount !== undefined && !AMOUNT_PATTERN.test(request.amount)) throw refuse("A Solana Pay amount is a plain decimal number.");
  const params: string[] = [];
  if (request.amount !== undefined) params.push(`amount=${request.amount}`);
  if (request.splToken) params.push(`spl-token=${request.splToken}`);
  for (const reference of request.references) params.push(`reference=${reference}`);
  for (const [name, value] of [["label", request.label], ["message", request.message], ["memo", request.memo]] as const) {
    const text = checkedText(name, value);
    if (text !== undefined) params.push(`${name}=${encodeURIComponent(text)}`);
  }
  return `solana:${request.recipient}${params.length > 0 ? `?${params.join("&")}` : ""}`;
}

/** Reads a `solana:` transfer request URL; refuses anything the spec does not allow. */
export function parseSolanaPayTransferUrl(url: string): SolanaPayTransferRequest {
  const match = /^solana:([1-9A-HJ-NP-Za-km-z]{32,44})(?:\?(.*))?$/u.exec(url.trim());
  if (!match || !isSolanaAddress(match[1] as string)) throw refuse("Not a Solana Pay transfer request URL.");
  const query = new URLSearchParams(match[2] ?? "");
  const single = (name: string) => {
    const values = query.getAll(name);
    if (values.length > 1) throw refuse(`A Solana Pay URL carries ${name} at most once.`);
    return values[0];
  };
  const amount = single("amount");
  const splToken = single("spl-token");
  const references = query.getAll("reference");
  const decoded: SolanaPayTransferRequest = {
    recipient: match[1] as string,
    ...(amount !== undefined ? { amount } : {}),
    ...(splToken !== undefined ? { splToken } : {}),
    references,
    ...Object.fromEntries((["label", "message", "memo"] as const).flatMap((name) => {
      const value = single(name);
      return value === undefined ? [] : [[name, checkedText(name, value)]];
    })),
  };
  // Re-encoding checks every field the same way the builder does.
  encodeSolanaPayTransferUrl(decoded);
  return decoded;
}

/** Signatures of transactions that name `reference` (newest first), read-only. */
export async function findSolanaPayTransactions(network: SolanaNetworkKey, reference: string, limit = 10): Promise<string[]> {
  if (!isSolanaAddress(reference)) throw refuse("A Solana Pay reference must be a Solana address.");
  try {
    const rows = await solanaRpc(network)
      .getSignaturesForAddress(address(reference), { limit, commitment: "confirmed" })
      .send({ abortSignal: rpcAbortSignal() });
    return rows.filter((row) => row.err === null).map((row) => String(row.signature));
  } catch {
    throw new PlatformError("SOLANA_RPC_UNAVAILABLE", "Solana Pay references could not be looked up. Try again shortly.", 502);
  }
}

/** The transfer request URL of a planned or prepared step (amount, mint and reference as the transaction carries them). */
export function solanaPayStepUrl(step: Pick<IntentStep, "input" | "recipient" | "network">, reference: string): string {
  if (!step.input || !step.recipient) throw refuse("A Solana Pay step needs an amount and a recipient.");
  const asset = assetFromRef(step.input);
  return encodeSolanaPayTransferUrl({
    recipient: step.recipient.slice(step.recipient.lastIndexOf(":") + 1),
    amount: step.input.formatted,
    ...(asset.isNative ? {} : { splToken: asset.address as string }),
    references: [reference],
    label: "Kletia",
  });
}

function title(action: Pick<AdapterAction, "amount" | "input" | "recipient" | "network">): string {
  return `Pay ${formatAmount(fromBaseUnits(action.amount, action.input.decimals))} ${action.input.symbol} to ${shortAddress(action.recipient.address)} with Solana Pay on ${CHAINS[action.network].name}`;
}

async function feeUsd(network: SolanaNetworkKey): Promise<number | undefined> {
  const price = await nativeUsdPrice(network);
  return price === null ? undefined : BASE_FEE_SOL * price;
}

function solanaNetwork(action: Pick<AdapterAction, "network">): SolanaNetworkKey {
  if (!isSolanaNetworkKey(action.network)) throw new PlatformError("NETWORK_UNSUPPORTED", "Solana Pay transfers run on solana or solana-devnet.", 422);
  return action.network;
}

export const solanaPayAdapter: ProtocolAdapter = {
  id: "solana-pay",
  protocols: ["solana-pay"],
  label: "Solana Pay",
  explicitOnly: true,

  supports(route) {
    return route.kind === "transfer" && isSolanaNetworkKey(route.network) && route.destinationNetwork === route.network && sameAsset(route.input, route.output);
  },

  async plan(action): Promise<PlannedStep> {
    const network = solanaNetwork(action);
    await Promise.all([
      assertSolanaWalletRecipient(network, action.recipient.address),
      action.input.isNative ? null : readMintProgram(network, action.input.address as string),
    ]);
    const amount = assetAmount(action.input, action.amount);
    const fees = await feeUsd(network);
    const warnings = ["Carries a unique Solana Pay reference key, so the payment can be found and verified by it."];
    if (!action.input.isNative) warnings.push("Creates the recipient's token account if it does not exist (about 0.002 SOL rent, paid by the sender).");
    if (!action.input.verified) warnings.push(`${action.input.symbol} is not a verified token.`);
    return {
      protocol: "solana-pay",
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

  async prepare({ graph, step, action }): Promise<PreparedPayload> {
    const network = solanaNetwork(action);
    const reference = solanaPayReference(graph.id, step.id);
    const prepared = await buildSolanaTransfer({
      network,
      from: action.account.address,
      to: action.recipient.address,
      mint: action.input.isNative ? "SOL" : (action.input.address as string),
      amount: action.amount,
      decimals: action.input.decimals,
      references: [reference],
    });
    const simulation = await confirmSimulation(network, prepared.transaction, prepared.simulation);
    if (simulation && !simulation.ok) {
      throw new PlatformError("SIMULATION_FAILED", `The payment would fail on-chain (${simulation.error.slice(0, 160)}). Check the balance of the sending account.`, 422);
    }
    const info = assertSolanaTransactionOwner(prepared.transaction, action.account.address);
    const program = action.input.isNative
      ? SOLANA_PROGRAM_IDS.system
      : info.programs.find((id) => id === SOLANA_PROGRAM_IDS.token || id === SOLANA_PROGRAM_IDS.token2022);
    if (!program) throw new PlatformError("TRANSFER_BUILD_FAILED", "The payment transaction has no token program.", 500);
    const description = title(action);
    const amount = assetAmount(action.input, action.amount);
    const fees = await feeUsd(network);
    return {
      transactions: [
        { vm: "svm", network, feePayer: action.account.address, transaction: prepared.transaction, encoding: "base64", lastValidBlockHeight: prepared.lastValidBlockHeight, description },
      ],
      records: [{ vm: "svm", network, feePayer: action.account.address, to: program, description }],
      input: amount,
      expectedOutput: amount,
      minimumOutput: amount,
      ...(fees !== undefined ? { feesUsd: fees } : {}),
      trackingId: reference,
      warnings: simulation ? [] : ["Simulation was unavailable; the wallet will simulate before signing."],
    };
  },

  async verify(context): Promise<VerificationResult> {
    const { step } = context;
    const reference = step.settlement?.trackingId;
    if (!step.input || !step.recipient || !reference || !isSolanaAddress(reference)) {
      return { status: "failed", evidence: [], failure: { code: "STEP_INVALID", message: "The Solana Pay step has no amount, recipient or prepared reference." } };
    }
    const asset = assetFromRef(step.input);
    const recipient = step.recipient.slice(step.recipient.lastIndexOf(":") + 1);
    const expected = BigInt(step.input.amount);
    const transferPrograms = new Set<string>([SOLANA_PROGRAM_IDS.system, SOLANA_PROGRAM_IDS.token, SOLANA_PROGRAM_IDS.token2022]);
    const { result } = await verifySolanaReferences(context, (observations) => {
      const referenced = observations
        .flatMap((observation) => observation.instructions ?? [])
        .some((entry) => transferPrograms.has(entry.program) && entry.accounts.includes(reference));
      if (!referenced) {
        return { failure: { code: "REFERENCE_MISMATCH", message: `No transfer in the transaction carries the step's Solana Pay reference ${reference}.` } };
      }
      const credited = observations.reduce((total, observation) => {
        const delta = asset.isNative ? observation.lamportDeltas.get(recipient) : observation.tokenDeltas.get(`${recipient}:${asset.address}`);
        return total + (delta ?? 0n);
      }, 0n);
      if (credited < expected) {
        return { failure: { code: "REFERENCE_MISMATCH", message: `The transaction did not credit ${step.input?.formatted} ${asset.symbol} to the recipient.` } };
      }
    });
    return result.status === "confirmed" ? { ...result, actualOutput: step.input } : result;
  },
};
