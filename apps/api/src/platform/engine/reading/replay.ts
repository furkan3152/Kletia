/**
 * Replay of recorded provider answers: the CI default. A recording is keyed by
 * the model, its pinned provider, the prompt variant, the schema version, the
 * catalog hash and the masked text, so any of them changing invalidates it. A
 * missing recording throws `ReplayMissing` (tests fail on it); the eval counts
 * it as no proposal.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReadingAnswer, ReadingCall, ReadingProvider } from "./provider.js";
import { ReadingTransportError } from "./provider.js";
import { READING_SCHEMA_VERSION } from "./schema.js";

export interface Recording {
  readonly key: string;
  readonly model: string;
  readonly provider: string;
  readonly variant: string;
  readonly text: string;
  readonly servedProvider?: string;
}

export class ReplayMissing extends ReadingTransportError {
  constructor(readonly key: string) {
    super("replay_missing");
  }
}

export function recordingKey(call: Pick<ReadingCall, "profile" | "variant" | "user" | "purpose">, catalogHash: string): string {
  const parts = [call.purpose, call.profile.model, call.profile.provider, call.variant, READING_SCHEMA_VERSION, catalogHash, call.user];
  return `sha256:${createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex")}`;
}

/** Loads every `*.json` file of a directory (arrays of recordings). */
export function loadRecordings(dir: string): Recording[] {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  return files.flatMap((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as Recording[]);
}

export function replayProvider(recordings: readonly Recording[], catalogHash: string): ReadingProvider & { readonly missing: string[] } {
  const byKey = new Map(recordings.map((entry) => [entry.key, entry]));
  const missing: string[] = [];
  return {
    kind: "replay",
    missing,
    call(call): Promise<ReadingAnswer> {
      const key = recordingKey(call, catalogHash);
      const found = byKey.get(key);
      if (!found) {
        missing.push(key);
        return Promise.reject(new ReplayMissing(key));
      }
      return Promise.resolve({ text: found.text, ...(found.servedProvider ? { servedProvider: found.servedProvider } : {}) });
    },
  };
}
