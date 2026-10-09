import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { KletiaClient } from "@kletia/sdk";
import { useKletiaClient } from "./context.js";
import { createIntentFollower, type IntentFollowState } from "./intentFollower.js";

export interface UseIntentOptions {
  /** Overrides the client from `KletiaProvider`. */
  readonly client?: KletiaClient;
  /** Poll interval while the event stream is unavailable (default 4000 ms). */
  readonly pollIntervalMs?: number;
}

/**
 * Follows an intent live: its event stream (resumed with Last-Event-ID after
 * reconnects and remounts), with polling while the stream is unavailable,
 * until a terminal status. `status` is `live` on the stream, `polling`
 * without it and `done` once terminal. Pass null to follow nothing.
 */
export function useIntent(intentId: string | null | undefined, options: UseIntentOptions = {}): IntentFollowState {
  const client = useKletiaClient(options.client);
  const pollIntervalMs = options.pollIntervalMs;
  const follower = useMemo(
    () => createIntentFollower(client, pollIntervalMs === undefined ? {} : { pollIntervalMs }),
    [client, pollIntervalMs],
  );
  useEffect(() => follower.attach(), [follower]);
  useEffect(() => {
    follower.follow(intentId ?? null);
  }, [follower, intentId]);
  return useSyncExternalStore(follower.subscribe, follower.getState, follower.getState);
}
