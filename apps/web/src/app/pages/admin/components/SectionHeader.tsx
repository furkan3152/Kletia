import type React from "react";

import { Icon } from "../../../site/art/Icon";
import type { IconName } from "../../../site/art/icons";
import { cx, LABEL, TEXT_MUTED } from "../../../site/ui/styles";

/** The head of an admin section: pictogram plate, H1, one intro line and the section's actions. */
export function SectionHeader({
  icon,
  eyebrow,
  title,
  intro,
  actions,
}: {
  readonly icon: IconName;
  readonly eyebrow: string;
  readonly title: string;
  readonly intro?: React.ReactNode;
  readonly actions?: React.ReactNode;
}) {
  return (
    <header className="flex min-w-0 flex-col gap-3 pb-6">
      <div className="flex items-center gap-2.5">
        <Icon name={icon} size={28} />
        <span className={cx(LABEL, "font-extrabold", TEXT_MUTED)}>{eyebrow}</span>
      </div>
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <h1 id="admin-section-title" tabIndex={-1} className="min-w-0 font-display text-3xl font-bold leading-tight outline-none sm:text-4xl">
          {title}
        </h1>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {intro ? <p className={cx("max-w-3xl text-[15px] leading-relaxed", TEXT_MUTED)}>{intro}</p> : null}
    </header>
  );
}

/** A titled block inside a section. */
export function Panel({ title, aside, children, className }: { readonly title: string; readonly aside?: React.ReactNode; readonly children: React.ReactNode; readonly className?: string }) {
  return (
    <section className={cx("flex min-w-0 flex-col gap-3", className)} aria-label={title}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-xl font-bold">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** An empty state: a dashed box with one sentence (and optional action). */
export function EmptyState({ children, action }: { readonly children: React.ReactNode; readonly action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3 border-[3px] border-dashed border-[#121212]/40 bg-surface-2 px-5 py-6 dark:border-white/25">
      <p className="text-[15px] font-semibold">{children}</p>
      {action}
    </div>
  );
}
