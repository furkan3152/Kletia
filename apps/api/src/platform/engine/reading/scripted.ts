/** A scripted provider for tests: answers each call with a function of the call (or throws). */
import type { ReadingAnswer, ReadingCall, ReadingProvider } from "./provider.js";

export type Script = (call: ReadingCall) => string | ReadingAnswer | Promise<string | ReadingAnswer>;

export function scriptedProvider(script: Script): ReadingProvider & { readonly calls: ReadingCall[] } {
  const calls: ReadingCall[] = [];
  return {
    kind: "scripted",
    calls,
    async call(call) {
      calls.push(call);
      const out = await script(call);
      return typeof out === "string" ? { text: out } : out;
    },
  };
}
