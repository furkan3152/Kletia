/**
 * "Why this route": the chosen shape and venues of
 * each leg, what they were compared with (or why excluded), estimates
 * marked, the quoted vs guaranteed minimum, re-plan alternatives, and the
 * providers that saw the person's address.
 */
import type { IntentConstraints, IntentGraph } from "@kletia/core";

import { providersLine, READING_COPY, readAsChips, routeRows } from "./modelReading";
import type { ClarifyAssumption } from "@kletia/core";

export interface RoutePanelProps {
  readonly intent: IntentGraph;
  readonly assumptions?: readonly ClarifyAssumption[];
  /** Re-plans with an alternative's constraints; absent when the plan cannot change now. */
  readonly onAlternative?: (constraints: Partial<IntentConstraints>) => void;
}

export function RoutePanel({ intent, assumptions = [], onAlternative }: RoutePanelProps) {
  const legs = routeRows(intent);
  const providers = providersLine(intent);
  const chips = readAsChips(assumptions);
  if (legs.length === 0 && !providers && chips.length === 0 && !intent.interpretation.modelReading) return null;
  return (
    <details className="kd-memory">
      <summary>{READING_COPY.routeTitle}</summary>
      {intent.interpretation.modelReading ? <p className="mt-2 text-fg-muted">{READING_COPY.confirmNote}</p> : null}
      {chips.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-2" aria-label="Read as">
          {chips.map((chip) => (
            <li key={chip.label} className={`rounded border px-2 py-0.5 ${chip.material ? "font-bold" : "text-fg-muted"}`}>
              {chip.label}
            </li>
          ))}
        </ul>
      ) : null}
      {legs.map((leg, index) => (
        <div key={index} className="mt-2 flex flex-col gap-1">
          <p>{leg.reason}</p>
          <table className="w-full text-left">
            <tbody>
              {leg.rows.map((row) => (
                <tr key={row.label} className={row.chosen ? "font-bold" : ""}>
                  <td className="pr-2 align-top">{row.label}</td>
                  <td className="text-fg-muted">{row.excluded ?? row.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {onAlternative && leg.alternatives.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {leg.alternatives.map((alternative) => (
                <button key={alternative.id} type="button" className="underline underline-offset-2" title={alternative.detail} onClick={() => onAlternative(alternative.constraints)}>
                  {alternative.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ))}
      {providers ? (
        <p className="mt-2">
          <span className="font-bold">{READING_COPY.providersTitle}: </span>
          {providers}
        </p>
      ) : null}
    </details>
  );
}
