import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { typingJitter } from "./tokens";
import { useReducedMotion } from "./useReducedMotion";

export interface TypewriterProps {
  /** Full text. Changing it restarts the animation. */
  readonly text: string;
  /** Base delay per character in ms (default 28). */
  readonly speed?: number;
  /** Delay before the first character in ms (default 0). */
  readonly startDelay?: number;
  /** When false the typing freezes where it is (it does not reset). Default true. */
  readonly play?: boolean;
  /** Called once per `text` when it is fully typed (next tick with reduced motion). */
  readonly onDone?: () => void;
  /** Blinking block caret after the typed text. */
  readonly caret?: boolean;
  readonly className?: string;
  readonly caretClassName?: string;
}

/**
 * Types `text` one character at a time. Screen readers get the full text
 * immediately from an sr-only copy; the typed characters are `aria-hidden`.
 * Reduced motion shows the full text at once.
 */
export function Typewriter({
  text,
  speed = 28,
  startDelay = 0,
  play = true,
  onDone,
  caret = false,
  className,
  caretClassName,
}: TypewriterProps) {
  const reduced = useReducedMotion();
  const [state, setState] = useState<{ readonly text: string; readonly count: number }>({ text, count: 0 });
  let count = state.count;
  if (state.text !== text) {
    // A new text restarts from the first character.
    setState({ text, count: 0 });
    count = 0;
  }
  const visible = reduced ? text.length : Math.min(count, text.length);

  const onDoneRef = useRef(onDone);
  useLayoutEffect(() => {
    onDoneRef.current = onDone;
  });
  const doneForRef = useRef<string | null>(null);

  useEffect(() => {
    if (state.text !== text) return undefined;
    const finished = reduced || state.count >= text.length;
    if (finished) {
      if (doneForRef.current === text) return undefined;
      const timer = window.setTimeout(() => {
        doneForRef.current = text;
        onDoneRef.current?.();
      }, 0);
      return () => window.clearTimeout(timer);
    }
    if (!play) return undefined;
    const delay = (state.count === 0 ? Math.max(0, startDelay) : 0) + Math.max(0, speed) + typingJitter(state.count);
    const timer = window.setTimeout(() => {
      setState((current) => (current.text === text ? { text, count: current.count + 1 } : current));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [state, text, play, reduced, speed, startDelay]);

  return (
    <span className={className}>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {text.slice(0, visible)}
        {caret ? (
          <span
            className={
              caretClassName ??
              "kl-caret kl-loop ml-0.5 inline-block h-[1.05em] w-[0.55em] translate-y-[0.15em] bg-current"
            }
          />
        ) : null}
      </span>
    </span>
  );
}
