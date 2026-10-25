/**
 * The desk powers on: on the first desk open of the session
 * the nameplate light sweeps (1.1 s), the dial spins in from -150 deg with detent clicks, the
 * rail and panel modules click in (80-90 ms stagger, back.out(2)), the LCD rows light, and the
 * `boot` sound plays (only after a gesture, like every sound). Once per session, never under
 * reduced motion, and skippable: any key or click, or the topbar's "Skip start-up", ends it.
 */
import { useLayoutEffect, useRef, useState, type RefObject } from "react";

import { EASE, reducedMotion, timeline, type Timeline } from "../../../kit/motion";
import { playSound } from "../../../kit/sound";

export const BOOT_SESSION_KEY = "kletia-desk-booted";

let decided: boolean | null = null;

/** Whether the desk already booted in this tab session (decided once per page load). */
function bootedThisSession(): boolean {
  if (decided !== null) return decided;
  decided = readAndMark();
  return decided;
}

function readAndMark(): boolean {
  try {
    if (window.sessionStorage.getItem(BOOT_SESSION_KEY)) return true;
    window.sessionStorage.setItem(BOOT_SESSION_KEY, "1");
    return false;
  } catch {
    return true;
  }
}

export function useBoot(shell: RefObject<HTMLElement | null>): { readonly booting: boolean; readonly skip: () => void } {
  const [booting, setBooting] = useState(() => typeof window !== "undefined" && !reducedMotion() && !bootedThisSession());
  const tl = useRef<Timeline | null>(null);

  const skip = () => {
    tl.current?.finish();
    tl.current = null;
    for (const animation of shell.current?.getAnimations({ subtree: true }) ?? []) {
      try {
        animation.finish();
      } catch {
        animation.cancel();
      }
    }
    setBooting(false);
  };

  useLayoutEffect(() => {
    const root = shell.current;
    if (!booting || !root) return undefined;
    // Later desk opens in this page load (leaving the desk and coming back) do not boot again.
    decided = true;
    const rail = [...root.querySelectorAll(".kd-machine-rail [data-boot-part]")];
    const panel = [...root.querySelectorAll(".kd-mpanel [data-boot-part]")];
    const lcd = [...root.querySelectorAll(".k-lcd-row")];
    const t = timeline();
    t.call(() => playSound("boot"), 0);
    rail.forEach((element, index) => t.add(element, [{ transform: "translateY(-10px)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 450, easing: EASE.back(2), delay: 200 + index * 80 }, 0));
    panel.forEach((element, index) => t.add(element, [{ transform: "translateY(-12px)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 450, easing: EASE.back(2), delay: 300 + index * 90 }, 0));
    lcd.forEach((element, index) => t.add(element, [{ opacity: 0 }, { opacity: 1 }], { duration: 50, delay: 550 + index * 120, easing: "steps(1, end)" }, 0));
    for (const at of [350, 500, 620]) t.call(() => playSound("tick", 0.6), at);
    for (const at of [350, 440, 530, 620]) t.call(() => playSound("key", 0.25), at);
    tl.current = t;
    let ended = false;
    void t.play().then(() => {
      if (!ended) setBooting(false);
    });
    const onInput = (event: Event) => {
      if (event instanceof KeyboardEvent && (event.key === "Tab" || event.key === "Shift")) return;
      skip();
    };
    window.addEventListener("keydown", onInput, { once: true });
    window.addEventListener("pointerdown", onInput, { once: true });
    return () => {
      ended = true;
      window.removeEventListener("keydown", onInput);
      window.removeEventListener("pointerdown", onInput);
    };
    // The boot plays once: only its first `booting` matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { booting, skip };
}
