import React, { useCallback, useEffect, useState } from "react";

export interface InViewOptions {
  /** Stop observing after the element first enters the viewport (default false). */
  readonly once?: boolean;
  /** IntersectionObserver rootMargin (default "0px"). */
  readonly rootMargin?: string;
  /** IntersectionObserver threshold (default 0). */
  readonly threshold?: number | readonly number[];
}

type EntryListener = (entry: IntersectionObserverEntry) => void;

interface SharedObserver {
  readonly observer: IntersectionObserver;
  readonly listeners: Map<Element, Set<EntryListener>>;
}

const observers = new Map<string, SharedObserver>();

export function supportsIntersectionObserver(): boolean {
  return typeof window !== "undefined" && typeof window.IntersectionObserver === "function";
}

/**
 * Observes `element` with one IntersectionObserver shared by every caller
 * that uses the same (rootMargin, threshold) pair. Returns an unsubscribe
 * function. Without IntersectionObserver it does nothing (callers treat the
 * element as visible).
 */
export function observeIntersection(
  element: Element,
  listener: EntryListener,
  options: { rootMargin?: string; threshold?: number | readonly number[] } = {},
): () => void {
  if (!supportsIntersectionObserver()) return () => undefined;
  const rootMargin = options.rootMargin ?? "0px";
  const threshold = options.threshold ?? 0;
  const key = `${rootMargin}|${Array.isArray(threshold) ? threshold.join(",") : String(threshold)}`;
  let shared = observers.get(key);
  if (!shared) {
    const listeners = new Map<Element, Set<EntryListener>>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const set = listeners.get(entry.target);
          if (!set) continue;
          for (const callback of [...set]) callback(entry);
        }
      },
      { rootMargin, threshold: threshold as number | number[] },
    );
    shared = { observer, listeners };
    observers.set(key, shared);
  }
  const { observer, listeners } = shared;
  let set = listeners.get(element);
  if (!set) {
    set = new Set();
    listeners.set(element, set);
    observer.observe(element);
  }
  set.add(listener);
  return () => {
    const current = listeners.get(element);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) {
      listeners.delete(element);
      observer.unobserve(element);
    }
  };
}

/**
 * `[ref, inView]` for an element. Uses a shared observer per option pair.
 * Without IntersectionObserver it reports `true`, so content is shown and
 * one-shot animations may run once.
 */
export function useInView<T extends Element>(options: InViewOptions = {}): readonly [React.RefCallback<T>, boolean] {
  const { once = false, rootMargin, threshold } = options;
  const [element, setElement] = useState<T | null>(null);
  const [inView, setInView] = useState(() => !supportsIntersectionObserver());
  const thresholdKey = Array.isArray(threshold) ? threshold.join(",") : threshold;

  const ref = useCallback((node: T | null) => setElement(node), []);

  useEffect(() => {
    if (!element) return undefined;
    let stop: () => void = () => undefined;
    stop = observeIntersection(
      element,
      (entry) => {
        setInView(entry.isIntersecting);
        if (once && entry.isIntersecting) stop();
      },
      { rootMargin, threshold: parseThreshold(thresholdKey) },
    );
    return () => stop();
    // `inView` is not a dependency: a `once` observer must not re-subscribe after it fired.
  }, [element, once, rootMargin, thresholdKey]);

  return [ref, inView] as const;
}

function parseThreshold(value: string | number | undefined): number | number[] | undefined {
  if (value === undefined || typeof value === "number") return value;
  return value.split(",").map(Number);
}
