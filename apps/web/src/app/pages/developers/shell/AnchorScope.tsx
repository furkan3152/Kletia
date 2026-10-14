import React, { useMemo } from "react";

import { RouterContext } from "../../../routes/routerContext";
import { useRoute } from "../../../routes/useRoute";

/**
 * A bridge for components that still read their state from a `#` anchor
 * (the API explorer's `#op-<id>`, the recipes' `#recipe-<id>`): inside this
 * scope they see the page's path parameter as that anchor, so
 * `/developers/api/getIntent` opens getIntent. The URL itself never changes.
 * Pages drop it once their component reads the path.
 */
export function AnchorScope({ hash, children }: { readonly hash: string | null; readonly children: React.ReactNode }) {
  const state = useRoute();
  const value = useMemo(() => (hash === null ? state : { ...state, location: { ...state.location, hash } }), [state, hash]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}
