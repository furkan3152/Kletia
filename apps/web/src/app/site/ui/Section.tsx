import React from "react";

import { PlatformNumber } from "../art/Ornaments";
import { Reveal } from "../motion/Reveal";
import { CONTAINER, cx, LABEL, TEXT_MUTED } from "./styles";

export type SectionTone = "plain" | "paper" | "ink" | "yellow" | "blue";

const TONES: Record<SectionTone, string> = {
  plain: "",
  paper: "bg-[#EDE9DF] dark:bg-[#0E1729]",
  ink: "bg-[#111318] text-white dark:bg-[#060A14]",
  // Printed ink stays ink on yellow in both themes (the art reads --kla-text and --kla-muted).
  yellow: "bg-[#FFD60A] text-[#1A1A1A] [--kla-muted:#3A3B3F] [--kla-text:#1A1A1A]",
  blue: "bg-[#0052FF] text-white",
};

export interface SectionProps {
  readonly id?: string;
  readonly eyebrow?: React.ReactNode;
  /**
   * Section number on its platform plate (Platform 01, 02, ...). With a
   * number the eyebrow is printed as a `PlatformNumber`; without one it is a
   * plain mono label.
   */
  readonly platform?: number;
  readonly title?: React.ReactNode;
  readonly intro?: React.ReactNode;
  /** Right-aligned header content (links, filters). */
  readonly actions?: React.ReactNode;
  readonly tone?: SectionTone;
  readonly bordered?: boolean;
  /**
   * Rise the header (eyebrow, then title +60 ms, then intro +120 ms) when it
   * scrolls into view. Default false. Children are not wrapped: use `<Reveal>`.
   */
  readonly reveal?: boolean;
  readonly className?: string;
  readonly containerClassName?: string;
  readonly children?: React.ReactNode;
}

function HeaderCopy({ reveal, children }: { readonly reveal: boolean; readonly children: React.ReactNode }) {
  if (!reveal) return <div className="max-w-4xl">{children}</div>;
  return (
    <Reveal className="max-w-4xl" stagger>
      {children}
    </Reveal>
  );
}

/** Page section with an optional eyebrow, heading and intro, labelled for assistive tech. */
export function Section({
  id,
  eyebrow,
  platform,
  title,
  intro,
  actions,
  tone = "plain",
  bordered = false,
  reveal = false,
  className,
  containerClassName,
  children,
}: SectionProps) {
  const headingId = id ? `${id}-heading` : undefined;
  const dark = tone === "ink" || tone === "blue";
  const item = reveal ? { "data-reveal-item": "" } : undefined;
  return (
    <section
      id={id}
      aria-labelledby={title ? headingId : undefined}
      className={cx(
        "relative scroll-mt-24 py-16 sm:py-20 lg:py-24",
        TONES[tone],
        bordered && "border-y-[3px] border-[#1A1A1A] dark:border-[#4B5563]",
        className,
      )}
    >
      <div className={cx(CONTAINER, containerClassName)}>
        {title || eyebrow || intro || actions ? (
          <header className="mb-10 flex flex-col gap-6 lg:mb-14 lg:flex-row lg:items-end lg:justify-between">
            <HeaderCopy reveal={reveal}>
              {eyebrow ? (
                platform !== undefined ? (
                  <div {...item} className="mb-5">
                    <PlatformNumber n={platform} tone={dark ? "ink" : "paper"}>
                      {eyebrow}
                    </PlatformNumber>
                  </div>
                ) : (
                  <p
                    {...item}
                    className={cx(
                      LABEL,
                      "mb-4 font-code",
                      dark ? "text-[#FFD60A]" : tone === "yellow" ? "text-[#1A1A1A]" : "text-[#0047E0] dark:text-[#7EA6FF]",
                    )}
                  >
                    {eyebrow}
                  </p>
                )
              ) : null}
              {title ? (
                <h2
                  {...item}
                  id={headingId}
                  className="text-balance font-display text-[2rem] font-bold leading-[1.05] tracking-[-0.03em] sm:text-5xl lg:text-[3.5rem]"
                >
                  {title}
                </h2>
              ) : null}
              {intro ? (
                <div
                  {...item}
                  className={cx(
                    "mt-5 max-w-2xl text-base leading-relaxed sm:text-lg",
                    dark ? "text-white/80" : tone === "yellow" ? "text-[#1A1A1A]/85" : TEXT_MUTED,
                  )}
                >
                  {intro}
                </div>
              ) : null}
            </HeaderCopy>
            {actions ? <div className="flex shrink-0 flex-wrap gap-3">{actions}</div> : null}
          </header>
        ) : null}
        {children}
      </div>
    </section>
  );
}
