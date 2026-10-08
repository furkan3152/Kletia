/**
 * Which API key created an intent, for webhook routing.
 *
 * The engine's public service API does not expose the owner of a stored
 * intent, so the HTTP layer remembers owners of intents it created (bounded
 * LRU) and, when the engine stores intents in Postgres, falls back to the
 * `kletia_intents.owner_key_id` column so events after a restart or from
 * another instance still route.
 */
import { getIntentStore } from "../index.js";
import { dbRead, platformDatabaseUrl } from "./db.js";

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

async function ownerFromDatabase(intentId: string): Promise<string | null | undefined> {
  if (!platformDatabaseUrl() || getIntentStore().kind !== "postgres") return undefined;
  try {
    const result = await dbRead<{ owner_key_id: string | null }>("SELECT owner_key_id FROM kletia_intents WHERE id = $1", [intentId]);
    const row = result.rows[0];
    return row ? row.owner_key_id : undefined;
  } catch {
    return undefined;
  }
}

/** The owning key id, null for public intents, undefined when not (yet) known. */
export async function resolveIntentOwner(intentId: string): Promise<string | null | undefined> {
  if (owners.has(intentId)) return owners.get(intentId) ?? null;
  const stored = await ownerFromDatabase(intentId);
  if (stored !== undefined) remember(intentId, stored);
  return stored;
}
