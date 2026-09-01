import express from "express";
import rateLimit from "express-rate-limit";
import { randomUUID } from "node:crypto";
import { StrKey } from "@stellar/stellar-sdk";
import { compileWorkflowPlanV2, sealWorkflowPlanV2 } from "./compiler.js";
import {
  advanceWorkflowV2,
  refreshWorkflowAuthorizationV2,
} from "./advance.js";
import { assertRedactedWorkflowPrompt, parseWorkflowGoalV2 } from "./parser.js";
import { readWorkflowRouteMetrics } from "./quotes.js";
import { readArbitrumSepoliaBorrowCapacity } from "../../networks/arbitrum-sepolia/service.js";
import { assertArbitrumSepoliaReadiness } from "../../networks/arbitrum-sepolia/config.js";
import { readStellarReadiness } from "../../networks/stellar/service.js";
import {
  assertStellarExecutionSurfaceOpen,
  readStellarProtocolManifest,
} from "../../networks/stellar/protocolManifest.js";
import { prepareStellarPolicyRegistryCommit } from "../../networks/stellar/policyRegistryState.js";
import { readStellarPolicyRegistryReadiness } from "../../networks/stellar/policyRegistryReadiness.js";
import { readStellarPrivatePaymentsReadiness } from "../../networks/stellar/privatePaymentsManifest.js";
import {
  assertWorkflowCheckpointStoreReadiness,
  readWorkflowCheckpointStoreReadiness,
} from "./checkpointStore.js";
import type { WorkflowLifecycleClassificationV1 } from "./lifecycle.js";
import { readIntentGrammarManifest } from "./intentGrammar.js";
import { readRouteGraphManifest } from "./routeGraph.js";
import { readPrivacySurfaceReportV1 } from "./privacySurfaceReport.js";

function isWorkflowLifecycleClassification(
  value: unknown,
): value is WorkflowLifecycleClassificationV1 {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { schemaVersion?: unknown }).schemaVersion ===
      "kletia_workflow_lifecycle_v1"
  );
}

const router = express.Router();
router.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
router.use(rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false }));

function requestId(value: unknown): string {
  const id = String(value ?? "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)
    ? id
    : randomUUID();
}

function sendError(res: express.Response, error: unknown) {
  const candidate = error as {
    code?: unknown;
    statusCode?: unknown;
    message?: unknown;
    lifecycle?: unknown;
    workflowToken?: unknown;
    workflowPlan?: unknown;
  };
  const statusCode = Number.isInteger(candidate.statusCode) ? Number(candidate.statusCode) : 500;
  const lifecycle = isWorkflowLifecycleClassification(candidate.lifecycle)
    ? candidate.lifecycle
    : null;
  return res.status(statusCode).json({
    success: false,
    code: typeof candidate.code === "string" ? candidate.code : "WORKFLOW_V2_ERROR",
    message:
      statusCode >= 500
        ? "The Stellar-centered workflow service is temporarily unavailable."
        : typeof candidate.message === "string"
          ? candidate.message
          : "Workflow request was rejected.",
    // A classified checkpoint failure returns the re-sealed plan so the browser
    // observes the same lifecycle state the server recorded. `indeterminate` is
    // reported as retryable but is never resubmitted automatically.
    ...(lifecycle
      ? {
          lifecycle,
          ...(typeof candidate.workflowToken === "string"
            ? { workflowToken: candidate.workflowToken }
            : {}),
          ...(candidate.workflowPlan ? { workflowPlan: candidate.workflowPlan } : {}),
        }
      : {}),
  });
}

const FORBIDDEN_POLICY_SECRET_FIELDS = [
  "policyBlind",
  "privacyBudgetBlind",
  "policyCommitmentBlind",
  "privacyBudgetCommitmentBlind",
  "policyCommitmentSalt",
  "privacyBudgetCommitmentSalt",
  "policyPreimage",
  "privacyBudgetPreimage",
  "rawBlind",
] as const;

function requestedPolicyAnchorMode(value: unknown) {
  const mode = String(value ?? "local_manifest").trim();
  if (mode !== "local_manifest" && mode !== "stellar_public_registry") {
    throw Object.assign(new Error("The requested policy anchor mode is invalid."), {
      code: "WORKFLOW_POLICY_ANCHOR_INVALID",
      statusCode: 400,
    });
  }
  return mode;
}

function assertNoPolicySecretMaterial(body: unknown): void {
  const forbiddenNames = new Set(
    FORBIDDEN_POLICY_SECRET_FIELDS.map((field) => field.toLowerCase()),
  );
  const seen = new WeakSet<object>();
  const visit = (value: unknown, depth: number): string | null => {
    if (!value || typeof value !== "object" || depth > 16) return null;
    if (seen.has(value)) return null;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const entry of value) {
        const nested = visit(entry, depth + 1);
        if (nested) return nested;
      }
      return null;
    }
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (forbiddenNames.has(key.toLowerCase())) return key;
      const nested = visit(entry, depth + 1);
      if (nested) return nested;
    }
    return null;
  };
  const forbidden = visit(body, 0);
  if (!forbidden) return;
  throw Object.assign(
    new Error(
      `${forbidden} is private browser material and must never be sent to the Kletia API. Send only the two domain-separated 32-byte commitments.`,
    ),
    { code: "PRIVATE_POLICY_MATERIAL_EGRESS_BLOCKED", statusCode: 400 },
  );
}

