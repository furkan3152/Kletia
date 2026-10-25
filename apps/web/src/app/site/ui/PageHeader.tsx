import "./ui.css";

import { ChevronLeft } from "lucide-react";
import React, { useEffect, useRef } from "react";

import { Link } from "../../routes/Link";
import { cx, FOCUS_RING } from "./styles";

export interface PageHeaderProps {
  /** The page's one H1. */
  readonly title: React.ReactNode;
  /** A small line above the title (a plate, a group name). */
  readonly eyebrow?: React.ReactNode;
  /** One paragraph under the title. */
  readonly intro?: React.ReactNode;
  /** Page actions, aligned right of the title on wide screens. */
  readonly actions?: React.ReactNode;
  /** A status line between the title and the intro (pills, facts). */
  readonly meta?: React.ReactNode;
  /** Detail pages: the way back to their list ("‹ Contracts"). */
  readonly back?: { readonly label: string; readonly to: string };
  /**
   * A shell that moves focus after client-side navigation passes a new value
   * per navigation: the H1 takes focus when it changes (and on mount while
   * set). Null or absent: focus stays where it is.
   */
  readonly focusKey?: string | number | null;
  readonly className?: string;
  readonly children?: React.ReactNode;
}

/**
 * The head of a page: optional back link and eyebrow, the H1 (a focus target
 * that is not in the tab order and draws no box when the shell focuses it),
 * the actions, a status line and an intro.
 */
export function PageHeader({ title, eyebrow, intro, actions, meta, back, focusKey = null, className, children }: PageHeaderProps) {
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    if (focusKey === null || focusKey === undefined) return;
    headingRef.current?.focus({ preventScroll: true });
  }, [focusKey]);

  return (
    <header className={cx("ku-head", className)}>
      {back ? (
        <Link
          to={back.to}
          className={cx("ku-back", FOCUS_RING)}
        >
          <ChevronLeft aria-hidden="true" />
          {back.label}
        </Link>
      ) : null}
      {eyebrow ? <div className="flex min-w-0 flex-wrap items-center gap-3">{eyebrow}</div> : null}
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="ku-h1"
        >
          {title}
        </h1>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {meta ? <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-sm">{meta}</div> : null}
      {intro ? <div className="ku-intro">{intro}</div> : null}
      {children}
    </header>
  );
}
