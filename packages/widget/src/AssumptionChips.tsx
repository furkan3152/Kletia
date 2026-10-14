import { useId, useState } from "react";
import { CHAINS, type ClarifyAssumption } from "@kletia/core";
import { assumptionViews } from "./review.js";

export interface AssumptionChipsProps {
  /** The turn's assumptions; shown material first, at most three. */
  readonly assumptions: readonly ClarifyAssumption[];
  /** The user picked another value for an assumption: re-plan with it (clarify `assumption` turn). */
  readonly onChange: (id: string, optionId: string) => void;
  /** Disables the alternatives (e.g. while a re-plan is in flight). */
  readonly disabled?: boolean;
}

/**
 * "Kletia assumed" chips: every default Kletia picked is visible and
 * editable. Material chips (where money goes, how much moves) are listed
 * first and marked by a heavier border and the word "Material". A chip
 * with alternatives opens them inline; picking one re-plans.
 */
export function AssumptionChips(props: AssumptionChipsProps) {
  const { assumptions, onChange, disabled = false } = props;
  const views = assumptionViews(assumptions);
  const [open, setOpen] = useState<string | null>(null);
  const baseId = useId();
  if (views.length === 0) return null;
  return (
    <div className="kw-assume" role="group" aria-labelledby={`${baseId}-k`}>
      <p className="kw-assume-k" id={`${baseId}-k`}>
        Kletia assumed
      </p>
      <ul className="kw-assume-list">
        {views.map((view, position) => {
          const panelId = `${baseId}-${position}`;
          const expanded = open === view.id;
          return (
            <li key={view.id} className="kw-assume-chip" data-material={view.material ? "true" : undefined}>
              {view.alternatives.length > 0 ? (
                <button
                  type="button"
                  className="kw-assume-btn"
                  aria-expanded={expanded}
                  aria-controls={panelId}
                  disabled={disabled}
                  onClick={() => setOpen(expanded ? null : view.id)}
                >
                  {view.material ? <span className="kw-assume-tag">Material</span> : null}
                  {view.label}
                  <span aria-hidden="true"> ▾</span>
                </button>
              ) : (
                <span className="kw-assume-btn" data-static="true">
                  {view.material ? <span className="kw-assume-tag">Material</span> : null}
                  {view.label}
                </span>
              )}
              {view.reason ? <span className="kw-assume-why">{view.reason}</span> : null}
              {expanded ? (
                <ul className="kw-assume-alts" id={panelId} aria-label={`Instead of ${view.label}`}>
                  {view.alternatives.map((alternative) => {
                    const chain = alternative.network ? CHAINS[alternative.network] : null;
                    return (
                      <li key={alternative.id}>
                        <button
                          type="button"
                          className="kw-opt"
                          disabled={disabled}
                          onClick={() => {
                            setOpen(null);
                            onChange(view.id, alternative.id);
                          }}
                        >
                          <span className="kw-opt-body">
                            <span className="kw-opt-label">
                              {chain ? <span className="kw-dot" style={{ background: chain.color }} aria-hidden="true" /> : null}
                              {alternative.label}
                            </span>
                            {alternative.detail ? <span className="kw-opt-detail">{alternative.detail}</span> : null}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default AssumptionChips;
