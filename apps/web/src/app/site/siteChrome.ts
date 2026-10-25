/**
 * The site theme, shared with pages that draw their own chrome. The home page ("the machine at
 * full size") draws its own tape, header and base plate; SiteLayout leaves its header
 * and footer out on that route and hands the page the theme through this context.
 */
import { createContext, useContext } from "react";

import type { SiteTheme } from "./theme";

export interface SiteThemeState {
  readonly theme: SiteTheme;
  readonly toggle: (origin?: { x: number; y: number }) => void;
}

export const SiteThemeContext = createContext<SiteThemeState | null>(null);

/** The site theme and its toggle (light with a no-op outside SiteLayout). */
export function useSiteThemeState(): SiteThemeState {
  return useContext(SiteThemeContext) ?? { theme: "light", toggle: () => undefined };
}

/** Routes whose page draws its own header and footer. */
export const OWN_CHROME_ROUTES: ReadonlySet<string> = new Set(["home"]);
