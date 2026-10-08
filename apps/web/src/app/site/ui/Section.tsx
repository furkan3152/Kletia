import React from "react";

import { CONTAINER, cx, LABEL, TEXT_MUTED } from "./styles";

export type SectionTone = "plain" | "paper" | "ink" | "yellow" | "blue";

const TONES: Record<SectionTone, string> = {
  plain: "",
  paper: "bg-[#EDE9DF] dark:bg-[#0E1729]",
  ink: "bg-[#111318] text-white dark:bg-[#060A14]",
  yellow: "bg-[#FFD60A] text-[#1A1A1A]",
  blue: "bg-[#0052FF] text-white",
};

export interface SectionProps {
  readonly id?: string;
  readonly eyebrow?: React.ReactNode;
  readonly title?: React.ReactNode;
  readonly intro?: React.ReactNode;
  /** Right-aligned header content (links, filters). */
  readonly actions?: React.ReactNode;
  readonly tone?: SectionTone;
  readonly bordered?: boolean;
  readonly className?: string;
  readonly containerClassName?: string;
  readonly children?: React.ReactNode;
}

/** Page section with an optional eyebrow, heading and intro, labelled for assistive tech. */
export function Section({
  id,
  eyebrow,
  title,
  intro,
  actions,
  tone = "plain",
  bordered = false,
  className,
  containerClassName,
  children,
}: SectionProps) {
  const headingId = id ? `${id}-heading` : undefined;
  const dark = tone === "ink" || tone === "blue";
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
            <div className="max-w-3xl">
              {eyebrow ? (
                <p
                  className={cx(
                    LABEL,
                    "mb-4 inline-flex items-center gap-2",
                    dark ? "text-[#FFD60A]" : tone === "yellow" ? "text-[#1A1A1A]" : "text-[#0052FF] dark:text-[#7EA6FF]",
                  )}
                >
                  <span aria-hidden="true" className="inline-block h-[3px] w-6 bg-current" />
                  {eyebrow}
                </p>
              ) : null}
              {title ? (
                <h2
                  id={headingId}
                  className="font-display text-[2rem] font-bold leading-[1.05] tracking-[-0.03em] sm:text-5xl lg:text-[3.5rem]"
                >
                  {title}
                </h2>
              ) : null}
              {intro ? (
                <div
                  className={cx(
                    "mt-5 max-w-2xl text-base leading-relaxed sm:text-lg",
                    dark ? "text-white/80" : tone === "yellow" ? "text-[#1A1A1A]/85" : TEXT_MUTED,
                  )}
                >
                  {intro}
                </div>
              ) : null}
            </div>
            {actions ? <div className="flex shrink-0 flex-wrap gap-3">{actions}</div> : null}
          </header>
        ) : null}
        {children}
      </div>
    </section>
  );
}
