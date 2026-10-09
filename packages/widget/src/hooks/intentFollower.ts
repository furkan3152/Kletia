/**
 * Framework-neutral follower behind `useIntent`: keeps one intent current
 * through `watchIntent` (event stream with Last-Event-ID resume, polling
 * while the stream is unavailable) until it reaches a terminal status.
 */
import type { AnyKletiaEvent, IntentGraph } from "@kletia/core";
import { isIntentTerminal, watchIntent, type KletiaClient } from "@kletia/sdk";
import { createStore } from "./store.js";

export type IntentFollowStatus = "idle" | "loading" | "live" | "polling" | "done" | "error";

export interface IntentFollowState {
  readonly status: IntentFollowStatus;
  readonly intent: IntentGraph | null;
  readonly error: unknown;
  /** The last stream event seen; a remount resumes after it. */
  readonly lastEvent: AnyKletiaEvent | null;
}

export interface IntentFollower {
  getState(): IntentFollowState;
  subscribe(listener: () => void): () => void;
  /** Follows `intentId` (null stops). Following the same id again does nothing. */
  follow(intentId: string | null): void;
  /** Starts accepting work (mount); the returned function stops following (unmount). */
  attach(): () => void;
}

export interface IntentFollowerOptions {
  /** Poll interval while the stream is unavailable (default 4000 ms). */
  readonly pollIntervalMs?: number;
  /** Called for every new stream event. */
  readonly onEvent?: (event: AnyKletiaEvent) => void;
}

const IDLE: IntentFollowState = Object.freeze({ status: "idle", intent: null, error: null, lastEvent: null });

export function createIntentFollower(client: KletiaClient, options: IntentFollowerOptions = {}): IntentFollower {
  const store = createStore<IntentFollowState>(IDLE);
  let attached = 0;
  let current: string | null = null;
  let controller: AbortController | null = null;
  /** Last event id per intent, kept across remounts for Last-Event-ID resume. */
  const resumeAfter = new Map<string, string>();

  const stop = () => {
    controller?.abort();
    controller = null;
  };

  const start = (intentId: string) => {
    stop();
    const mine = new AbortController();
    controller = mine;
    const live = () => !mine.signal.aborted && current === intentId;
    const previous = store.getState();
    store.setState({
      status: previous.intent?.id === intentId && previous.intent && isIntentTerminal(previous.intent) ? "done" : "loading",
      intent: previous.intent?.id === intentId ? previous.intent : null,
      error: null,
      lastEvent: previous.intent?.id === intentId ? previous.lastEvent : null,
    });
    const resume = resumeAfter.get(intentId);
    watchIntent(client, intentId, {
      signal: mine.signal,
      ...(resume ? { lastEventId: resume } : {}),
      ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
      onUpdate: (intent) => {
        if (!live()) return;
        const state = store.getState();
        store.setState({ ...state, intent, status: isIntentTerminal(intent) ? "done" : state.status === "loading" ? "polling" : state.status });
      },
      onTransport: (transport) => {
        if (!live()) return;
        const state = store.getState();
        if (state.status === "done" || state.status === "error") return;
        store.setState({ ...state, status: transport === "stream" ? "live" : state.intent ? "polling" : "loading" });
      },
      onEvent: (event) => {
        if (!live()) return;
        resumeAfter.set(intentId, event.id);
        if (resumeAfter.size > 50) resumeAfter.delete(resumeAfter.keys().next().value as string);
        store.setState({ ...store.getState(), lastEvent: event });
        options.onEvent?.(event);
      },
    }).then(
      (intent) => {
        if (live()) store.setState({ ...store.getState(), intent, status: "done", error: null });
      },
      (error: unknown) => {
        if (live()) store.setState({ ...store.getState(), status: "error", error });
      },
    );
  };

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    follow: (intentId) => {
      if (attached === 0 || intentId === current) return;
      current = intentId;
      if (intentId === null) {
        stop();
        store.setState(IDLE);
        return;
      }
      start(intentId);
    },
    attach: () => {
      attached += 1;
      let detached = false;
      return () => {
        if (detached) return;
        detached = true;
        attached -= 1;
        if (attached > 0) return;
        stop();
        // Forget the id so a remount follows it again (resuming after the last event).
        current = null;
      };
    },
  };
}
