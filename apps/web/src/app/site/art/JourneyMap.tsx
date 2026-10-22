import "./base.css";
import "./journey.css";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { CHAINS, type JourneyCertainty } from "@kletia/core";
import { JOURNEY_CERTAINTY_INFO, type JourneyLegView, type JourneyModel, type JourneyStopView } from "@kletia/widget/review";

import { cx } from "../ui/styles";
import { countdownText, custodyStamp, journeyLayout, legDrawing, legLeaving, type JourneyOrientation } from "./journeyFormat";
import { LineBullet } from "./LineBullet";
import { LINES, YELLOW } from "./tokens";

/*
 * The itinerary as Interchange art: stations are rings on the network's
 * line colour, Solana segments run on the SVM gauge, cross-network legs
 * are an interchange transfer (dashed until they arrive), a yellow "You
 * are here" plate marks where the money is, and each station has a card:
 * holder, custody stamp, amounts with certainty glyphs, the yellow "At
 * least" plate and the dollar value (its source on hover).
 *
 * Horizontal from 720 px of the map's own width (6 stops need 900 px),
 * vertical below (the LineStrip pattern). The map is an ordered list of
 * stops and legs read in order; lines, rings, gauges and the train are
 * aria-hidden, and each stop's heading speaks network, holder, amounts and
 * custody. The train moves only while visible and never with reduced motion.
 */

export interface JourneyMapProps {
  readonly model: JourneyModel;
  /** The intent is executing: the train runs on the leg the money is moving through. */
  readonly live?: boolean;
  /** The moving leg took longer than usual. */
  readonly overdue?: boolean;
  /** Seconds left on the moving leg (live countdown), when known. */
  readonly remainingSeconds?: number | null;
  /** Heading level of each stop. Default 4. */
  readonly headingLevel?: 3 | 4 | 5;
  readonly className?: string;
}

