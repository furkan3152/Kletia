/**
 * Approval digests, ceilings, typed data and message text.
 */
import { parseAccountId } from "../caip.js";
import { canonicalJson } from "../contracts.js";
import { sha256Hex } from "../hash.js";
import type { IntentGraph } from "../intent.js";

/* ================================================================ approvals */

/**
 * What an approval approves: `0x` + sha256 of the canonical intent shape (no
 * amounts; the ceiling bounds them).
 */
export function approvalDigest(graph: IntentGraph, ownerKeyId: string): string {
  return `0x${sha256Hex(
    canonicalJson({
      intent: graph.id,
      owner: ownerKeyId,
      accounts: graph.request.accounts,
      steps: graph.steps.map((step) => ({
        id: step.id,
        kind: step.kind,
        network: step.network,
        destinationNetwork: step.settlement?.destinationNetwork,
        protocol: step.protocol,
        venue: step.venue,
        input: step.input?.asset,
        output: step.expectedOutput?.asset,
        recipient: step.recipient ?? step.account,
        recipientName: step.recipientName,
        contract: step.call?.contract,
        entry: step.call?.entry,
      })),
    }),
  )}`;
}

/** ceil(notional × 1.02) in cents (the hold's ceiling). */
export function approvalCeilingUsdCents(notionalUsdMicros: bigint): bigint {
  const denominator = 100n * 10_000n;
  return (notionalUsdMicros * 102n + denominator - 1n) / denominator;
}

export interface ApprovalSigningInput {
  readonly approvalId: string;
  readonly intentId: string;
  /** `approvalDigest` (0x + 64 hex). */
  readonly digest: string;
  readonly ceilingUsdCents: bigint | string | number;
  readonly decision: "approve" | "reject";
  /** Unix seconds, or an ISO time. */
  readonly expiresAt: number | string;
}

function expiresSeconds(value: number | string): bigint {
  const seconds = typeof value === "number" ? value : Math.floor(Date.parse(value) / 1_000);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error("expiresAt must be unix seconds or an ISO time.");
  return BigInt(seconds);
}

/** EIP-712 approval typed data, domain "Kletia Approvals" v1 on the signer's chain (pass to viem signTypedData / verifyTypedData). */
export function approvalTypedData(input: ApprovalSigningInput & { readonly signer: string }) {
  const account = parseAccountId(input.signer);
  const chainId = account?.chain.evmChainId;
  if (!account || chainId === undefined) throw new Error("EVM approvals need an eip155 CAIP-10 signer; Solana approvals sign approvalMessageText.");
  if (!/^0x[0-9a-f]{64}$/u.test(input.digest)) throw new Error("digest must be 0x + 64 lower-case hex.");
  return {
    domain: { name: "Kletia Approvals", version: "1", chainId },
    types: {
      Approval: [
        { name: "approval", type: "string" },
        { name: "intent", type: "string" },
        { name: "digest", type: "bytes32" },
        { name: "ceilingUsdCents", type: "uint256" },
        { name: "decision", type: "string" },
        { name: "expiresAt", type: "uint64" },
      ],
    },
    primaryType: "Approval" as const,
    message: {
      approval: input.approvalId,
      intent: input.intentId,
      digest: input.digest as `0x${string}`,
      ceilingUsdCents: BigInt(input.ceilingUsdCents),
      decision: input.decision,
      expiresAt: expiresSeconds(input.expiresAt),
    },
  };
}

function dollars(centsValue: bigint): string {
  const whole = (centsValue / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  return `$${whole}.${(centsValue % 100n).toString().padStart(2, "0")}`;
}

/** Canonical Solana approval message (UTF-8, LF, no trailing spaces), signed with signMessage. */
export function approvalMessageText(input: ApprovalSigningInput): string {
  const expires = new Date(Number(expiresSeconds(input.expiresAt)) * 1_000).toISOString().replace(/\.\d{3}Z$/u, "Z");
  return [
    "Kletia approval",
    `approval: ${input.approvalId}`,
    `intent: ${input.intentId}`,
    `digest: ${input.digest}`,
    `up to: ${dollars(BigInt(input.ceilingUsdCents))}`,
    `decision: ${input.decision}`,
    `expires: ${expires}`,
  ].join("\n");
}
