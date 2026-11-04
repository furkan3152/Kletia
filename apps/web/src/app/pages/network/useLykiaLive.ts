import { useEffect, useState } from "react";

import { BACKEND_URL } from "../../../shared/config/runtime";
import { isPageVisible } from "../../site/motion/usePageVisible";
import type { LykiaLive } from "./networkData";
import { cachedLykia, LYKIA_CACHE_MS, loadLykia } from "./lykiaLive";

const LOADING: LykiaLive = { state: "loading", stats: null, health: null, at: null };

/** Lykia's live figures: the cached answer at once, then a fresh read every minute while the tab is visible. */
export function useLykiaLive(): LykiaLive {
  const [live, setLive] = useState<LykiaLive>(() => cachedLykia() ?? LOADING);
  useEffect(() => {
    let active = true;
    const read = () => {
      loadLykia({ relayOrigin: BACKEND_URL }).then((entry) => {
        if (active) setLive(entry);
      });
    };
    read();
    const timer = window.setInterval(() => {
      if (isPageVisible()) read();
    }, LYKIA_CACHE_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);
  return live;
}
