import "./network.css";

import { useAutoPause } from "../../site/motion/useAutoPause";
import { LINEAGE, LINES, MAP_STOPS, type MapStop } from "./networkData";

/*
 * The line map: the lineage drawn as a transit diagram. The Interchange
 * (Kletia's intent engine) feeds one trunk into the Engine port, where Elyia
 * took the engine's concepts; the Summit Line climbs from there through
 * Elyia's altitude layers, and the Coast Line leaves the same port for Arc.
 * Train lights run Interchange → Summit and Interchange → Coast, in that
 * order, which is the order the products were built. Two drawings (wide and
 * phone) share the stops; CSS shows the one that fits. Lights are CSS loops
 * that stop off screen and under reduced motion.
 */

interface Placed {
  readonly x: number;
  readonly y: number;
  /** Label position relative to the stop. */
  readonly label: "above" | "below" | "right" | "aboveLeft";
  readonly note?: string;
}

interface Layout {
  readonly id: "wide" | "phone";
  readonly width: number;
  readonly height: number;
  readonly trunk: string;
  readonly summit: string;
  readonly coast: string;
  readonly stops: Readonly<Record<string, Placed>>;
  readonly tags: readonly { readonly x: number; readonly y: number; readonly text: string; readonly anchor?: "start" | "middle" | "end" }[];
}

const WIDE: Layout = {
  id: "wide",
  width: 1000,
  height: 300,
  trunk: "M110 170 H300",
  summit: "M110 170 H300 L360 110 H430 L480 60 H880",
  coast: "M110 170 H300 L360 230 H880",
  stops: {
    engine: { x: 110, y: 170, label: "below", note: "Intent graph · Rule Book" },
    port: { x: 300, y: 170, label: "right", note: "Elyia ports the concepts" },
    floor: { x: 430, y: 110, label: "aboveLeft" },
    ridge: { x: 620, y: 60, label: "above" },
    summit: { x: 880, y: 60, label: "above" },
    fence: { x: 580, y: 230, label: "below" },
    arc: { x: 880, y: 230, label: "below" },
  },
  tags: [
    { x: 205, y: 152, text: "ENGINE CONCEPTS", anchor: "middle" },
    { x: 470, y: 218, text: "BUILT ON THE LINEAGE", anchor: "start" },
  ],
};

const PHONE: Layout = {
  id: "phone",
  width: 360,
  height: 520,
  trunk: "M40 48 V140",
  summit: "M40 48 V390",
  coast: "M40 48 V140 H170 L210 180 V470",
  stops: {
    engine: { x: 40, y: 48, label: "right", note: "Intent graph, Rule Book" },
    port: { x: 40, y: 140, label: "right", note: "Elyia ports the concepts" },
    floor: { x: 40, y: 230, label: "right" },
    ridge: { x: 40, y: 310, label: "right" },
    summit: { x: 40, y: 390, label: "right" },
    fence: { x: 210, y: 300, label: "right", note: "Built for Arc" },
    arc: { x: 210, y: 470, label: "right" },
  },
  tags: [],
};

function labelPosition(stop: Placed, layout: Layout): { x: number; y: number; anchor: "start" | "middle" | "end" } {
  if (stop.label === "aboveLeft") return { x: stop.x - 10, y: stop.y - 30, anchor: "end" };
  if (stop.label === "right") return { x: stop.x + (stop === layout.stops.engine ? 46 : layout.id === "wide" && stop === layout.stops.port ? 34 : 20), y: layout.id === "phone" && stop === layout.stops.port ? stop.y - 30 : stop.y + 4, anchor: "start" };
  if (stop.label === "above") return { x: stop.x, y: stop.y - 38, anchor: "middle" };
  return { x: stop.x, y: stop.y + 34, anchor: "middle" };
}

function Stop({ stop, place, layout }: { readonly stop: MapStop; readonly place: Placed; readonly layout: Layout }) {
  const position = labelPosition(place, layout);
  const note = place.note ?? stop.note;
  const color = LINES[stop.line].color;
  return (
    <g className="knm-stop" data-line={stop.line}>
      {stop.id === "engine" ? (
        <g className="knm-engine">
          <rect x={place.x - 32} y={place.y - 16} width={64} height={32} rx={16} />
          <text x={place.x} y={place.y + 5} textAnchor="middle">
            KLT
          </text>
        </g>
      ) : stop.interchange ? (
        <circle className="knm-dot knm-dot--x" cx={place.x} cy={place.y} r={11} />
      ) : stop.terminus ? (
        <rect className="knm-dot knm-dot--end" x={place.x - 10} y={place.y - 10} width={20} height={20} rx={3} style={{ stroke: color }} />
      ) : (
        <circle className="knm-dot" cx={place.x} cy={place.y} r={7} style={{ stroke: color }} />
      )}
      <text className="knm-name" x={position.x} y={position.y} textAnchor={position.anchor}>
        {stop.name}
      </text>
      <text className="knm-note" x={position.x} y={position.y + 16} textAnchor={position.anchor}>
        {note}
      </text>
    </g>
  );
}

function Drawing({ layout }: { readonly layout: Layout }) {
  return (
    <svg className={`knm-svg knm-svg--${layout.id}`} viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden="true" focusable="false">
      <path className="knm-casing" d={layout.summit} />
      <path className="knm-casing" d={layout.coast} />
      <path className="knm-track" d={layout.summit} style={{ stroke: LINES.elyia.color }} />
      <path className="knm-track" d={layout.coast} style={{ stroke: LINES.lykia.color }} />
      <path className="knm-track knm-track--trunk" d={layout.trunk} />
      <path className="knm-light knm-light--summit kla-loop" d={layout.summit} pathLength={100} />
      <path className="knm-light knm-light--coast kla-loop" d={layout.coast} pathLength={100} />
      {layout.tags.map((tag) => (
        <text key={tag.text} className="knm-tag" x={tag.x} y={tag.y} textAnchor={tag.anchor ?? "start"}>
          {tag.text}
        </text>
      ))}
      {MAP_STOPS.map((stop) => {
        const place = layout.stops[stop.id];
        return place ? <Stop key={stop.id} stop={stop} place={place} layout={layout} /> : null;
      })}
    </svg>
  );
}

export function LineMap({ caption = true }: { readonly caption?: boolean }) {
  const { ref } = useAutoPause<HTMLElement>();
  const summary = `Line map. ${LINEAGE.map((step) => step.verb).join(". ")}. Summit Line stops: ${MAP_STOPS.filter((stop) => stop.line === "elyia")
    .map((stop) => stop.name)
    .join(", ")}. Coast Line stops: ${MAP_STOPS.filter((stop) => stop.line === "lykia")
    .map((stop) => stop.name)
    .join(", ")}.`;
  return (
    <figure ref={ref} className="knm" role="img" aria-label={summary}>
      <Drawing layout={WIDE} />
      <Drawing layout={PHONE} />
      {caption ? (
        <figcaption className="knm-legend" aria-hidden="true">
          <span>
            <i style={{ background: LINES.kletia.color }} /> Interchange · Kletia
          </span>
          <span>
            <i style={{ background: LINES.elyia.color }} /> Summit Line · Elyia
          </span>
          <span>
            <i style={{ background: LINES.lykia.color }} /> Coast Line · Lykia
          </span>
        </figcaption>
      ) : null}
    </figure>
  );
}
