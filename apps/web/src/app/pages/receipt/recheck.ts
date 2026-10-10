/**
 * Rows of the recheck board: one per (anchor, public source). Before the
 * reader asks, the rows only list what would be read and from where; no RPC
 * request is made until they press the button. Pure (node --test loads it).
 */
import type { ReceiptDocument } from "@kletia/core";
import type { ReverifyReport } from "@kletia/sdk/receipts";

import { anchorNetwork, anchorRef, anchorWhere, networkLabel, type LegModel } from "./receiptModel.ts";

export type RecheckResult = "ready" | "checking" | "match" | "mismatch" | "unavailable" | "conflict";

export interface RecheckRow {
  readonly key: string;
  /** "01" */
  readonly leg: string;
  readonly network: string | null;
  readonly networkName: string;
  /** "52 379 872" (block or slot number). */
  readonly where: string;
  readonly whereKind: "Block" | "Slot";
  /** Host (and short path) of the public node. */
  readonly source: string;
  readonly result: RecheckResult;
  readonly detail?: string;
}

export const RESULT_FLAPS: Readonly<Record<RecheckResult, string>> = {
  ready: "READY",
  checking: "CHECKING",
  match: "MATCH",
  mismatch: "MISMATCH",
  unavailable: "NO DATA",
  conflict: "CONFLICT",
};

export const RESULT_SPEECH: Readonly<Record<RecheckResult, string>> = {
  ready: "not checked yet",
  checking: "checking",
  match: "matches the receipt",
  mismatch: "differs from the receipt",
  unavailable: "no data from this source",
  conflict: "sources disagree",
};

type SourceList = Readonly<Partial<Record<string, readonly string[]>>>;

/**
 * Public nodes that refuse requests made from a web page: they answer a CORS
 * preflight but return 403 "Access forbidden" to any request that carries an
 * Origin header (api.mainnet-beta.solana.com, observed 2026-10-10). Asked from
 * the reader's browser they can only ever say "no data", which would turn
 * every Solana leg into "not conclusive"; the CLI still asks them.
 */
export const BROWSER_REFUSED_RPCS: ReadonlySet<string> = new Set(["https://api.mainnet-beta.solana.com"]);

/**
 * The sources the receipt page asks: the SDK's defaults minus the ones that
 * refuse browsers. A network left with one source is checked by that source
 * alone, and the report says so (the SDK's single-source rule).
 */
export function browserSources(defaults: SourceList): Record<string, readonly string[]> {
  const out: Record<string, readonly string[]> = {};
  for (const [network, urls] of Object.entries(defaults)) {
    if (!urls) continue;
    const usable = urls.filter((url) => !BROWSER_REFUSED_RPCS.has(url));
    out[network] = usable.length > 0 ? usable : urls;
  }
  return out;
}

function legNo(legs: readonly Pick<LegModel, "id" | "index">[], stepId: string): string {
  const index = legs.find((leg) => leg.id === stepId)?.index ?? 0;
  return String(index + 1).padStart(2, "0");
}

/** What a recheck would read: every disclosed anchor on every configured source (display form). */
export function plannedRows(
  document: ReceiptDocument,
  legs: readonly Pick<LegModel, "id" | "index">[],
  sources: SourceList,
  display: (url: string) => string,
  result: "ready" | "checking" = "ready",
): RecheckRow[] {
  const rows: RecheckRow[] = [];
  for (const step of [...document.payload.steps].sort((a, b) => a.index - b.index)) {
    const evidence = document.disclosures?.[`steps.${step.id}.evidence`]?.value as { anchors?: unknown } | undefined;
    const anchors = Array.isArray(evidence?.anchors) ? (evidence.anchors as Parameters<typeof anchorRef>[0][]) : [];
    for (const anchor of anchors) {
      const network = anchorNetwork(anchor);
      const where = anchorWhere(anchor);
      for (const url of (network ? sources[network] : undefined) ?? []) {
        const source = display(url);
        rows.push({
          key: `${step.id}:${anchorRef(anchor)}:${source}`,
          leg: legNo(legs, step.id),
          network,
          networkName: network ? networkLabel(network) : anchor.chain,
          where: where.replace(/^(Block|Slot) /u, ""),
          whereKind: anchor.vm === "evm" ? "Block" : "Slot",
          source,
          result,
        });
      }
    }
  }
  return rows;
}

