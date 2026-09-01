import express from "express";
import rateLimit from "express-rate-limit";
import {
  compileWorkflowPlanV3,
  workflowPlanV3Hash,
} from "./compiler.js";
import { ASSETS_V3, CHAINS_V3 } from "./chains.js";
import { protocolCapabilitiesV3 } from "./capabilities.js";
import {
  commitWorkflowAdvanceV3,
  commitWorkflowExecutionHandoffV3,
  commitWorkflowExecutionProgressV3,
  commitWorkflowMarketSelectionV3,
  commitWorkflowPolicyProofBindingV3,
  commitWorkflowRouteHydrationV3,
  openWorkflowTokenV3,
  listSolverOpportunitiesV3,
  readWorkflowPlanV3,
  readWorkflowV3StoreReadiness,
  saveWorkflowPlanV3,
  sealWorkflowPlanV3,
} from "./store.js";
import { applyWorkflowLiveReadV3, executeWorkflowLiveReadV3 } from "./liveReads.js";
import { verifyAndBindPolicyProofV3 } from "./policyProof.js";
import { readStellarMppReadiness } from "../../networks/stellar/mpp.js";
import { readStellarControlPlaneReadiness } from "../../networks/stellar/controlPlaneReadiness.js";
import { readStellarSolverMarketReadiness } from "../../networks/stellar/solverMarketReadiness.js";
import { readReferenceSolverStatus } from "../../networks/stellar/referenceSolverStatus.js";
import { verifyAndBindSolverAuctionWinnerV3 } from "./solverMarket.js";
import { hydrateWorkflowRouteV3 } from "./executionAdapter.js";
import {
  verifyAndApplyControlPlaneFinalizationV3,
  verifyAndApplyIntentControlPlaneCommitV3,
  verifyAndApplyReceiptRegistryCommitV3,
} from "./controlPlaneAdvance.js";
import { bindReviewedWorkflowV2ExecutorV3 } from "./executionHandoff.js";
import { synchronizeWorkflowExecutionV3 } from "./executionSync.js";
import { openWorkflowPlanV2 } from "../v2/compiler.js";

const router = express.Router();
const policyProofLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
});
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
    code: typeof candidate.code === "string" ? candidate.code : "WORKFLOW_V3_ERROR",
    message:
      statusCode >= 500
        ? "The unified workflow service is temporarily unavailable."
        : typeof candidate.message === "string"
          ? candidate.message
          : "The unified workflow request was rejected.",
  });
}

function workflowId(value: unknown): string {
  const id = String(value ?? "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)) {
    throw Object.assign(new Error("A valid Workflow V3 identifier is required."), {
      code: "WORKFLOW_V3_ID_INVALID",
      statusCode: 400,
    });
  }
  return id;
}

function workflowTokenFromHeader(req: express.Request): string {
  const authorization = req.header("Authorization")?.trim() || "";
  if (/^Bearer\s+/iu.test(authorization)) {
    return authorization.replace(/^Bearer\s+/iu, "").trim();
  }
  const explicit = req.header("X-Kletia-Workflow-Token")?.trim() || "";
  if (explicit) return explicit;
  throw Object.assign(
    new Error("A sealed Workflow V3 token is required in an authorization header."),
    { code: "WORKFLOW_V3_TOKEN_REQUIRED", statusCode: 401 },
  );
}

