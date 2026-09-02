import { Pool, type PoolConfig } from "pg";
import type { Store } from "mppx/server";

const connectionString =
  process.env.STELLAR_MPP_DATABASE_URL?.trim() ||
  process.env.WORKFLOW_V3_DATABASE_URL?.trim() ||
  process.env.WORKFLOW_V2_DATABASE_URL?.trim() ||
  "";

let pool: Pool | null = null;
let initialized: Promise<void> | null = null;

function postgresConfig(): PoolConfig {
  const url = new URL(connectionString);
  const sslMode = url.searchParams.get("sslmode");
  return {
    connectionString,
    max: 4,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    ...(sslMode === "require" || sslMode === "verify-full"
      ? { ssl: { rejectUnauthorized: sslMode === "verify-full" } }
      : {}),
  };
}

function database(): Pool {
  if (!connectionString) {
    throw Object.assign(
      new Error("Stellar MPP requires a durable PostgreSQL replay-protection store."),
      { code: "STELLAR_MPP_STORE_UNAVAILABLE", statusCode: 503 },
    );
  }
  pool ??= new Pool(postgresConfig());
  return pool;
}

async function ensureSchema(): Promise<void> {
  initialized ??= database().query(`
    CREATE TABLE IF NOT EXISTS kletia_stellar_mpp_store (
      store_key TEXT PRIMARY KEY,
      value_json JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).then(() => undefined).catch((error) => {
    initialized = null;
    throw error;
  });
  return initialized;
}

export function stellarMppAtomicStore(): Store.AtomicStore {
  return {
    async get(key) {
      await ensureSchema();
      const result = await database().query<{ value_json: unknown }>(
        "SELECT value_json FROM kletia_stellar_mpp_store WHERE store_key = $1",
        [key],
      );
      return result.rows[0]?.value_json ?? null;
    },
    async put(key, value) {
      await ensureSchema();
      await database().query(
        `INSERT INTO kletia_stellar_mpp_store (store_key, value_json)
         VALUES ($1, $2::jsonb)
         ON CONFLICT (store_key) DO UPDATE
           SET value_json = EXCLUDED.value_json, updated_at = NOW()`,
        [key, JSON.stringify(value)],
      );
    },
    async delete(key) {
      await ensureSchema();
      await database().query(
        "DELETE FROM kletia_stellar_mpp_store WHERE store_key = $1",
        [key],
      );
    },
    async update(key, updateValue) {
      await ensureSchema();
      const client = await database().connect();
      try {
        await client.query("BEGIN");
        // The transaction-scoped advisory lock also serializes the absent-row
        // case; SELECT FOR UPDATE alone cannot prevent concurrent first writes.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
        const currentResult = await client.query<{ value_json: unknown }>(
          "SELECT value_json FROM kletia_stellar_mpp_store WHERE store_key = $1 FOR UPDATE",
          [key],
        );
        const change = updateValue(currentResult.rows[0]?.value_json ?? null);
        if (change.op === "set") {
          await client.query(
            `INSERT INTO kletia_stellar_mpp_store (store_key, value_json)
             VALUES ($1, $2::jsonb)
             ON CONFLICT (store_key) DO UPDATE
               SET value_json = EXCLUDED.value_json, updated_at = NOW()`,
            [key, JSON.stringify(change.value)],
          );
        } else if (change.op === "delete") {
          await client.query(
            "DELETE FROM kletia_stellar_mpp_store WHERE store_key = $1",
            [key],
          );
        }
        await client.query("COMMIT");
        return change.result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

export async function readStellarMppStoreReadiness(): Promise<boolean> {
  try {
    await ensureSchema();
    await database().query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