export async function planWorkflowV2Handler(req: express.Request, res: express.Response) {
  try {
    assertNoPolicySecretMaterial(req.body);
    const id = requestId(req.body?.requestId);
    const policyAnchorMode = requestedPolicyAnchorMode(
      req.body?.policyAnchorMode,
    );
    if (
      policyAnchorMode === "local_manifest" &&
      (req.body?.policyCommitment !== undefined ||
        req.body?.privacyBudgetCommitment !== undefined)
    ) {
      throw Object.assign(
        new Error(
          "Opaque registry commitments were supplied while local_manifest is selected. Choose stellar_public_registry explicitly or remove them.",
        ),
        { code: "WORKFLOW_POLICY_ANCHOR_MISMATCH", statusCode: 400 },
      );
    }
    const prompt = assertRedactedWorkflowPrompt(req.body?.prompt);
    const privacyBudgetPreset = String(
      req.body?.privacyBudgetPreset ?? "deterministic_only_public_execution",
    );
    if (
      ![
        "public_execution",
        "private_planning_public_execution",
        "deterministic_only_public_execution",
        "confidential_ledger_required",
      ].includes(privacyBudgetPreset)
    ) {
      throw Object.assign(new Error("The requested Privacy Budget preset is invalid."), {
        code: "PRIVACY_BUDGET_INVALID",
        statusCode: 400,
      });
    }
    if (privacyBudgetPreset === "confidential_ledger_required") {
      throw Object.assign(
        new Error(
          "Ledger confidentiality was requested, but no reviewed confidential verifier and execution surface is available. Kletia will not downgrade the request to public settlement.",
        ),
        {
          code: "PRIVACY_BUDGET_UNSATISFIABLE",
          statusCode: 409,
        },
      );
    }
    const goal = await parseWorkflowGoalV2(prompt, {
      semanticPlanner:
        privacyBudgetPreset === "deterministic_only_public_execution"
          ? "deterministic_registry"
          : "openrouter_constrained",
      semanticContext: req.body?.semanticContext,
    });
    if (!goal.isComplete) {
      return res.status(409).json({
        success: false,
        status: "question",
        requiresInput: true,
        requestId: id,
        question:
          goal.question ||
          "Should this public testnet route include a Stellar settlement checkpoint?",
      });
    }
    const policyRegistryCommit =
      policyAnchorMode === "stellar_public_registry"
        ? await prepareStellarPolicyRegistryCommit({
            owner: req.body?.walletBindings?.stellarAddress,
            policyCommitment: req.body?.policyCommitment,
            privacyBudgetCommitment: req.body?.privacyBudgetCommitment,
          })
        : undefined;
    await assertWorkflowCheckpointStoreReadiness();
    const aave = await readArbitrumSepoliaBorrowCapacity(
      req.body?.walletBindings?.arbitrumSepoliaAddress,
    );
    const requestedRoute = String(req.body?.routePreference ?? "auto");
    let routeMetrics = await readWorkflowRouteMetrics(
      aave.supplyApyBps,
      requestedRoute === "direct_cctp"
        ? "direct_only"
        : "all",
    );
    const hasStellarWallet = StrKey.isValidEd25519PublicKey(
      String(req.body?.walletBindings?.stellarAddress ?? ""),
    );
    // Auto ranking may consider only routes the currently connected wallet set
    // can actually authorize. Without a Stellar account the direct corridor
    // remains executable; an explicit Stellar request still fails closed below.
    if (requestedRoute === "auto" && !hasStellarWallet) {
      routeMetrics = {
        direct: routeMetrics.direct,
        stellarUnavailableReason:
          "Connect a Stellar Testnet account before including the Stellar public corridor.",
      };
    }
    // Auto mode may degrade to the independently verified direct corridor when
    // Stellar RPC, live CCTP evidence, or executable pins are unavailable. An
    // explicit Stellar request never downgrades silently: the compiler returns
    // the precise unavailable reason instead.
    if (requestedRoute !== "direct_cctp" && routeMetrics.stellar) {
      try {
        const stellarReadiness = await readStellarReadiness();
        const manifest =
          stellarReadiness.status === "ready"
            ? await readStellarProtocolManifest()
            : null;
        if (stellarReadiness.status !== "ready" || !manifest?.executionSurfaceOpen) {
          routeMetrics = {
            direct: routeMetrics.direct,
            stellarUnavailableReason:
              manifest && manifest.quarantinedKeys.length > 0
                ? `Stellar execution contracts are quarantined: ${manifest.quarantinedKeys.join(", ")}.`
                : "Stellar RPC, network identity, or execution pins are not ready.",
          };
        }
      } catch (error) {
        routeMetrics = {
          direct: routeMetrics.direct,
          stellarUnavailableReason:
            error instanceof Error
              ? error.message
              : "Stellar readiness could not be observed.",
        };
      }
    }
    const plan = compileWorkflowPlanV2({
      requestId: id,
      goal,
      amountCommitment: req.body?.amountCommitment,
      recipientCommitment: req.body?.recipientCommitment,
      routePreference: req.body?.routePreference,
      privacyBudgetPreset: req.body?.privacyBudgetPreset,
      policyAnchorMode,
      policyRegistryCommit,
      arcAddress: req.body?.walletBindings?.arcAddress,
      stellarAddress: req.body?.walletBindings?.stellarAddress,
      arbitrumSepoliaAddress: req.body?.walletBindings?.arbitrumSepoliaAddress,
      routeMetrics,
    });
    if (plan.selectedRoute !== "direct_cctp") {
      const stellarReadiness = await readStellarReadiness();
      if (stellarReadiness.status !== "ready") {
        throw Object.assign(new Error("Stellar Testnet capability is not ready."), {
          code: "STELLAR_MVP_DISABLED",
          statusCode: 503,
        });
      }
      // Fail closed only for the selected route that can actually sign a
      // Stellar call. A direct Arc → Arbitrum plan has no Stellar target and
      // must remain independent from Horizon/RPC availability and WASM pins.
      await assertStellarExecutionSurfaceOpen();
    }
    return res.json({
      success: true,
      status: "success",
      executionKind: "workflow_plan_v2",
      message: "A testnet workflow was compiled without sending raw private fields to the AI.",
      network: "stellar",
      chainRef: "stellar:testnet",
      requestId: id,
      workflowPlan: plan,
      workflowToken: sealWorkflowPlanV2(plan),
    });
  } catch (error) {
    return sendError(res, error);
  }
}

