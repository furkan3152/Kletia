import "../../site/art/base.css";
import "./network.css";

import { LINES, TRANSFERS, type LineId, type TransferStation } from "./networkData";

const ORDER: readonly LineId[] = ["kletia", "elyia", "lykia"];

/**
 * Transfer stations: where the lines meet. One concept per station, its name
 * on each line side by side, joined by transfer arrows. A real table, so a
 * screen reader reads "Rules before signing, Kletia: Rule Book, ...".
 * `only` keeps the Kletia column and one line (the line pages).
 */
export function TransferStations({ only }: { readonly only?: Exclude<LineId, "kletia"> }) {
  const columns = only ? (["kletia", only] as const) : ORDER;
  return (
    <div className="kts" data-cols={columns.length}>
      <table className="kts-table">
        <caption className="kla-sr">Shared concepts across the Kletia network</caption>
        <thead>
          <tr>
            <th scope="col">Transfer station</th>
            {columns.map((id) => (
              <th scope="col" key={id}>
                <span className="kts-bullet" style={{ background: LINES[id].color, color: LINES[id].on }} aria-hidden="true">
                  {LINES[id].code}
                </span>
                {LINES[id].name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {TRANSFERS.map((station: TransferStation) => (
            <tr key={station.id}>
              <th scope="row">
                <span className="kts-concept">{station.concept}</span>
                <span className="kts-note">{station.note}</span>
              </th>
              {columns.map((id, index) => (
                <td key={id} data-line={id} data-label={LINES[id].name}>
                  {index > 0 ? (
                    <span className="kts-swap" aria-hidden="true">
                      ⇄
                    </span>
                  ) : null}
                  <span className="kts-name" style={{ ["--kts-line" as string]: LINES[id].color }}>
                    {station[id]}
                  </span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
