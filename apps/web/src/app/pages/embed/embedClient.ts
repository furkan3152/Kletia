import { KletiaClient } from "@kletia/sdk";

import { BACKEND_URL } from "../../../shared/config/runtime";
import { withContractPreparationBoundary } from "../../../shared/platform/contractExecutionBoundary";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function isIntentCreate(url: URL, init: RequestInit | undefined): boolean {
  return (
    (init?.method ?? "GET").toUpperCase() === "POST" &&
    url.pathname.replace(/\/+$/u, "").endsWith("/v1/intents")
  );
}

/**
 * Public-tier client for the embed. Never carries an API key.
 *
 * In `plan` mode (no wallet connected) every `POST /v1/intents` is sent as a
 * dry run: the widget can show a plan for the demo accounts without
 * persisting anything, and it cannot execute (no signers are passed).
 */
export function createEmbedClient(mode: "plan" | "live", integrationIntentId?: () => string | null): KletiaClient {
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
  const client = new KletiaClient({ baseUrl: BACKEND_URL, timeoutMs: 15_000, fetch: fetchImpl });
  return withContractPreparationBoundary(client, integrationIntentId ?? (() => null));
}
