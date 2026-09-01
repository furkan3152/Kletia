import express from "express";
import rateLimit from "express-rate-limit";
import { capabilityEdgesV4, networkRolesV4 } from "./capabilityGraph.js";
import {
  compileWorkflowPlanV4,
  derivePolicyOptionsV4,
  interpretIntentV4,
  workflowPlanV4Hash,
} from "./compiler.js";
import {
  openWorkflowTokenV4,
  readWorkflowEvidenceV4,
  readWorkflowPlanV4,
  readWorkflowV4StoreReadiness,
  replaceWorkflowPlanV4,
  saveWorkflowPlanV4,
  sealWorkflowPlanV4,
} from "./store.js";
import { readStellarControlPlaneV2Readiness } from "../../networks/stellar/controlPlaneV2Readiness.js";
import { readStellarMppReadiness } from "../../networks/stellar/mpp.js";
import { stellarPolicyProofVerifierV4, verifyAndBindPolicyProofV4 } from "./policyProof.js";
import { selectedPolicyLeavesV4 } from "./policyProof.js";
import { deriveRouteBoundWorkflowRootV3 } from "../v3/compiler.js";
import { workflowPlanV3Hash } from "../v3/compiler.js";
import { hydrateWorkflowRouteV3 } from "../v3/executionAdapter.js";
import { verifyAndApplyIntentControlPlaneCommitV4 } from "./controlPlaneAdvance.js";
import { bindReviewedWorkflowV2ExecutorV4 } from "./executionHandoff.js";
import { synchronizeWorkflowExecutionV4 } from "./executionSync.js";

const router = express.Router();
const policyProofLimiter = rateLimit({ windowMs: 60_000, max: 5, standardHeaders: true, legacyHeaders: false });
router.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
router.use(rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false }));

function sendError(res: express.Response, error: unknown) {
  const candidate = error as { code?: unknown; statusCode?: unknown; message?: unknown };
  const statusCode = Number.isInteger(candidate.statusCode) ? Number(candidate.statusCode) : 500;
  return res.status(statusCode).json({
    success: false,
    code: typeof candidate.code === "string" ? candidate.code : "WORKFLOW_V4_ERROR",
    message: statusCode >= 500
      ? "The canonical workflow service is temporarily unavailable."
      : typeof candidate.message === "string"
        ? candidate.message
        : "The canonical workflow request was rejected.",
  });
}

function workflowId(value: unknown): string {
  const id = String(value ?? "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)) {
    throw Object.assign(new Error("A valid Workflow V4 identifier is required."), {
      code: "WORKFLOW_V4_ID_INVALID",
      statusCode: 400,
    });
  }
  return id;
}

function tokenFromRequest(req: express.Request): string {
  const authorization = req.header("Authorization")?.trim() || "";
  if (/^Bearer\s+/iu.test(authorization)) return authorization.replace(/^Bearer\s+/iu, "").trim();
  const explicit = req.header("X-Kletia-Workflow-Token")?.trim() || "";
  if (explicit) return explicit;
  if (typeof req.body?.workflowToken === "string") return req.body.workflowToken;
  throw Object.assign(new Error("A sealed Workflow V4 token is required."), {
    code: "WORKFLOW_V4_TOKEN_REQUIRED",
    statusCode: 401,
  });
}

async function authorizedPlan(req: express.Request) {
  const id = workflowId(req.params.workflowId);
  const token = openWorkflowTokenV4(tokenFromRequest(req));
  if (token.workflowId !== id) {
    throw Object.assign(new Error("Workflow token identity did not match the requested workflow."), {
      code: "WORKFLOW_V4_TOKEN_IDENTITY_MISMATCH",
      statusCode: 409,
    });
  }
  const plan = await readWorkflowPlanV4(id);
  if (token.planHash !== workflowPlanV4Hash(plan)) {
    throw Object.assign(new Error("Workflow token is stale; reload the canonical workflow state."), {
      code: "WORKFLOW_V4_TOKEN_STALE",
      statusCode: 409,
    });
  }
  return plan;
}

