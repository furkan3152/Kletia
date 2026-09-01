import "dotenv/config";

import { execFile } from "node:child_process";
import { unlinkSync } from "node:fs";
import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import {
  Address,
  BASE_FEE,
  Contract,
  StrKey,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

import { STELLAR_TESTNET } from "../networks/stellar/config.js";
import {
  computeSolverBidCommitment,
  createSolverBidSalt,
  type SolverBidSecretV1,
} from "../networks/stellar/solverBidCommitment.js";
import {
  isReferenceSolverRouteEligible,
  referenceSolverNetworkCliArgs,
} from "../networks/stellar/referenceSolverPolicy.js";

const execFileAsync = promisify(execFile);
const API_URL = (
  process.env.STELLAR_REFERENCE_SOLVER_API_URL?.trim() ||
  "http://127.0.0.1:3001/api/workflows/v3/solver-market/opportunities"
);
const KEY_ALIAS = process.env.STELLAR_REFERENCE_SOLVER_KEY_ALIAS?.trim() || "";
const CLI = process.env.STELLAR_CLI_PATH?.trim() || "stellar";
const POLL_MS = Math.max(3_000, Number(process.env.STELLAR_REFERENCE_SOLVER_POLL_MS || 5_000));
const MAX_BACKOFF_MS = Math.max(
  POLL_MS,
  Number(process.env.STELLAR_REFERENCE_SOLVER_MAX_BACKOFF_MS || 15 * 60_000),
);
const MIN_OUTPUT = BigInt(process.env.STELLAR_REFERENCE_SOLVER_MIN_OUTPUT_ATOMIC || "25000000");
const MAX_OUTPUT = BigInt(process.env.STELLAR_REFERENCE_SOLVER_MAX_OUTPUT_ATOMIC || "10000000000");
const STATE_PATH = resolve(
  process.env.STELLAR_REFERENCE_SOLVER_STATE_PATH?.trim() ||
    ".kletia/reference-solver-state.json",
);
const HEARTBEAT_PATH = resolve(
  process.env.STELLAR_REFERENCE_SOLVER_HEARTBEAT_PATH?.trim() ||
    ".kletia/reference-solver-heartbeat.json",
);
const LOCK_PATH = resolve(
  process.env.STELLAR_REFERENCE_SOLVER_LOCK_PATH?.trim() ||
    ".kletia/reference-solver.lock",
);
let lockOwned = false;
type Hex32 = `0x${string}`;
type Stage = "locked" | "committed" | "revealed" | "finalized";

interface Opportunity {
  readonly schemaVersion: "kletia_solver_opportunity_v1";
  readonly workflowId: string;
  readonly expiresAt: number;
  readonly auctionRoot: Hex32;
  readonly constraintsHash: Hex32;
  readonly contracts: { readonly bondVault: string; readonly routeAuction: string };
  readonly minimumBondAtomic: string;
  readonly routes: readonly {
    readonly id: string;
    readonly routeHash: Hex32;
    readonly quoteEvidenceHash: Hex32;
    readonly chains: readonly string[];
    readonly protocols: readonly string[];
  }[];
}

interface PersistedEntry {
  readonly workflowId: string;
  readonly stage: Stage;
  readonly secret: SolverBidSecretV1;
  readonly minimumBondAtomic: string;
  readonly settlementDeadlineLedger: number;
  readonly updatedAt: string;
}

interface PersistedState {
  readonly schemaVersion: "kletia_reference_solver_state_v1";
  readonly entries: Record<string, PersistedEntry>;
}

class OpportunityApiError extends Error {
  readonly retryAfterMs: number | null;

  constructor(message: string, retryAfterMs: number | null = null) {
    super(message);
    this.name = "OpportunityApiError";
    this.retryAfterMs = retryAfterMs;
  }
}

function fail(message: string): never {
  throw new Error(message);
}

function exactHex32(value: unknown, field: string): Hex32 {
  const text = String(value ?? "").toLowerCase();
  if (!/^0x[a-f\d]{64}$/u.test(text) || /^0x0{64}$/u.test(text)) {
    throw new Error(`${field} is not a non-zero bytes32 value.`);
  }
  return text as Hex32;
}

function hexArg(value: Hex32): string {
  return value.slice(2);
}

function enumCase(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 1) return keys[0] || "";
  }
  return "";
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} did not return a contract record.`);
  }
  return value as Record<string, unknown>;
}

function bytes32Hex(value: unknown, field: string): Hex32 {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new Error(`${field} was not an onchain bytes32 value.`);
  }
  return `0x${Buffer.from(value).toString("hex")}`;
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function acquireSingleInstanceLock(): Promise<void> {
  await mkdir(dirname(LOCK_PATH), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(LOCK_PATH, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
      } finally {
        await handle.close();
      }
      lockOwned = true;
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readJson<{ readonly pid?: unknown }>(LOCK_PATH, {});
      const existingPid = Number(existing.pid);
      if (processIsAlive(existingPid)) {
        fail(`Another Testnet reference solver is already running with PID ${existingPid}.`);
      }
      await unlink(LOCK_PATH).catch((unlinkError: NodeJS.ErrnoException) => {
        if (unlinkError.code !== "ENOENT") throw unlinkError;
      });
    }
  }
  fail("The Testnet reference solver instance lock could not be acquired.");
}

function releaseSingleInstanceLock(): void {
  if (!lockOwned) return;
  try {
    unlinkSync(LOCK_PATH);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  } finally {
    lockOwned = false;
  }
}

async function heartbeat(input: {
  readonly solver: string;
  readonly status: "starting" | "idle" | "working" | "waiting" | "error";
  readonly action: string;
  readonly workflowRoot?: Hex32;
  readonly error?: string;
}): Promise<void> {
  await writePrivateJson(HEARTBEAT_PATH, {
    schemaVersion: "kletia_reference_solver_heartbeat_v1",
    solver: input.solver,
    status: input.status,
    action: input.action,
    workflowRoot: input.workflowRoot ?? null,
    error: input.error?.slice(0, 240) ?? null,
    updatedAt: new Date().toISOString(),
  });
}

async function cli(args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(CLI, [...args], {
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return stdout.trim();
}

async function invoke(contractId: string, method: string, args: readonly string[]): Promise<void> {
  await cli([
    "contract", "invoke",
    "--id", contractId,
    ...referenceSolverNetworkCliArgs({
      rpcUrl: STELLAR_TESTNET.rpcUrl,
      networkPassphrase: STELLAR_TESTNET.networkPassphrase,
    }),
    "--source-account", KEY_ALIAS,
    "--send", "yes",
    "--auto-sign",
    "--quiet",
    "--",
    method,
    ...args,
  ]);
}

async function contractRead(
  source: string,
  contractId: string,
  method: string,
  args: readonly xdr.ScVal[],
): Promise<{ readonly value: unknown; readonly latestLedger: number }> {
  const server = new rpc.Server(STELLAR_TESTNET.rpcUrl, { timeout: 10_000 });
  const account = await server.getAccount(source);
  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: STELLAR_TESTNET.networkPassphrase,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const simulation = await server.simulateTransaction(transaction);
  if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result) {
    throw new Error(`${method} could not be read from Stellar Testnet.`);
  }
  return {
    value: scValToNative(simulation.result.retval) as unknown,
    latestLedger: simulation.latestLedger,
  };
}

function validOpportunity(value: unknown): value is Opportunity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  const contracts = entry.contracts as Record<string, unknown> | undefined;
  return (
    entry.schemaVersion === "kletia_solver_opportunity_v1" &&
    typeof entry.workflowId === "string" &&
    typeof entry.expiresAt === "number" &&
    /^0x[a-f\d]{64}$/iu.test(String(entry.auctionRoot)) &&
    /^0x[a-f\d]{64}$/iu.test(String(entry.constraintsHash)) &&
    contracts !== undefined &&
    StrKey.isValidContract(String(contracts.bondVault ?? "")) &&
    StrKey.isValidContract(String(contracts.routeAuction ?? "")) &&
    /^[1-9]\d*$/u.test(String(entry.minimumBondAtomic ?? "")) &&
    Array.isArray(entry.routes)
  );
}

async function opportunities(): Promise<readonly Opportunity[]> {
  const response = await fetch(API_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    const retryAfter = response.headers.get("retry-after")?.trim() || "";
    const numericSeconds = /^\d+$/u.test(retryAfter) ? Number(retryAfter) : Number.NaN;
    const retryDate = numericSeconds >= 0 ? Number.NaN : Date.parse(retryAfter);
    const retryAfterMs = Number.isFinite(numericSeconds)
      ? numericSeconds * 1_000
      : Number.isFinite(retryDate)
        ? Math.max(0, retryDate - Date.now())
        : null;
    throw new OpportunityApiError(
      `Opportunity API returned HTTP ${response.status}.`,
      retryAfterMs,
    );
  }
  const body = await response.json() as Record<string, unknown>;
  if (
    body.success !== true ||
    body.schemaVersion !== "kletia_solver_opportunity_list_v1" ||
    !Array.isArray(body.opportunities)
  ) {
    throw new Error("Opportunity API response failed its schema boundary.");
  }
  return body.opportunities.filter(validOpportunity);
}

async function pruneTerminalPersistedEntries(
  solver: string,
  state: PersistedState,
): Promise<void> {
  let changed = false;
  for (const [workflowRoot, entry] of Object.entries(state.entries)) {
    try {
      const auctionRead = await contractRead(
        solver,
        entry.secret.auctionContract,
        "get",
        [xdr.ScVal.scvBytes(Buffer.from(workflowRoot.slice(2), "hex"))],
      );
      if (auctionRead.value === null || auctionRead.value === undefined) continue;
      const status = enumCase(record(auctionRead.value, "persisted route auction").status);
      if (status !== "Open") {
        // Commit/reveal secrets are no longer useful once the auction leaves
        // Open. Settlement and bond resolution remain recoverable from exact
        // onchain state and do not require retaining the private bid salt.
        delete state.entries[workflowRoot];
        changed = true;
      }
    } catch {
      // A transient RPC failure must never erase recovery material.
    }
  }
  if (changed) await writePrivateJson(STATE_PATH, state);
}

function routeFor(opportunity: Opportunity) {
  return opportunity.routes.find(isReferenceSolverRouteEligible);
}

async function processOpportunity(
  solver: string,
  opportunity: Opportunity,
  state: PersistedState,
): Promise<boolean> {
  if (opportunity.expiresAt <= Date.now()) return false;
  const expectedVault = process.env.STELLAR_SOLVER_BOND_VAULT_TESTNET_CONTRACT_ID?.trim();
  const expectedAuction = process.env.STELLAR_ROUTE_AUCTION_TESTNET_CONTRACT_ID?.trim();
  if (
    opportunity.contracts.bondVault !== expectedVault ||
    opportunity.contracts.routeAuction !== expectedAuction
  ) {
    return false;
  }
  const workflowRoot = exactHex32(opportunity.auctionRoot, "auctionRoot");
  const rootArg = xdr.ScVal.scvBytes(Buffer.from(workflowRoot.slice(2), "hex"));
  const auctionRead = await contractRead(
    solver,
    opportunity.contracts.routeAuction,
    "get",
    [rootArg],
  );
  if (auctionRead.value === null || auctionRead.value === undefined) return false;
  const auction = record(auctionRead.value, "route auction");
  const status = enumCase(auction.status);
  if (["Succeeded", "SolverFault", "Indeterminate", "NoWinner", "Cancelled"].includes(status)) {
    delete state.entries[workflowRoot];
    await writePrivateJson(STATE_PATH, state);
    return false;
  }
  if (bytes32Hex(auction.workflow_root, "workflow_root") !== workflowRoot) return false;
  if (bytes32Hex(auction.constraints_hash, "constraints_hash") !== opportunity.constraintsHash) return false;

  const minimumOutput = BigInt(String(auction.minimum_output ?? "0"));
  const minimumBond = BigInt(String(auction.minimum_bond ?? "0"));
  const maximumDuration = Number(auction.maximum_duration_seconds);
  const commitDeadline = Number(auction.commit_deadline_ledger);
  const revealDeadline = Number(auction.reveal_deadline_ledger);
  const settlementDeadline = Number(auction.settlement_deadline_ledger);
  if (
    minimumOutput < MIN_OUTPUT || minimumOutput > MAX_OUTPUT ||
    minimumBond !== BigInt(opportunity.minimumBondAtomic) ||
    maximumDuration <= 0 || maximumDuration > 3_600 ||
    !Number.isSafeInteger(commitDeadline) ||
    !Number.isSafeInteger(revealDeadline) ||
    !Number.isSafeInteger(settlementDeadline) ||
    !(commitDeadline < revealDeadline && revealDeadline < settlementDeadline) ||
    settlementDeadline > auctionRead.latestLedger + 360
  ) {
    return false;
  }

  let entry = state.entries[workflowRoot];
  if (status === "Finalized") {
    // The bid salt is no longer needed after reveal/finalization. Drop it from
    // the durable worker state even though settlement and bond resolution are
    // intentionally handled by separate evidence-aware authorities.
    if (entry) {
      delete state.entries[workflowRoot];
      await writePrivateJson(STATE_PATH, state);
    }
    await heartbeat({ solver, status: "waiting", action: "winner selected; waiting for verified execution", workflowRoot });
    return true;
  }
  if (status !== "Open") return false;

  const route = routeFor(opportunity);
  if (!route) return false;
  if (!entry && auctionRead.latestLedger <= commitDeadline) {
    const secret: SolverBidSecretV1 = {
      schemaVersion: "kletia_solver_bid_secret_v1",
      auctionContract: opportunity.contracts.routeAuction,
      workflowRoot,
      solver,
      routeHash: exactHex32(route.routeHash, "routeHash"),
      quoteEvidenceHash: exactHex32(route.quoteEvidenceHash, "quoteEvidenceHash"),
      promisedOutputAtomic: minimumOutput.toString(),
      solverFeeAtomic: "0",
      durationSeconds: Math.min(maximumDuration, 600),
      quoteExpiresAtLedger: settlementDeadline,
      salt: createSolverBidSalt(),
    };
    entry = {
      workflowId: opportunity.workflowId,
      stage: "locked",
      secret,
      minimumBondAtomic: minimumBond.toString(),
      settlementDeadlineLedger: settlementDeadline,
      updatedAt: new Date().toISOString(),
    };
    state.entries[workflowRoot] = entry;
    await writePrivateJson(STATE_PATH, state);

    const lockRead = await contractRead(
      solver,
      opportunity.contracts.bondVault,
      "bond_lock",
      [new Address(solver).toScVal(), rootArg],
    );
    if (lockRead.value === null || lockRead.value === undefined) {
      await heartbeat({ solver, status: "working", action: "locking solver bond", workflowRoot });
      await invoke(opportunity.contracts.bondVault, "lock", [
        "--solver", solver,
        "--workflow_root", hexArg(workflowRoot),
        "--amount", minimumBond.toString(),
        "--expires_at_ledger", String(settlementDeadline),
      ]);
    }
    const commitment = computeSolverBidCommitment(secret);
    await heartbeat({ solver, status: "working", action: "committing sealed bid", workflowRoot });
    await invoke(opportunity.contracts.routeAuction, "commit_bid", [
      "--solver", solver,
      "--workflow_root", hexArg(workflowRoot),
      "--commitment", hexArg(commitment),
    ]);
    state.entries[workflowRoot] = { ...entry, stage: "committed", updatedAt: new Date().toISOString() };
    await writePrivateJson(STATE_PATH, state);
    return true;
  }

  if (entry) {
    if (
      entry.secret.workflowRoot !== workflowRoot ||
      entry.secret.auctionContract !== opportunity.contracts.routeAuction ||
      entry.secret.solver !== solver ||
      entry.minimumBondAtomic !== minimumBond.toString() ||
      entry.settlementDeadlineLedger !== settlementDeadline
    ) {
      throw new Error("Persisted solver state does not match the exact live auction.");
    }
  }
  if (entry?.stage === "locked" && auctionRead.latestLedger <= commitDeadline) {
    const lockRead = await contractRead(
      solver,
      opportunity.contracts.bondVault,
      "bond_lock",
      [new Address(solver).toScVal(), rootArg],
    );
    if (lockRead.value === null || lockRead.value === undefined) {
      await invoke(opportunity.contracts.bondVault, "lock", [
        "--solver", solver,
        "--workflow_root", hexArg(workflowRoot),
        "--amount", minimumBond.toString(),
        "--expires_at_ledger", String(settlementDeadline),
      ]);
    }
    const bidRead = await contractRead(
      solver,
      opportunity.contracts.routeAuction,
      "bid",
      [rootArg, new Address(solver).toScVal()],
    );
    if (bidRead.value === null || bidRead.value === undefined) {
      const commitment = computeSolverBidCommitment(entry.secret);
      await heartbeat({ solver, status: "working", action: "recovering sealed bid commit", workflowRoot });
      await invoke(opportunity.contracts.routeAuction, "commit_bid", [
        "--solver", solver,
        "--workflow_root", hexArg(workflowRoot),
        "--commitment", hexArg(commitment),
      ]);
    }
    state.entries[workflowRoot] = { ...entry, stage: "committed", updatedAt: new Date().toISOString() };
    await writePrivateJson(STATE_PATH, state);
    return true;
  }
  if (!entry) return false;
  if (entry.stage === "locked" && auctionRead.latestLedger > commitDeadline) {
    const [lockRead, bidRead] = await Promise.all([
      contractRead(
        solver,
        opportunity.contracts.bondVault,
        "bond_lock",
        [new Address(solver).toScVal(), rootArg],
      ),
      contractRead(
        solver,
        opportunity.contracts.routeAuction,
        "bid",
        [rootArg, new Address(solver).toScVal()],
      ),
    ]);
    if (bidRead.value === null || bidRead.value === undefined) {
      const lockStatus = lockRead.value === null || lockRead.value === undefined
        ? ""
        : enumCase(record(lockRead.value, "solver bond lock").status);
      if (lockStatus !== "Locked") {
        delete state.entries[workflowRoot];
        await writePrivateJson(STATE_PATH, state);
        return false;
      }
      await heartbeat({
        solver,
        status: "waiting",
        action: "commit window missed; locked bond requires recovery",
        workflowRoot,
      });
      return true;
    }
    state.entries[workflowRoot] = {
      ...entry,
      stage: "committed",
      updatedAt: new Date().toISOString(),
    };
    await writePrivateJson(STATE_PATH, state);
    entry = state.entries[workflowRoot];
  }
  if (
    entry?.stage === "committed" &&
    auctionRead.latestLedger > commitDeadline &&
    auctionRead.latestLedger <= revealDeadline
  ) {
    const bidRead = await contractRead(
      solver,
      opportunity.contracts.routeAuction,
      "bid",
      [rootArg, new Address(solver).toScVal()],
    );
    const bid = record(bidRead.value, "solver bid");
    if (bid.revealed_at_ledger === null || bid.revealed_at_ledger === undefined) {
      const secret = entry.secret;
      await heartbeat({ solver, status: "working", action: "revealing eligible bid", workflowRoot });
      await invoke(opportunity.contracts.routeAuction, "reveal_bid", [
        "--solver", solver,
        "--workflow_root", hexArg(secret.workflowRoot),
        "--route_hash", hexArg(secret.routeHash),
        "--quote_evidence_hash", hexArg(secret.quoteEvidenceHash),
        "--promised_output", secret.promisedOutputAtomic,
        "--solver_fee", secret.solverFeeAtomic,
        "--duration_seconds", String(secret.durationSeconds),
        "--quote_expires_at_ledger", String(secret.quoteExpiresAtLedger),
        "--salt", hexArg(secret.salt),
      ]);
    }
    state.entries[workflowRoot] = { ...entry, stage: "revealed", updatedAt: new Date().toISOString() };
    await writePrivateJson(STATE_PATH, state);
    return true;
  }

  if (entry?.stage === "committed") {
    await heartbeat({
      solver,
      status: "waiting",
      action: auctionRead.latestLedger <= commitDeadline
        ? "sealed bid committed; waiting for reveal window"
        : "reveal window missed; committed bid requires recovery",
      workflowRoot,
    });
    return true;
  }

  if (
    entry?.stage === "revealed" &&
    auctionRead.latestLedger > revealDeadline &&
    auctionRead.latestLedger <= settlementDeadline
  ) {
    await heartbeat({ solver, status: "working", action: "finalizing route competition", workflowRoot });
    await invoke(opportunity.contracts.routeAuction, "finalize", [
      "--workflow_root", hexArg(workflowRoot),
    ]);
    delete state.entries[workflowRoot];
    await writePrivateJson(STATE_PATH, state);
    return true;
  }

  if (entry?.stage === "revealed") {
    await heartbeat({
      solver,
      status: "waiting",
      action: auctionRead.latestLedger <= revealDeadline
        ? "bid revealed; waiting for finalization window"
        : "settlement window expired; revealed bid requires recovery",
      workflowRoot,
    });
    return true;
  }
  return true;
}

async function main(): Promise<void> {
  if (process.env.STELLAR_REFERENCE_SOLVER_ENABLED?.trim() !== "true") {
    fail("STELLAR_REFERENCE_SOLVER_ENABLED must be true for the Testnet worker.");
  }
  if (!KEY_ALIAS) fail("STELLAR_REFERENCE_SOLVER_KEY_ALIAS is required.");
  if (process.env.NODE_ENV === "production") {
    fail("The bundled reference solver is intentionally Testnet-only and cannot run in production mode.");
  }
  await acquireSingleInstanceLock();
  process.once("exit", releaseSingleInstanceLock);
  process.once("SIGINT", () => {
    releaseSingleInstanceLock();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    releaseSingleInstanceLock();
    process.exit(0);
  });
  const solver = (await cli(["keys", "address", KEY_ALIAS])).trim();
  if (!StrKey.isValidEd25519PublicKey(solver)) fail("The configured solver key alias is invalid.");
  const state = await readJson<PersistedState>(STATE_PATH, {
    schemaVersion: "kletia_reference_solver_state_v1",
    entries: {},
  });
  if (state.schemaVersion !== "kletia_reference_solver_state_v1") {
    fail("Reference solver state has an unsupported schema version.");
  }
  await pruneTerminalPersistedEntries(solver, state);
  await heartbeat({ solver, status: "starting", action: "checking live Testnet opportunities" });
  process.stdout.write(`Kletia Testnet reference solver active: ${solver}\n`);

  let consecutiveFailures = 0;
  let lastPersistedStatePruneAt = Date.now();
  for (;;) {
    let nextPollMs = POLL_MS;
    try {
      const list = await opportunities();
      if (Date.now() - lastPersistedStatePruneAt >= 60_000) {
        await pruneTerminalPersistedEntries(solver, state);
        lastPersistedStatePruneAt = Date.now();
      }
      consecutiveFailures = 0;
      const activeRoot = Object.entries(state.entries).find(([, entry]) =>
        entry.stage !== "finalized",
      )?.[0];
      const ordered = activeRoot
        ? [
            ...list.filter((entry) => entry.auctionRoot === activeRoot),
            ...list.filter((entry) => entry.auctionRoot !== activeRoot),
          ]
        : list;
      let handled = false;
      for (const opportunity of ordered) {
        if (await processOpportunity(solver, opportunity, state)) {
          handled = true;
          break;
        }
      }
      if (!handled) {
        await heartbeat({ solver, status: "idle", action: "waiting for eligible auctions" });
      }
    } catch (error) {
      consecutiveFailures += 1;
      const message = error instanceof Error ? error.message : "Unknown reference solver failure.";
      await heartbeat({ solver, status: "error", action: "poll failed", error: message });
      const exponentialBackoff = Math.min(
        MAX_BACKOFF_MS,
        POLL_MS * 2 ** Math.min(consecutiveFailures, 8),
      );
      const retryAfterMs = error instanceof OpportunityApiError
        ? error.retryAfterMs
        : null;
      const hasPendingCommit = Object.values(state.entries).some(
        (entry) => entry.stage === "locked" || entry.stage === "committed",
      );
      nextPollMs = hasPendingCommit
        ? POLL_MS
        : Math.min(
            MAX_BACKOFF_MS,
            Math.max(POLL_MS, exponentialBackoff, retryAfterMs ?? 0),
          );
      if (consecutiveFailures === 1 || consecutiveFailures % 5 === 0) {
        process.stderr.write(
          `Reference solver poll failed: ${message} Retrying in ${Math.ceil(nextPollMs / 1_000)}s.\n`,
        );
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, nextPollMs));
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
