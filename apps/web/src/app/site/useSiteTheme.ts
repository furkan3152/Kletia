import { useCallback, useEffect, useState } from "react";

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

  const toggle = useCallback(() => {
    const next: SiteTheme = theme === "dark" ? "light" : "dark";
    storeSiteTheme(next);
    setTheme(next);
  }, [theme]);

  return { theme, toggle };
}