router.post("/plan", planWorkflowV2Handler);

// Publishes the closed enumeration of expressible intents. A reviewer can see
// which scenarios have a signable path today and which are declared for review
// only, without reading the source.
router.get("/grammar", (_req, res) => {
  return res.json({ success: true, status: "success", ...readIntentGrammarManifest() });
});

// Publishes the route graph: which (network, asset) positions Kletia knows, which
// protocol operations connect them, and how disclosure is priced. This is the
// aggregator surface a reviewer can read without trusting a claim, and it states
// per edge whether the operation is signable or quote-only.
router.get("/graph", (_req, res) => {
  return res.json({ success: true, status: "success", ...readRouteGraphManifest() });
});

// Publishes privacy truth per reachable surface. This is deliberately separate
// from capability readiness: a ready public route is not a confidential route,
// and WorkflowPlanV2 isolation must not be generalized to legacy intents,
// standalone Stellar tools or x402.
router.get("/privacy-surfaces", (_req, res) => {
  return res.json({
    success: true,
    status: "declared",
    ...readPrivacySurfaceReportV1(),
  });
});

router.get("/readiness", async (_req, res) => {
  try {
    const [checkpointStore] = await Promise.all([
      readWorkflowCheckpointStoreReadiness(),
      assertArbitrumSepoliaReadiness(),
    ]);
    if (checkpointStore.status !== "ready") {
      throw Object.assign(new Error("The WorkflowPlanV2 capability is not ready."), {
        code: "WORKFLOW_V2_NOT_READY",
        statusCode: 503,
      });
    }
    let stellar: Awaited<ReturnType<typeof readStellarReadiness>> | null = null;
    let policyRegistry: Awaited<
      ReturnType<typeof readStellarPolicyRegistryReadiness>
    > | null = null;
    let protocolManifest: Awaited<ReturnType<typeof readStellarProtocolManifest>> | null = null;
    let stellarReason: string | null = null;
    const privatePayments = await readStellarPrivatePaymentsReadiness().catch(
      () => null,
    );
    try {
      [stellar, policyRegistry] = await Promise.all([
        readStellarReadiness(),
        readStellarPolicyRegistryReadiness(),
      ]);
      if (stellar.status === "ready") {
        protocolManifest = await readStellarProtocolManifest();
      }
    } catch (error) {
      stellarReason = error instanceof Error
        ? error.message
        : "Stellar readiness could not be observed.";
    }
    const stellarRouteReady =
      stellar?.status === "ready" &&
      protocolManifest?.executionSurfaceOpen === true;
    return res.json({
      success: true,
      enabled: true,
      status: "ready",
      environmentLane: "testnet",
      networks: stellarRouteReady
        ? ["arc_testnet", "stellar_testnet", "arbitrum_sepolia"]
        : ["arc_testnet", "arbitrum_sepolia"],
      routes: {
        direct_cctp: {
          ready: true,
          networks: ["arc_testnet", "arbitrum_sepolia"],
        },
        stellar_centered_public: {
          ready: stellarRouteReady,
          networks: ["arc_testnet", "stellar_testnet", "arbitrum_sepolia"],
          ...(!stellarRouteReady
            ? {
                reason:
                  stellarReason ||
                  "Stellar RPC, network identity, or reviewed executable pins are not ready.",
              }
            : {}),
        },
      },
      policyAnchors: {
        local_manifest: {
          ready: true,
          default: true,
          onchainAnchor: false,
        },
        stellar_public_registry: {
          ready: policyRegistry?.ready === true,
          default: false,
          userOptInRequired: true,
          ownerAuthorizationRequired: true,
          providesConfidentiality: false,
          provesExternalExecution: false,
          ...(policyRegistry?.ready !== true
            ? {
                status: policyRegistry?.status ?? "rpc_unobservable",
                reason:
                  policyRegistry?.reason ??
                  "Policy registry readiness could not be observed.",
              }
            : { contractId: policyRegistry.contractId }),
        },
      },
      checkpointStore,
      protocolManifest,
      capabilities: {
        privatePayments:
          privatePayments ?? {
            readiness: {
              xlmLifecycle: "quarantined",
              eurcLifecycle: "quarantined",
              usdcLifecycle: "not_deployed",
              mainnet: "unavailable",
            },
          },
      },
      privacy: {
        claimScope: "workflow_v2_semantic_planning_only",
        privateIntentIsolation: "ready",
        rawPrivateFieldsReceivedByAi: false,
        // The exact amount is commitment-only at plan time, but the API does
        // receive the public destination wallet binding. Keeping the old
        // aggregate field false would incorrectly imply API-blind recipient
        // privacy, so the split fields below are authoritative.
        rawPrivateFieldsReceivedByApiDuringPlanning: true,
        rawExactAmountReceivedByApiDuringPlanning: false,
        publicExecutionRecipientReceivedByApiDuringPlanning: true,
        semanticPromptReceivedByApi: "allowlisted_redacted_envelope",
        commitmentOpeningsReceivedByApiDuringAdvance: true,
        settlementVisibility: "public_ledger",
        onchainConfidentiality: "not_in_public_workflow_runtime",
        shieldedAlternative: "stellar_private_payments_xlm_testnet",
        surfaceReport: {
          endpoint: "/api/workflows/v2/privacy-surfaces",
          schemaVersion: "kletia_privacy_surface_report_v1",
          assurance: "reviewed_source_manifest_not_noninterference_proof",
          privatePlanning: "workflow_v2_only",
          systemwideLedgerConfidentiality: false,
        },
        privacyBudget: {
          schemaVersion: "kletia_privacy_budget_v1",
          enforcement: "fail_closed",
          availablePresets: [
            "deterministic_only_public_execution",
            "public_execution",
            "private_planning_public_execution",
          ],
          blockedPresets: {
            confidential_ledger_required:
              "No reviewed confidential verifier and execution surface is available in this runtime.",
          },
        },
      },
      stellar,
      policyRegistry,
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/advance", async (req, res) => {
  try {
    return res.json({ success: true, ...(await advanceWorkflowV2(req.body || {})) });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/refresh-authorization", async (req, res) => {
  try {
    return res.json({
      success: true,
      ...(await refreshWorkflowAuthorizationV2(req.body || {})),
    });
  } catch (error) {
    return sendError(res, error);
  }
});

export default router;
