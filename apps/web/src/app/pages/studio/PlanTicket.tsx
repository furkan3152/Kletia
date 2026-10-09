import type { IntentGraph } from "@kletia/core";

import { lineFor } from "../../site/art";
import { Ticket } from "../../site/art/Ticket";
import { planLegs, ticketSerial } from "./planTicketFormat";

/**
 * The dry-run plan as a printed ticket, above the graph: the sentence, where
 * the money starts and ends, one line per leg and a PLANNED stamp (nothing is
 * signed in Studio's preview). Amounts are printed as the API returned them.
 */
export function PlanTicket({ intent }: { readonly intent: IntentGraph }) {
  const steps = [...intent.steps].sort((a, b) => a.index - b.index);
  const first = steps[0];
  const last = steps[steps.length - 1];
  if (!first || !last) return null;
  const from = lineFor(first.network);
  const to = lineFor(last.settlement?.destinationNetwork ?? last.network);
  // A network this bundle does not know yet: the graph below still shows the plan.
  if (!from || !to) return null;
  const signatures = intent.summary.signaturesRequired;
  const text = intent.request.text?.trim() || intent.interpretation.normalizedText || intent.summary.title;
  return (
    <Ticket
      serial={ticketSerial(intent.id)}
      intent={text}
      from={from}
      to={to}
      legs={planLegs(intent)}
      state="planned"
      ticketClass="Dry run"
      fields={[
        { label: "Class", value: "Dry run" },
        { label: "Signatures", value: `${signatures} in your wallet` },
        { label: "Settles when", value: "Seen on-chain" },
      ]}
      animateStamp
    />
  );
}
