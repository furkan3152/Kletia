import "../../site/art/base.css";
import "../../site/art/board.css";
import "./receipt.css";

import { useEffect, useRef, useState } from "react";

import { padFlaps, riffleFrame } from "../../site/art/boardFormat";
import { LineBullet } from "../../site/art/LineBullet";
import { lineFor } from "../../site/art/tokens";
import { useReducedMotion } from "../../site/motion/useReducedMotion";
import { cx } from "../../site/ui/styles";
import { RESULT_FLAPS, RESULT_SPEECH, type RecheckRow } from "./recheck";

/*
 * The recheck as a departure board: one row per transaction and public
 * node, the verdict on split-flap tiles. It is a real table (the tiles are
 * hidden from assistive tech and every value is printed once as text). The
 * flaps only turn after the reader pressed "Re-check on-chain": the board
 * never asks a node anything on its own.
 */

const RESULT_WIDTH = 8;

function useFlaps(target: string, enabled: boolean): { text: string; turning: readonly boolean[] | null } {
  const [state, setState] = useState<{ text: string; turning: readonly boolean[] | null }>({ text: target, turning: null });
  const shown = useRef(target);
  useEffect(() => {
    if (!enabled) {
      shown.current = target;
      return undefined;
    }
    const from = padFlaps(shown.current, target.length);
    if (from === target) return undefined;
    let raf = 0;
    const start = performance.now();
    const step = (now: number) => {
      const frame = riffleFrame(from, target, now - start);
      shown.current = frame.text;
      setState({ text: frame.text, turning: frame.done ? null : frame.turning });
      if (!frame.done) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, enabled]);
  return enabled ? state : { text: target, turning: null };
}

function ResultFlaps({ row, animate }: { readonly row: RecheckRow; readonly animate: boolean }) {
  const target = padFlaps(RESULT_FLAPS[row.result], RESULT_WIDTH);
  const shown = useFlaps(target, animate);
  const tone = row.result === "match" ? "running" : row.result === "unavailable" || row.result === "checking" ? "delayed" : row.result === "ready" ? "unknown" : "suspended";
  return (
    <span className="kla-board__status">
      <span className="kla-board__lamp" data-status={row.result === "match" ? "running" : row.result === "ready" ? undefined : tone} aria-hidden="true" />
      <span className="kla-flaps" aria-hidden="true" data-tone={tone}>
        {Array.from(shown.text, (char, index) => (
          <span key={index} className="kla-flap" data-turning={shown.turning?.[index] || undefined}>
            {char === " " ? " " : char}
          </span>
        ))}
      </span>
      <span className="kla-sr">{RESULT_SPEECH[row.result]}</span>
    </span>
  );
}

export interface RecheckBoardProps {
  readonly rows: readonly RecheckRow[];
  /** "10:42 UTC" of the last run, or a dash. */
  readonly clock: string;
  readonly busy: boolean;
  /** Flaps turn only after the reader started a recheck. */
  readonly started: boolean;
  readonly className?: string;
}

export function RecheckBoard({ rows, clock, busy, started, className }: RecheckBoardProps) {
  const reduced = useReducedMotion();
  return (
    <div className={cx("kla-board kl-recheck", className)}>
      <div className="kla-board__head">
        <p className="kla-board__title">
          Recheck
          <span className="kla-board__sub">Public nodes, read from your browser</span>
        </p>
        <p className="kla-board__clock">
          <span className="kla-sr">Last run </span>
          {clock}
        </p>
      </div>
      <div className="kl-recheck__scroll">
        <table className="kla-board__table" aria-busy={busy || undefined}>
          <caption className="kla-sr">Each transaction of the receipt, read again from public nodes</caption>
          <thead>
            <tr>
              <th scope="col">Leg</th>
              <th scope="col">Network</th>
              <th scope="col" className="kl-recheck__where">
                Block / slot
              </th>
              <th scope="col">Source</th>
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const line = row.network ? lineFor(row.network) : null;
              return (
                <tr key={row.key} className="kla-board__row">
                  <td className="kl-recheck__leg">
                    <span className="kl-recheck__legno">{row.leg}</span>
                  </td>
                  <th scope="row" className="kl-recheck__net">
                    {line ? <LineBullet line={line} decorative /> : null}
                    <span>{row.networkName}</span>
                  </th>
                  <td className="kl-recheck__where">
                    <span className="kla-sr">{row.whereKind} </span>
                    {row.where}
                  </td>
                  <td className="kl-recheck__source" title={row.detail}>
                    {row.source}
                  </td>
                  <td>
                    <ResultFlaps row={row} animate={started && !reduced} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
