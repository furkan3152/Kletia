/**
 * Output helpers shared by the commands: amounts, USD, durations, intents,
 * journeys and confirmation prompts.
 */
import {
  CONSEQUENCE_SEVERITIES,
  sameAddressAccount,
  type IntentGraph,
  type Journey,
} from "@kletia/core";
import { CONFIRM_OPTION } from "../common.js";
import { amount, table, when, type Printer } from "../output.js";

export function formatAmount(value: { readonly formatted: string; readonly symbol: string } | undefined): string {
  return value ? `${amount(value.formatted)} ${value.symbol}` : "-";
}

export function usd(value: number | undefined): string {
  return value === undefined ? "-" : `$${value.toFixed(2)}`;
}

export function seconds(value: number | undefined): string {
  if (value === undefined) return "-";
  return value >= 90 ? `${Math.round(value / 60)}m` : `${Math.max(1, Math.round(value))}s`;
}

/**
 * Steps whose recipient is not one of the planning accounts (funds leave the
 * user's control). The user's own address on another network of the same VM
 * (a bridge's default recipient) is theirs, as in the planner.
 */
function externalRecipients(intent: IntentGraph): string[] {
  const own = intent.request.accounts;
  return intent.steps
    .filter((step) => step.recipient && !own.some((account) => sameAddressAccount(account, step.recipient as string)))
    .map((step) => `${step.id}: ${step.recipientName ? `${step.recipientName} → ` : ""}${step.recipient}`);
}

export function printIntent(print: Printer, intent: IntentGraph): void {
  print.out(`${intent.summary.title}`);
  print.out(
    `id ${intent.id}  status ${intent.status}  signatures ${intent.summary.signaturesRequired}  fees ≈ ${usd(intent.summary.totalFeesUsd)}  eta ≈ ${seconds(intent.summary.estimatedSeconds)}`,
  );
  print.out("");
  print.out(
    table(
      intent.steps.map((step) => [
        step.id,
        step.status,
        step.settlement?.destinationNetwork ? `${step.network}→${step.settlement.destinationNetwork}` : step.network,
        step.protocol,
        formatAmount(step.input),
        step.expectedOutput ? `${formatAmount(step.expectedOutput)}${step.minimumOutput ? ` (min ${amount(step.minimumOutput.formatted)})` : ""}` : "-",
      ]),
      ["step", "status", "network", "venue", "in", "out"],
    ),
  );
  // Why this route: Kletia's reason per leg, the quoted vs guaranteed minimum, and a model reading if any.
  const routes = intent.interpretation?.routes ?? [];
  if (routes.length > 0) {
    print.out("");
    for (const route of routes) {
      const kind = route.score.minimumKind === "onchain" ? "guaranteed minimum" : "quoted minimum";
      print.out(`route ${route.shape}${route.carrier ? ` via ${route.carrier}` : ""}: ${route.reason} (${kind} ${usd(route.score.minimumUsd)}${route.score.estimate ? ", estimate" : ""})`);
    }
  }
  if (intent.interpretation?.modelReading) print.out("read with model assistance and confirmed by the person");
  const external = externalRecipients(intent);
  if (external.length > 0) {
    print.out("");
    print.out("Sends to accounts that are not yours:");
    for (const line of external) print.out(`  ${line}`);
  }
  for (const warning of [...intent.warnings, ...intent.steps.flatMap((step) => step.warnings ?? [])]) print.out(`warning: ${warning}`);
  for (const step of intent.steps) if (step.failure) print.out(`${step.id} failed: ${step.failure.code} ${step.failure.message}`);
}

/* -------------------------------------------------------------- journey */

const SEVERITY_LABEL: Readonly<Record<string, string>> = { block: "BLOCK", act: "ACT", warn: "WARN", info: "info" };

function usdOf(value: number | null | undefined): string {
  return value === null || value === undefined ? "-" : `$${value.toFixed(2)}`;
}

/**
 * The journey as aligned text: stops (network, holder, custody, amounts and
 * at-least, USD with its source), legs (venue, ETA), then the consequences
 * by severity with their option labels.
 */
export function formatJourney(journey: Journey): string {
  const lines: string[] = [];
  lines.push(`Journey of ${journey.intentId} (${journey.stage}, reads ${journey.basis.reads}, ${when(journey.computedAt)})`);
  lines.push("");
  const stopRows = journey.stops.flatMap((stop) => {
    const holdings = stop.holdings.length > 0 ? stop.holdings : [null];
    return holdings.map((holding, index) => [
      index === 0 ? String(stop.index) : "",
      index === 0 ? stop.network : "",
      index === 0 ? stop.holder.label : "",
      index === 0 ? stop.custody : "",
      index === 0 ? stop.state : "",
      holding ? `${amount(holding.expected.formatted)} ${holding.asset.symbol}` : "-",
      holding ? `${amount(holding.atLeast.formatted)} ${holding.asset.symbol}` : "-",
      holding ? `${usdOf(holding.value.expectedUsd)} (${holding.value.source})` : "-",
      holding ? holding.certainty : "",
      index === 0 && stop.eta ? `+${seconds(stop.eta.afterFirstSignatureSeconds)}` : "",
    ]);
  });
  lines.push(table(stopRows, ["#", "network", "holder", "custody", "state", "holds", "at least", "value", "certainty", "eta"]));
  if (journey.legs.length > 0) {
    lines.push("");
    lines.push(
      table(
        journey.legs.map((leg) => [
          leg.id,
          leg.kind,
          leg.destinationNetwork !== leg.network ? `${leg.network}→${leg.destinationNetwork}` : leg.network,
          leg.venue.name,
          leg.seconds === null ? "-" : seconds(leg.seconds),
          String(leg.signatures),
          leg.status,
          leg.title,
        ]),
        ["leg", "kind", "network", "venue", "eta", "sigs", "status", "what"],
      ),
    );
  }
  const ordered = [...journey.consequences].sort(
    (a, b) => CONSEQUENCE_SEVERITIES.indexOf(a.severity) - CONSEQUENCE_SEVERITIES.indexOf(b.severity),
  );
  if (ordered.length > 0) lines.push("");
  for (const consequence of ordered) {
    lines.push(`${(SEVERITY_LABEL[consequence.severity] ?? consequence.severity).padEnd(5)}  ${consequence.title}`);
    if (consequence.detail) lines.push(`       ${consequence.detail}`);
    if (consequence.prompt) lines.push(`       ${consequence.prompt.question}`);
    for (const option of consequence.options) {
      lines.push(`       - ${option.label}${option.recommended ? " (recommended)" : ""}  [${consequence.id}=${option.id}]`);
    }
  }
  lines.push("");
  lines.push(`Now: ${journey.now.waitingFor === "nothing" ? "nothing to wait for" : `waiting for ${journey.now.waitingFor}`}${journey.now.stopIds.length > 0 ? ` at ${journey.now.stopIds.join(", ")}` : ""}`);
  if (journey.blockers.length > 0) lines.push(`Answer before the next signature: ${journey.blockers.join(", ")}`);
  return lines.join("\n");
}

export const confirm = CONFIRM_OPTION;
