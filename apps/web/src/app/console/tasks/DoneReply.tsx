/**
 * Kletia's reply once a card settled: what landed, counted up, from the
 * API's own record of the run (each last step's `actualOutput`, else its expected output, said as
 * such), where it is, and the fees. Shown only after the API completed the intent.
 */
import { useEffect, useState } from "react";
import { totalFeesUsd, type IntentGraph, type IntentPreview } from "@kletia/core";

import { countUp } from "../../kit/motion";
import { playSound } from "../../kit/sound";
import { displayDecimal, formatUsd, networkName } from "../../site/intent/format";
import { leafSteps } from "./cardModel";
import { KletiaTurn, Say } from "./Conversation";

function Counted({ value, animate }: { readonly value: string; readonly animate: boolean }) {
  const target = Number(value);
  const decimals = value.includes(".") ? Math.min(6, value.split(".")[1]!.length) : 0;
  const [shown, setShown] = useState(animate && Number.isFinite(target) ? (0).toFixed(decimals) : value);
  useEffect(() => {
    if (!animate || !Number.isFinite(target)) return undefined;
    for (let index = 0; index < 6; index += 1) window.setTimeout(() => playSound("tick", 0.5), 250 + index * 140);
    return countUp(0, target, (next) => setShown(next >= target ? value : next.toFixed(decimals)), { duration: 1100 });
  }, [animate, decimals, target, value]);
  return <b className="k-num">{shown}</b>;
}

export function DoneReply({ intent, preview, animate }: { readonly intent: IntentGraph; readonly preview: IntentPreview | null; readonly animate: boolean }) {
  const leaves = leafSteps(intent.steps);
  const landed = leaves
    .map((step) => {
      const amount = step.actualOutput ?? step.expectedOutput;
      if (!amount) return null;
      const network = step.settlement?.kind === "cross-network" && step.settlement.destinationNetwork ? step.settlement.destinationNetwork : step.network;
      return { id: step.id, value: displayDecimal(amount.formatted), symbol: amount.symbol, network, actual: Boolean(step.actualOutput) };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  const fees = formatUsd(totalFeesUsd({ summary: intent.summary, preview: preview && preview.intentId === intent.id ? preview : null }));
  const networks = [...new Set(landed.map((entry) => entry.network))];
  const allActual = landed.length > 0 && landed.every((entry) => entry.actual);
  return (
    <KletiaTurn fresh={animate}>
      <Say>
        Done.{" "}
        {landed.length > 0 ? (
          <>
            {allActual ? "" : "Every step settled. The plan expected "}
            {landed.map((entry, index) => (
              <span key={entry.id}>
                {index > 0 ? " and " : ""}
                <Counted value={entry.value} animate={animate} /> {entry.symbol}
              </span>
            ))}
            {allActual ? ` ${landed.length === 1 ? "is" : "are"} in your wallet` : ""}
            {networks.length === 1 ? ` on ${networkName(networks[0]!)}` : ""}.{" "}
          </>
        ) : (
          "Every step settled. "
        )}
        {fees ? `Fees came to about ${fees}.` : ""}
      </Say>
      <Say muted>The receipt is below, and the card is in your binder.</Say>
    </KletiaTurn>
  );
}