/** Certainty shapes of the fare plus the filled square of `observed`; decorative (the words are read). */
export function CertaintyGlyph({ certainty }: { readonly certainty: JourneyCertainty }) {
  const shape = JOURNEY_CERTAINTY_INFO[certainty]?.shape ?? "dashed";
  return (
    <svg className="kla-jm__glyph" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      {shape === "square" ? <rect x="1.5" y="1.5" width="9" height="9" fill="currentColor" /> : null}
      {shape === "dot" ? <circle cx="6" cy="6" r="4.5" fill="currentColor" /> : null}
      {shape === "half" ? (
        <>
          <circle cx="6" cy="6" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6 1.75a4.25 4.25 0 0 1 0 8.5z" fill="currentColor" />
        </>
      ) : null}
      {shape === "diamond" ? <path d="M6 1.2 10.8 6 6 10.8 1.2 6z" fill="none" stroke="currentColor" strokeWidth="1.5" /> : null}
      {shape === "ring" ? <circle cx="6" cy="6" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.5" /> : null}
      {shape === "dashed" ? <circle cx="6" cy="6" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 1.6" /> : null}
    </svg>
  );
}

function lineColor(network: string): string {
  return LINES[network as keyof typeof LINES]?.color ?? YELLOW;
}

function isSvm(network: string): boolean {
  return CHAINS[network as keyof typeof CHAINS]?.vm === "svm";
}

function Station({ stop, leavesBy, headingLevel, column }: { readonly stop: JourneyStopView; readonly leavesBy: number | null; readonly headingLevel: 3 | 4 | 5; readonly column: number }) {
  const Heading = `h${headingLevel}` as "h3" | "h4" | "h5";
  const line = LINES[stop.network];
  const style = { "--kla-jm-line": lineColor(stop.network), "--kla-jm-col": column } as CSSProperties;
  return (
    <li
      className="kla-jm__stop"
      data-kind={stop.kind}
      data-state={stop.state}
      data-here={stop.here ? "" : undefined}
      data-custody={stop.custody}
      style={style}
    >
      <span className="kla-jm__ring" aria-hidden="true" />
      <Heading className="kla-sr">{stop.heading}</Heading>
      <div className="kla-jm__card" aria-hidden="true">
        <p className="kla-jm__kind">
          {line ? <LineBullet line={line} decorative /> : null}
          <span>{stop.kindLabel}</span>
          <span className="kla-jm__net">{stop.networkName}</span>
        </p>
        <p className="kla-jm__holder">
          {stop.holderLabel}
          {stop.accountShort ? (
            <span className="kla-jm__acct" title={stop.account ?? undefined}>
              {stop.accountShort}
            </span>
          ) : null}
        </p>
        {stop.holdings.map((holding, index) => (
          <div key={`${holding.symbol}-${index}`} className="kla-jm__hold">
            <p className="kla-jm__amt" title={holding.certaintyInfo.sentence}>
              <CertaintyGlyph certainty={holding.certainty} />
              <span>{holding.expected}</span>
              {holding.atLeast ? <span className="kla-jm__exp">expected</span> : null}
            </p>
            {holding.atLeast ? <p className="kla-jm__plate">At least {holding.atLeast}</p> : null}
            <p className="kla-jm__usd" title={`Value source: ${holding.usdSource}`}>
              {holding.usd ? `${holding.usd} (${holding.usdSource})` : "Price unavailable"}
            </p>
            {holding.roleText ? <p className="kla-jm__role">{holding.roleText}</p> : null}
            {holding.identity ? <p className="kla-jm__role">{holding.identity}</p> : null}
            {holding.basis ? <p className="kla-jm__role">{holding.basis}</p> : null}
          </div>
        ))}
        {stop.total ? <p className="kla-jm__amt">Total {stop.total}</p> : null}
        <p className="kla-jm__stamps">
          <span className="kla-jm__stamp" data-custody={stop.custody}>
            {custodyStamp(stop.custody, stop.custody === "venue" ? stop.holderLabel : null)}
          </span>
          {leavesBy !== null && stop.holdings.some((holding) => holding.role === "spent-next") ? <span className="kla-jm__next">To leg {leavesBy}</span> : null}
        </p>
        {stop.eta ? <p className="kla-jm__eta">{stop.eta}</p> : null}
        {stop.reachedAt ? <p className="kla-jm__eta">Reached {stop.reachedAt}</p> : null}
        {stop.here ? <p className="kla-jm__here">You are here</p> : null}
      </div>
      {stop.evidenceUrl ? (
        <a className="kla-link kla-jm__link" href={stop.evidenceUrl} target="_blank" rel="noopener noreferrer">
          View on the explorer
          <span className="kla-sr"> (opens in a new tab)</span>
        </a>
      ) : null}
    </li>
  );
}

function Leg({
  leg,
  sourceNetwork,
  live,
  overdue,
  remainingSeconds,
  column,
}: {
  readonly leg: JourneyLegView;
  readonly sourceNetwork: string | null;
  readonly live: boolean;
  readonly overdue: boolean;
  readonly remainingSeconds: number | null;
  readonly column: number;
}) {
  const drawing = legDrawing(leg, (sourceNetwork as never) ?? null, (network) => isSvm(network));
  const moving = live && drawing.moving;
  const countdown = moving ? countdownText(remainingSeconds, overdue) : null;
  const style = {
    "--kla-jm-line": lineColor(sourceNetwork ?? ""),
    "--kla-jm-col": column,
  } as CSSProperties;
  return (
    <li
      className="kla-jm__leg"
      data-style={drawing.style}
      data-dashed={drawing.dashed ? "" : undefined}
      data-gauge={drawing.gauge}
      data-moving={moving ? "" : undefined}
      data-overdue={moving && overdue ? "" : undefined}
      style={style}
    >
      <span className="kla-jm__track" aria-hidden="true">
        {moving ? <span className="kla-jm__train" /> : null}
      </span>
      <div className="kla-jm__legtext">
        <p className="kla-jm__legline">
          <span className="kla-sr">Leg {leg.number}: </span>
          <span className="kla-jm__legno" aria-hidden="true">
            {String(leg.number).padStart(2, "0")}
          </span>
          {leg.line}
          {leg.crossNetwork ? <span className="kla-jm__legto"> · to {leg.destinationName}</span> : null}
        </p>
        {leg.status ? <p className="kla-jm__legstatus">{leg.status}</p> : null}
        {countdown ? (
          <p className="kla-jm__countdown" data-overdue={overdue ? "" : undefined}>
            {countdown}
          </p>
        ) : null}
        {leg.failure ? <p className="kla-jm__fail">{leg.failure}</p> : null}
        {leg.refund ? <p className="kla-jm__role">Refund: {leg.refund}</p> : null}
        {leg.gasTopup ? <p className="kla-jm__role">{leg.gasTopup}</p> : null}
        {leg.tracking ? (
          <a className="kla-link kla-jm__link" href={leg.tracking.url} target="_blank" rel="noopener noreferrer">
            {leg.tracking.label}
            <span className="kla-sr"> (opens in a new tab)</span>
          </a>
        ) : null}
      </div>
    </li>
  );
}

/** Measures the map's own width (container queries cannot depend on the number of stops). */
function useOrientation(stops: number): { readonly ref: (node: HTMLDivElement | null) => void; readonly orientation: JourneyOrientation } {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  const frame = useRef(0);
  useEffect(() => {
    // The observer reports the first size as soon as it observes (no measurement: vertical).
    if (!node || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (typeof next !== "number") return;
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => setWidth(next));
    });
    observer.observe(node);
    return () => {
      cancelAnimationFrame(frame.current);
      observer.disconnect();
    };
  }, [node]);
  return { ref: setNode, orientation: journeyLayout(stops, width).orientation };
}

export function JourneyMap({ model, live = false, overdue = false, remainingSeconds = null, headingLevel = 4, className }: JourneyMapProps) {
  const { ref, orientation } = useOrientation(model.stops.length);
  const stopNetwork = new Map(model.stops.map((stop) => [stop.id, stop.network as string]));
  const stopIndex = new Map(model.stops.map((stop, index) => [stop.id, index]));
  return (
    <div
      ref={ref}
      className={cx("kla-jm", className)}
      data-orientation={orientation}
      data-stage={model.stage}
      style={{ "--kla-jm-n": Math.max(1, model.stops.length) } as CSSProperties}
    >
      <ol className="kla-jm__route">
        {model.route.map((item) =>
          item.type === "stop" ? (
            <Station
              key={`stop-${item.stop.id}`}
              stop={item.stop}
              leavesBy={legLeaving(item.stop.id, model.legs)}
              headingLevel={headingLevel}
              column={(stopIndex.get(item.stop.id) ?? 0) + 1}
            />
          ) : (
            <Leg
              key={`leg-${item.leg.id}`}
              leg={item.leg}
              sourceNetwork={stopNetwork.get(item.leg.from) ?? null}
              live={live}
              overdue={overdue}
              remainingSeconds={remainingSeconds}
              column={(stopIndex.get(item.leg.from) ?? 0) + 1}
            />
          ),
        )}
      </ol>
    </div>
  );
}