export async function capabilitiesV3Handler(_req: express.Request, res: express.Response) {
  try {
    const store = await readWorkflowV3StoreReadiness();
    const stellarMpp = await readStellarMppReadiness();
    const testnetControlPlane = await readStellarControlPlaneReadiness("testnet");
    const [testnetSolverMarket, referenceSolver] = await Promise.all([
      readStellarSolverMarketReadiness("testnet"),
      readReferenceSolverStatus(),
    ]);
    return res.json({
      success: true,
      schemaVersion: "kletia_capabilities_v3",
      generatedAt: new Date().toISOString(),
      lanes: {
        production: ["base_mainnet", "arbitrum_one", "stellar_mainnet"],
        testnet: ["stellar_testnet", "arc_testnet", "arbitrum_sepolia"],
      },
      chains: Object.values(CHAINS_V3),
      assets: Object.values(ASSETS_V3),
      protocols: protocolCapabilitiesV3({
        stellarMpp: {
          enabled: stellarMpp.enabled,
          valid: stellarMpp.valid,
          ready: stellarMpp.ready,
          recipient: stellarMpp.recipient,
          databaseConfigured: stellarMpp.databaseConfigured,
          storeReady: stellarMpp.storeReady,
        },
      }),
      workflowStore: store,
      controlPlane: {
        sourceReady: true,
        deployLast: true,
        testnetExecutionEnabled: testnetControlPlane.ready,
        productionExecutionEnabled: false,
        provesExternalExecution: false,
        privacyModel: "field_minimization_and_policy_commitments_not_anonymity",
        readiness: testnetControlPlane,
      },
      solverMarket: {
        ...testnetSolverMarket,
        referenceSolver,
      },
      workflowV3: {
        planning: "source_ready",
        exactCallExecution: "stellar_control_plane_commits_and_live_reads_financial_calls_fail_closed",
        liveReadExecution: [
          "stellar_testnet:stellar-classic:portfolio",
          "arbitrum_sepolia:aave-v3:portfolio",
          "arbitrum_sepolia:aave-v3:borrow_capacity",
        ],
        policyProofBinding: "live_testnet_registry_verified",
        controlPlaneXdrPreparation: "browser_source_ready_wallet_signature_required",
        reviewedExecutionFallback: "workflow_v2_and_network_local_engines",
        automaticRetry: false,
      },
    });
  } catch (error) {
    return sendError(res, error);
  }
}

router.get("/capabilities", capabilitiesV3Handler);

router.get("/solver-market/opportunities", async (_req, res) => {
  try {
    const readiness = await readStellarSolverMarketReadiness("testnet");
    if (
      process.env.STELLAR_REFERENCE_SOLVER_ENABLED?.trim() !== "true" ||
      !readiness.ready
    ) {
      return res.json({
        success: true,
        schemaVersion: "kletia_solver_opportunity_list_v1",
        solverAvailable: false,
        opportunities: [],
      });
    }
    const opportunities = await listSolverOpportunitiesV3();
    return res.json({
      success: true,
      schemaVersion: "kletia_solver_opportunity_list_v1",
      solverAvailable: true,
      opportunities,
    });
  } catch (error) {
    return sendError(res, error);
  }
});

