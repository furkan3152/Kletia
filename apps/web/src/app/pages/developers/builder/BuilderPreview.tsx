import { mountKletiaIntent, type MountedKletiaIntent } from "@kletia/embed";
import { useEffect, useRef, useState } from "react";

import { Link } from "../../../routes/Link";
import { cx, FOCUS_RING, INK_BORDER, TEXT_MUTED } from "../../../site/ui/styles";
import { PREVIEW_SANDBOX_NOTE, previewErrorHint } from "./builderModel";

export type PreviewWidth = "360" | "480" | "fluid";

interface PreviewEvent {
  readonly id: number;
  readonly text: string;
}

/**
 * The live preview: this deployment's real `/embed`, framed by the portal
 * through `<kletia-intent>` (the portal is the host, so the bridge connects
 * and the element's events are listed). Settings changes are debounced and
 * remount the element, the way a partner page's attribute change reloads it.
 */
export function BuilderPreview({
  options,
  width,
  pageColor,
  height,
  webOrigin = typeof window === "undefined" ? "https://kletiaai.xyz" : window.location.origin,
}: {
  options: Readonly<Record<string, string | number>>;
  width: PreviewWidth;
  pageColor: string | null;
  height: number;
  /** This site's origin: the origin a publishable key's project must allow for the preview to run (default: this page's). */
  webOrigin?: string;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const [events, setEvents] = useState<readonly PreviewEvent[]>([]);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const key = JSON.stringify(options);
  const hint = errorCode ? previewErrorHint(errorCode, webOrigin) : null;

  useEffect(() => {
    const target = host.current;
    if (!target) return undefined;
    let mounted: MountedKletiaIntent | null = null;
    let counter = 0;
    const log = (text: string) => setEvents((list) => [{ id: (counter += 1), text }, ...list].slice(0, 6));
    const timer = window.setTimeout(() => {
      setEvents([]);
      setErrorCode(null);
      try {
        mounted = mountKletiaIntent(target, {
          ...(JSON.parse(key) as Record<string, string | number>),
          label: "Embed builder preview",
          onReady: (detail) => log(`ready · ${detail.height} px`),
          onIntentPlanned: (detail) => log(`intent-planned · ${detail.status}`),
          onIntentCreated: (detail) => log(`intent-created · ${detail.status}`),
          onQuestion: (detail) => log(`question · ${detail.count}${detail.reasons.length > 0 ? ` · ${detail.reasons.join(", ")}` : ""}`),
          onCompleted: (detail) => log(`completed · ${detail.status}`),
          onError: (detail) => {
            log(`error · ${detail.code}`);
            setErrorCode(detail.code);
          },
        });
      } catch (error) {
        log(`error · ${error instanceof Error ? error.message : "the preview could not start"}`);
      }
    }, 300);
    return () => {
      window.clearTimeout(timer);
      mounted?.destroy();
    };
  }, [key]);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className={cx("min-w-0 overflow-hidden p-3 sm:p-4", INK_BORDER)} style={{ background: pageColor ?? "transparent" }}>
        <div
          ref={host}
          className="mx-auto w-full"
          style={{ maxWidth: width === "fluid" ? "100%" : `${width}px`, minHeight: Math.min(height, 720) }}
          aria-label="Widget preview"
          role="region"
        />
      </div>
      {hint ? (
        <p role="note" className="border-l-[3px] border-[#B45309] pl-3 text-sm">
          {hint}{" "}
          <Link to="/developers/project" className={cx("font-bold underline decoration-2 underline-offset-2", FOCUS_RING)}>
            Project settings
          </Link>
        </p>
      ) : null}
      <div>
        <p className={cx("text-xs font-bold uppercase tracking-[0.12em]", TEXT_MUTED)}>Events</p>
        <ul aria-live="polite" className="mt-1 flex flex-col gap-0.5 font-code text-xs">
          {events.length === 0 ? <li className={TEXT_MUTED}>Waiting for the frame…</li> : null}
          {events.map((event) => (
            <li key={event.id}>{event.text}</li>
          ))}
        </ul>
      </div>
      <p className={cx("text-xs", TEXT_MUTED)}>{PREVIEW_SANDBOX_NOTE}</p>
    </div>
  );
}
