/**
 * The live provider: OpenRouter chat completions with structured output. Each
 * profile pins its serving provider (`provider.only`, no fallbacks) and asks
 * no fallbacks) with zero data retention and no data collection; reasoning
 * is off. The key comes from OPENROUTER_API_KEY and is never logged or echoed;
 * errors carry codes only.
 */
import type { ReadingAnswer, ReadingCall, ReadingProvider } from "./provider.js";
import { ReadingTransportError } from "./provider.js";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export function openRouterProvider(apiKey: string, fetchImpl: typeof fetch = fetch): ReadingProvider {
  return {
    kind: "openrouter",
    async call(call: ReadingCall): Promise<ReadingAnswer> {
      const body = {
        model: call.profile.model,
        messages: [
          { role: "system", content: call.system },
          { role: "user", content: call.user },
        ],
        response_format: { type: "json_schema", json_schema: { name: call.purpose, strict: true, schema: call.schema } },
        provider: { only: [call.profile.provider], allow_fallbacks: false, data_collection: "deny", zdr: true, require_parameters: true },
        reasoning: { enabled: false },
        max_tokens: 400,
        ...(call.profile.temperature !== undefined ? { temperature: call.profile.temperature } : {}),
        ...(call.profile.seed !== undefined ? { seed: call.profile.seed } : {}),
      };
      let response: Response;
      try {
        response = await fetchImpl(ENDPOINT, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "x-title": "Kletia" },
          body: JSON.stringify(body),
          signal: call.signal,
        });
      } catch {
        throw new ReadingTransportError(call.signal.aborted ? "timeout" : "transport");
      }
      if (!response.ok) throw new ReadingTransportError(`http_${response.status}`, response.status);
      let json: unknown;
      try {
        json = await response.json();
      } catch {
        throw new ReadingTransportError("invalid_body");
      }
      const record = json as { choices?: { message?: { content?: unknown } }[]; provider?: unknown };
      const text = record.choices?.[0]?.message?.content;
      if (typeof text !== "string") throw new ReadingTransportError("invalid_body");
      return { text, ...(typeof record.provider === "string" ? { servedProvider: record.provider } : {}) };
    },
  };
}