export async function compileWorkflowV3Handler(req: express.Request, res: express.Response) {
  try {
    const input = req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? req.body as Record<string, unknown>
      : {};
    const { sourceWorkflowTokenV2, ...compileInput } = input;
    const sourceReceipt = compileInput.sourceIntentReceipt;
    if (sourceReceipt !== undefined && sourceReceipt !== null) {
      const sourcePlan = openWorkflowPlanV2(sourceWorkflowTokenV2);
      const receipt = sourceReceipt && typeof sourceReceipt === "object" && !Array.isArray(sourceReceipt)
        ? sourceReceipt as Record<string, unknown>
        : {};
      const privateBindings = Array.isArray(compileInput.privateBindings)
        ? compileInput.privateBindings.filter(
            (entry): entry is Record<string, unknown> =>
              Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
          )
        : [];
      const amountBinding = privateBindings.find((entry) => entry.field === "amount");
      const recipientBinding = privateBindings.find((entry) => entry.field === "recipient");
      if (
        receipt.workflowId !== sourcePlan.workflowId ||
        receipt.requestId !== sourcePlan.requestId ||
        receipt.planCoreSha256 !== sourcePlan.authorizationBoundary.planCoreSha256 ||
        receipt.selectedRoute !== sourcePlan.selectedRoute ||
        compileInput.requestId !== sourcePlan.requestId ||
        amountBinding?.commitment !== sourcePlan.privacy.amountCommitment ||
        recipientBinding?.commitment !== sourcePlan.privacy.recipientCommitment
      ) {
        throw Object.assign(
          new Error("The Workflow V3 request did not preserve the exact sealed V2 intent receipt."),
          { code: "SOURCE_INTENT_TOKEN_MISMATCH", statusCode: 409 },
        );
      }
    } else if (sourceWorkflowTokenV2 !== undefined) {
      throw Object.assign(
        new Error("A Workflow V2 token cannot be supplied without its typed source receipt binding."),
        { code: "SOURCE_INTENT_RECEIPT_REQUIRED", statusCode: 409 },
      );
    }
    const initialPlan = compileWorkflowPlanV3(compileInput);
    const [controlPlaneReadiness, solverMarketReadiness] = await Promise.all([
      initialPlan.controlPlane.required
        ? readStellarControlPlaneReadiness(initialPlan.lane)
        : null,
      initialPlan.coordinationMarket.required
        ? readStellarSolverMarketReadiness(initialPlan.lane)
        : null,
    ]);
    const plan = controlPlaneReadiness?.ready || solverMarketReadiness?.ready
      ? compileWorkflowPlanV3(compileInput, {
          liveControlPlaneReady: controlPlaneReadiness?.ready === true,
          liveSolverMarketReady: solverMarketReadiness?.ready === true,
          ...(solverMarketReadiness?.bindings?.minimumBondAtomic
            ? {
                liveSolverMinimumBondAtomic:
                  solverMarketReadiness.bindings.minimumBondAtomic,
              }
            : {}),
        })
      : initialPlan;
    await saveWorkflowPlanV3(plan);
    return res.status(201).json({
      success: true,
      status: plan.selectedRouteId ? "planned" : "blocked",
      executionKind: "workflow_plan_v3",
      workflowPlan: plan,
      workflowToken: sealWorkflowPlanV3(plan),
      limitations: [
        "A compiled plan does not send a transaction or prove a foreign-chain outcome.",
        "Amount-dependent quotes and exact calls must be hydrated locally and re-approved before signing.",
        controlPlaneReadiness?.ready
          ? "The Stellar Testnet development control plane is pinned live; the connected wallet must still sign exact XDR and this is not a production trusted setup."
          : "Stellar control-plane execution remains fail-closed because live readiness did not pass.",
        plan.coordinationMarket.required
          ? solverMarketReadiness?.ready
            ? "Competitive selection requires a workflow-scoped bond and a complete commit-reveal auction before policy-proof binding."
            : "Competitive selection remains fail-closed because the solver bond vault and route auction are not live-attested."
          : "This direct workflow does not pay for or depend on the solver market.",
      ],
    });
  } catch (error) {
    return sendError(res, error);
  }
}

router.post("/compile", compileWorkflowV3Handler);

