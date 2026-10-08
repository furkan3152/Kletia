/**
 * Which API key created an intent, for webhook routing.
 *
 * The owner is recorded by the engine's intent store when the intent is
 * created (memory or Postgres), so events from intents created by another
 * instance or before a restart route too. Owners never change, so resolved
 * owners are cached in a bounded LRU.
 */
import { getIntentOwner } from "../index.js";

const MAX_REMEMBERED = 20_000;
const owners = new Map<string, string | null>();

function remember(intentId: string, ownerKeyId: string | null): void {
  owners.delete(intentId);
  owners.set(intentId, ownerKeyId);
  while (owners.size > MAX_REMEMBERED) {
    const oldest = owners.keys().next().value;
    if (oldest === undefined) break;
    owners.delete(oldest);
  }
}

/** Records the creator of an intent created through this API (null for keyless callers). */
export function rememberIntentOwner(intentId: string, ownerKeyId: string | undefined): void {
  remember(intentId, ownerKeyId ?? null);
}

/** The owning key id, null for public intents, undefined when not (yet) known or the store is unavailable. */
export async function resolveIntentOwner(intentId: string): Promise<string | null | undefined> {
  if (owners.has(intentId)) return owners.get(intentId) ?? null;
  let stored: string | null | undefined;
  try {
    stored = await getIntentOwner(intentId);
  } catch {
    return undefined;
  }
  if (stored !== undefined) remember(intentId, stored);
  return stored;
}
