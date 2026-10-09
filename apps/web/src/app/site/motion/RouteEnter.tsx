import React, { useState } from "react";

export interface RouteEnterProps {
  /** Changes on every route change; each value mounts a fresh wrapper. */
  readonly routeKey: string;
  /** Fade the page in when it mounts (false for the initial load). */
  readonly animate: boolean;
  readonly children: React.ReactNode;
}

function EnterFrame({ animate, children }: { readonly animate: boolean; readonly children: React.ReactNode }) {
  // Decided once per mount: if a View Transition is animating this swap, the
  // CSS fallback must not run on top of it (and must not start later either).
  const [enter] = useState(
    () => animate && typeof document !== "undefined" && !document.documentElement.dataset.klVt,
  );
  return <div className={enter ? "kl-page kl-route-enter" : "kl-page"}>{children}</div>;
}

/**
 * Page wrapper for site routes. `.kl-page` gets a `view-transition-name`
 * only while a route View Transition runs; without one, a new page fades in
 * (opacity only: the wrapper never gets a transform, so `position: fixed`
 * descendants keep working). Reduced motion: no animation.
 */
export function RouteEnter({ routeKey, animate, children }: RouteEnterProps) {
  return (
    <EnterFrame key={routeKey} animate={animate}>
      {children}
    </EnterFrame>
  );
}
