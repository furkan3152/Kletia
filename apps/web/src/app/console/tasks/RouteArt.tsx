/**
 * The route on the card (Card machine): the networks the plan
 * touches as cartridges, the bridges and venues as stations, rails between them, drawn from the
 * real plan (`routeStops`). When the card is printed a pen plotter draws the rails (pen drops,
 * draws, lifts, travels, parks) and the stops pop in with the leg tones.
 *
 * While the plan runs, each step's coin rides its own rail as far as the chain has taken it
 * (`legProgress`): it waits at the start while the wallet asks, rides part way once signed and in
 * flight, and reaches the end only when the API says the step settled; the travelled part of the
 * rail turns lime. A swap's coin turns into the asset it bought when it arrives.
 */
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";

import { ICON_PATHS } from "../../kit/iconPaths";
import { animate, EASE, reducedMotion } from "../../kit/motion";
import { playSound, type SoundName } from "../../kit/sound";
import { ART, routeGeometry, routeLabel, type LegProgress, type RoutePlan } from "./cardModel";

export interface RouteArtProps {
  readonly plan: RoutePlan;
  /** Each step's progress (empty before signing). */
  readonly progress: readonly LegProgress[];
  /** Symbols of each step's input and output (the coin's face). */
  readonly coins: Readonly<Record<string, { readonly from: string; readonly to: string }>>;
  /** Draw the route with the pen plotter (a card being printed now). */
  readonly plot: boolean;
  /** Delay before the plotter starts (after the print), ms. */
  readonly plotDelay?: number;
}

const LEG_TONES: readonly SoundName[] = ["leg1", "leg2", "leg3"];

/** The coin's face: "$" for dollars, "Ξ" for ether, else the first letter. */
function coinFace(symbol: string): string {
  if (/usd|dai/iu.test(symbol)) return "$";
  if (/^w?eth$/iu.test(symbol)) return "Ξ";
  if (/^w?sol$/iu.test(symbol)) return "◎";
  return symbol.slice(0, 1).toUpperCase();
}

function coinTone(symbol: string): string {
  if (/usd|dai/iu.test(symbol)) return "usd";
  if (/eth/iu.test(symbol)) return "eth";
  if (/sol/iu.test(symbol)) return "sol";
  return "other";
}

export function RouteArt({ plan, progress, coins, plot, plotDelay = 0 }: RouteArtProps) {
  const geometry = useMemo(() => routeGeometry(plan), [plan]);
  const svg = useRef<SVGSVGElement>(null);
  const plotted = useRef(!plot);

  // The pen plotter: stops pop in order, the pen draws each rail and parks.
  useLayoutEffect(() => {
    if (plotted.current) return undefined;
    plotted.current = true;
    const root = svg.current;
    if (!root || reducedMotion()) return undefined;
    const nodes = [...root.querySelectorAll<SVGGElement>(".kd-rnode")];
    const rails = [...root.querySelectorAll<SVGPathElement>(".kd-rail-draw")];
    const pen = root.querySelector<SVGGElement>(".kd-pen");
    const timers: number[] = [];
    const at = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, plotDelay + ms));
    for (const node of nodes) node.style.opacity = "0";
    for (const rail of rails) rail.style.strokeDashoffset = "1";
    let t = 0;
    nodes.forEach((node, index) => {
      at(t, () => {
        node.style.opacity = "";
        animate(node, [{ transform: "scale(0)" }, { transform: "scale(1)" }], { duration: 400, easing: EASE.back(index % 2 ? 3 : 2.5) });
        if (index > 0) playSound(LEG_TONES[Math.min(index - 1, 2)]!, 0.8);
      });
      const rail = rails[index];
      const from = geometry.stops[index];
      const to = geometry.stops[index + 1];
      if (rail && from && to) {
        const x0 = from.x + from.half;
        const x1 = to.x - to.half;
        at(t + 60, () => {
          if (!pen) return;
          pen.style.opacity = "1";
          animate(pen, [{ transform: `translate(${x0}px, ${ART.y - 22}px)` }, { transform: `translate(${x0}px, ${ART.y}px)` }], { duration: 100, easing: EASE.in(2), fill: "forwards" });
        });
        at(t + 160, () => {
          playSound("pen", 0.7);
          animate(rail, [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 420, easing: EASE.inOut(2), fill: "persist" });
          if (pen) animate(pen, [{ transform: `translate(${x0}px, ${ART.y}px)` }, { transform: `translate(${x1}px, ${ART.y}px)` }], { duration: 420, easing: EASE.inOut(2), fill: "forwards" });
        });
        at(t + 590, () => {
          if (pen) animate(pen, [{ transform: `translate(${x1}px, ${ART.y}px)` }, { transform: `translate(${x1}px, ${ART.y - 20}px)` }], { duration: 100, fill: "forwards" });
          rail.style.strokeDashoffset = "";
        });
        t += 640;
      } else {
        t += 200;
      }
    });
    at(t + 40, () => {
      if (!pen) return;
      const end = geometry.stops[geometry.stops.length - 1];
      void animate(pen, [{ opacity: 1 }, { transform: `translate(${(end?.x ?? 300) + 24}px, 20px)`, opacity: 0 }], { duration: 300, easing: EASE.in(2), fill: "forwards" })
        ?.finished.catch(() => undefined);
    });
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      for (const node of nodes) node.style.opacity = "";
      for (const rail of rails) rail.style.strokeDashoffset = "";
    };
    // Once per printed card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const byStep = new Map(progress.map((leg) => [leg.stepId, leg]));
  return (
    <svg ref={svg} viewBox={`0 0 ${ART.width} ${ART.height}`} role="img" aria-label={routeLabel(plan)} className="kd-route">
      {geometry.rails.map((d, index) => (
        <path key={`bg${index}`} className="kd-rail-bg" d={d} />
      ))}
      {geometry.rails.map((d, index) => (
        <path key={`r${index}`} className="kd-rail-draw" d={d} pathLength={1} />
      ))}
      {geometry.legs.map((leg) => (
        <TravelledRail key={leg.stepId} d={leg.d} share={byStep.get(leg.stepId)?.travelled ?? 0} />
      ))}
      {geometry.stops.map((stop, index) =>
        stop.kind === "network" ? (
          <g key={index} className="kd-rnode" style={{ transformOrigin: `${stop.x}px ${stop.y}px` }}>
            <rect className="kd-cart" x={stop.x - geometry.cart.w / 2} y={stop.y - geometry.cart.h / 2} width={geometry.cart.w} height={geometry.cart.h} rx={9} />
            <path className="kd-ridge" d={`M${stop.x - 10} ${stop.y - geometry.cart.h / 2 + 6} H${stop.x + 10}`} />
            <g className="kd-rn-ic" transform={`translate(${stop.x - 12} ${stop.y - 10})`} dangerouslySetInnerHTML={{ __html: ICON_PATHS[stop.icon] }} />
            <text className="kd-rn-l" x={stop.x} y={stop.y + geometry.cart.h / 2 + 18} textAnchor="middle">
              {stop.label}
            </text>
          </g>
        ) : (
          <g key={index} className="kd-rnode" style={{ transformOrigin: `${stop.x}px ${stop.y}px` }}>
            <circle className="kd-stn" cx={stop.x} cy={stop.y} r={geometry.stationR} />
            <g className="kd-rn-ic" transform={`translate(${stop.x - 7} ${stop.y - 7}) scale(.58)`} dangerouslySetInnerHTML={{ __html: ICON_PATHS[stop.icon] }} />
            <text className="kd-rn-l" x={stop.x} y={stop.y + geometry.stationR + 22} textAnchor="middle">
              {stop.label}
            </text>
          </g>
        ),
      )}
      {geometry.legs.map((leg) => {
        const state = byStep.get(leg.stepId);
        if (!state || state.state === "queued") return null;
        const face = coins[leg.stepId];
        return <Coin key={leg.stepId} from={leg.from} to={leg.to} state={state} face={face ?? { from: "$", to: "$" }} />;
      })}
      <g className="kd-pen" style={{ opacity: 0 }} aria-hidden="true">
        <path d="M0 0 L-6 -16 L6 -16 Z" />
        <rect x={-7} y={-46} width={14} height={30} rx={4} />
      </g>
    </svg>
  );
}

