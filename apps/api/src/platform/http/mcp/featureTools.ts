/**
 * MCP tools of the round-5 features (read-only, like every Kletia tool):
 *
 * - `preview_intent`: the fare breakdown of a stored intent (rows, payments,
 *   totals, needs, warnings; never calldata). Shares the per-intent limit of
 *   POST /v1/intents/{id}/preview.
 * - `get_receipt`: a receipt by intent id (the owner's capability) or by a
 *   share link (never returns an intent id), checked with the server's own
 *   `verifyReceipt` run; agents should still re-verify for third parties.
 */
import {
  CHAINS,
  explorerTxUrl,
  verifyReceipt,
  type AnchorRole,
  type IntentPreview,
  type ReceiptAnchor,
  type ReceiptDisclosure,
} from "@kletia/core";
import { INTENT_ID_PATTERN } from "../../index.js";
import { invalidRequest, isRecord } from "../context.js";
import { recomputePreview } from "../preview.js";
import { readOwnerReceipt, readShareCiphertext, readSharedReceipt, type ReceiptDocumentView } from "../receipts/handlers.js";
import { decryptShare, parseShareUrl } from "../receipts/shares.js";
import { receiptKeys } from "../receipts/signer.js";
import type { KletiaTool, ToolAnnotations } from "./tools.js";

const REVERIFY_COMMAND = "npx @kletia/cli receipt reverify <share url or receipt file>";

function annotations(title: string, openWorld: boolean, idempotent = true): ToolAnnotations {
  return { title, readOnlyHint: true, destructiveHint: false, idempotentHint: idempotent, openWorldHint: openWorld };
}

function usd(value: number | null | undefined): string | undefined {
  return value === null || value === undefined ? undefined : `$${value.toFixed(2)}`;
}

/** Compact fare breakdown for agents: what moves, totals, needs and warnings. */
export function previewSummary(preview: IntentPreview): Record<string, unknown> {
  return {
    digest: preview.digest,
    stage: preview.stage,
    basis: preview.basis,
    computedAt: preview.computedAt,
    rows: preview.rows.map((row) => ({
      network: row.network,
      account: row.account,
      asset: row.symbol,
      expected: row.expected.formatted,
      atWorst: row.worst.formatted,
      ...(row.expected.usd !== undefined ? { usd: usd(row.expected.usd) } : {}),
      certainty: row.certainty,
      ...(row.role === "transit" ? { transit: true } : {}),
    })),
    payments: preview.payments.map((payment) => ({
      network: payment.network,
      recipient: payment.recipient,
      ...(payment.recipientName ? { recipientName: payment.recipientName } : {}),
      asset: payment.symbol,
      expected: payment.expected.formatted,
      atLeast: payment.worst.formatted,
      certainty: payment.certainty,
    })),
    approvals: preview.approvals.map((approval) => ({ network: approval.network, token: approval.token.symbol, spender: approval.spenderLabel, amount: approval.formatted, leftAfter: approval.leftAfter })),
    totals: {
      youPay: usd(preview.totals.youPayUsd) ?? "unpriced",
      youGet: { expected: usd(preview.totals.youGetUsd.expected) ?? "unpriced", atLeast: usd(preview.totals.youGetUsd.worst) ?? "unpriced" },
      networkFees: usd(preview.totals.networkFeesUsd) ?? "unpriced",
      venueFees: usd(preview.totals.venueFeesUsd) ?? "unpriced",
      cost: { expected: usd(preview.totals.costUsd.expected) ?? "unpriced", worst: usd(preview.totals.costUsd.worst) ?? "unpriced" },
      ...(preview.totals.unpriced.length > 0 ? { unpriced: preview.totals.unpriced } : {}),
    },
    ...(preview.arrival ? { arrival: preview.arrival } : {}),
    needs: preview.needs.map((need) => ({ network: need.network, asset: need.asset.symbol, amount: need.formatted, reason: need.reason, ...(need.have !== undefined ? { have: need.have } : {}) })),
    warnings: preview.warnings,
  };
}

function explorerUrl(anchor: ReceiptAnchor): string | undefined {
  const chain = Object.values(CHAINS).find((candidate) => candidate.id === anchor.chain);
  return chain ? explorerTxUrl(chain, anchor.vm === "evm" ? anchor.tx : anchor.signature) : undefined;
}

function anchorsOf(disclosures: Readonly<Record<string, ReceiptDisclosure>> | undefined, stepId: string): { chain: string; ref: string; role: AnchorRole; block?: string; slot?: string; explorerUrl?: string }[] {
  const value = disclosures?.[`steps.${stepId}.evidence`]?.value;
  const anchors = isRecord(value) && Array.isArray(value.anchors) ? (value.anchors as ReceiptAnchor[]) : [];
  return anchors.map((anchor) => {
    const url = explorerUrl(anchor);
    return anchor.vm === "evm"
      ? { chain: anchor.chain, ref: anchor.tx, role: anchor.role, block: anchor.blockNumber, ...(url ? { explorerUrl: url } : {}) }
      : { chain: anchor.chain, ref: anchor.signature, role: anchor.role, slot: anchor.slot, ...(url ? { explorerUrl: url } : {}) };
  });
}

