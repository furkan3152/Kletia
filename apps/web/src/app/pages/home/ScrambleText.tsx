import { useEffect, useState } from "react";

import { seededRandom } from "../../site/motion/tokens";
import { useReducedMotion } from "../../site/motion/useReducedMotion";

const HEX = "0123456789abcdef";

export interface ScrambleTextProps {
  /** Final text; `0x`, dots and ellipses stay fixed while hex digits scramble. */
  readonly text: string;
  /** Scramble while true, then settle on `text` (one pass per false → true change). */
  readonly play: boolean;
  /** How long the digits scramble, in ms (default 400). */
  readonly duration?: number;
  readonly className?: string;
}

function scrambled(text: string, random: () => number): string {
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    const fixed = index < 2 || !/[0-9a-f]/iu.test(char);
    out += fixed ? char : HEX[Math.floor(random() * HEX.length)]!;
  }
  return out;
}

/**
 * A hash that scrambles briefly before it settles (decorative: render it
 * `aria-hidden` or next to the real value). Width is fixed in `ch`, so
 * nothing shifts. Reduced motion shows the final text.
 */
export function ScrambleText({ text, play, duration = 400, className }: ScrambleTextProps) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState<string | null>(null);

  useEffect(() => {
    if (!play || reduced) return undefined;
    const random = seededRandom(text.length * 7919 + 17);
    const startedAt = performance.now();
    const timer = window.setInterval(() => {
      if (performance.now() - startedAt >= duration) {
        window.clearInterval(timer);
        setShown(null);
        return;
      }
      setShown(scrambled(text, random));
    }, 45);
    return () => {
      window.clearInterval(timer);
    };
  }, [play, reduced, text, duration]);

  return (
    <span className={className} style={{ display: "inline-block", minWidth: `${text.length}ch` }}>
      {play && !reduced ? (shown ?? text) : text}
    </span>
  );
}