/** The lime part of a step's rail: as far as its coin has travelled. */
function TravelledRail({ d, share }: { readonly d: string; readonly share: number }) {
  const ref = useRef<SVGPathElement>(null);
  const previous = useRef(share);
  useEffect(() => {
    const from = previous.current;
    previous.current = share;
    if (from === share) return;
    animate(ref.current, [{ strokeDashoffset: 1 - from }, { strokeDashoffset: 1 - share }], { duration: share === 1 ? 600 : 3000, easing: EASE.inOut(1) });
  }, [share]);
  return <path ref={ref} className="kd-rail-go" d={d} pathLength={1} style={{ strokeDashoffset: 1 - share }} />;
}

function Coin({ from, to, state, face }: { readonly from: number; readonly to: number; readonly state: LegProgress; readonly face: { readonly from: string; readonly to: string } }) {
  const ref = useRef<SVGGElement>(null);
  const previous = useRef<LegProgress | null>(null);
  const x = from + (to - from) * state.travelled;
  const arrived = state.state === "done";
  const symbol = arrived ? face.to : face.from;
  useEffect(() => {
    const element = ref.current;
    const before = previous.current;
    previous.current = state;
    if (!element) return;
    if (!before) {
      animate(element, [{ transform: `translate(${x}px, ${ART.y}px) scale(0)` }, { transform: `translate(${x}px, ${ART.y}px) scale(1)` }], { duration: 300, easing: EASE.back(3) });
      return;
    }
    const x0 = from + (to - from) * before.travelled;
    if (x0 !== x) {
      animate(element, [{ transform: `translate(${x0}px, ${ART.y}px) rotate(0deg)` }, { transform: `translate(${x}px, ${ART.y}px) rotate(720deg)` }], { duration: arrived ? 700 : 3000, easing: EASE.inOut(1) });
    }
    if (arrived && before.state !== "done") {
      window.setTimeout(() => playSound("hop", 0.8), arrived ? 650 : 0);
      if (face.to !== face.from) animate(element.querySelector(".kd-coin-face"), [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration: 220, delay: 650, easing: EASE.back(2) });
    }
  }, [arrived, face.from, face.to, from, state, to, x]);
  return (
    <g ref={ref} className="kd-coin" data-state={state.state} data-tone={coinTone(symbol)} style={{ transform: `translate(${x}px, ${ART.y}px)` }} aria-hidden="true">
      <g className="kd-coin-face">
        <circle r={10} />
        <text y={4} textAnchor="middle">
          {coinFace(symbol)}
        </text>
      </g>
    </g>
  );
}
