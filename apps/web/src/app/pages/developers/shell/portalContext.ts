/**
 * What the portal shell offers its pages: open the key menu or the sections
 * drawer, the per-navigation focus key for the page H1, and the shared API
 * status. Outside the shell (a page rendered on its own) every action is a
 * no-op and nothing moves focus.
 */
import { createContext, useContext } from "react";

import type { PortalHealth } from "./usePortalHealth";

export interface PortalShellApi {
  /** Opens the key menu ("Load a key"). */
  readonly openKeyMenu: () => void;
  /** Opens the sections drawer (narrow screens). */
  readonly openSections: () => void;
  /**
   * Changes once per client-side navigation inside the portal: the page H1
   * takes focus (PageHeader `focusKey`). Null on the first page load and for
   * links to an anchor, which the router focuses instead.
   */
  readonly headingFocusKey: number | null;
  readonly health: PortalHealth | null;
}

export const PortalContext = createContext<PortalShellApi>({
  openKeyMenu: () => undefined,
  openSections: () => undefined,
  headingFocusKey: null,
  health: null,
});

export function usePortal(): PortalShellApi {
  return useContext(PortalContext);
}
