import React from "react";

export interface LazyBoundaryProps {
  /** Rendered instead of the children once they failed to load or render. */
  readonly fallback: (reload: () => void) => React.ReactNode;
  /** Changing this value clears a caught error (e.g. a new route or intent). */
  readonly resetKey?: unknown;
  readonly children: React.ReactNode;
}

interface LazyBoundaryState {
  readonly failed: boolean;
  readonly resetKey: unknown;
}

function reloadPage(): void {
  try {
    window.location.reload();
  } catch {
    // Reloading is best effort (sandboxed frames may refuse it).
  }
}

/**
 * Error boundary for lazily loaded surfaces (wallet panels, the embed wallet
 * bar, route chunks). A chunk that fails to download (offline, a deploy that
 * replaced hashed files) or a panel that throws while rendering degrades to
 * `fallback` instead of unmounting the whole page.
 *
 * React.lazy caches a failed import, so the fallback offers a page reload
 * rather than an in-place retry.
 */
export class LazyBoundary extends React.Component<LazyBoundaryProps, LazyBoundaryState> {
  state: LazyBoundaryState = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(): Partial<LazyBoundaryState> {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: LazyBoundaryProps, state: LazyBoundaryState): Partial<LazyBoundaryState> | null {
    if (props.resetKey !== state.resetKey) return { failed: false, resetKey: props.resetKey };
    return null;
  }

  componentDidCatch(error: unknown): void {
    if (import.meta.env.DEV) console.warn("[kletia] lazy surface failed", error);
  }

  render(): React.ReactNode {
    return this.state.failed ? this.props.fallback(reloadPage) : this.props.children;
  }
}

export default LazyBoundary;
