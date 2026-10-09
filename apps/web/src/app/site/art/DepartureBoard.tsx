import "./base.css";
import "./board.css";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { useInView } from "../motion/useInView";
import { useReducedMotion } from "../motion/useReducedMotion";
import { cx } from "../ui/styles";
import {
  boardName,
  describeLatency,
  formatLatency,
  LATENCY_WIDTH,
  NAME_WIDTH,
  padFlaps,
  riffleFrame,
  STATUS_FLAPS,
  STATUS_SPEECH,
  STATUS_WIDTH,
  type BoardStatus,
} from "./boardFormat";
import { LineBullet } from "./LineBullet";
import type { Line } from "./tokens";

/*
 * Split-flap departure board for network status. It is a real table: every
 * value is printed on flap tiles (hidden from assistive tech) and repeated
 * once as text, so a row reads "Base, eip155:8453, 96 milliseconds, running".
 * The tiles riffle into place when the board first scrolls into view, and a
 * tile turns again only when its character changes. Reduced motion (or
 * animate={false}) prints the values at once. Under 520 px of width the RPC
 * column is dropped and names are printed instead of flapped; under 860 px
 * the chain column is dropped.
 */

export interface BoardRow {
  readonly line: Line;
  /** RPC round trip in ms, or null when there is no reading. */
  readonly latencyMs: number | null;
  readonly status: BoardStatus;
}

export interface DepartureBoardProps {
  readonly rows: readonly BoardRow[];
  /** Pre-formatted time of the last check, e.g. "10:42 UTC" (see formatBoardClock). */
  readonly clock: string;
  /** Small print under the board: where the timings come from. */
  readonly note?: ReactNode;
  readonly title?: string;
  readonly subtitle?: string;
  /** Table caption for assistive tech. */
  readonly caption?: string;
  /** Riffle the tiles (ignored with reduced motion). Default true. */
  readonly animate?: boolean;
  /** Marks the table busy while a check is running. */
  readonly busy?: boolean;
  readonly className?: string;
}

interface FlapState {
  readonly text: string;
  readonly turning: readonly boolean[] | null;
}

/**
 * The characters a row of tiles shows. Starts blank when it will riffle,
 * turns once `run` is true, and turns again whenever `target` changes.
 */
function useFlapText(target: string, enabled: boolean, run: boolean): FlapState {
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

function Flaps({
  text,
  width,
  enabled,
  run,
  tone,
  className,
}: {
  readonly text: string;
  readonly width: number;
  readonly enabled: boolean;
  readonly run: boolean;
  readonly tone?: BoardStatus;
  readonly className?: string;
}) {
  const target = padFlaps(text, width);
  const shown = useFlapText(target, enabled, run);
  return (
    <span className={cx("kla-flaps", className)} aria-hidden="true" data-tone={tone}>
      {Array.from(shown.text, (char, index) => (
        <span key={index} className="kla-flap" data-turning={shown.turning?.[index] || undefined}>
          {char === " " ? " " : char}
        </span>
      ))}
    </span>
  );
}

/** A shortened CAIP-2 id for the chain column (the full id is in the title). */
function shortCaip(id: string): string {
  return id.length > 18 ? `${id.slice(0, 16)}…` : id;
}

export function DepartureBoard({
  rows,
  clock,
  note,
  title = "Departures",
  subtitle = "Network status",
  caption = "RPC status per network",
  animate = true,
  busy = false,
  className,
}: DepartureBoardProps) {
  const reduced = useReducedMotion();
  const enabled = animate && !reduced;
  const [ref, inView] = useInView<HTMLDivElement>({ once: true, threshold: 0.2 });
  const production = rows.filter((row) => !row.line.yard);
  const yard = rows.filter((row) => row.line.yard);

  const renderRow = (row: BoardRow) => {
    const name = boardName(row.line);
    return (
      <tr key={row.line.key} className="kla-board__row">
        <td className="kla-board__line">
          <LineBullet line={row.line} size="lg" decorative />
        </td>
        <th scope="row" className="kla-board__network">
          <span className="kla-sr">{row.line.name}</span>
          <span className="kla-board__name" aria-hidden="true">
            {name}
          </span>
          <Flaps text={name} width={NAME_WIDTH} enabled={enabled} run={inView} className="kla-board__name-flaps" />
        </th>
        <td className="kla-board__caip" title={row.line.id}>
          {shortCaip(row.line.id)}
        </td>
        <td className="kla-board__rpc">
          <span className="kla-sr">{describeLatency(row.latencyMs)}</span>
          <Flaps text={formatLatency(row.latencyMs)} width={LATENCY_WIDTH} enabled={enabled} run={inView} />
        </td>
        <td>
          <span className="kla-board__status">
            <span className="kla-board__lamp" data-status={row.status} aria-hidden="true" />
            <span className="kla-sr">{STATUS_SPEECH[row.status]}</span>
            <Flaps text={STATUS_FLAPS[row.status]} width={STATUS_WIDTH} enabled={enabled} run={inView} tone={row.status} />
          </span>
        </td>
      </tr>
    );
  };

  return (
    <div ref={ref} className={cx("kla-board", className)}>
      <div className="kla-board__head">
        <p className="kla-board__title">
          {title}
          <span className="kla-board__sub">{subtitle}</span>
        </p>
        <p className="kla-board__clock">
          <span className="kla-sr">Last checked </span>
          {clock}
        </p>
      </div>
      <table className="kla-board__table" aria-busy={busy || undefined}>
        <caption className="kla-sr">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Line</th>
            <th scope="col">Network</th>
            <th scope="col" className="kla-board__caip">
              Chain
            </th>
            <th scope="col" className="kla-board__rpc">
              RPC
            </th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>{production.map(renderRow)}</tbody>
        {yard.length ? (
          <tbody className="kla-board__yard">
            <tr>
              <th colSpan={5} scope="rowgroup" className="kla-board__yard-head">
                Test yard · separate capital
              </th>
            </tr>
            {yard.map(renderRow)}
          </tbody>
        ) : null}
      </table>
      {note ? <p className="kla-board__note">{note}</p> : null}
    </div>
  );
}
