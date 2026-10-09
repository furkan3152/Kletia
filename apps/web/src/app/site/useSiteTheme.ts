import { useCallback, useEffect, useState } from "react";
import { flushSync } from "react-dom";

import { runViewTransition } from "./motion/viewTransition";
import {
  applySiteTheme,
  preferredSiteTheme,
  readStoredSiteTheme,
  storeSiteTheme,
  type SiteTheme,
} from "./theme";

/** Site theme state: stored choice, else the OS preference (followed live until the user picks). */
export function useSiteTheme() {
  const [theme, setTheme] = useState<SiteTheme>(() => preferredSiteTheme());

  useEffect(() => {
    applySiteTheme(theme);
  }, [theme]);

  useEffect(() => {
    let media: MediaQueryList;
    try {
      media = window.matchMedia("(prefers-color-scheme: dark)");
    } catch {
      return undefined;
    }
    const onChange = (event: MediaQueryListEvent) => {
      if (readStoredSiteTheme() === null) setTheme(event.matches ? "dark" : "light");
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  /**
   * Flips the theme. With View Transitions (and motion allowed) the new theme
   * is revealed as a circle growing from `origin` (the toggle button); without
   * them it swaps instantly.
   */
  const toggle = useCallback(
    (origin?: { x: number; y: number }) => {
      const next: SiteTheme = theme === "dark" ? "light" : "dark";
      storeSiteTheme(next);
      void runViewTransition(
        "theme",
        () => {
          flushSync(() => setTheme(next));
          applySiteTheme(next);
        },
        origin ? { origin } : {},
      );
    },
    [theme],
  );

  return { theme, toggle };
}
