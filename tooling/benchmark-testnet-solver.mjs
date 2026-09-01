#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

const API_ORIGIN = (process.env.KLETIA_API_ORIGIN || "http://127.0.0.1:3001").replace(/\/$/u, "");
const SAMPLE_COUNT = boundedInteger(process.env.SOLVER_BENCHMARK_SAMPLES, 5, 1, 120);
const INTERVAL_MS = boundedInteger(process.env.SOLVER_BENCHMARK_INTERVAL_MS, 5_000, 3_000, 60_000);
const HEARTBEAT_PATH = resolve(
  process.env.STELLAR_REFERENCE_SOLVER_HEARTBEAT_PATH ||
    "apps/api/.kletia/reference-solver-heartbeat.json",
);
const STATE_PATH = resolve(
  process.env.STELLAR_REFERENCE_SOLVER_STATE_PATH ||
    "apps/api/.kletia/reference-solver-state.json",
);

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Expected an integer between ${minimum} and ${maximum}; received ${value}.`);
  }
  return parsed;
}

async function jsonFile(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function timedJson(path) {
  const startedAt = performance.now();
  const response = await fetch(`${API_ORIGIN}${path}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  const latencyMs = performance.now() - startedAt;
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${path} returned non-JSON data (HTTP ${response.status}).`);
  }
  if (!response.ok || body?.success !== true) {
    throw new Error(`${path} failed (HTTP ${response.status}): ${body?.message || "unknown error"}`);
  }
  return { body, latencyMs };
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)];
}

function rounded(value) {
  return value === null ? null : Math.round(value * 10) / 10;
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function main() {
  const health = await timedJson("/health");
  const capabilities = await timedJson("/api/workflows/v3/capabilities");
  const market = capabilities.body.solverMarket || {};
  const worker = market.referenceSolver || {};
  const observations = [];
  const observedActions = new Set();
  const observedWorkflowRoots = new Set();
  const observedStages = new Set();

  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    const opportunityResponse = await timedJson("/api/workflows/v3/solver-market/opportunities");
    const heartbeat = await jsonFile(HEARTBEAT_PATH, null);
    const state = await jsonFile(STATE_PATH, { entries: {} });
    const opportunities = Array.isArray(opportunityResponse.body.opportunities)
      ? opportunityResponse.body.opportunities
      : [];
    if (typeof heartbeat?.action === "string") observedActions.add(heartbeat.action);
    if (typeof heartbeat?.workflowRoot === "string") observedWorkflowRoots.add(heartbeat.workflowRoot);
    for (const opportunity of opportunities) {
      if (typeof opportunity?.auctionRoot === "string") observedWorkflowRoots.add(opportunity.auctionRoot);
    }
    for (const entry of Object.values(state?.entries || {})) {
      if (typeof entry?.stage === "string") observedStages.add(entry.stage);
    }
    observations.push({
      latencyMs: opportunityResponse.latencyMs,
      opportunityCount: opportunities.length,
      heartbeat,
      stateEntryCount: Object.keys(state?.entries || {}).length,
    });
    if (sample + 1 < SAMPLE_COUNT) await sleep(INTERVAL_MS);
  }

  const latest = observations.at(-1);
  const heartbeatAgeMs = latest?.heartbeat?.updatedAt
    ? Date.now() - Date.parse(latest.heartbeat.updatedAt)
    : null;
  const heartbeatFresh = Number.isFinite(heartbeatAgeMs) && heartbeatAgeMs >= -5_000 && heartbeatAgeMs <= 20_000;
  const latencies = observations.map((entry) => entry.latencyMs);
  const participated = observedStages.size > 0 || [...observedActions].some((action) =>
    /locking|committing|committed|revealing|revealed|finalizing|winner selected/iu.test(action),
  );
  const report = {
    schemaVersion: "kletia_testnet_solver_benchmark_v1",
    measuredAt: new Date().toISOString(),
    readOnly: true,
    api: {
      online: true,
      healthLatencyMs: rounded(health.latencyMs),
      capabilitiesLatencyMs: rounded(capabilities.latencyMs),
      opportunityEndpointLatencyMs: {
        samples: latencies.length,
        min: rounded(Math.min(...latencies)),
        p50: rounded(percentile(latencies, 0.5)),
        p95: rounded(percentile(latencies, 0.95)),
        max: rounded(Math.max(...latencies)),
      },
    },
    auctionContracts: {
      ready: market.ready === true,
      productionReady: market.productionReady === true,
      provesForeignExecution: market.provesForeignExecution === true,
      bondVault: market.contracts?.find?.((entry) => entry.key === "solverBondVault")?.contractId || null,
      routeAuction: market.contracts?.find?.((entry) => entry.key === "routeAuction")?.contractId || null,
    },
    worker: {
      enabled: worker.enabled === true,
      onlineAtCapabilityCheck: worker.online === true,
      onlineNow: heartbeatFresh && latest?.heartbeat?.status !== "error",
      currentHeartbeatStatus: latest?.heartbeat?.status || null,
      currentAction: latest?.heartbeat?.action || null,
      heartbeatAgeMs: Number.isFinite(heartbeatAgeMs) ? heartbeatAgeMs : null,
      solver: latest?.heartbeat?.solver || worker.solver || null,
    },
    observation: {
      eligibleOpportunitySeen: observations.some((entry) => entry.opportunityCount > 0),
      maximumConcurrentOpportunities: Math.max(...observations.map((entry) => entry.opportunityCount)),
      workflowRootsSeen: [...observedWorkflowRoots],
      localStagesSeen: [...observedStages],
      actionsSeen: [...observedActions],
      referenceSolverParticipationObserved: participated,
      foreignChainExecutionVerifiedByThisBenchmark: false,
    },
    verdict: participated
      ? "Reference-solver auction activity was observed. Bind the finalized onchain winner and exact execution receipts before claiming the workflow was solved."
      : "The worker and contracts were checked, but no reference-solver auction activity was observed during this window.",
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (
    !report.auctionContracts.ready ||
    !report.worker.enabled ||
    !report.worker.onlineAtCapabilityCheck ||
    !report.worker.onlineNow
  ) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`Solver benchmark failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
