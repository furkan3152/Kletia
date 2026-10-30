/** The registered slot components (journey ledger, questions); re-renders when one registers late. */
import { useSyncExternalStore } from "react";

import { getDeskSlots, subscribeDeskSlots, type DeskSlots } from "../tasks/slots";

export function useDeskSlots(): DeskSlots {
  return useSyncExternalStore(subscribeDeskSlots, getDeskSlots, getDeskSlots);
}
