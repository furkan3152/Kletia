import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { EASE } from "../motion/tokens";
import { usePageVisible } from "../motion/usePageVisible";
import { useReducedMotion } from "../motion/useReducedMotion";
import { cx, FOCUS_RING } from "./styles";
import { getToasts, subscribeToasts, toast as toastApi, visibleToasts, type ToastRecord, type ToastTone } from "./toast";

export interface ToasterProps {
  /** "site": bottom-right (full width at the bottom on phones). "console": top-right below the navbar. */
  readonly placement?: "site" | "console";
}

/** Card machine toast plate: a dark slot with a lime icon tile; magenta for errors, amber for warnings. */
const TONES: Record<ToastTone, { stripe: string; icon: typeof Info; iconClass: string; label: string }> = {
  success: { stripe: "#C6FF3A", icon: CircleCheck, iconClass: "bg-[#C6FF3A] text-[#121212]", label: "Success" },
  error: { stripe: "#FF3D9A", icon: CircleAlert, iconClass: "bg-[#FF3D9A] text-[#121212]", label: "Error" },
  info: { stripe: "#C6FF3A", icon: Info, iconClass: "bg-[#C6FF3A] text-[#121212]", label: "Info" },
  warning: { stripe: "#FBBF24", icon: TriangleAlert, iconClass: "bg-[#FBBF24] text-[#121212]", label: "Warning" },
};

function announcement(toast: ToastRecord): string {
  return toast.description ? `${toast.title}. ${toast.description}` : toast.title;
}

interface ToastItemProps {
  readonly toast: ToastRecord;
  readonly pageVisible: boolean;
}

function ToastItem({ toast, pageVisible }: ToastItemProps) {
  const [held, setHeld] = useState(false);
  const persistent = toast.duration === "persistent";
  const duration = persistent ? 0 : (toast.duration as number);
  const halted = held || !pageVisible || toast.leaving || persistent;
  const remainingRef = useRef(duration);
  const revisionRef = useRef(toast.revision);
  const tone = TONES[toast.tone];
  const Icon = tone.icon;

  useEffect(() => {
    if (revisionRef.current !== toast.revision) {
      revisionRef.current = toast.revision;
      remainingRef.current = duration;
    }
    if (halted) return undefined;
    const startedAt = performance.now();
    const timer = window.setTimeout(() => toastApi.dismiss(toast.id), Math.max(0, remainingRef.current));
    return () => {
      window.clearTimeout(timer);
      remainingRef.current -= performance.now() - startedAt;
    };
  }, [halted, toast.id, toast.revision, duration]);

  return (
    <li
      data-toast-id={toast.id}
      data-leaving={toast.leaving ? "" : undefined}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHeld(false);
      }}
      className={cx(
        "kl-toast pointer-events-auto relative flex overflow-hidden rounded-[12px] bg-[#161616] text-[#F2F0EA] shadow-[0_4px_0_#000,0_20px_40px_-12px_rgba(0,0,0,.45)] dark:bg-black dark:shadow-[0_4px_0_#2A2A30,0_20px_40px_-12px_rgba(0,0,0,.6)]",
        toast.leaving && "kl-toast--leaving",
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3 py-3 pl-3.5">
        <span aria-hidden="true" className={cx("grid h-7 w-7 shrink-0 place-items-center rounded-[8px]", tone.iconClass)}>
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          {/* Announced through the live regions; hidden here so it is not read twice. */}
          <div aria-hidden={toast.silent ? undefined : true}>
            <p className="text-sm font-semibold leading-snug">{toast.title}</p>
            {toast.description ? (
              <p className="mt-0.5 text-[12.5px] leading-snug text-[#A9A69D]">{toast.description}</p>
            ) : null}
          </div>
          {toast.action ? (
            <button
              type="button"
              onClick={() => {
                toast.action?.onClick();
                toastApi.dismiss(toast.id);
              }}
              className={cx(
                "mt-2 inline-flex min-h-9 items-center rounded-[8px] border border-[#88B514] bg-[#C6FF3A] px-3 py-1 text-[13px] font-semibold text-[#121212] shadow-[inset_0_1px_0_rgba(255,255,255,.75),0_3px_0_#88B514] transition-[transform,box-shadow] duration-60 ease-mech active:translate-y-[3px] active:shadow-[0_1px_0_#88B514]",
                FOCUS_RING,
              )}
            >
              {toast.action.label}
            </button>
          ) : null}
        </div>
      </div>
      <button
        type="button"
        onClick={() => toastApi.dismiss(toast.id)}
        className={cx(
          "inline-flex h-11 w-11 shrink-0 items-center justify-center text-[#F2F0EA] hover:bg-white/10",
          FOCUS_RING,
          "focus-visible:-outline-offset-4",
        )}
      >
        <X className="h-4 w-4" aria-hidden="true" />
        <span className="sr-only">Dismiss notification: {toast.title}</span>
      </button>
      {persistent ? null : (
        <span
          key={toast.revision}
          aria-hidden="true"
          className="kl-toast-timer absolute inset-x-0 bottom-0 h-[3px] origin-left"
          style={{
            backgroundColor: tone.stripe,
            animationDuration: `${duration}ms`,
            animationPlayState: halted ? "paused" : "running",
          }}
        />
      )}
    </li>
  );
}

