import { useEffect, useRef } from "react";

import { useRoute } from "../../routes/useRoute";
import { EASE } from "../../site/motion/tokens";
import { prefersReducedMotion } from "../../site/motion/useReducedMotion";
import { ButtonLink } from "../../site/ui/Button";
import { CONTAINER, cx, LABEL, TEXT_MUTED } from "../../site/ui/styles";

const WOBBLE: Keyframe[] = [
  { transform: "rotate(-6deg)" },
  { transform: "rotate(-12deg)" },
  { transform: "rotate(-3deg)" },
  { transform: "rotate(-6deg)" },
];

/** 404 page for unknown paths. The yellow "0" settles once and wobbles on hover. */
export default function NotFoundPage() {
  const { location } = useRoute();
  const zeroRef = useRef<HTMLSpanElement | null>(null);

  const wobble = (duration: number) => {
    const zero = zeroRef.current;
    if (!zero || prefersReducedMotion() || typeof zero.animate !== "function") return;
    zero.animate(WOBBLE, { duration, easing: EASE.snap });
  };

  useEffect(() => {
    const zero = zeroRef.current;
    if (!zero || prefersReducedMotion() || typeof zero.animate !== "function") return undefined;
    const animation = zero.animate(WOBBLE, { duration: 600, easing: EASE.snap, delay: 150 });
    return () => animation.cancel();
  }, []);

  return (
    <div className="kl-grid-backdrop border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563]">
      <div className={cx(CONTAINER, "flex min-h-[70vh] flex-col justify-center py-20")}>
        <p className={cx(LABEL, "text-[#0052FF] dark:text-[#7EA6FF]")}>Error 404 · route not found</p>
        <h1 className="mt-4 font-display text-[clamp(5rem,22vw,14rem)] font-bold leading-[0.8] tracking-[-0.06em]">
          4
          <span
            ref={zeroRef}
            onPointerEnter={() => wobble(480)}
            className="inline-block -rotate-6 border-[3px] border-[#1A1A1A] bg-[#FFD60A] px-2 text-[#1A1A1A] shadow-hard dark:border-[#4B5563]"
          >
            0
          </span>
          4
        </h1>
        <p className={cx("mt-8 max-w-xl text-lg", TEXT_MUTED)}>
          No page lives at <code className="break-all bg-white px-1.5 py-0.5 font-code text-base text-[#1A1A1A] dark:bg-[#131E32] dark:text-white">{location.pathname}</code>.
          The intent was clear; the route was not.
        </p>
        <div className="mt-10 flex flex-wrap gap-3">
          <ButtonLink to="/" size="lg">
            Back to home
          </ButtonLink>
          <ButtonLink to="/studio" variant="secondary" size="lg">
            Open Intent Studio
          </ButtonLink>
          <ButtonLink to="/protocols" variant="secondary" size="lg">
            Browse protocols
          </ButtonLink>
          <ButtonLink to="/developers" variant="ghost" size="lg">
            Developer docs
          </ButtonLink>
        </div>
      </div>
    </div>
  );
}
