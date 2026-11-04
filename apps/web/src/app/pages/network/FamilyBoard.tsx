import "../../site/art/base.css";
import "../../site/art/board.css";
import "./network.css";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { padFlaps, riffleFrame } from "../../site/art/boardFormat";
import { useInView } from "../../site/motion/useInView";
import { useReducedMotion } from "../../site/motion/useReducedMotion";
import { FLAP_INFO_WIDTH, FLAP_LINE_WIDTH, FLAP_STATUS_WIDTH, type BoardTone, type FamilyBoardRow } from "./networkData";

/*
 * The family's departure board: the same split-flap fixture as /networks,
 * listing the lines that leave the Interchange. Tiles riffle in when the
 * board first scrolls into view and turn again only when a value changes
 * (the live Lykia reading). Every row is also read aloud once as text.
 */

interface FlapState {
  readonly text: string;
  readonly turning: readonly boolean[] | null;
}

function useFlaps(target: string, enabled: boolean, run: boolean): FlapState {
  const [state, setState] = useState<FlapState>(() => ({ text: enabled ? " ".repeat(target.length) : target, turning: null }));
  const shown = useRef(state.text);
  useEffect(() => {
    if (!enabled || !run) return undefined;
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
  }, [target, enabled, run]);
  return enabled ? state : { text: target, turning: null };
}

function Flaps({ text, width, enabled, run, tone, className }: { readonly text: string; readonly width: number; readonly enabled: boolean; readonly run: boolean; readonly tone?: BoardTone; readonly className?: string }) {
  const shown = useFlaps(padFlaps(text, width), enabled, run);
  return (
    <span className={className ? `kla-flaps ${className}` : "kla-flaps"} aria-hidden="true" data-tone={tone}>
      {Array.from(shown.text, (char, index) => (
        <span key={index} className="kla-flap" data-turning={shown.turning?.[index] || undefined}>
          {char === " " ? " " : char}
        </span>
      ))}
    </span>
  );
}

export interface FamilyBoardProps {
  readonly rows: readonly FamilyBoardRow[];
  readonly clock: string;
  readonly note?: ReactNode;
  readonly busy?: boolean;
}

export function FamilyBoard({ rows, clock, note, busy = false }: FamilyBoardProps) {
  const reduced = useReducedMotion();
  const [ref, inView] = useInView<HTMLDivElement>({ once: true, threshold: 0.2 });
  const enabled = !reduced;
  return (
    <div ref={ref} className="kla-board knb">
      <div className="kla-board__head">
        <p className="kla-board__title">
          Departures
          <span className="kla-board__sub">The network · from the Interchange</span>
        </p>
        <p className="kla-board__clock">
          <span className="kla-sr">Last checked </span>
          {clock}
        </p>
      </div>
      <table className="kla-board__table" aria-busy={busy || undefined}>
        <caption className="kla-sr">Lines of the Kletia network and their status</caption>
        <thead>
          <tr>
            <th scope="col">Line</th>
            <th scope="col">Destination</th>
            <th scope="col" className="knb-nets">
              Networks
            </th>
            <th scope="col" className="knb-info">
              Reading
            </th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.line.id} className="kla-board__row" data-line={row.line.id}>
              <td className="kla-board__line">
                <span className="kla-bullet kla-bullet--lg knb-bullet" style={{ backgroundColor: row.line.color, color: row.line.on }} aria-hidden="true">
                  {row.line.code}
                </span>
              </td>
              <th scope="row" className="knb-dest">
                <span className="kla-sr">{row.spoken}</span>
                <span className="knb-dest-text" aria-hidden="true">
                  <b>{row.line.name}</b> {row.line.line}
                  <small>{row.flapInfo}</small>
                </span>
                <Flaps text={row.flapLine} width={FLAP_LINE_WIDTH} enabled={enabled} run={inView} className="knb-dest-flaps" />
              </th>
              <td className="knb-nets" aria-hidden="true">
                {row.line.id === "kletia" ? "EVM + Solana" : row.line.networks.join(" · ")}
              </td>
              <td className="knb-info" aria-hidden="true">
                <Flaps text={row.flapInfo} width={FLAP_INFO_WIDTH} enabled={enabled} run={inView} />
              </td>
              <td aria-hidden="true">
                <span className="kla-board__status">
                  <span className="kla-board__lamp knb-lamp" data-status={row.tone} />
                  <Flaps text={row.flapStatus} width={FLAP_STATUS_WIDTH} enabled={enabled} run={inView} tone={row.tone} />
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {note ? <p className="kla-board__note">{note}</p> : null}
    </div>
  );
}
