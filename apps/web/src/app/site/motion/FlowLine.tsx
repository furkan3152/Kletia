import { useEffect, useId, useRef } from "react";

import { cssVars } from "./tokens";
import { useAutoPause } from "./useAutoPause";
import { useReducedMotion } from "./useReducedMotion";

export interface FlowLineProps {
  /** SVG path data. */
  readonly d: string;
  /** Network colour for the glow underlay and packets (default Kletia blue). */
  readonly color?: string;
  /** "funds" = solid ink edge; "orders" = dashed edge that fades in instead of drawing. */
  readonly kind?: "funds" | "orders";
  /** Draw the path in (`kl-draw`) when it mounts. */
  readonly draw?: boolean;
  /** Delay before the draw-in, in ms. */
  readonly drawDelay?: number;
  /** Number of travelling packets (default 0 = none). */
  readonly packets?: number;
  /** Packet fill (default `color`). */
  readonly packetColor?: string;
  /** Time for one packet to travel the path, in ms (default 1400). */
  readonly packetDuration?: number;
  /** Packets move only while true (default true); they also pause off-screen and in hidden tabs. */
  readonly active?: boolean;
  /** Arrow head at the end of the path (default false). */
  readonly arrow?: boolean;
  /** Glow underlay in the network colour (default true). */
  readonly glow?: boolean;
  /** Ink stroke classes (default ink in light, slate-200 in dark). */
  readonly inkClassName?: string;
  readonly className?: string;
}

const DRAW_MS = 380;
const SAMPLES = 32;
const INK = "stroke-[#1A1A1A] dark:stroke-[#CBD5E1]";

/**
 * An edge between two nodes in an SVG diagram: a glow underlay in the network
 * colour, an ink stroke with an optional arrow head and square "packets"
 * travelling along it. Render it inside an `aria-hidden` `<svg>` and describe
 * the diagram in text elsewhere.
 *
 * Packets use the Web Animations API (keyframes sampled from the path once
 * per `d`), so there is no per-frame JavaScript. They pause when `active` is
 * false, off-screen or in a hidden tab. Reduced motion draws the path
 * statically with no packets.
 */
export function FlowLine({
  d,
  color = "#0052FF",
  kind = "funds",
  draw = false,
  drawDelay = 0,
  packets = 0,
  packetColor,
  packetDuration = 1400,
  active = true,
  arrow = false,
  glow = true,
  inkClassName = INK,
  className,
}: FlowLineProps) {
  const reduced = useReducedMotion();
  const { ref: pauseRef, active: onScreen } = useAutoPause<SVGGElement>();
  const markerId = `kl-arrow-${useId().replace(/[^a-zA-Z0-9_-]/gu, "")}`;
  const pathRef = useRef<SVGPathElement | null>(null);
  const packetRefs = useRef<Array<SVGRectElement | null>>([]);
  const animationsRef = useRef<Animation[]>([]);
  const count = reduced ? 0 : Math.max(0, Math.min(6, Math.floor(packets)));
  const running = active && onScreen;
  const runningRef = useRef(running);
  const dashed = kind === "orders";
  const drawn = draw && !dashed;
  const animateIn = draw ? (dashed ? "kl-draw-fade" : "kl-draw") : undefined;
  const delayStyle = draw ? cssVars({ "--kl-delay": `${Math.max(0, drawDelay)}ms` }) : undefined;

  // (Re)build the packet animations when the geometry or packet set changes.
  useEffect(() => {
    const path = pathRef.current;
    if (!path || count === 0 || typeof path.getTotalLength !== "function") return undefined;
    let length: number;
    try {
      length = path.getTotalLength();
    } catch {
      return undefined;
    }
    if (!(length > 0)) return undefined;
    const keyframes: Keyframe[] = [];
    for (let index = 0; index <= SAMPLES; index += 1) {
      const offset = index / SAMPLES;
      const point = path.getPointAtLength(length * offset);
      keyframes.push({
        offset,
        transform: `translate(${point.x.toFixed(2)}px, ${point.y.toFixed(2)}px)`,
        opacity: offset < 0.08 || offset > 0.92 ? 0 : 1,
      });
    }
    const startDelay = draw ? Math.max(0, drawDelay) + DRAW_MS : 0;
    const spacing = packetDuration / count;
    const animations: Animation[] = [];
    packetRefs.current.slice(0, count).forEach((packet, index) => {
      if (!packet || typeof packet.animate !== "function") return;
      const animation = packet.animate(keyframes, {
        duration: packetDuration,
        delay: startDelay + index * spacing,
        iterations: Infinity,
        easing: "linear",
        fill: "backwards",
      });
      if (!runningRef.current) animation.pause();
      animations.push(animation);
    });
    animationsRef.current = animations;
    return () => {
      for (const animation of animations) animation.cancel();
      animationsRef.current = [];
    };
  }, [d, count, packetDuration, draw, drawDelay]);

  // Pause and resume without rebuilding.
  useEffect(() => {
    runningRef.current = running;
    for (const animation of animationsRef.current) {
      if (running) animation.play();
      else animation.pause();
    }
  }, [running]);

  return (
    <g ref={pauseRef} className={className}>
      {arrow ? (
        <defs>
          <marker
            id={markerId}
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0 0 L10 5 L0 10 z" className="fill-[#1A1A1A] dark:fill-[#CBD5E1]" />
          </marker>
        </defs>
      ) : null}
      {glow ? (
        <path
          d={d}
          fill="none"
          stroke={color}
          strokeOpacity={0.35}
          strokeWidth={7}
          strokeLinecap="round"
          strokeLinejoin="round"
          pathLength={drawn ? 1 : undefined}
          className={animateIn}
          style={delayStyle}
        />
      ) : null}
      <path
        ref={pathRef}
        d={d}
        fill="none"
        strokeWidth={2.5}
        strokeLinejoin="round"
        strokeDasharray={dashed ? "6 5" : undefined}
        pathLength={drawn ? 1 : undefined}
        markerEnd={arrow ? `url(#${markerId})` : undefined}
        className={animateIn ? `${inkClassName} ${animateIn}` : inkClassName}
        style={delayStyle}
      />
      {Array.from({ length: count }, (_, index) => (
        <rect
          key={index}
          ref={(node) => {
            packetRefs.current[index] = node;
          }}
          x={-5}
          y={-5}
          width={10}
          height={10}
          fill={packetColor ?? color}
          strokeWidth={1.5}
          opacity={0}
          className="stroke-[#1A1A1A] dark:stroke-[#0B1120]"
        />
      ))}
    </g>
  );
}
