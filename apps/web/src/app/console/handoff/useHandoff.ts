/**
 * Takes the hand-off waiting for this view: the sentence the desk
 * read as a perps trade, a native order or an automation prefills the view's
 * form once. Nothing is quoted, prepared or signed until the person does it
 * in the view.
 */
import { useEffect } from "react";
import type { IntentHandoff } from "@kletia/core";
import { getDeskStore, useDeskStore } from "../state/deskStore";

export function useHandoff(surface: IntentHandoff["surface"], onHandoff: (handoff: IntentHandoff) => void): void {
  const pending = useDeskStore((state) => state.pendingHandoff);
  useEffect(() => {
    if (!pending || pending.surface !== surface) return;
    const taken = getDeskStore().getState().takeHandoff(surface);
    if (taken) onHandoff(taken);
  }, [pending, surface, onHandoff]);
}