async function receiptSummary(document: ReceiptDocumentView, intentId: string | undefined): Promise<Record<string, unknown>> {
  const check = await verifyReceipt(document, { keys: receiptKeys(), ...(intentId ? { intentId } : {}) });
  const payload = document.payload;
  return {
    receiptId: payload.receiptId,
    sequence: payload.sequence,
    status: payload.intent.status,
    terminal: payload.intent.terminal,
    issuedOn: payload.issuedOn,
    digest: document.digest,
    kid: document.signature.kid,
    verified: check.valid,
    ...(check.problems.length > 0 ? { problems: check.problems.map((problem) => problem.code) } : {}),
    disclosed: check.disclosed,
    sealed: check.sealed,
    steps: payload.steps.map((step) => ({
      id: step.id,
      kind: step.kind,
      network: step.network,
      protocol: step.protocol,
      status: step.status,
      anchors: anchorsOf(document.disclosures, step.id),
    })),
    inclusion: document.inclusion ? { batch: document.inclusion.batch.seq, anchoredOnBase: document.inclusion.anchor?.tx ?? null } : null,
  };
}

export const PREVIEW_INTENT_TOOL: KletiaTool = {
  name: "preview_intent",
  description:
    "Fare breakdown of a stored intent before anything is signed: what leaves the user's wallets, what arrives (expected and at least), payments to others, fees, approvals and what the wallets must hold, each number labelled simulated, quoted or venue minimum. Recomputed now (at most 6 times a minute per intent); never returns transactions.",
  inputSchema: {
    type: "object",
    properties: {
      intentId: { type: "string", pattern: INTENT_ID_PATTERN.source, description: "int_ followed by 32 hex characters." },
      refreshQuotes: { type: "boolean", description: "Re-quote ready steps first (rate limited; default false re-simulates cached quotes)." },
    },
    required: ["intentId"],
    additionalProperties: false,
  },
  annotations: annotations("Preview an intent's asset changes", true, false),
  async run(args) {
    const intentId = typeof args.intentId === "string" ? args.intentId : "";
    if (!INTENT_ID_PATTERN.test(intentId)) throw invalidRequest("intentId must be int_ followed by 32 hex characters.", [{ path: "intentId", message: "Invalid intent id." }]);
    return previewSummary(await recomputePreview(intentId, args.refreshQuotes === true));
  },
};

export const GET_RECEIPT_TOOL: KletiaTool = {
  name: "get_receipt",
  description:
    "Read a verifiable receipt of a finished intent: by `intentId` (the intent's owner) or by a receipt `shareUrl` (what its owner chose to share; never reveals the intent id). Receipts are issued after every on-chain reference is final, so a fresh intent answers `pending` with an expected time. `verified` is Kletia's own check; for a third party, re-verify on-chain with the CLI command returned.",
  inputSchema: {
    type: "object",
    properties: {
      intentId: { type: "string", pattern: INTENT_ID_PATTERN.source },
      shareUrl: { type: "string", maxLength: 400, description: "https://kletiaai.xyz/r/rcpt_…#s=rsh_…&k=…" },
      sequence: { type: "integer", minimum: 1, description: "An earlier receipt of the intent (intentId only)." },
    },
    additionalProperties: false,
  },
  annotations: annotations("Read a receipt", false),
  async run(args) {
    const intentId = typeof args.intentId === "string" ? args.intentId : undefined;
    const link = typeof args.shareUrl === "string" ? args.shareUrl : undefined;
    if ((intentId === undefined) === (link === undefined)) {
      throw invalidRequest("Provide exactly one of intentId or shareUrl.", [{ path: intentId ? "shareUrl" : "intentId", message: "Exactly one is required." }]);
    }
    if (link !== undefined) {
      const parsed = parseShareUrl(link);
      if (!parsed) throw invalidRequest("shareUrl must be a receipt share link: https://…/r/rcpt_…#s=rsh_…&k=….", [{ path: "shareUrl", message: "Not a share link." }]);
      const { document } = await readSharedReceipt(parsed.receiptId);
      const share = await readShareCiphertext(parsed.receiptId, parsed.shareId);
      const disclosures = decryptShare(parsed.receiptId, parsed.shareId, share.ciphertext, parsed.key);
      if (!disclosures) throw invalidRequest("The share link's key does not open this share.", [{ path: "shareUrl", message: "Wrong key." }]);
      return { state: "issued", receipt: await receiptSummary({ ...document, disclosures }, undefined), verifyCommand: REVERIFY_COMMAND };
    }
    const id = intentId as string;
    if (!INTENT_ID_PATTERN.test(id)) throw invalidRequest("intentId must be int_ followed by 32 hex characters.", [{ path: "intentId", message: "Invalid intent id." }]);
    const sequence = typeof args.sequence === "number" && Number.isSafeInteger(args.sequence) && args.sequence >= 1 ? args.sequence : undefined;
    try {
      const read = await readOwnerReceipt(id, sequence);
      if (read.state === "pending") return { state: "pending", pending: { reason: read.pending.reason, expectedBy: read.pending.expectedBy }, verifyCommand: REVERIFY_COMMAND };
      return {
        state: "issued",
        ...(read.pending ? { pending: { reason: read.pending.reason, expectedBy: read.pending.expectedBy } } : {}),
        receipt: await receiptSummary(read.document, id),
        verifyCommand: REVERIFY_COMMAND,
      };
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === "RECEIPT_NOT_READY") return { state: "not_ready", detail: (error as Error).message };
      throw error;
    }
  },
};

/** One line for get_intent: whether a receipt exists (no disclosures). */
export async function receiptLine(intentId: string): Promise<Record<string, unknown>> {
  try {
    const read = await readOwnerReceipt(intentId);
    if (read.state === "pending") return { state: "pending", expectedBy: read.pending.expectedBy };
    return { state: "issued", receiptId: read.receipt.id, sequence: read.receipt.sequence, ...(read.pending ? { newerPending: true } : {}) };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "RECEIPT_NOT_READY") return { state: "not_ready" };
    if (code === "RECEIPT_NOT_APPLICABLE") return { state: "not_applicable" };
    return { state: "unavailable" };
  }
}

