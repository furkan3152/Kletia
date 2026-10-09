/**
 * Pure helpers that turn a planned IntentGraph into ticket text (serial and
 * one line per leg). Amounts are printed exactly as the API returned them.
 */
import type { IntentGraph, IntentStep } from "@kletia/core";

import type { TicketLeg } from "../../site/art";
import { formatAmount, humanize, networkName, protocolName, shortAccount } from "../../site/intent/format";

/** "int_7f3ac21e…" -> "7F3A-C21E": the last eight letters and digits of the intent id. */
export function ticketSerial(id: string): string {
  const chars = id.replace(/[^a-z0-9]/giu, "").toUpperCase().slice(-8).padStart(8, "0");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function legDetail(step: IntentStep): string {
  const input = formatAmount(step.input);
  const output = formatAmount(step.expectedOutput);
  const destination = step.settlement?.destinationNetwork;
  const route = destination && destination !== step.network ? `, ${networkName(step.network)} → ${networkName(destination)}` : "";
  // A third-party recipient is named the way the API resolved it (ENS, Basenames, SNS), with the address.
  const to =
    step.recipient && step.recipient !== step.account
      ? ` to ${step.recipientName ? `${step.recipientName} (${shortAccount(step.recipient)})` : shortAccount(step.recipient)}`
      : "";
  if (input && output && input !== output) return `${input} → ${output}${route}${to}`;
  if (input) return `${input}${route}${to}`;
  return step.title;
}

export function planLegs(intent: IntentGraph): TicketLeg[] {
  return [...intent.steps]
    .sort((a, b) => a.index - b.index)
    .map((step) => ({
      verb: capitalize(humanize(step.kind)),
      detail: legDetail(step),
      via: protocolName(step.protocol),
      done: step.status === "settled",
    }));
}

