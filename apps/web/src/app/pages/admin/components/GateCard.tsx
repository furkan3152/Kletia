import type React from "react";

import { Icon } from "../../../site/art/Icon";
import type { IconName } from "../../../site/art/icons";
import { cx, HARD_SHADOW_LG, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";

export interface GateCardProps {
  readonly icon: IconName;
  /** Small plate above the title ("Admin is off"). */
  readonly eyebrow: string;
  readonly title: string;
  readonly children?: React.ReactNode;
  readonly actions?: React.ReactNode;
  /** A line to copy (an env line, the address to connect). */
  readonly code?: string;
  readonly tone?: "paper" | "warning" | "danger";
  readonly className?: string;
}

const TONE_PLATE: Readonly<Record<NonNullable<GateCardProps["tone"]>, string>> = {
  paper: "bg-[#FFD60A] text-[#1A1A1A]",
  warning: "bg-warning-bg text-warning",
  danger: "bg-danger-bg text-danger",
};

/** One gate state of the panel (admin design G.2): a pictogram, the state in words and what to do. */
export function GateCard({ icon, eyebrow, title, children, actions, code, tone = "paper", className }: GateCardProps) {
  return (
    <section aria-labelledby="admin-gate-title" className={cx("kl-rise mx-auto flex w-full max-w-xl flex-col gap-5 p-6 sm:p-8", INK_BORDER, HARD_SHADOW_LG, SURFACE, className)}>
      <div className="flex items-center gap-3">
        <Icon name={icon} size={36} />
        <span className={cx(LABEL, "border-2 border-current px-2 py-0.5 font-extrabold", TONE_PLATE[tone])}>{eyebrow}</span>
      </div>
      <h1 id="admin-gate-title" className="font-display text-2xl font-bold leading-tight sm:text-3xl">
        {title}
      </h1>
      {children ? <div className={cx("flex flex-col gap-3 text-[15px] leading-relaxed", TEXT_MUTED)}>{children}</div> : null}
      {code ? (
        <pre className="overflow-x-auto whitespace-pre-wrap break-all border-[3px] border-[#1A1A1A] bg-[#0D1117] px-4 py-3 font-code text-[13px] text-[#E6EDF3] dark:border-[#4B5563]">
          <code>{code}</code>
        </pre>
      ) : null}
      {actions ? <div className="flex flex-wrap items-center gap-3">{actions}</div> : null}
    </section>
  );
}
