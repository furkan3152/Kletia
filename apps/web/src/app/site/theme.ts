/**
 * Site theme and document mode. Tiny and dependency-free so the entry can
 * apply the stored theme before the first paint of a marketing route.
 *
 * The console keeps its own theme key ("kletia-theme"); the site uses
 * "kletia-site-theme" and defaults to the operating system preference.
 */

export type SiteTheme = "light" | "dark";

export const SITE_THEME_STORAGE_KEY = "kletia-site-theme";
const SITE_MODE_CLASS = "kletia-site";

export function readStoredSiteTheme(): SiteTheme | null {
  try {
    const value = window.localStorage.getItem(SITE_THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

export function storeSiteTheme(theme: SiteTheme) {
  try {
    window.localStorage.setItem(SITE_THEME_STORAGE_KEY, theme);
  } catch {
    // Storage can be blocked (private mode, policies); the choice then lasts for this page view.
  }
}

export function systemSiteTheme(): SiteTheme {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function preferredSiteTheme(): SiteTheme {
  return readStoredSiteTheme() ?? systemSiteTheme();
}

export function applySiteTheme(theme: SiteTheme) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
}

/** Switches the document into scrollable site mode and applies the site theme. */
export function enterSiteMode() {
  document.documentElement.classList.add(SITE_MODE_CLASS);
  applySiteTheme(preferredSiteTheme());
}

/** Restores the console's fixed, full-viewport document mode. */
export function leaveSiteMode() {
  const root = document.documentElement;
  root.classList.remove(SITE_MODE_CLASS);
  root.style.colorScheme = "";
}
