import "./base.css";
import "./map.css";

import { useCallback, useEffect, useId, useState } from "react";

import { useAutoPause } from "../motion/useAutoPause";
import { useReducedMotion } from "../motion/useReducedMotion";
import { cx } from "../ui/styles";
import { DOWN, rounded, tick, UP, type Pt } from "./geometry";
import {
  BULLET_HEIGHT,
  BULLET_WIDTH,
  INTERCHANGE,
  KLETIA_PLATE,
  LEG_MARKERS,
  MAP_HEIGHT,
  MAP_WIDTH,
  labelPlacement,
  mapDescription,
  signLayout,
  TRACKS,
  TRAIN_REST,
  TRIP_POINTS,
  WALLET,
  YARD,
  yardLayout,
} from "./routeMapLayout";
import { LINES, venueOn, YARD_LINES, type Line } from "./tokens";

/*
 * Route map: the production networks drawn as transit lines that meet at one
 * interchange (Kletia's planner and bridge auction), Solana leaving on its
 * own SVM gauge, and the testnets parked in a fenced yard with no through
 * service. Stations are registry venues on that network.
 *
 * Drawing order: yard, network shadow, casings, tick casings, line colour,
 * ticks, gauge sleepers, interchange, signs, labels, then the moving train
 * (outside any filter, so the animation never re-rasterises a filtered layer).
 *
 * Motion: the lines draw in once and a small train runs the example trip
 * twice. Both pause off-screen and in hidden tabs (useAutoPause), and neither
 * exists with reduced motion or animate={false}: the map is printed finished.
 */

export interface RouteMapProps {
  /** "full" for wide layouts; "strip" is the Base to Solana excerpt for phones. */
  readonly variant?: "full" | "strip";
  /** Draw the lines in and run the train (ignored with reduced motion). Default true. */
  readonly animate?: boolean;
  /** Hide the map from assistive tech when the page already says the same thing in text. */
  readonly decorative?: boolean;
  readonly className?: string;
}

const SVM_DASH = "10 7";

function MapBullet({ line, at, width = BULLET_WIDTH }: { readonly line: Line; readonly at: Pt; readonly width?: number }) {
  const [cx0, cy] = at;
  const h = BULLET_HEIGHT;
  return (
    <g className="kla-map__bullet">
      <rect x={cx0 - width / 2 + 3} y={cy - h / 2 + 3} width={width} height={h} className="kla-map__shadow" />
      <rect x={cx0 - width / 2} y={cy - h / 2} width={width} height={h} fill={line.color} className="kla-map__edge" strokeWidth={3} />
      {line.gauge === "svm" ? (
        <path d={`M${cx0 - width / 2 + 3} ${cy + 8}H${cx0 + width / 2 - 3}`} className="kla-map__sleepers kla-map__sleepers--bullet" />
      ) : null}
      <text x={cx0} y={cy + 4} textAnchor="middle" fill={line.on} className="kla-map__code">
        {line.code}
      </text>
    </g>
  );
}

/**
 * Ref for the map's <svg>: pauses the CSS draw-in (data-kl-paused) and the
 * SMIL train (pauseAnimations) off-screen and in hidden tabs.
 */
function useMapMotion(animate: boolean) {
  const pause = useAutoPause<SVGSVGElement>();
  const pauseRef = pause.ref;
  const [svg, setSvg] = useState<SVGSVGElement | null>(null);
  const ref = useCallback(
    (node: SVGSVGElement | null) => {
      pauseRef(node);
      setSvg(node);
    },
    [pauseRef],
  );
  useEffect(() => {
    if (!svg || !animate || typeof svg.pauseAnimations !== "function") return;
    if (pause.active) svg.unpauseAnimations();
    else svg.pauseAnimations();
  }, [svg, animate, pause.active]);
  return ref;
}

export function RouteMap({ variant = "full", animate: wantAnimate = true, decorative = false, className }: RouteMapProps) {
  const id = useId().replace(/:/g, "");
  const reduced = useReducedMotion();
  const animate = wantAnimate && !reduced;
  return variant === "strip" ? (
    <RouteStrip id={id} animate={animate} decorative={decorative} className={className} />
  ) : (
    <FullMap id={id} animate={animate} decorative={decorative} className={className} />
  );
}