/** The finished report as rows, in the same order as `plannedRows`. */
export function reportRows(document: ReceiptDocument, legs: readonly Pick<LegModel, "id" | "index">[], report: ReverifyReport): RecheckRow[] {
  const rows: RecheckRow[] = [];
  for (const step of [...document.payload.steps].sort((a, b) => a.index - b.index)) {
    const evidence = document.disclosures?.[`steps.${step.id}.evidence`]?.value as { anchors?: unknown } | undefined;
    const anchors = Array.isArray(evidence?.anchors) ? (evidence.anchors as Parameters<typeof anchorRef>[0][]) : [];
    for (const anchor of anchors) {
      const ref = anchorRef(anchor);
      const check = report.anchors.find((candidate) => candidate.step === step.id && candidate.ref === ref);
      const network = anchorNetwork(anchor);
      for (const source of check?.sources ?? []) {
        const result: RecheckResult = check?.result === "conflict" && source.result !== "unavailable" ? "conflict" : source.result;
        rows.push({
          key: `${step.id}:${ref}:${source.url}`,
          leg: legNo(legs, step.id),
          network,
          networkName: network ? networkLabel(network) : anchor.chain,
          where: anchorWhere(anchor).replace(/^(Block|Slot) /u, ""),
          whereKind: anchor.vm === "evm" ? "Block" : "Slot",
          source: source.url,
          result,
          ...(source.detail ? { detail: source.detail } : {}),
        });
      }
    }
  }
  return rows;
}

export interface RecheckSummary {
  readonly verdict: ReverifyReport["verdict"];
  readonly headline: string;
  readonly lines: readonly string[];
  /** Distinct sources that matched at least one anchor. */
  readonly agreeingSources: number;
}

/** Plain sentences for the verdict, bindings, the log anchor and the notes. */
export function summarize(report: ReverifyReport, legs: readonly Pick<LegModel, "id" | "index">[]): RecheckSummary {
  const lines: string[] = [];
  for (const binding of report.bindings) {
    const leg = `Leg ${legNo(legs, binding.step)}`;
    if (binding.result === "match") lines.push(`${leg}: the transaction that landed is byte for byte what Kletia prepared.`);
    else if (binding.result === "mismatch") lines.push(`${leg}: the transaction that landed is not one Kletia prepared.`);
    else if (binding.result === "unavailable") lines.push(`${leg}: the prepared payload could not be compared (${binding.detail ?? "no source"}).`);
  }
  if (report.anchoring) {
    lines.push(
      report.anchoring.result === "anchored"
        ? "The receipt's log batch is timestamped on Base."
        : report.anchoring.result === "not_anchored"
          ? "The receipt's log batch is not anchored on Base yet (anchoring is optional)."
          : "Base could not be asked whether the log batch is anchored.",
    );
  }
  if (report.singleSource) lines.push("Only one public node answered for at least one network. Add your own RPC with the CLI for an independent check.");
  if (report.sealedSteps.length > 0) lines.push("Some transactions are sealed by the owner, so they could not be re-checked.");
  if (report.anchors.some((anchor) => anchor.result === "unavailable")) {
    lines.push("No data from this source. Public nodes forget old transactions; try another source.");
  }
  const agreeing = new Set(report.anchors.flatMap((anchor) => anchor.sources.filter((source) => source.result === "match").map((source) => source.url)));
  const headline =
    report.verdict === "verified"
      ? "Every transaction matches the receipt on public nodes."
      : report.verdict === "mismatch"
        ? report.offline.valid
          ? "A public node returned data that differs from the receipt."
          : "The receipt does not verify, so nothing on-chain was trusted."
        : "Not conclusive: some data was not available from public nodes.";
  return { verdict: report.verdict, headline, lines, agreeingSources: agreeing.size };
}
