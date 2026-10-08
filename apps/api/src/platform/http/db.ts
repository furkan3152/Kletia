/**
 * Postgres access for the HTTP layer (API keys, webhooks, intent owners).
 * Uses the same KLETIA_DATABASE_URL as the intent store, through its own
 * small pool. Every failure becomes 503 STORE_UNAVAILABLE without leaking
 * connection details.
 */
import pg from "pg";
import { PlatformError } from "../errors.js";

let pool: pg.Pool | null = null;
const schemas = new Map<string, Promise<void>>();

export function platformDatabaseUrl(): string | null {
  return process.env.KLETIA_DATABASE_URL?.trim() || null;
}

export function storeUnavailable(): PlatformError {
  return new PlatformError("STORE_UNAVAILABLE", "Platform storage is temporarily unavailable.", 503);
}

function platformPool(): pg.Pool {
  const url = platformDatabaseUrl();
  if (!url) throw storeUnavailable();
  if (!pool) {
    pool = new pg.Pool({ connectionString: url, max: 3, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
    pool.on("error", (error) => {
      console.error("[platform] http postgres pool error:", error.message);
    });
  }
  return pool;
}

/** Runs DDL once per process; a failure is retried on the next call. */
async function ensureSchema(name: string, ddl: string): Promise<void> {
  let ready = schemas.get(name);
  if (!ready) {
    ready = platformPool().query(ddl).then(() => undefined);
    schemas.set(name, ready);
    ready.catch(() => schemas.delete(name));
  }
  return ready;
}

/** Query with lazy schema creation; database errors map to 503. */
export async function dbQuery<R extends pg.QueryResultRow>(
  schema: { readonly name: string; readonly ddl: string },
  text: string,
  values: readonly unknown[],
): Promise<pg.QueryResult<R>> {
  try {
    await ensureSchema(schema.name, schema.ddl);
    return await platformPool().query<R>(text, [...values]);
  } catch (error) {
    if (error instanceof PlatformError) throw error;
    console.error(`[platform] ${schema.name} query failed:`, error instanceof Error ? error.message : error);
    throw storeUnavailable();
  }
}

/** Read-only query against a table this module does not own (no DDL); errors map to 503. */
export async function dbRead<R extends pg.QueryResultRow>(text: string, values: readonly unknown[]): Promise<pg.QueryResult<R>> {
  try {
    return await platformPool().query<R>(text, [...values]);
  } catch (error) {
    if (error instanceof PlatformError) throw error;
    console.error("[platform] read query failed:", error instanceof Error ? error.message : error);
    throw storeUnavailable();
  }
}

/** Runs `task` in a transaction on one client. Database errors map to 503; PlatformErrors pass through. */
export async function dbTransaction<T>(
  schema: { readonly name: string; readonly ddl: string },
  task: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  let client: pg.PoolClient;
  try {
    await ensureSchema(schema.name, schema.ddl);
    client = await platformPool().connect();
  } catch (error) {
    if (error instanceof PlatformError) throw error;
    console.error(`[platform] ${schema.name} connect failed:`, error instanceof Error ? error.message : error);
    throw storeUnavailable();
  }
  try {
    await client.query("BEGIN");
    const result = await task(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof PlatformError) throw error;
    console.error(`[platform] ${schema.name} transaction failed:`, error instanceof Error ? error.message : error);
    throw storeUnavailable();
  } finally {
    client.release();
  }
}

/** Ends the HTTP layer's pool (graceful shutdown, tests). */
export async function closePlatformDatabase(): Promise<void> {
  const current = pool;
  pool = null;
  schemas.clear();
  if (current) await current.end();
}