interface MapViewProps {
  readonly id: string;
  readonly animate: boolean;
  readonly decorative: boolean;
  readonly className?: string;
}

function FullMap({ id, animate, decorative, className }: MapViewProps) {
  const titleId = `${id}-t`;
  const descId = `${id}-d`;
  const tripId = `${id}-trip`;
  const ref = useMapMotion(animate);
  const sign = signLayout();
  const yard = yardLayout(YARD_LINES);
  const solana = TRACKS.find((track) => track.line.key === "solana");
  // Platforms: every line that ends inside the capsule gets a passage to the exit.
  const entries = TRACKS.filter((track) => track !== solana).map((track) => track.points[0]![1]);
  const exitY = solana?.points[0]![1] ?? 272;
  const capsuleCx = INTERCHANGE.x + INTERCHANGE.width / 2;
  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
      className={cx("kla-map kla-map--full", animate && "kla-map--animate", className)}
      focusable="false"
      {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-labelledby": `${titleId} ${descId}` })}
    >
      {decorative ? null : (
        <>
          <title id={titleId}>Kletia route map</title>
          <desc id={descId}>{mapDescription()}</desc>
        </>
      )}

      {/* Test yard: fenced, hatched, no through service. */}
      {yard.rows.length ? (
        <g className="kla-map__yard">
          <rect x={YARD.x} y={YARD.y} width={YARD.width} height={yard.height} rx={4} className="kla-map__yard-ground" />
          <rect x={YARD.x} y={YARD.y} width={YARD.width} height={yard.height} rx={4} className="kla-map__yard-fence" />
          <text x={YARD.x + 14} y={YARD.y + 21} className="kla-map__mono kla-map__mono--strong">
            TEST YARD
          </text>
          <text x={YARD.x + 84} y={YARD.y + 21} className="kla-map__small">
            separate capital · no through service
          </text>
          {yard.rows.map(({ line, y }) => (
            <g key={line.key}>
              <path d={`M618 ${y}H712`} className="kla-map__casing kla-map__casing--yard" />
              <path d={`M618 ${y}H712`} stroke={line.color} className="kla-map__yard-line" />
              <rect x={713} y={y - 9} width={5} height={18} className="kla-map__ink-fill" />
              <circle cx={726} cy={y} r={3} className="kla-map__lamp" />
              <MapBullet line={line} at={[486, y]} width={42} />
              <text x={514} y={y + 4} className="kla-map__label kla-map__label--sm">
                {line.name}
              </text>
            </g>
          ))}
        </g>
      ) : null}

      {/* Hard shadow under the whole network, like a die-cut layer. */}
      <g className="kla-map__network-shadow" transform="translate(5 5)">
        {TRACKS.map((track, index) => (
          <path
            key={track.line.key}
            d={rounded(track.points)}
            pathLength={1}
            className="kla-map__casing kla-map__draw"
            style={{ animationDelay: `${index * 90}ms` }}
          />
        ))}
      </g>

      <g className="kla-map__network">
        {TRACKS.map((track, index) => (
          <path
            key={track.line.key}
            d={rounded(track.points)}
            pathLength={1}
            className="kla-map__casing kla-map__draw"
            style={{ animationDelay: `${index * 90}ms` }}
          />
        ))}
        {TRACKS.flatMap((track) =>
          track.stations.map((station) => (
            <path
              key={`${track.line.key}-${station.venue}-c`}
              d={tick(station.at, station.n, 0, 17)}
              className="kla-map__tick-casing kla-map__after-draw"
            />
          )),
        )}
        {TRACKS.map((track, index) => (
          <path
            key={track.line.key}
            d={rounded(track.points)}
            pathLength={1}
            stroke={track.line.color}
            className="kla-map__line kla-map__draw"
            style={{ animationDelay: `${index * 90}ms` }}
          />
        ))}
        {TRACKS.flatMap((track) =>
          track.stations.map((station) => (
            <path
              key={`${track.line.key}-${station.venue}`}
              d={tick(station.at, station.n, 0, 15)}
              stroke={track.line.color}
              className="kla-map__tick kla-map__after-draw"
            />
          )),
        )}
        {/* SVM gauge: a row of ink sleepers down the middle of the line. */}
        {TRACKS.filter((track) => track.line.gauge === "svm").map((track) => (
          <path
            key={`${track.line.key}-svm`}
            d={rounded(track.points)}
            className="kla-map__sleepers kla-map__after-draw"
            strokeDasharray={SVM_DASH}
          />
        ))}
      </g>

      {/* Interchange: every platform has a passage to the exit. */}
      <g className="kla-map__interchange kla-map__after-draw">
        <rect
          x={INTERCHANGE.x + 3}
          y={INTERCHANGE.y + 3}
          width={INTERCHANGE.width}
          height={INTERCHANGE.height}
          rx={INTERCHANGE.rx}
          className="kla-map__shadow"
        />
        <rect
          x={INTERCHANGE.x}
          y={INTERCHANGE.y}
          width={INTERCHANGE.width}
          height={INTERCHANGE.height}
          rx={INTERCHANGE.rx}
          className="kla-map__capsule"
        />
        {entries.map((y) => (
          <path
            key={y}
            d={`M${INTERCHANGE.x + 8} ${y}C${capsuleCx} ${y} ${capsuleCx} ${exitY} ${INTERCHANGE.x + INTERCHANGE.width - 8} ${exitY}`}
            className="kla-map__passage"
          />
        ))}
        <rect
          x={KLETIA_PLATE.x + 3}
          y={KLETIA_PLATE.y + 3}
          width={KLETIA_PLATE.width}
          height={KLETIA_PLATE.height}
          className="kla-map__shadow"
        />
        <rect x={KLETIA_PLATE.x} y={KLETIA_PLATE.y} width={KLETIA_PLATE.width} height={KLETIA_PLATE.height} className="kla-map__plate" />
        <text x={capsuleCx} y={KLETIA_PLATE.y + 18} textAnchor="middle" className="kla-map__plate-text">
          Kletia
        </text>
      </g>

      {/* "Change here for" sign, hung off the interchange. */}
      {sign.items.length ? (
        <g className="kla-map__sign kla-map__after-draw">
          <path d={`M${INTERCHANGE.x + INTERCHANGE.width} 340H452`} className="kla-map__leader" />
          <rect x={455} y={315} width={sign.width} height={sign.height} className="kla-map__shadow" />
          <rect x={452} y={312} width={sign.width} height={sign.height} className="kla-map__card" />
          <rect x={452} y={312} width={sign.width} height={20} className="kla-map__sign-head" />
          <text x={462} y={326} className="kla-map__mono kla-map__mono--on-ink">
            CHANGE HERE FOR
          </text>
          {sign.items.map((item) => (
            <text key={item.name} x={item.x} y={item.y} className="kla-map__label kla-map__label--sm">
              {item.name}
            </text>
          ))}
        </g>
      ) : null}

      {/* Key. */}
      <g className="kla-map__legend">
        <rect x={475} y={21} width={268} height={128} className="kla-map__shadow" />
        <rect x={472} y={18} width={268} height={128} className="kla-map__card" />
        <text x={486} y={37} className="kla-map__mono kla-map__mono--strong">
          KEY
        </text>
        <path d="M486 54H522" className="kla-map__casing kla-map__casing--key" />
        <path d="M486 54H522" className="kla-map__line kla-map__line--key kla-map__line--neutral" />
        <text x={534} y={58} className="kla-map__small">
          Production network
        </text>
        <path d="M486 76H522" className="kla-map__casing kla-map__casing--key" />
        <path d="M486 76H522" stroke={LINES.solana.color} className="kla-map__line kla-map__line--key" />
        <path d="M486 76H522" className="kla-map__sleepers kla-map__sleepers--key" />
        <text x={534} y={80} className="kla-map__small">
          Solana, on the SVM gauge
        </text>
        <path d="M486 98H522" className="kla-map__casing kla-map__casing--key" />
        <path d="M504 98V86" className="kla-map__tick-casing kla-map__tick-casing--key" />
        <path d="M486 98H522" className="kla-map__line kla-map__line--key kla-map__line--neutral" />
        <path d="M504 98V87.5" className="kla-map__tick kla-map__tick--key kla-map__line--neutral" />
        <text x={534} y={102} className="kla-map__small">
          A venue Kletia can call
        </text>
        <rect x={488} y={112} width={32} height={14} rx={7} className="kla-map__capsule kla-map__capsule--key" />
        <text x={534} y={123} className="kla-map__small">
          Interchange and bridge auction
        </text>
        <path d="M486 138H516" className="kla-map__yard-line kla-map__yard-line--key kla-map__line--neutral" />
        <rect x={517} y={132} width={4} height={12} className="kla-map__ink-fill" />
        <text x={534} y={142} className="kla-map__small">
          Test yard, separate capital
        </text>
      </g>

      {/* Station names, network names and bullets. */}
      <g className="kla-map__labels kla-map__after-draw">
        {TRACKS.flatMap((track) =>
          track.stations.map((station) => {
            const place = labelPlacement(station);
            return (
              <text
                key={`${track.line.key}-${station.venue}-l`}
                x={place.x}
                y={place.y}
                textAnchor={place.anchor}
                className="kla-map__label"
              >
                {station.label}
              </text>
            );
          }),
        )}
        {TRACKS.map((track) => (
          <g key={track.line.key}>
            <MapBullet line={track.line} at={track.bullet} />
            <text x={track.name.at[0]} y={track.name.at[1]} textAnchor={track.name.anchor} className="kla-map__name">
              {track.line.name}
            </text>
          </g>
        ))}
      </g>

      {/* The example trip. */}
      <g className="kla-map__trip kla-map__after-draw">
        <circle cx={WALLET[0]} cy={WALLET[1]} r={9} className="kla-map__capsule" />
        <text x={WALLET[0]} y={WALLET[1] + 30} textAnchor="middle" className="kla-map__label">
          Your wallet
        </text>
        <text x={WALLET[0]} y={WALLET[1] + 46} textAnchor="middle" className="kla-map__mono">
          50 USDC
        </text>
        {LEG_MARKERS.map((leg) => (
          <g key={leg.n} className="kla-map__leg" transform={`translate(${leg.at[0]} ${leg.at[1]})`}>
            <circle r={11} className="kla-map__leg-dot" />
            <text y={4} textAnchor="middle" className="kla-map__leg-num">
              {leg.n}
            </text>
          </g>
        ))}
        <path id={tripId} d={rounded(TRIP_POINTS, 22)} fill="none" stroke="none" />
        <Train animate={animate} tripId={tripId} rest={TRAIN_REST} seconds={7} waitSeconds={0.9} />
      </g>
    </svg>
  );
}

