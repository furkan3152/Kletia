import "./base.css";
import "./endOfLine.css";

import { useId } from "react";

import { useAutoPause } from "../motion/useAutoPause";
import { useReducedMotion } from "../motion/useReducedMotion";
import { cx } from "../ui/styles";

/*
 * 404: the end of the line. A track runs out at a buffer stop with a red
 * lamp, next to a yellow sign for a platform that does not exist. Drawn in
 * elevation (side view) with the same ink, paper and hard shadows as the map.
 * Decorative; the page's H1 says what happened. The lamp blinks five times
 * (paused off-screen and in hidden tabs, never with reduced motion).
 */
export interface EndOfLineProps {
  /** Blink the lamp (ignored with reduced motion). Default true. */
  readonly animate?: boolean;
  /** The number on the platform sign. Default "404". */
  readonly platform?: string;
  readonly className?: string;
}

export function EndOfLine({ animate: wantAnimate = true, platform = "404", className }: EndOfLineProps) {
  const id = useId().replace(/:/g, "");
  const reduced = useReducedMotion();
  const animate = wantAnimate && !reduced;
  const { ref } = useAutoPause<SVGSVGElement>();
  const hazard = `${id}-hz`;
  const ballast = `${id}-bl`;
  const fade = `${id}-fd`;
  return (
    <svg
      ref={ref}
      viewBox="0 0 720 300"
      aria-hidden="true"
      focusable="false"
      className={cx("kla-eol", animate && "kla-eol--animate", className)}
    >
      <defs>
        <pattern id={hazard} width={16} height={16} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width={16} height={16} className="kla-eol__hazard-y" />
          <rect width={8} height={16} className="kla-eol__hazard-k" />
        </pattern>
        <pattern id={ballast} width={7} height={7} patternUnits="userSpaceOnUse">
          <circle cx={3.5} cy={3.5} r={1.5} className="kla-eol__ink-fill" />
        </pattern>
        <linearGradient id={`${fade}-g`} x1={0} y1={0} x2={0} y2={1}>
          <stop offset={0} stopColor="#fff" stopOpacity={0.9} />
          <stop offset={1} stopColor="#fff" stopOpacity={0} />
        </linearGradient>
        <mask id={fade}>
          <rect x={0} y={252} width={720} height={48} fill={`url(#${fade}-g)`} />
        </mask>
      </defs>

      {/* Ballast in halftone, fading into the page. */}
      <rect x={0} y={252} width={720} height={48} fill={`url(#${ballast})`} mask={`url(#${fade})`} className="kla-eol__ballast" />
      <path d="M0 251H720" className="kla-eol__ground" />

      {/* The platform, behind the track. */}
      <rect x={206} y={212} width={300} height={39} className="kla-eol__platform" />
      <rect x={206} y={212} width={300} height={7} className="kla-eol__edge" />

      {/* Sleepers and the rail. */}
      {Array.from({ length: 17 }, (_, index) => (
        <rect key={index} x={8 + index * 34} y={243} width={22} height={9} className="kla-eol__ink-fill" />
      ))}
      <rect x={0} y={231} width={604} height={12} className="kla-eol__ink-fill" />
      <path d="M0 234.5H600" className="kla-eol__shine" />

      {/* Grass. */}
      <path
        d="M52 250l-3-11M56 250l1-14M60 250l4-10M150 250l-2-9M154 250l2-12M530 250l-3-10M534 250l1-13M690 250l-3-12M694 250l2-9"
        className="kla-eol__grass"
      />

      {/* Platform sign on two posts. */}
      <rect x={322} y={108} width={8} height={104} className="kla-eol__ink-fill" />
      <rect x={438} y={108} width={8} height={104} className="kla-eol__ink-fill" />
      <rect x={302} y={46} width={176} height={76} className="kla-eol__shadow" />
      <rect x={296} y={40} width={176} height={76} className="kla-eol__sign" />
      <text x={384} y={59} textAnchor="middle" className="kla-eol__sign-k">
        PLATFORM
      </text>
      <text x={384} y={106} textAnchor="middle" className="kla-eol__sign-n">
        {platform}
      </text>

      {/* Notice pinned to the left post. */}
      <g transform="rotate(-4 290 160)">
        <rect x={262} y={122} width={60} height={76} className="kla-eol__notice" />
        <rect x={262} y={122} width={60} height={15} className="kla-eol__notice-head" />
        <text x={292} y={133} textAnchor="middle" className="kla-eol__notice-k">
          NOTICE
        </text>
        <path d="M270 148H314M270 156H310M270 164H314M270 172H304M270 184H296" className="kla-eol__notice-lines" />
        <circle cx={292} cy={121} r={3} className="kla-eol__pin" />
      </g>

      {/* Buffer stop. */}
      <rect x={642} y={146} width={18} height={96} className="kla-eol__shadow" />
      <rect x={636} y={140} width={18} height={96} className="kla-eol__ink-fill" />
      <path d="M566 232h16l66-72-12-8z" className="kla-eol__ink-fill" />
      <rect x={562} y={156} width={104} height={36} className="kla-eol__shadow" />
      <rect x={556} y={150} width={104} height={36} fill={`url(#${hazard})`} className="kla-eol__beam" />
      <rect x={534} y={158} width={22} height={20} className="kla-eol__buffer" />
      <rect x={525} y={151} width={10} height={34} className="kla-eol__ink-fill" />

      {/* Lamp. */}
      <rect x={641} y={98} width={8} height={44} className="kla-eol__ink-fill" />
      <rect x={626} y={70} width={38} height={30} className="kla-eol__ink-fill" />
      <circle cx={645} cy={85} r={18} className="kla-eol__glow kla-loop" />
      <circle cx={645} cy={85} r={9} className="kla-eol__lens kla-loop" />
    </svg>
  );
}
