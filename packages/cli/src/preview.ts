/**
 * `kletia preview`: the asset-change preview ("fare breakdown") of an
 * intent as an aligned table: what each of your accounts gains and loses
 * (expected and worst case), what others receive, fees, approvals and needs,
 * with the certainty of every number. Unpriced values print as `n/p`.
 * Simulations only: nothing is prepared or signed.
 */
import type { IntentPreview, PreviewIssue } from "@kletia/core";
import { EXIT_OK, positional, signalOption, type Command } from "./common.js";
import { table } from "./output.js";

function shortAccount(account: string): string {
  const address = account.split(":").at(-1) ?? account;
  return address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

function usd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/p";
  const sign = value < 0 ? "-" : "";
  const magnitude = Math.abs(value);
  // A fee of a fraction of a cent is still a fee: never print it as $0.00.
  if (magnitude > 0 && magnitude < 0.005) return `${sign}<$0.01`;
  return `${sign}$${magnitude.toFixed(2)}`;
}

function signed(formatted: string): string {
  return /^[-+]/u.test(formatted) || formatted === "0" ? formatted : `+${formatted}`;
}

function issues(list: readonly PreviewIssue[]): string[] {
  return list.map((issue) => `${issue.severity === "block" ? "BLOCK" : "warn"}  ${issue.code}  ${issue.message}`);
}

/** The fare table, one string (no trailing newline). */
export function formatFare(preview: IntentPreview): string {
  const lines: string[] = [];
  lines.push(`Fare breakdown: stage ${preview.stage}, basis ${preview.basis}, computed ${preview.computedAt.replace("T", " ").replace(/\.\d+Z$/u, "Z")}`);
  lines.push(`digest ${preview.digest}`);
  lines.push("");
  if (preview.rows.length > 0) {
    lines.push(
      table(
        preview.rows.map((row) => [
          row.network,
          shortAccount(row.account),
          `${row.symbol}${row.listed ? "" : " (unlisted)"}`,
          signed(row.expected.formatted),
          signed(row.worst.formatted),
          usd(row.worst.usd),
          row.certainty,
          row.role,
        ]),
        ["network", "account", "asset", "expected", "worst", "worst usd", "certainty", "role"],
      ),
    );
  } else lines.push("No asset changes for your accounts.");
  if (preview.payments.length > 0) {
    lines.push("", "Paid to others:");
    lines.push(
      table(
        preview.payments.map((payment) => [
          payment.stepId,
          payment.network,
          payment.recipientName ? `${payment.recipientName} (${shortAccount(payment.recipient)})` : shortAccount(payment.recipient),
          payment.symbol,
          payment.expected.formatted,
          payment.worst.formatted,
          usd(payment.worst.usd),
          payment.certainty,
        ]),
        ["step", "network", "recipient", "asset", "expected", "at least", "usd", "certainty"],
      ),
    );
  }
  if (preview.fees.length > 0) {
    lines.push("", "Fees:");
    lines.push(
      table(
        preview.fees.map((fee) => [fee.stepId, fee.label, fee.formatted ? `${fee.formatted}${fee.asset ? ` ${fee.asset.symbol}` : ""}` : "-", usd(fee.usd), fee.paid, fee.certainty]),
        ["step", "fee", "amount", "usd", "paid", "certainty"],
      ),
    );
  }
  if (preview.approvals.length > 0) {
    lines.push("", "Approvals:");
    lines.push(
      table(
        preview.approvals.map((approval) => [approval.stepId, approval.network, `${approval.formatted} ${approval.token.symbol}`, approval.spenderLabel, shortAccount(approval.spender), approval.leftAfter === null ? "not simulated" : approval.leftAfter]),
        ["step", "network", "amount", "spender", "address", "left after"],
      ),
    );
  }
  const totals = preview.totals;
  lines.push("");
  lines.push(
    `You pay ${usd(totals.youPayUsd)}, get ${usd(totals.youGetUsd.expected)} (at least ${usd(totals.youGetUsd.worst)}); others get ${usd(totals.paidToOthersUsd.expected)} (at least ${usd(totals.paidToOthersUsd.worst)}).`,
  );
  lines.push(
    `Cost ${usd(totals.costUsd.expected)} (worst ${usd(totals.costUsd.worst)}): network ${usd(totals.networkFeesUsd)}, venue ${usd(totals.venueFeesUsd)}, extra ${usd(totals.extraCostsUsd)}, price difference ${usd(totals.priceDifferenceUsd)}.`,
  );
  if (totals.unpriced.length > 0) lines.push(`Unpriced (n/p): ${totals.unpriced.join(", ")}`);
  if (preview.arrival) lines.push(`Arrives on ${preview.arrival.network} in about ${preview.arrival.seconds}s.`);
  for (const need of preview.needs) {
    lines.push(`Needs ${need.formatted} ${need.asset.symbol} on ${need.network} (${need.reason})${need.have !== undefined ? `, has ${need.have}` : ""}.`);
  }
  for (const step of preview.steps) {
    for (const line of issues(step.issues)) lines.push(`${step.stepId}: ${line}`);
  }
  for (const warning of preview.warnings) lines.push(`warning: ${warning}`);
  return lines.join("\n");
}

const preview: Command = {
  name: "preview",
  summary: "Asset-change preview (fare breakdown) of a stored intent; simulations only, nothing is prepared or signed.",
  args: "<intent id>",
  options: {
    "refresh-quotes": { type: "boolean", description: "Re-quote ready steps first (once per 20 s per intent)." },
    last: { type: "boolean", description: "Show the last computed preview instead of computing a fresh one." },
  },
  positionals: { min: 1, max: 1 },
  run: async (context) => {
    const id = positional(context, 0);
    const client = context.client();
    const result =
      context.values.last === true
        ? await client.intents.getPreview(id, signalOption(context))
        : await client.intents.preview(id, { refreshQuotes: context.values["refresh-quotes"] === true, ...signalOption(context) });
    if (context.json) context.print.json(result);
    else context.print.out(formatFare(result));
    return EXIT_OK;
  },
};

export const PREVIEW_COMMANDS: readonly Command[] = Object.freeze([preview]);