/**
 * The little train. It appears at the first station after `waitSeconds`
 * (while the lines draw in), runs the trip in `seconds`, twice, then stays at
 * the last station. With motion off it rests at `rest` and never moves.
 */
function Train({
  animate,
  tripId,
  rest,
  seconds,
  waitSeconds,
}: {
  readonly animate: boolean;
  readonly tripId: string;
  readonly rest: Pt;
  readonly seconds: number;
  readonly waitSeconds: number;
}) {
  return (
    <g
      className="kla-map__train"
      transform={animate ? undefined : `translate(${rest[0]} ${rest[1]})`}
      visibility={animate ? "hidden" : undefined}
    >
      <rect x={-14} y={-7} width={28} height={14} rx={3} className="kla-map__train-body" />
      <rect x={5} y={-3.5} width={5} height={7} className="kla-map__train-window" />
      {animate ? (
        <>
          <set attributeName="visibility" to="visible" begin={`${waitSeconds}s`} fill="freeze" />
          <animateMotion
            dur={`${seconds}s`}
            begin={`${waitSeconds}s`}
            repeatCount="2"
            fill="freeze"
            rotate="auto"
            keyPoints="0;1"
            keyTimes="0;1"
            calcMode="spline"
            keySplines="0.45 0 0.25 1"
          >
            <mpath href={`#${tripId}`} />
          </animateMotion>
        </>
      ) : null}
    </g>
  );
}

