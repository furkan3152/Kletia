import React from "react";

import { isInternalHref, navigate } from "./history";
import { prefetchHref } from "./routeTable";
import { useRoute } from "./useRoute";

export interface LinkProps
  extends Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  /** Same-origin path (`/developers`, `/#product`) or an absolute URL. */
  readonly to: string;
  readonly replace?: boolean;
  /** Prefetch the target route chunk on hover/focus (default true). */
  readonly prefetch?: boolean;
  /** Extra classes applied when the link points at the current page. */
  readonly activeClassName?: string;
}

function pathnameOf(to: string): string | null {
  try {
    const url = new URL(to, window.location.href);
    if (url.origin !== window.location.origin || url.hash) return null;
    return url.pathname.length > 1 ? url.pathname.replace(/\/+$/u, "") : url.pathname;
  } catch {
    return null;
  }
}

/**
 * Router-aware anchor. Same-origin left clicks without modifier keys are
 * handled with `history.pushState`; everything else (new tab, download,
 * external origin, modified click) keeps native browser behaviour.
 */
export const Link = React.forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  {
    to,
    replace = false,
    prefetch = true,
    activeClassName,
    className,
    onClick,
    onMouseEnter,
    onFocus,
    onTouchStart,
    target,
    ...rest
  },
  ref,
) {
  const { location } = useRoute();
  const targetPath = pathnameOf(to);
  const active = targetPath !== null && targetPath === location.pathname;

  const warm = () => {
    if (prefetch) prefetchHref(to);
  };

  const handleClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    if (event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
    if (target && target !== "_self") return;
    if (rest.download !== undefined) return;
    if (!isInternalHref(to)) return;
    event.preventDefault();
    navigate(to, { replace });
  };

  return (
    <a
      ref={ref}
      href={to}
      target={target}
      aria-current={active ? "page" : undefined}
      className={[className, active ? activeClassName : undefined].filter(Boolean).join(" ") || undefined}
      onClick={handleClick}
      onMouseEnter={(event) => {
        onMouseEnter?.(event);
        warm();
      }}
      onFocus={(event) => {
        onFocus?.(event);
        warm();
      }}
      onTouchStart={(event) => {
        onTouchStart?.(event);
        warm();
      }}
      {...rest}
    />
  );
});
