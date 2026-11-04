import "../../site/art/base.css";
import "./network.css";

import { LYKIA_API, lykiaFigures, type LykiaLive } from "./networkData";

/** Lykia's live figures as an LCD strip, with the source named. */
export function LiveFigures({ live }: { readonly live: LykiaLive }) {
  const figures = lykiaFigures(live);
  const host = new URL(LYKIA_API).host;
  return (
    <section aria-label="Lykia live figures">
      <p className="knl-head">
        <span className="knl-pill" data-state={live.state}>
          <i aria-hidden="true" />
          {live.state === "live" ? "Live" : live.state === "loading" ? "Checking" : "No signal"}
        </span>
        <span>
          Coast Line · from <code className="knet-small" style={{ margin: 0 }}>{host}</code>
        </span>
      </p>
      <dl className="knl" aria-busy={live.state === "loading" || undefined}>
        {figures.map((figure) => (
          <div key={figure.label}>
            <dt title={figure.spoken}>{figure.label}</dt>
            <dd>
              {figure.value}
              {figure.value === "—" ? <span className="kla-sr"> no reading</span> : null}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