/**
 * Renders the toast queue: at most three cards, the rest wait. Mounted once
 * by the router (lazily, never on `/embed`). Info, success and warning are
 * announced in a polite status region, errors in an alert region; `silent`
 * toasts are only visual. Hovering or focusing a toast pauses its timer, and
 * Escape dismisses the newest toast while focus is inside the stack.
 */
export function Toaster({ placement = "site" }: ToasterProps) {
  const all = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  const pageVisible = usePageVisible();
  const reduced = useReducedMotion();
  // Empty live regions first, then the queue: screen readers only announce
  // insertions into regions that already exist.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setReady(true), 100);
    return () => window.clearTimeout(timer);
  }, []);
  const visible = ready ? visibleToasts(all) : [];
  const spoken = visible.filter((toast) => !toast.silent && !toast.leaving);

  const listRef = useRef<HTMLOListElement | null>(null);
  const positionsRef = useRef(new Map<string, number>());
  const idsKey = visible.map((toast) => toast.id).join("|");

  // Smoothly move the remaining toasts when one leaves (FLIP, transform only).
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) {
      positionsRef.current = new Map();
      return;
    }
    const next = new Map<string, number>();
    for (const child of Array.from(list.children) as HTMLElement[]) {
      const id = child.dataset.toastId;
      if (!id) continue;
      const top = child.offsetTop;
      next.set(id, top);
      const before = positionsRef.current.get(id);
      if (before !== undefined && before !== top && !reduced && typeof child.animate === "function") {
        child.animate([{ transform: `translateY(${before - top}px)` }, { transform: "translateY(0)" }], {
          duration: 240,
          easing: EASE.standard,
        });
      }
    }
    positionsRef.current = next;
  }, [idsKey, reduced]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    const newest = [...visible].reverse().find((toast) => !toast.leaving);
    if (!newest) return;
    event.stopPropagation();
    toastApi.dismiss(newest.id);
  };

  const position =
    placement === "console"
      ? "top-[84px] sm:left-auto sm:right-4 sm:w-[22rem]"
      : "bottom-[max(1rem,env(safe-area-inset-bottom))] sm:left-auto sm:right-4 sm:w-[22rem]";

  return (
    <>
      <div className="sr-only" role="status" aria-live="polite">
        {spoken
          .filter((toast) => toast.tone !== "error")
          .map((toast) => (
            <p key={`${toast.id}:${toast.revision}`}>{announcement(toast)}</p>
          ))}
      </div>
      <div className="sr-only" role="alert">
        {spoken
          .filter((toast) => toast.tone === "error")
          .map((toast) => (
            <p key={`${toast.id}:${toast.revision}`}>{announcement(toast)}</p>
          ))}
      </div>
      {visible.length > 0 ? (
        <section
          aria-label="Notifications"
          onKeyDown={onKeyDown}
          className={cx("pointer-events-none fixed inset-x-4 z-[80] font-body", position)}
        >
          <ol ref={listRef} className="flex flex-col gap-3">
            {visible.map((toast) => (
              <ToastItem key={toast.id} toast={toast} pageVisible={pageVisible} />
            ))}
          </ol>
        </section>
      ) : null}
    </>
  );
}

export default Toaster;