export async function capabilitiesV4Handler(req: express.Request, res: express.Response) {
  try {
    const [store, stellarMpp, controlPlaneV2] = await Promise.all([
      readWorkflowV4StoreReadiness(),
      readStellarMppReadiness(),
      readStellarControlPlaneV2Readiness(),
    ]);
    const edges = capabilityEdgesV4({
      stellarMpp: {
        enabled: stellarMpp.enabled,
        valid: stellarMpp.valid,
        ready: stellarMpp.ready,
        recipient: stellarMpp.recipient,
        databaseConfigured: stellarMpp.databaseConfigured,
        storeReady: stellarMpp.storeReady,
      },
    });
    const lane = req.query.lane === "production" || req.query.lane === "testnet" ? req.query.lane : null;
    const source = typeof req.query.source === "string" ? req.query.source : null;
    const destination = typeof req.query.destination === "string" ? req.query.destination : null;
    const operation = typeof req.query.operation === "string" ? req.query.operation : null;
    const protocol = typeof req.query.protocol === "string" ? req.query.protocol : null;
    return res.json({
      success: true,
      schemaVersion: "kletia_capabilities_v4",
      generatedAt: new Date().toISOString(),
      model: "directional_capability_edges",
      networkRoles: networkRolesV4(),
      edges: edges.filter((edge) =>
        (!lane || edge.lane === lane) &&
        (!source || edge.source === source) &&
        (!destination || edge.destination === destination) &&
        (!operation || edge.operations.includes(operation)) &&
        (!protocol || edge.protocol === protocol)),
      workflowStore: store,
      controlPlaneV2,
      invariants: {
        financialExecutionRequiresStellarControlPlane: true,
        controlPlaneFailureMode: "financial_fail_closed_read_only_may_continue",
        protocolLevelExecuteDoesNotImplyDirectionalV4Readiness: true,
        transactionHashAloneIsSuccess: false,
        mockDataAllowed: false,
      },
    });
  } catch (error) {
    return sendError(res, error);
  }
}

router.get("/capabilities", capabilitiesV4Handler);

