/**
 * The desk's document mode: the site's scrolling document and the site
 * theme (stored under "kletia-site-theme", the OS preference otherwise),
 * plus `data-kl-desk` on <html> for the desk's own rules. The entry calls
 * `enterDeskMode` before the first paint of /app, so the desk never
 * flashes the old console's dark shell; the desk leaves the mode when it
 * unmounts (a site route then enters site mode itself).
 *
 * Tiny and dependency-free apart from the site theme module: it ships in the
 * entry bundle.
 */
import { enterSiteMode, leaveSiteMode } from "../site/theme";

export const DESK_MODE_ATTRIBUTE = "data-kl-desk";

export function enterDeskMode(): void {
  enterSiteMode();
  document.documentElement.setAttribute(DESK_MODE_ATTRIBUTE, "");
  // The old console marked the document per workspace; the desk has none.
  document.documentElement.removeAttribute("data-network");
  document.documentElement.classList.remove("arc-mode");
}

export function leaveDeskMode(): void {
  document.documentElement.removeAttribute(DESK_MODE_ATTRIBUTE);
  leaveSiteMode();
}
