import { Hash } from "lucide-react";
import React from "react";

import { Link } from "../../routes/Link";
import { cx, FOCUS_RING, LABEL, TEXT_MUTED } from "../../site/ui/styles";

export interface DocSectionProps {
  readonly id: string;
  readonly index: number;
  readonly title: React.ReactNode;
  readonly intro?: React.ReactNode;
  readonly badge?: React.ReactNode;
  readonly children: React.ReactNode;
}

/** A numbered documentation section with a deep-link anchor. */
export function DocSection({ id, index, title, intro, badge, children }: DocSectionProps) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-heading`}
      className="scroll-mt-28 border-b-[3px] border-dashed border-[#1A1A1A]/20 py-14 first:pt-4 last:border-b-0 dark:border-white/10"
    >
      <p className={cx(LABEL, "text-[#0052FF] dark:text-[#7EA6FF]")}>{String(index).padStart(2, "0")}</p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h2 id={`${id}-heading`} className="font-display text-3xl font-bold tracking-[-0.03em] sm:text-4xl">
          {title}
        </h2>
        {badge}
        <Link
          to={`/developers#${id}`}
          className={cx("ml-auto inline-flex h-9 w-9 items-center justify-center text-[#45464B] hover:text-[#0052FF] dark:text-[#A9B6C8] dark:hover:text-[#FFD60A]", FOCUS_RING)}
          aria-label={`Link to ${typeof title === "string" ? title : id}`}
        >
          <Hash className="h-4 w-4" aria-hidden="true" />
        </Link>
      </div>
      {intro ? <div className={cx("mt-3 max-w-3xl text-base leading-relaxed", TEXT_MUTED)}>{intro}</div> : null}
      <div className="mt-8">{children}</div>
    </section>
  );
}
