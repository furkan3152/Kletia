/**
 * The home page's printed card and binder stack, built on the kit (PrintedCard, CardArt,
 * CardBody, Facts, Thumb, Odometer). The hero loop and the scroll story drive them: they
 * switch `phase` (latch, stamp, step bars) and animate the parts inside (rail, nodes, coin)
 * through the class names below.
 */
import { useLayoutEffect, useRef, type RefObject } from "react";

import { CardArt, CardBody, Facts, PrintedCard, Thumb } from "../../kit/Card";
import { keyClass } from "../../kit/keyClass";
import { animate, EASE } from "../../kit/motion";
import { Odometer } from "../../kit/Parts";
import { Ico, IcoGroup } from "./Ico";
import type { HeroIntent } from "./homeData";
import { nodeXs, RAIL_Y, serialOf, X0, X1, type CardPhase, type ThumbData } from "./homeCardModel";



/** The route plotted on the card: rail, stations, networks, and the coin that rides it. */
export function RouteArt({ intent, plotted }: { readonly intent: HeroIntent; readonly plotted: boolean }) {
  const xs = nodeXs(intent);
  const offset = plotted ? 0 : 1;
  return (
    <svg className="route" viewBox="0 0 300 104" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <path className="rail-b" d={`M${X0} ${RAIL_Y}H${X1}`} />
      <path className="rail" d={`M${X0} ${RAIL_Y}H${X1}`} pathLength={1} strokeDasharray="1" strokeDashoffset={offset} />
      <path className="rail-f" d={`M${X0} ${RAIL_Y}H${X1}`} pathLength={1} strokeDasharray="1" strokeDashoffset={1} />
      {intent.nodes.map(([kind, icon, label, amount], index) => {
        const x = xs[index]!;
        const style = { transform: plotted ? "none" : "scale(0)" };
        if (kind === "stn") {
          return (
            <g key={index} className="node n-stn" style={style}>
              <circle cx={x} cy={RAIL_Y} r="13" />
              <IcoGroup name={icon} x={x - 9} y={RAIL_Y - 9} />
              <text className="lbl" x={x} y={RAIL_Y + 34} textAnchor="middle">
                {label}
              </text>
            </g>
          );
        }
        return (
          <g key={index} className={kind === "end" ? "node n-chain n-end" : "node n-chain"} style={style}>
            <rect x={x - 17} y={RAIL_Y - 17} width="34" height="34" rx="8" />
            <IcoGroup name={icon} x={x - 9} y={RAIL_Y - 9} ink={kind === "end" ? "#121212" : undefined} />
            <text className="lbl" x={x} y={RAIL_Y + 34} textAnchor="middle">
              {label}
            </text>
            {amount ? (
              <text className="amt" x={x} y={RAIL_Y - 25} textAnchor="middle">
                {amount}
              </text>
            ) : null}
          </g>
        );
      })}
      <g className="coin" transform={`translate(${X0} ${RAIL_Y})`} opacity="0">
        <circle r="8" />
        <text textAnchor="middle" y="3">
          $
        </text>
      </g>
    </svg>
  );
}


const PHASE_ORDER: readonly CardPhase[] = ["printed", "sealed", "signing", "settled"];
const atLeast = (phase: CardPhase, step: CardPhase) => PHASE_ORDER.indexOf(phase) >= PHASE_ORDER.indexOf(step);


/** A printed plan card (example). */
export function PlanCard({ intent, serial, phase, plotted = false }: { readonly intent: HeroIntent; readonly serial: number; readonly phase: CardPhase; readonly plotted?: boolean }) {
  return (
    <PrintedCard
      className={`hm-card band-${intent.band}`}
      label={`Example plan card ${serialOf(serial)}: ${intent.text}`}
      type={intent.type}
      serial={serialOf(serial)}
      tilt={false}
      latch={atLeast(phase, "sealed") ? "SEALED" : null}
      stamp={
        atLeast(phase, "settled") ? (
          <>
            Settled<small>{intent.stamp}</small>
          </>
        ) : null
      }
      front={
        <>
          <CardArt>
            <RouteArt intent={intent} plotted={plotted} />
          </CardArt>
          <div className="pc-body">
            <CardBody from={intent.from} title={intent.title} />
            <Facts rows={intent.facts} />
          </div>
          <div className="pc-foot">
            {atLeast(phase, "signing") ? (
              <div className="pc-steps">
                {Array.from({ length: intent.steps }, (_, index) => (
                  <i key={index}>
                    <b style={{ width: phase === "settled" ? "100%" : "0%" }} />
                  </i>
                ))}
              </div>
            ) : (
              <>
                <span className="note">Quote held 30 s</span>
                <span className={keyClass({ tone: "lime", size: "sm" }, "sign")}>
                  <Ico name="lock" />
                  {intent.sign}
                </span>
              </>
            )}
          </div>
        </>
      }
    />
  );
}



/** The binder module: three filed cards fanned in a well and the count. A new card drops in on top. */
export function BinderStack({ label = "Binder", thumbs, count, className, trayRef }: { readonly label?: string; readonly thumbs: readonly ThumbData[]; readonly count: number; readonly className?: string; readonly trayRef?: RefObject<HTMLDivElement> }) {
  const own = useRef<HTMLDivElement>(null);
  const tray = trayRef ?? own;
  const top = thumbs[thumbs.length - 1]?.id;
  const firstTop = useRef(top);
  useLayoutEffect(() => {
    if (!top || top === firstTop.current || !tray.current) return;
    firstTop.current = top;
    const nodes = tray.current.querySelectorAll<HTMLElement>(".k-thumb");
    const newest = nodes[nodes.length - 1];
    animate(newest, [{ translate: "0 -60px", opacity: 0 }, { translate: "0 0", opacity: 1 }], { duration: 500, easing: EASE.back(1.6) });
    [...nodes].slice(0, -1).forEach((node, index) => {
      animate(node, [{ translate: "0 0" }, { translate: "0 -10px", offset: 0.3 }, { translate: "0 4px", offset: 0.65 }, { translate: "0 0" }], { duration: 340, delay: index * 40 });
    });
  }, [top, tray]);
  return (
    <div className={className ? `bstack ${className}` : "bstack"}>
      <div className="bs-h">
        <span>{label}</span>
        <b>
          <Odometer value={String(count)} />
        </b>
      </div>
      <div className="bs-tray" ref={tray}>
        {thumbs.slice(-3).map((thumb, index) => (
          <Thumb key={thumb.id} className={`t${index}`} kind={thumb.kind} serial={serialOf(thumb.serial)} title={thumb.title} sub={thumb.sub} />
        ))}
      </div>
    </div>
  );
}
