/**
 * Same-document View Transitions with a safe fallback. Tiny and dependency
 * free: the router imports it, so it ships in the entry chunk.
 */
import { prefersReducedMotion } from "./useReducedMotion";

export type ViewTransitionKind = "route" | "theme" | "filter";

interface ViewTransitionLike {
  readonly finished: Promise<unknown>;
  readonly ready: Promise<unknown>;
  readonly updateCallbackDone: Promise<unknown>;
}

type StartViewTransition = (update: () => void) => ViewTransitionLike;

function starter(): StartViewTransition | null {
  if (typeof document === "undefined") return null;
  const start = (document as Document & { startViewTransition?: unknown }).startViewTransition;
  return typeof start === "function" ? (start.bind(document) as StartViewTransition) : null;
}

export function supportsViewTransitions(): boolean {
  return starter() !== null;
}

let sequence = 0;

/**
 * Runs `update` inside `document.startViewTransition` when supported, the
 * page is visible and motion is allowed; otherwise calls it synchronously.
 * Sets `html[data-kl-vt=kind]` for the duration (it scopes the CSS) and
 * `--kl-vt-x` / `--kl-vt-y` from `origin` (viewport px). Never throws: an
 * aborted or skipped transition resolves, and `update` always runs exactly
 * once.
 */
export function runViewTransition(
  kind: ViewTransitionKind,
  update: () => void,
  options: { origin?: { x: number; y: number } } = {},
): Promise<void> {
  const start = starter();
  const visible = typeof document !== "undefined" && document.visibilityState !== "hidden";
  if (!start || !visible || prefersReducedMotion()) {
    try {
      update();
    } catch (error) {
      reportUpdateError(error);
    }
    return Promise.resolve();
  }

  const root = document.documentElement;
  const token = (sequence += 1);
  root.dataset.klVt = kind;
  if (options.origin) {
    root.style.setProperty("--kl-vt-x", `${Math.round(options.origin.x)}px`);
    root.style.setProperty("--kl-vt-y", `${Math.round(options.origin.y)}px`);
  }
  const cleanup = () => {
    // A newer transition owns the attribute now; leave it alone.
    if (token !== sequence) return;
    delete root.dataset.klVt;
    root.style.removeProperty("--kl-vt-x");
    root.style.removeProperty("--kl-vt-y");
  };

  let ran = false;
  const guardedUpdate = () => {
    if (ran) return;
    ran = true;
    try {
      update();
    } catch (error) {
      reportUpdateError(error);
    }
  };

  let transition: ViewTransitionLike;
  try {
    transition = start(guardedUpdate);
  } catch {
    guardedUpdate();
    cleanup();
    return Promise.resolve();
  }
  // A skipped transition rejects `ready`; that is expected, not an error.
  transition.ready.catch(() => undefined);
  transition.updateCallbackDone.catch(() => undefined);
  return transition.finished.then(
    () => cleanup(),
    () => {
      guardedUpdate();
      cleanup();
    },
  );
}

function reportUpdateError(error: unknown) {
  // Surface the bug without breaking navigation.
  if (typeof queueMicrotask === "function") {
    queueMicrotask(() => {
      throw error;
    });
  }
}
