import { HOST_ORIGIN_HEADER } from "@kletia/core";
import { KletiaClient } from "@kletia/sdk";

import { BACKEND_URL } from "../../../shared/config/runtime";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function isIntentCreate(url: URL, init: RequestInit | undefined): boolean {
  return (
    (init?.method ?? "GET").toUpperCase() === "POST" &&
    url.pathname.replace(/\/+$/u, "").endsWith("/v1/intents")
  );
}

/** A project's publishable key and the host origin the bridge proved (phase 2). */
export interface EmbedClientProject {
  readonly publishableKey: string;
  /** Sent as `Kletia-Host-Origin`: the API checks it against the project's allowed origins. */
  readonly hostOrigin: string;
}

/**
 * Client for the embed. Never carries a secret API key: the public tier, or
 * with `project` the project's publishable key (`kl_pub_…`) plus the
 * bridge-proven host origin in `Kletia-Host-Origin`, so the API can tell the
 * frame runs on a site the project allowed. The SDK refuses server-only calls
 * for a publishable key before sending anything.
 *
 * In `plan` mode (no wallet connected) every `POST /v1/intents` is sent as a
 * dry run: the widget can show a plan for the demo accounts without
 * persisting anything, and it cannot execute (no signers are passed).
 */
export function createEmbedClient(mode: "plan" | "live", project?: EmbedClientProject | null): KletiaClient {
  const fetchImpl: FetchLike = (input, init) => {
    if (mode === "plan") {
      try {
        const url = new URL(input);
        if (isIntentCreate(url, init)) {
          url.searchParams.set("dryRun", "true");
          return globalThis.fetch(url.toString(), init);
        }
      } catch {
        // Fall through with the original request.
      }
    }
    return globalThis.fetch(input, init);
  };
  return new KletiaClient({
    baseUrl: BACKEND_URL,
    timeoutMs: 15_000,
    fetch: fetchImpl,
    ...(project ? { publishableKey: project.publishableKey, headers: { [HOST_ORIGIN_HEADER]: project.hostOrigin } } : {}),
  });
}