function RouteStrip({ id, animate, decorative, className }: MapViewProps) {
  const titleId = `${id}-t`;
  const tripId = `${id}-trip`;
  const ref = useMapMotion(animate);
  const base = LINES.base;
  const solana = LINES.solana;
  const firstYard = YARD_LINES[0];
  const jupiter = venueOn("jupiter", "solana");
  const jito = venueOn("jito", "solana");
  const baseD = "M48 64H164";
  const solD = "M196 64H302";
  return (
    <svg
      ref={ref}
      viewBox="0 0 360 156"
      className={cx("kla-map kla-map--strip", animate && "kla-map--animate", className)}
      focusable="false"
      {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-labelledby": titleId })}
    >
      {decorative ? null : (
        <title id={titleId}>
          {`${base.name} to ${solana.name} through the Kletia interchange. Testnets run in a separate yard.`}
        </title>
      )}
      <g className="kla-map__network-shadow" transform="translate(4 4)">
        <path d={baseD} className="kla-map__casing kla-map__draw" pathLength={1} />
        <path d={solD} className="kla-map__casing kla-map__draw" pathLength={1} style={{ animationDelay: "120ms" }} />
      </g>
      <path d={baseD} className="kla-map__casing kla-map__draw" pathLength={1} />
      <path d={solD} className="kla-map__casing kla-map__draw" pathLength={1} style={{ animationDelay: "120ms" }} />
      {jupiter ? <path d={tick([232, 64], DOWN, 0, 17)} className="kla-map__tick-casing kla-map__after-draw" /> : null}
      {jito ? <path d={tick([276, 64], UP, 0, 17)} className="kla-map__tick-casing kla-map__after-draw" /> : null}
      <path d={baseD} stroke={base.color} className="kla-map__line kla-map__draw" pathLength={1} />
      <path d={solD} stroke={solana.color} className="kla-map__line kla-map__draw" pathLength={1} style={{ animationDelay: "120ms" }} />
      {jupiter ? <path d={tick([232, 64], DOWN, 0, 15)} stroke={solana.color} className="kla-map__tick kla-map__after-draw" /> : null}
      {jito ? <path d={tick([276, 64], UP, 0, 15)} stroke={solana.color} className="kla-map__tick kla-map__after-draw" /> : null}
      {solana.gauge === "svm" ? <path d={solD} className="kla-map__sleepers kla-map__after-draw" strokeDasharray={SVM_DASH} /> : null}
      <g className="kla-map__interchange kla-map__after-draw">
        <rect x={155} y={43} width={52} height={48} rx={20} className="kla-map__shadow" />
        <rect x={152} y={40} width={52} height={48} rx={20} className="kla-map__capsule" />
        <rect x={150} y={9} width={56} height={22} className="kla-map__shadow" transform="translate(3 3)" />
        <rect x={150} y={9} width={56} height={22} className="kla-map__plate" />
        <text x={178} y={25} textAnchor="middle" className="kla-map__plate-text kla-map__plate-text--sm">
          Kletia
        </text>
      </g>
      <g className="kla-map__labels kla-map__after-draw">
        <circle cx={70} cy={64} r={8} className="kla-map__capsule" />
        <text x={70} y={96} textAnchor="middle" className="kla-map__label">
          Your wallet
        </text>
        {jupiter ? (
          <text x={232} y={98} textAnchor="middle" className="kla-map__label">
            {jupiter.name}
          </text>
        ) : null}
        {jito ? (
          <text x={276} y={36} textAnchor="middle" className="kla-map__label">
            {jito.name}
          </text>
        ) : null}
        <MapBullet line={base} at={[26, 64]} width={44} />
        <MapBullet line={solana} at={[326, 64]} width={44} />
      </g>
      {firstYard ? (
        <g className="kla-map__yard">
          <text x={6} y={137} className="kla-map__mono kla-map__mono--strong">
            TEST YARD
          </text>
          <text x={74} y={137} className="kla-map__small">
            separate capital
          </text>
          <path d="M232 133H330" className="kla-map__casing kla-map__casing--yard" />
          <path d="M232 133H330" stroke={firstYard.color} className="kla-map__yard-line" />
          <rect x={331} y={124} width={5} height={18} className="kla-map__ink-fill" />
          <MapBullet line={firstYard} at={[206, 133]} width={42} />
        </g>
      ) : null}
      <path id={tripId} d="M70 64H300" fill="none" stroke="none" />
      <Train animate={animate} tripId={tripId} rest={[124, 64]} seconds={5} waitSeconds={0.6} />
    </svg>
  );
}
