import { useContext } from "react";

import { getLocation, navigate } from "./history";
import { matchRoute } from "./routeTable";
import { RouterContext, type RouterState } from "./routerContext";

export { navigate };

/** Current location, matched route and pending state. Works outside the router too (read-only snapshot). */
export function useRoute(): RouterState {
  const state = useContext(RouterContext);
  if (state) return state;
  const location = getLocation();
  return { location, route: matchRoute(location.pathname), pending: false };
}