router.post("/:workflowId/routes/:routeId/hydrate", async (req, res) => {
  try {
    const id = workflowId(req.params.workflowId);
    const routeId = String(req.params.routeId ?? "").trim();
    if (!/^[a-z][a-z0-9-]{2,80}$/u.test(routeId)) {
      throw Object.assign(new Error("A valid sealed route identifier is required."), {
        code: "WORKFLOW_V3_ROUTE_ID_INVALID",
        statusCode: 400,
      });
    }
    const token = openWorkflowTokenV3(workflowTokenFromHeader(req));
    if (token.workflowId !== id) {
      throw Object.assign(new Error("Workflow token identity did not match the requested workflow."), {
        code: "WORKFLOW_V3_TOKEN_IDENTITY_MISMATCH",
        statusCode: 409,
      });
    }
    const plan = await readWorkflowPlanV3(id);
    if (token.planHash !== workflowPlanV3Hash(plan)) {
      throw Object.assign(new Error("Workflow token is stale; reload before refreshing a route quote."), {
        code: "WORKFLOW_V3_TOKEN_STALE",
        statusCode: 409,
      });
    }
    const hydrated = await hydrateWorkflowRouteV3(plan, {
      routeId,
      amount: req.body?.amount,
      amountSalt: req.body?.amountSalt,
      acknowledgePublicExecution: req.body?.acknowledgePublicExecution,
    });
    await commitWorkflowRouteHydrationV3({
      expectedPlanHash: token.planHash,
      previousPlan: plan,
      nextPlan: hydrated.plan,
      routeId,
      evidence: hydrated.evidence,
    });
    return res.json({
      success: true,
      status: hydrated.plan.coordinationMarket.required
        ? "route_quote_bound_auction_may_open"
        : "route_quote_bound_exact_executor_may_bind",
      workflowPlan: hydrated.plan,
      workflowToken: sealWorkflowPlanV3(hydrated.plan),
      routeQuote: hydrated.quote,
      quoteEvidence: hydrated.evidence,
      automaticExecution: false,
      limitations: [
        "Hydration discloses the execution amount to Kletia API and public-chain providers only after explicit approval; the LLM still does not receive it.",
        "The quoted destination amount subtracts the buffered maximum CCTP fee. Testnet ETH gas is estimated separately and is not represented as a fabricated USD value.",
        "No transaction was signed, submitted or retried.",
      ],
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/:workflowId", async (req, res) => {
  try {
    const id = workflowId(req.params.workflowId);
    const token = openWorkflowTokenV3(workflowTokenFromHeader(req));
    if (token.workflowId !== id) {
      throw Object.assign(new Error("Workflow token identity did not match the requested workflow."), {
        code: "WORKFLOW_V3_TOKEN_IDENTITY_MISMATCH",
        statusCode: 409,
      });
    }
    const plan = await readWorkflowPlanV3(id);
    if (token.planHash !== workflowPlanV3Hash(plan)) {
      throw Object.assign(new Error("Workflow token is stale; use the latest sealed workflow state."), {
        code: "WORKFLOW_V3_TOKEN_STALE",
        statusCode: 409,
      });
    }
    return res.json({
      success: true,
      workflowPlan: plan,
      workflowToken: sealWorkflowPlanV3(plan),
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/:workflowId/solver-market/sync", async (req, res) => {
  try {
    const id = workflowId(req.params.workflowId);
    const token = openWorkflowTokenV3(workflowTokenFromHeader(req));
    if (token.workflowId !== id) {
      throw Object.assign(new Error("Workflow token identity did not match the requested workflow."), {
        code: "WORKFLOW_V3_TOKEN_IDENTITY_MISMATCH",
        statusCode: 409,
      });
    }
    const plan = await readWorkflowPlanV3(id);
    if (token.planHash !== workflowPlanV3Hash(plan)) {
      throw Object.assign(new Error("Workflow token is stale; reload before syncing the solver market."), {
        code: "WORKFLOW_V3_TOKEN_STALE",
        statusCode: 409,
      });
    }
    const bound = await verifyAndBindSolverAuctionWinnerV3(plan);
    await commitWorkflowMarketSelectionV3({
      expectedPlanHash: token.planHash,
      previousPlan: plan,
      nextPlan: bound.plan,
      evidence: bound.evidence,
    });
    return res.json({
      success: true,
      status: "solver_winner_bound_device_policy_proof_required",
      workflowPlan: bound.plan,
      workflowToken: sealWorkflowPlanV3(bound.plan),
      auctionEvidence: bound.evidence,
      limitations: [
        "The Stellar auction proves the winning bid and live workflow bond, not the truth of the foreign-chain quote.",
        "The winner's route must still pass the device policy proof, exact-call hydration, live quote refresh and per-step wallet approval.",
        "Bridge delay or an indeterminate result is never treated as automatic solver fault.",
      ],
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/:workflowId/policy-proof", policyProofLimiter, async (req, res) => {
  try {
    const id = workflowId(req.params.workflowId);
    const token = openWorkflowTokenV3(workflowTokenFromHeader(req));
    if (token.workflowId !== id) {
      throw Object.assign(new Error("Workflow token identity did not match the requested workflow."), {
        code: "WORKFLOW_V3_TOKEN_IDENTITY_MISMATCH",
        statusCode: 409,
      });
    }
    const plan = await readWorkflowPlanV3(id);
    if (token.planHash !== workflowPlanV3Hash(plan)) {
      throw Object.assign(new Error("Workflow token is stale; reload before binding a device proof."), {
        code: "WORKFLOW_V3_TOKEN_STALE",
        statusCode: 409,
      });
    }
    const bound = await verifyAndBindPolicyProofV3(plan, req.body?.policyProof);
    await commitWorkflowPolicyProofBindingV3({
      expectedPlanHash: token.planHash,
      previousPlan: plan,
      nextPlan: bound.plan,
    });
    return res.json({
      success: true,
      status: "policy_proof_bound_exact_xdr_required",
      workflowPlan: bound.plan,
      workflowToken: sealWorkflowPlanV3(bound.plan),
      policyProofEvidence: bound.evidence,
      limitations: [
        "Proof acceptance verifies the pinned policy circuit, not a foreign-chain execution result.",
        "Raw proof bytes and all private witness material were excluded from durable storage.",
        "The browser must still hydrate the exact control-plane XDR, pass enforcing simulation and obtain a Freighter signature.",
      ],
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/:workflowId/execution-handoff", async (req, res) => {
  try {
    const id = workflowId(req.params.workflowId);
    const token = openWorkflowTokenV3(workflowTokenFromHeader(req));
    if (token.workflowId !== id) {
      throw Object.assign(new Error("Workflow token identity did not match the requested workflow."), {
        code: "WORKFLOW_V3_TOKEN_IDENTITY_MISMATCH",
        statusCode: 409,
      });
    }
    const plan = await readWorkflowPlanV3(id);
    if (token.planHash !== workflowPlanV3Hash(plan)) {
      throw Object.assign(new Error("Workflow token is stale; reload before binding the executor."), {
        code: "WORKFLOW_V3_TOKEN_STALE",
        statusCode: 409,
      });
    }
    const bound = await bindReviewedWorkflowV2ExecutorV3(plan);
    await commitWorkflowExecutionHandoffV3({
      expectedPlanHash: token.planHash,
      previousPlan: plan,
      nextPlan: bound.plan,
      executorPlan: bound.handoff.workflowPlan,
    });
    return res.json({
      success: true,
      status: "reviewed_v2_executor_bound",
      workflowPlan: bound.plan,
      workflowToken: sealWorkflowPlanV3(bound.plan),
      executionHandoff: bound.handoff,
      automaticExecution: false,
      limitations: [
        "The handoff token is returned once to the browser and is not persisted inside WorkflowPlanV3.",
        "The reviewed WorkflowPlanV2 executor still requires a fresh manifest signature and a separate wallet approval for every financial checkpoint.",
        "Stellar records the policy lifecycle and handoff hash; it does not prove the later CCTP or Aave result.",
      ],
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/:workflowId/execution-sync", async (req, res) => {
  try {
    const id = workflowId(req.params.workflowId);
    const token = openWorkflowTokenV3(workflowTokenFromHeader(req));
    if (token.workflowId !== id) {
      throw Object.assign(new Error("Workflow token identity did not match the requested workflow."), {
        code: "WORKFLOW_V3_TOKEN_IDENTITY_MISMATCH",
        statusCode: 409,
      });
    }
    const plan = await readWorkflowPlanV3(id);
    if (token.planHash !== workflowPlanV3Hash(plan)) {
      throw Object.assign(new Error("Workflow token is stale; reload before syncing execution."), {
        code: "WORKFLOW_V3_TOKEN_STALE",
        statusCode: 409,
      });
    }
    const workflowTokenV2 = req.body?.workflowTokenV2;
    const synchronized = synchronizeWorkflowExecutionV3(plan, workflowTokenV2);
    await commitWorkflowExecutionProgressV3({
      expectedPlanHash: token.planHash,
      previousPlan: plan,
      nextPlan: synchronized.plan,
      workflowTokenV2,
    });
    return res.json({
      success: true,
      status: synchronized.plan.compatibility?.status,
      workflowPlan: synchronized.plan,
      workflowToken: sealWorkflowPlanV3(synchronized.plan),
      executionProgress: synchronized.plan.compatibility,
      automaticRetry: false,
      limitations: [
        "The V2 bearer token was opened only to verify progress and was not persisted in V3 state.",
        "A terminal receipt is application evidence bound to independently checked checkpoints; Stellar still does not prove foreign-chain truth.",
        "Completed execution only unlocks separate owner-signed Stellar receipt finalization.",
      ],
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/:workflowId/advance", async (req, res) => {
  try {
    const id = workflowId(req.params.workflowId);
    const token = openWorkflowTokenV3(req.body?.workflowToken);
    if (token.workflowId !== id) {
      throw Object.assign(new Error("Workflow token identity did not match the requested workflow."), {
        code: "WORKFLOW_V3_TOKEN_IDENTITY_MISMATCH",
        statusCode: 409,
      });
    }
    const plan = await readWorkflowPlanV3(id);
    if (token.planHash !== workflowPlanV3Hash(plan)) {
      throw Object.assign(new Error("Workflow token is stale; reload the current workflow before continuing."), {
        code: "WORKFLOW_V3_TOKEN_STALE",
        statusCode: 409,
      });
    }
    const route = plan.routes.find((candidate) => candidate.id === plan.selectedRouteId);
    const step = route?.steps.find((candidate) => candidate.id === plan.currentStepId);
    if (!route || !step) {
      throw Object.assign(new Error("The workflow has no advanceable route step."), {
        code: "WORKFLOW_V3_STEP_MISSING",
        statusCode: 409,
      });
    }
    if (step.executionReadiness !== "ready") {
      throw Object.assign(new Error(step.unavailableReason || "The current capability is not ready."), {
        code: "WORKFLOW_V3_CAPABILITY_BLOCKED",
        statusCode: 409,
      });
    }
    if (step.operation === "control_plane_commit") {
      const verified = await verifyAndApplyIntentControlPlaneCommitV3(
        plan,
        step,
        req.body?.transactionHash,
      );
      await commitWorkflowAdvanceV3({
        expectedPlanHash: token.planHash,
        previousPlan: plan,
        nextPlan: verified.plan,
        evidence: verified.evidence,
      });
      return res.json({
        success: true,
        status: verified.plan.currentStepId ? "ready" : "confirmed",
        result: verified.result,
        evidence: verified.evidence,
        workflowPlan: verified.plan,
        workflowToken: sealWorkflowPlanV3(verified.plan),
        automaticRetry: false,
      });
    }
    if (step.operation === "receipt_registry_commit") {
      const verified = await verifyAndApplyReceiptRegistryCommitV3(
        plan,
        step,
        req.body?.transactionHash,
      );
      await commitWorkflowAdvanceV3({
        expectedPlanHash: token.planHash,
        previousPlan: plan,
        nextPlan: verified.plan,
        evidence: verified.evidence,
      });
      return res.json({
        success: true,
        status: verified.plan.currentStepId ? "ready" : "confirmed",
        result: verified.result,
        evidence: verified.evidence,
        workflowPlan: verified.plan,
        workflowToken: sealWorkflowPlanV3(verified.plan),
        automaticRetry: false,
      });
    }
    if (
      step.operation === "receipt_registry_finalize" ||
      step.operation === "control_plane_finalize"
    ) {
      const verified = await verifyAndApplyControlPlaneFinalizationV3(
        plan,
        step,
        req.body?.transactionHash,
      );
      await commitWorkflowAdvanceV3({
        expectedPlanHash: token.planHash,
        previousPlan: plan,
        nextPlan: verified.plan,
        evidence: verified.evidence,
      });
      return res.json({
        success: true,
        status: verified.plan.currentStepId ? "ready" : "finalized",
        result: verified.result,
        evidence: verified.evidence,
        workflowPlan: verified.plan,
        workflowToken: sealWorkflowPlanV3(verified.plan),
        automaticRetry: false,
      });
    }
    if (step.operation === "portfolio" || step.operation === "borrow_capacity") {
      const { result, evidence } = await executeWorkflowLiveReadV3(plan, step);
      const nextPlan = applyWorkflowLiveReadV3(plan, step.id);
      await commitWorkflowAdvanceV3({
        expectedPlanHash: token.planHash,
        previousPlan: plan,
        nextPlan,
        evidence,
      });
      return res.json({
        success: true,
        status: nextPlan.currentStepId ? "ready" : "confirmed",
        result,
        evidence,
        workflowPlan: nextPlan,
        workflowToken: sealWorkflowPlanV3(nextPlan),
        automaticRetry: false,
      });
    }
    // V3 intentionally refuses generic receipt-shaped input. Every financial
    // adapter must bind the exact target, method, calldata/XDR hash, signer,
    // quote and deadline before its evidence verifier can be enabled. Existing
    // reviewed execution remains available through WorkflowPlanV2 and the
    // network-local engines during this migration.
    throw Object.assign(
      new Error(
        `The ${step.protocol} V3 evidence verifier is not bound to an exact hydrated call yet. No transaction was submitted or retried.`,
      ),
      {
        code: "WORKFLOW_V3_EXACT_CALL_BINDING_REQUIRED",
        statusCode: 409,
      },
    );
  } catch (error) {
    return sendError(res, error);
  }
});

export default router;
