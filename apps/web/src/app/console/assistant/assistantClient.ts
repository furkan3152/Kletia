/**
 * Calls of /v1/assistant with the wallet's account session (the same
 * session as automations and developer accounts). Failures are PlatformErrors.
 */
import type { AssistantAnswer } from "@kletia/core";

import { accountRequest } from "../../pages/developers/keys/accountClient";
import { parseAnswer } from "./assistantModel";

export const assistantApi = {
  async ask(token: string, question: string, consent: string | null, signal?: AbortSignal): Promise<AssistantAnswer | null> {
    const body = await accountRequest<unknown>("/assistant/ask", {
      method: "POST",
      token,
      body: { question, ...(consent ? { model: "on", consent } : {}) },
      ...(signal ? { signal } : {}),
    });
    return parseAnswer(body);
  },
  consent: (token: string) => accountRequest<{ token: string; expiresAt: string }>("/assistant/consent", { method: "POST", token }),
};
