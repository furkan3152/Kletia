import { RadioTower } from "lucide-react";
import { useEffect, useLayoutEffect, useState } from "react";

import type { BridgeSnapshot, EmbedBridge } from "./embedBridge";

/** How long the reserved notice space waits for the host's connect before it collapses. */
const RESERVE_MS = 30_000;

function hostLabel(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

export interface EmbedBridgeNoticeProps {
  readonly bridge: EmbedBridge;
  readonly snapshot: BridgeSnapshot;
  /** The origin the host claimed in the URL; the connect can only come from it. */
  readonly expectedOrigin: string;
}

/**
 * Tells the visitor that the embedding site receives progress updates. The
 * space is reserved (invisible) from the first paint so nothing shifts when
 * the host connects; it collapses if the host never does. The bridge shares
 * intent ids only while this notice is on screen.
 */
export function EmbedBridgeNotice({ bridge, snapshot, expectedOrigin }: EmbedBridgeNoticeProps) {
  const connected = snapshot.status === "connected";
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    if (connected) return undefined;
    const timer = window.setTimeout(() => setExpired(true), RESERVE_MS);
    return () => window.clearTimeout(timer);
  }, [connected]);

  useLayoutEffect(() => {
    if (!connected) return undefined;
    bridge.setNoticeVisible(true);
    return () => bridge.setNoticeVisible(false);
  }, [bridge, connected]);

  if (!connected && expired) return null;
  const host = hostLabel(snapshot.origin ?? expectedOrigin);

  return (
    <p
      role={connected ? "status" : undefined}
      aria-hidden={connected ? undefined : true}
      className={`flex items-start gap-2 border-[3px] border-[#1A1A1A] bg-[#E6EEFF] px-2.5 py-2 text-xs font-semibold leading-snug text-[#1A1A1A] dark:border-[#4B5563] dark:bg-[#111C33] dark:text-[#E2E8F0] ${
        connected ? "kl-fade-in" : "invisible"
      }`}
    >
      <RadioTower className="mt-px h-3.5 w-3.5 shrink-0 text-[#0052FF] dark:text-[#7EA6FF]" aria-hidden="true" />
      <span>
        <span className="break-all font-black">{host}</span> is notified of your intent&apos;s progress and can look up
        the intents you create here.
      </span>
    </p>
  );
}