router.post("/interpret", (req, res) => {
  try {
    const interpretation = interpretIntentV4(req.body);
    return res.status(201).json({
      success: true,
      status: interpretation.questions.length > 0 ? "clarification_required" : "interpreted",
      interpretation,
      limitations: [
        "Interpretation never produces calldata, XDR or a success claim.",
        "Exact private fields must be converted to browser-held private:// references before this request.",
      ],
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/policy-options", (req, res) => {
  try {
    return res.status(201).json({ success: true, policyOptions: derivePolicyOptionsV4(req.body) });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/:intentId/answer", (req, res) => {
  try {
    const intentId = workflowId(req.params.intentId);
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? req.body as Record<string, unknown>
      : {};
    const original = body.interpretation && typeof body.interpretation === "object" && !Array.isArray(body.interpretation)
      ? body.interpretation as Record<string, unknown>
      : {};
    if (original.requestId !== intentId) {
      throw Object.assign(new Error("The clarification answer did not match the interpreted request."), {
        code: "INTENT_V4_CLARIFICATION_IDENTITY_MISMATCH",
        statusCode: 409,
      });
    }
    const answers = body.answers && typeof body.answers === "object" && !Array.isArray(body.answers)
      ? body.answers as Record<string, unknown>
      : {};
    const interpretation = interpretIntentV4({ ...original, ...answers, requestId: intentId });
    return res.json({
      success: true,
      status: interpretation.questions.length > 0 ? "clarification_required" : "interpreted",
      interpretation,
      stateModel: "client_sealed_no_server_conversation_memory",
    });
  } catch (error) {
    return sendError(res, error);
  }
});

export async function compileWorkflowV4Handler(req: express.Request, res: express.Response) {
  try {
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? req.body as Record<string, unknown>
      : {};
    const policyCore = body.policyProfile && typeof body.policyProfile === "object" && !Array.isArray(body.policyProfile)
      ? (body.policyProfile as Record<string, unknown>).core
      : null;
    const policyLane = policyCore && typeof policyCore === "object" && !Array.isArray(policyCore)
      ? (policyCore as Record<string, unknown>).lane
      : null;
    const lane = policyLane === "production" || policyLane === "testnet"
      ? policyLane
      : body.lane === "production" || body.lane === "testnet"
        ? body.lane
        : null;
    const readiness = lane === "testnet" ? await readStellarControlPlaneV2Readiness() : null;
    const plan = await compileWorkflowPlanV4(body, {
      liveControlPlaneReady: readiness?.ready === true,
      controlPlaneContractId: readiness?.ready === true
        ? readiness.configuration.controlPlane
        : null,
    });
    await saveWorkflowPlanV4(plan);
    return res.status(201).json({
      success: true,
      status: plan.executionGate.status,
      executionKind: "workflow_plan_v4",
      workflowPlan: plan,
      workflowToken: sealWorkflowPlanV4(plan),
      limitations: [
        "Compilation does not sign, submit or retry a financial transaction.",
        "The V3 compatibility plan is retained for migration, but its bearer token is never exposed by V4.",
        "Stellar anchors Kletia policy and receipt state; it does not independently prove foreign-chain execution.",
      ],
    });
  } catch (error) {
    return sendError(res, error);
  }
}

router.post("/compile", compileWorkflowV4Handler);
router.post("/:intentId/compile", (req, res) => {
  try {
    const intentId = workflowId(req.params.intentId);
    if (req.body?.requestId !== intentId) {
      throw Object.assign(new Error("The compile request did not match the interpreted intent identity."), {
        code: "INTENT_V4_COMPILE_IDENTITY_MISMATCH",
        statusCode: 409,
      });
    }
    return void compileWorkflowV4Handler(req, res);
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/:workflowId/policy-proof", policyProofLimiter, async (req, res) => {
  try {
    const plan = await authorizedPlan(req);
    const expectedPlanHash = workflowPlanV4Hash(plan);
    const bound = await verifyAndBindPolicyProofV4(
      plan,
      req.body?.policyProof,
      stellarPolicyProofVerifierV4,
    );
    await replaceWorkflowPlanV4({
      previous: plan,
      next: bound.plan,
      expectedPlanHash,
      evidenceId: `policy-proof:${bound.evidence.publicInputsHash.slice(2)}`,
      evidence: bound.evidence,
    });
    return res.json({
      success: true,
      status: bound.plan.executionGate.status,
      workflowPlan: bound.plan,
      workflowToken: sealWorkflowPlanV4(bound.plan),
      policyProofEvidence: bound.evidence,
      limitations: [
        "The proof verifies signed policy constraints and selected-route membership; it does not prove a foreign-chain execution result.",
        "Raw proof bytes and private witness material are not persisted.",
        "Every financial call still requires exact hydration, simulation and a separate wallet signature.",
      ],
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/:workflowId/policy-challenge", async (req, res) => {
  try {
    const plan = await authorizedPlan(req);
    const routeId = plan.selectedRouteId;
    const profile = plan.intent.policyProfile?.core;
    if (!routeId || !profile || plan.policy.proofBinding.status !== "device_proof_required") {
      throw Object.assign(new Error("This workflow is not at the Policy V2 proof boundary."), {
        code: "WORKFLOW_V4_POLICY_CHALLENGE_UNAVAILABLE",
        statusCode: 409,
      });
    }
    return res.json({
      success: true,
      schemaVersion: "kletia_policy_challenge_v2",
      routeId,
      workflowRoot: deriveRouteBoundWorkflowRootV3(plan.compatibility.plan, routeId),
      policyRoot: profile.policyRoot,
      protocolRegistryRoot: profile.protocolRegistryRoot,
      assetRegistryRoot: profile.assetRegistryRoot,
      recipientPolicyRoot: profile.recipientPolicyRoot,
      ...selectedPolicyLeavesV4(plan, routeId),
      environmentLane: plan.lane === "production" ? 0 : 1,
      executionExpiresAtLedger: profile.executionExpiresAtLedger,
      verifierVersion: 2,
      proofBytesExpected: 256,
      limitations: [
        "This challenge binds the selected route to the signed policy; it is not an execution success claim.",
        "The API re-derives every public input when the proof is submitted.",
      ],
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/:workflowId/control-plane/advance", async (req, res) => {
  try {
    const plan = await authorizedPlan(req);
    const expectedPlanHash = workflowPlanV4Hash(plan);
    const advanced = await verifyAndApplyIntentControlPlaneCommitV4(
      plan,
      req.body?.transactionHash,
    );
    await replaceWorkflowPlanV4({
      previous: plan,
      next: advanced.plan,
      expectedPlanHash,
      evidenceId: `control-plane-v2:${advanced.evidence.transactionHash}`,
      evidence: advanced.evidence,
    });
    return res.json({
      success: true,
      status: advanced.plan.executionGate.status,
      workflowPlan: advanced.plan,
      workflowToken: sealWorkflowPlanV4(advanced.plan),
      controlPlaneEvidence: advanced.evidence,
      limitations: [
        "This confirms Kletia policy commitment and nullifier consumption on Stellar; it does not prove a foreign-chain financial result.",
        "The transaction hash was accepted only after exact invocation, event and persisted-record verification.",
      ],
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/:workflowId/evidence", async (req, res) => {
  try {
    const plan = await authorizedPlan(req);
    const evidence = await readWorkflowEvidenceV4(plan.workflowId);
    return res.json({
      success: true,
      schemaVersion: "kletia_workflow_evidence_v4",
      workflowId: plan.workflowId,
      evidence,
      evidencePolicy: plan.evidencePolicy,
      emptyMeansNoExecutionProven: evidence.length === 0,
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/:workflowId", async (req, res) => {
  try {
    const plan = await authorizedPlan(req);
    return res.json({ success: true, workflowPlan: plan, workflowToken: sealWorkflowPlanV4(plan) });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/:workflowId/hydrate", async (req, res) => {
  try {
    const plan = await authorizedPlan(req);
    if (
      plan.policy.proofBinding.status !== "bound" ||
      plan.controlPlane.commitment.status !== "confirmed" ||
      !plan.selectedRouteId
    ) {
      throw Object.assign(
        new Error("Live route hydration requires the bound Policy V2 proof and confirmed Stellar V2 commitment."),
        { code: "WORKFLOW_V4_CONTROL_PLANE_REQUIRED", statusCode: 409 },
      );
    }
    const expectedPlanHash = workflowPlanV4Hash(plan);
    const rootBefore = deriveRouteBoundWorkflowRootV3(plan.compatibility.plan, plan.selectedRouteId);
    const hydrated = await hydrateWorkflowRouteV3(plan.compatibility.plan, {
      routeId: plan.selectedRouteId,
      amount: req.body?.amount,
      amountSalt: req.body?.amountSalt,
      acknowledgePublicExecution: req.body?.acknowledgePublicExecution,
    });
    const rootAfter = deriveRouteBoundWorkflowRootV3(hydrated.plan, plan.selectedRouteId);
    if (rootAfter !== rootBefore) {
      throw Object.assign(
        new Error("Live quote hydration changed the Stellar-committed route identity."),
        { code: "WORKFLOW_V4_HYDRATION_ROOT_DRIFT", statusCode: 409 },
      );
    }
    const next = {
      ...plan,
      routes: hydrated.plan.routes,
      compatibility: {
        ...plan.compatibility,
        planHash: workflowPlanV3Hash(hydrated.plan),
        plan: hydrated.plan,
      },
      executionGate: {
        signable: false,
        status: "exact_adapter_required" as const,
        reasons: ["The live amount-bound route quote is sealed; every financial call still requires its exact V4 adapter, simulation and wallet signature."],
      },
    };
    await replaceWorkflowPlanV4({
      previous: plan,
      next,
      expectedPlanHash,
      evidenceId: `route-hydration:${hydrated.evidence.reference.slice(2, 34)}`,
      evidence: hydrated.evidence,
    });
    return res.json({
      success: true,
      status: next.executionGate.status,
      workflowPlan: next,
      workflowToken: sealWorkflowPlanV4(next),
      routeQuote: hydrated.quote,
      quoteEvidence: hydrated.evidence,
      automaticExecution: false,
      limitations: [
        "The exact execution amount reaches Kletia API and public providers only after this explicit public-execution approval; it is never sent to the LLM.",
        "A quote is not a submitted transaction or a success receipt.",
      ],
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/:workflowId/executor", async (req, res) => {
  try {
    const plan = await authorizedPlan(req);
    const expectedPlanHash = workflowPlanV4Hash(plan);
    const bound = await bindReviewedWorkflowV2ExecutorV4(plan);
    await replaceWorkflowPlanV4({
      previous: plan,
      next: bound.plan,
      expectedPlanHash,
      evidenceId: `executor-bind:${bound.handoff.workflowPlan.workflowId}`,
      evidence: {
        schemaVersion: "kletia_v4_executor_binding_evidence_v1",
        parentPlanHash: bound.handoff.parentPlanHash,
        executorWorkflowId: bound.handoff.workflowPlan.workflowId,
        executorPlanCoreSha256: bound.handoff.workflowPlan.authorizationBoundary.planCoreSha256,
        controlPlaneTransactionHash: plan.controlPlane.commitment.transactionHash,
        externalExecutionTruthProvenByStellar: false,
        financialTransactionSubmitted: false,
        observedAt: new Date().toISOString(),
      },
    });
    return res.json({
      success: true,
      status: bound.plan.executionGate.status,
      workflowPlan: bound.plan,
      workflowToken: sealWorkflowPlanV4(bound.plan),
      executorHandoff: bound.handoff,
      limitations: [
        "Binding creates no financial transaction and proves no foreign-chain result.",
        "The executor requires a fresh EVM manifest signature and separate wallet approval for every financial checkpoint.",
        "Cross-chain execution is checkpointed and is never represented as globally atomic.",
      ],
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/:workflowId/executor/sync", async (req, res) => {
  try {
    const plan = await authorizedPlan(req);
    const expectedPlanHash = workflowPlanV4Hash(plan);
    const synchronized = synchronizeWorkflowExecutionV4(plan, req.body?.workflowTokenV2);
    const progress = synchronized.plan.executionHandoff;
    await replaceWorkflowPlanV4({
      previous: plan,
      next: synchronized.plan,
      expectedPlanHash,
      evidenceId: `executor-sync:${progress.confirmedCheckpointCount}:${progress.progressStatus}`,
      evidence: {
        schemaVersion: "kletia_v4_executor_progress_evidence_v1",
        executorWorkflowId: synchronized.executorPlan.workflowId,
        confirmedCheckpointCount: progress.confirmedCheckpointCount,
        totalCheckpointCount: progress.totalCheckpointCount,
        progressStatus: progress.progressStatus,
        terminalReceiptSha256: progress.terminalReceiptSha256,
        latestExecutorPlanCoreSha256: synchronized.executorPlan.authorizationBoundary.planCoreSha256,
        externalExecutionTruthProvenByStellar: false,
        observedAt: progress.lastSyncedAt,
      },
    });
    return res.json({
      success: true,
      status: progress.progressStatus,
      workflowPlan: synchronized.plan,
      workflowToken: sealWorkflowPlanV4(synchronized.plan),
      executionProgress: progress,
      automaticRetry: false,
      limitations: [
        "The WorkflowPlanV2 bearer token was verified but not persisted in V4 state.",
        "Checkpoint evidence is independently verified by its source-chain adapter; Stellar does not make a foreign-chain receipt true.",
      ],
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/:workflowId/advance", async (req, res) => {
  try {
    const plan = await authorizedPlan(req);
    if (!plan.executionGate.signable) {
      throw Object.assign(new Error(plan.executionGate.reasons.join(" ") || "The workflow is not signable."), {
        code: "WORKFLOW_V4_EXECUTION_GATE_BLOCKED",
        statusCode: 409,
      });
    }
    throw Object.assign(
      new Error("No V4 exact evidence adapter is bound to the current step. Nothing was submitted or retried."),
      { code: "WORKFLOW_V4_EVIDENCE_ADAPTER_REQUIRED", statusCode: 409 },
    );
  } catch (error) {
    return sendError(res, error);
  }
});

export default router;
