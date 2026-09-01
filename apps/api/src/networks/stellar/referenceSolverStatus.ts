import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { StrKey } from "@stellar/stellar-sdk";

const HEARTBEAT_MAX_AGE_MS = 20_000;

export async function readReferenceSolverStatus() {
  const enabled = process.env.STELLAR_REFERENCE_SOLVER_ENABLED?.trim() === "true";
  const base = {
    schemaVersion: "kletia_reference_solver_status_v1" as const,
    enabled,
    testnetOnly: true as const,
    productionReady: false as const,
  };
  if (!enabled) {
    return { ...base, online: false, status: "disabled" as const, solver: null, action: null, updatedAt: null };
  }
  const path = resolve(
    process.env.STELLAR_REFERENCE_SOLVER_HEARTBEAT_PATH?.trim() ||
      ".kletia/reference-solver-heartbeat.json",
  );
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const solver = String(value.solver ?? "");
    const updatedAt = String(value.updatedAt ?? "");
    const age = Date.now() - Date.parse(updatedAt);
    if (
      value.schemaVersion !== "kletia_reference_solver_heartbeat_v1" ||
      !StrKey.isValidEd25519PublicKey(solver) ||
      !Number.isFinite(age) || age < -5_000
    ) {
      throw new Error("Heartbeat schema mismatch.");
    }
    return {
      ...base,
      online: age <= HEARTBEAT_MAX_AGE_MS,
      status: age <= HEARTBEAT_MAX_AGE_MS ? String(value.status ?? "unknown") : "stale",
      solver,
      action: typeof value.action === "string" ? value.action : null,
      updatedAt,
    };
  } catch {
    return { ...base, online: false, status: "offline" as const, solver: null, action: null, updatedAt: null };
  }
}
