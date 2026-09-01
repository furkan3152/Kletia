import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const temporaryDirectory = mkdtempSync(join(tmpdir(), "kletia-workflow-v3-"));
process.env.NODE_ENV = "test";
process.env.WORKFLOW_V3_SQLITE_PATH = join(temporaryDirectory, "workflow.sqlite");
process.env.WORKFLOW_SIGNING_SECRET = "kletia-workflow-v3-store-verifier-secret";

try {
  const {
    compileWorkflowPlanV3,
    deriveRouteBoundWorkflowRootV3,
    workflowPlanV3Hash,
  } = await import("../cross-chain/v3/compiler.js");
  const { applyWorkflowLiveReadV3 } = await import("../cross-chain/v3/liveReads.js");
  const {
    commitWorkflowAdvanceV3,
    commitWorkflowExecutionHandoffV3,
    commitWorkflowExecutionProgressV3,
    commitWorkflowMarketSelectionV3,
    commitWorkflowPolicyProofBindingV3,
    openWorkflowTokenV3,
    readWorkflowPlanV3,
    saveWorkflowPlanV3,
    sealWorkflowPlanV3,
  } = await import("../cross-chain/v3/store.js");
  const { bindReviewedWorkflowV2ExecutorV3 } = await import(
    "../cross-chain/v3/executionHandoff.js"
  );
  const {
    computeWorkflowV2TerminalReceiptSha256,
    synchronizeWorkflowExecutionV3,
  } = await import("../cross-chain/v3/executionSync.js");
  const {
    rebindWorkflowPlanAuthorization,
    sealWorkflowPlanV2,
  } = await import("../cross-chain/v2/compiler.js");

  const plan = compileWorkflowPlanV3({
    semanticGoal: "Read my reviewed Base portfolio without exposing private fields.",
    legs: [{ operation: "portfolio", chain: "base_mainnet", assetIn: "USDC" }],
    walletBindings: { base_mainnet: "0x1111111111111111111111111111111111111111" },
    privacyBudget: {
      defaultLevel: "device_only",
      fields: {
        wallet_identity: "selected_provider",
        balance: "selected_provider",
        strategy: "selected_provider",
      },
      approvedProviders: ["kletia_api"],
      aiMode: "deterministic_only",
      ledgerMode: "public",
    },
  });
  await saveWorkflowPlanV3(plan);
  assert.equal(
    workflowPlanV3Hash(await readWorkflowPlanV3(plan.workflowId)),
    workflowPlanV3Hash(plan),
  );

  const token = sealWorkflowPlanV3(plan);
  assert.equal(openWorkflowTokenV3(token).workflowId, plan.workflowId);
  assert.throws(
    () => openWorkflowTokenV3(`${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`),
    (error: unknown) => (error as { code?: string }).code === "WORKFLOW_V3_TOKEN_INVALID",
  );

  const database = new DatabaseSync(process.env.WORKFLOW_V3_SQLITE_PATH);
  const tampered = structuredClone(plan);
  (tampered.intent as { semanticGoal: string }).semanticGoal = "tampered stored goal";
  database.prepare(
    "UPDATE kletia_workflow_v3_plans SET plan_json = ? WHERE workflow_id = ?",
  ).run(JSON.stringify(tampered), plan.workflowId);
  database.close();
  await assert.rejects(
    readWorkflowPlanV3(plan.workflowId),
    (error: unknown) => (error as { code?: string }).code === "WORKFLOW_V3_STORE_INTEGRITY_FAILED",
  );

  const liveReadPlan = compileWorkflowPlanV3({
    semanticGoal: "Calculate my reviewed Aave borrow capacity with live protocol evidence.",
    legs: [{
      operation: "borrow_capacity",
      chain: "arbitrum_sepolia",
      protocol: "aave-v3-arbitrum-sepolia",
      assetIn: "USDC",
    }],
    walletBindings: { arbitrum_sepolia: "0x1111111111111111111111111111111111111111" },
    privacyBudget: {
      defaultLevel: "device_only",
      fields: {
        wallet_identity: "selected_provider",
        balance: "selected_provider",
        strategy: "selected_provider",
      },
      approvedProviders: ["kletia_api", "arbitrum_sepolia_rpc"],
      aiMode: "deterministic_only",
      ledgerMode: "public",
    },
  });
  await saveWorkflowPlanV3(liveReadPlan);
  const liveReadStep = liveReadPlan.routes[0]!.steps[0]!;
  const advancedPlan = applyWorkflowLiveReadV3(liveReadPlan, liveReadStep.id);
  const evidence = {
    stepId: liveReadStep.id,
    kind: "protocol_read" as const,
    reference: "aave-v3-arbitrum-sepolia:block:123:test-evidence",
    level: "protocol_verified" as const,
    observedAt: "2026-08-22T12:00:00.000Z",
    chain: liveReadStep.chain,
    details: { mockData: false },
  };
  await commitWorkflowAdvanceV3({
    expectedPlanHash: workflowPlanV3Hash(liveReadPlan),
    previousPlan: liveReadPlan,
    nextPlan: advancedPlan,
    evidence,
  });
  assert.equal((await readWorkflowPlanV3(liveReadPlan.workflowId)).currentStepId, null);
  await assert.rejects(
    commitWorkflowAdvanceV3({
      expectedPlanHash: workflowPlanV3Hash(liveReadPlan),
      previousPlan: liveReadPlan,
      nextPlan: advancedPlan,
      evidence,
    }),
    (error: unknown) => (error as { code?: string }).code === "WORKFLOW_V3_TOKEN_STALE",
  );

  const compiledMarketPlan = compileWorkflowPlanV3({
    semanticGoal: "Select a bonded competitive route for my reviewed Base portfolio read.",
    coordinationMode: "competitive",
    legs: [{ operation: "portfolio", chain: "base_mainnet", assetIn: "USDC" }],
    walletBindings: {
      base_mainnet: "0x1111111111111111111111111111111111111111",
      stellar_mainnet: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    },
    privacyBudget: {
      defaultLevel: "selected_provider",
      fields: { wallet_identity: "selected_provider", balance: "selected_provider" },
      approvedProviders: ["kletia_api"],
      aiMode: "deterministic_only",
      ledgerMode: "public",
    },
  });
  const marketPlan = {
    ...compiledMarketPlan,
    coordinationMarket: {
      ...compiledMarketPlan.coordinationMarket,
      status: "auction_open_required" as const,
    },
  };
  const compiledMarketRoute = marketPlan.routes[0]!;
  const marketRoute = {
    ...compiledMarketRoute,
    available: true,
    unavailableReason: undefined,
    quoteExpiresAt: Date.now() + 120_000,
    steps: compiledMarketRoute.steps.map((step) => ({
      ...step,
      executionReadiness: "ready" as const,
      unavailableReason: undefined,
    })),
  };
  const executableMarketPlan = {
    ...marketPlan,
    routes: marketPlan.routes.map((route) =>
      route.id === marketRoute.id ? marketRoute : route),
  };
  await saveWorkflowPlanV3(executableMarketPlan);
  const marketSelectedPlan = {
    ...executableMarketPlan,
    selectedRouteId: marketRoute.id,
    currentStepId: null,
    coordinationMarket: {
      ...executableMarketPlan.coordinationMarket,
      status: "winner_selected" as const,
      winner: {
        solver: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        routeId: marketRoute.id,
        routeHash: marketRoute.solverRouteHash,
        netOutputAtomic: "1000000",
        observedAtLedger: "888",
      },
    },
  };
  const marketEvidence = {
    stepId: "solver-market-selection",
    kind: "auction_result" as const,
    reference: "route-auction:test-workflow:888",
    level: "chain_native_verified" as const,
    observedAt: "2026-08-22T12:00:00.000Z",
    chain: marketRoute.steps[0]!.chain.family === "stellar"
      ? marketRoute.steps[0]!.chain
      : {
          family: "stellar" as const,
          network: "testnet" as const,
          key: "stellar_testnet" as const,
          caip2: "stellar:testnet" as const,
          lane: "testnet" as const,
          networkPassphrase: "Test SDF Network ; September 2015",
        },
    details: { foreignExecutionProven: false },
  };
  const blockedMarketSelectedPlan = {
    ...marketSelectedPlan,
    routes: marketSelectedPlan.routes.map((route) =>
      route.id === marketRoute.id
        ? {
            ...route,
            available: false,
            unavailableReason: "test route became unavailable",
          }
        : route),
  };
  await assert.rejects(
    commitWorkflowMarketSelectionV3({
      expectedPlanHash: workflowPlanV3Hash(executableMarketPlan),
      previousPlan: executableMarketPlan,
      nextPlan: blockedMarketSelectedPlan,
      evidence: marketEvidence,
    }),
    (error: unknown) =>
      (error as { code?: string }).code ===
      "WORKFLOW_V3_MARKET_SELECTION_TRANSITION_INVALID",
  );
  await commitWorkflowMarketSelectionV3({
    expectedPlanHash: workflowPlanV3Hash(executableMarketPlan),
    previousPlan: executableMarketPlan,
    nextPlan: marketSelectedPlan,
    evidence: marketEvidence,
  });
  assert.equal(
    (await readWorkflowPlanV3(executableMarketPlan.workflowId)).coordinationMarket.status,
    "winner_selected",
  );
  await assert.rejects(
    commitWorkflowMarketSelectionV3({
      expectedPlanHash: workflowPlanV3Hash(executableMarketPlan),
      previousPlan: executableMarketPlan,
      nextPlan: marketSelectedPlan,
      evidence: marketEvidence,
    }),
    (error: unknown) => (error as { code?: string }).code === "WORKFLOW_V3_TOKEN_STALE",
  );

  const proofPendingPlan = compileWorkflowPlanV3({
    semanticGoal: "Apply a private policy to a reviewed multi-step Base workflow.",
    legs: [
      { operation: "portfolio", chain: "base_mainnet", assetIn: "USDC" },
      { operation: "portfolio", chain: "base_mainnet", assetIn: "USDC" },
    ],
    walletBindings: {
      base_mainnet: "0x1111111111111111111111111111111111111111",
      stellar_mainnet: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    },
    privacyBudget: {
      defaultLevel: "selected_provider",
      fields: { wallet_identity: "selected_provider", balance: "selected_provider" },
      approvedProviders: ["kletia_api"],
      aiMode: "deterministic_only",
      ledgerMode: "public",
    },
  });
  await saveWorkflowPlanV3(proofPendingPlan);
  const proofRoute = proofPendingPlan.routes[0]!;
  const scalar = (value: number) => `0x${value.toString(16).padStart(64, "0")}` as const;
  const proofBoundRoutes = proofPendingPlan.routes.map((route) =>
    route.id === proofRoute.id
      ? {
          ...route,
          steps: route.steps.map((step) =>
            step.operation === "control_plane_commit"
              ? {
                  ...step,
                  executionReadiness: "ready" as const,
                  status: "awaiting_signature" as const,
                  unavailableReason: undefined,
                }
              : step,
          ),
        }
      : route,
  );
  const proofBoundCurrentStepId = proofBoundRoutes
    .find((route) => route.id === proofRoute.id)!
    .steps.find((step) => step.status === "awaiting_signature" || step.status === "ready")!
    .id;
  const proofBoundPlan = {
    ...proofPendingPlan,
    selectedRouteId: proofRoute.id,
    currentStepId: proofBoundCurrentStepId,
    routes: proofBoundRoutes,
    controlPlane: {
      ...proofPendingPlan.controlPlane,
      workflowRoot: deriveRouteBoundWorkflowRootV3(proofPendingPlan, proofRoute.id),
      policyRoot: scalar(2),
      nullifier: scalar(3),
      proofBinding: {
        ...proofPendingPlan.controlPlane.proofBinding,
        status: "bound" as const,
        routeId: proofRoute.id,
        verifierVersion: 1,
        protocolRegistryRoot: scalar(4),
        assetRegistryRoot: scalar(5),
        recipientPolicyRoot: scalar(6),
        executionExpiresAtLedger: 99_999_999,
        executionContextCommitment: scalar(7),
        publicInputsHash: `0x${"88".repeat(32)}` as const,
        proofSha256: `0x${"99".repeat(32)}` as const,
        verifiedAtLedger: "777",
      },
      commitment: {
        ...proofPendingPlan.controlPlane.commitment,
        status: "awaiting_signature" as const,
      },
    },
  };
  const tamperedReceiptRegistryPlan = {
    ...proofBoundPlan,
    controlPlane: {
      ...proofBoundPlan.controlPlane,
      receiptRegistry: {
        ...proofBoundPlan.controlPlane.receiptRegistry,
        status: "awaiting_signature" as const,
      },
    },
  };
  await assert.rejects(
    commitWorkflowPolicyProofBindingV3({
      expectedPlanHash: workflowPlanV3Hash(proofPendingPlan),
      previousPlan: proofPendingPlan,
      nextPlan: tamperedReceiptRegistryPlan,
    }),
    (error: unknown) =>
      (error as { code?: string }).code ===
      "WORKFLOW_V3_POLICY_BINDING_TRANSITION_INVALID",
  );
  await commitWorkflowPolicyProofBindingV3({
    expectedPlanHash: workflowPlanV3Hash(proofPendingPlan),
    previousPlan: proofPendingPlan,
    nextPlan: proofBoundPlan,
  });
  assert.equal(
    (await readWorkflowPlanV3(proofPendingPlan.workflowId)).controlPlane.proofBinding.status,
    "bound",
  );
  assert.equal(
    (await readWorkflowPlanV3(proofPendingPlan.workflowId)).controlPlane.commitment.status,
    "awaiting_signature",
  );
  await assert.rejects(
    commitWorkflowPolicyProofBindingV3({
      expectedPlanHash: workflowPlanV3Hash(proofPendingPlan),
      previousPlan: proofPendingPlan,
      nextPlan: proofBoundPlan,
    }),
    (error: unknown) => (error as { code?: string }).code === "WORKFLOW_V3_TOKEN_STALE",
  );

  const handoffDraft = compileWorkflowPlanV3({
    semanticGoal: "Execute the reviewed Arc to Arbitrum Sepolia supply corridor.",
    coordinationMode: "direct",
    legs: [
      { operation: "bridge", chain: "arc_testnet", protocol: "circle-cctp-v2", assetIn: "USDC", assetOut: "USDC" },
      { operation: "supply", chain: "arbitrum_sepolia", protocol: "aave-v3", assetIn: "USDC" },
      { operation: "borrow_capacity", chain: "arbitrum_sepolia", protocol: "aave-v3", assetIn: "USDC" },
    ],
    walletBindings: {
      arc_testnet: "0x1111111111111111111111111111111111111111",
      arbitrum_sepolia: "0x1111111111111111111111111111111111111111",
      stellar_testnet: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    },
    privateBindings: [
      {
        field: "amount",
        reference: "private://amount",
        commitment: `0x${"aa".repeat(32)}`,
        disclosureLevel: "public_execution",
      },
      {
        field: "recipient",
        reference: "private://recipient",
        commitment: `0x${"bb".repeat(32)}`,
        disclosureLevel: "public_execution",
      },
    ],
    privacyBudget: {
      defaultLevel: "device_only",
      fields: {
        amount: "public_execution",
        recipient: "public_execution",
        wallet_identity: "selected_provider",
        balance: "selected_provider",
        strategy: "selected_provider",
      },
      approvedProviders: ["kletia_api", "arbitrum_sepolia_rpc"],
      aiMode: "deterministic_only",
      ledgerMode: "public",
    },
  }, { liveControlPlaneReady: true });
  const handoffRouteDraft = handoffDraft.routes.find(
    (route) => route.id === "arc-arbitrum-direct-cctp",
  )!;
  const handoffSteps = handoffRouteDraft.steps.map((step) => {
    if (step.operation === "control_plane_commit" || step.operation === "receipt_registry_commit") {
      return { ...step, status: "confirmed" as const, executionReadiness: "ready" as const };
    }
    const firstFinancial = handoffRouteDraft.steps.find(
      (candidate) =>
        candidate.operation !== "control_plane_commit" &&
        candidate.operation !== "receipt_registry_commit",
    );
    return {
      ...step,
      status: step.id === firstFinancial?.id ? "awaiting_signature" as const : "planned" as const,
      executionReadiness: "ready" as const,
      unavailableReason: undefined,
    };
  });
  const handoffRoute = {
    ...handoffRouteDraft,
    available: true,
    unavailableReason: undefined,
    quoteExpiresAt: Date.now() + 60_000,
    hydration: {
      schemaVersion: "kletia_route_hydration_v1" as const,
      status: "live_quote_bound" as const,
      amountCommitment: `0x${"aa".repeat(32)}` as const,
      quoteCommitment: `0x${"cc".repeat(32)}` as const,
      observedAt: new Date().toISOString(),
      observedAtBlock: "123",
      quoteExpiresAt: Date.now() + 60_000,
      sourceBalanceSufficient: true,
      publicAmountDisclosureApproved: true as const,
      standardFeeBps: 10,
      sources: ["arc_rpc", "circle_iris_sandbox", "aave_v3_arbitrum_sepolia"],
    },
    metrics: {
      ...handoffRouteDraft.metrics,
      estimatedOutputAtomic: "4994000",
      bridgeFeeUsd: "0.006",
      slippageBps: 0,
      estimatedApyBps: 325,
      amountDependentCostsComplete: true,
    },
    steps: handoffSteps,
  };
  const handoffCurrent = handoffSteps.find((step) => step.status === "awaiting_signature")!;
  const handoffReadyPlan = {
    ...handoffDraft,
    selectedRouteId: handoffRoute.id,
    currentStepId: handoffCurrent.id,
    routes: handoffDraft.routes.map((route) => route.id === handoffRoute.id ? handoffRoute : route),
    controlPlane: {
      ...handoffDraft.controlPlane,
      policyRoot: scalar(11),
      nullifier: scalar(12),
      proofBinding: {
        ...handoffDraft.controlPlane.proofBinding,
        status: "bound" as const,
        routeId: handoffRoute.id,
        verifierVersion: 1,
        protocolRegistryRoot: scalar(13),
        assetRegistryRoot: scalar(14),
        recipientPolicyRoot: scalar(15),
        executionExpiresAtLedger: 99_999,
        executionContextCommitment: scalar(16),
        publicInputsHash: `0x${"dd".repeat(32)}` as const,
        proofSha256: `0x${"ee".repeat(32)}` as const,
        verifiedAtLedger: "777",
      },
      commitment: {
        status: "confirmed" as const,
        owner: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        nonce: "7",
        transactionHash: "11".repeat(32),
        committedAtLedger: "778",
        receiptCloseByLedger: 100_719,
        retentionFloorLedger: 100_720,
      },
      receiptRegistry: {
        status: "confirmed" as const,
        owner: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        nonce: "7",
        transactionHash: "22".repeat(32),
        committedAtLedger: "779",
      },
    },
  };
  await saveWorkflowPlanV3(handoffReadyPlan);
  const handoffBound = await bindReviewedWorkflowV2ExecutorV3(
    handoffReadyPlan,
    {
      readRouteMetrics: async () => ({
        direct: {
          observedAt: "2026-08-24T00:00:30.000Z",
          quoteExpiresAt: Date.now() + 90_000,
          cctpStandardFeeBps: 12,
          cctpHops: 1 as const,
          cctpLegs: [{ sourceDomain: 26 as const, destinationDomain: 3 as const, standardFeeBps: 12 }],
          aaveSupplyApyBps: 330,
          sources: ["circle_iris_sandbox", "aave_v3_arbitrum_sepolia"] as const,
        },
      }),
      readBorrowCapacity: async () => ({ supplyApyBps: 330 }),
    } as never,
  );
  const tamperedHandoff = {
    ...handoffBound.plan,
    compatibility: {
      ...handoffBound.plan.compatibility!,
      planCoreSha256: `0x${"ff".repeat(32)}` as const,
    },
  };
  await assert.rejects(
    commitWorkflowExecutionHandoffV3({
      expectedPlanHash: workflowPlanV3Hash(handoffReadyPlan),
      previousPlan: handoffReadyPlan,
      nextPlan: tamperedHandoff,
      executorPlan: handoffBound.handoff.workflowPlan,
    }),
    (error: unknown) =>
      (error as { code?: string }).code ===
      "WORKFLOW_V3_EXECUTOR_HANDOFF_TRANSITION_INVALID",
  );
  await commitWorkflowExecutionHandoffV3({
    expectedPlanHash: workflowPlanV3Hash(handoffReadyPlan),
    previousPlan: handoffReadyPlan,
    nextPlan: handoffBound.plan,
    executorPlan: handoffBound.handoff.workflowPlan,
  });
  assert.equal(
    (await readWorkflowPlanV3(handoffReadyPlan.workflowId)).compatibility?.workflowId,
    handoffBound.handoff.workflowPlan.workflowId,
  );
  assert.equal(
    JSON.stringify(await readWorkflowPlanV3(handoffReadyPlan.workflowId)).includes(
      handoffBound.handoff.workflowToken,
    ),
    false,
  );

  const executorProgress = rebindWorkflowPlanAuthorization({
    ...handoffBound.handoff.workflowPlan,
    currentStepIndex: 1,
    steps: handoffBound.handoff.workflowPlan.steps.map((step, index) => index === 0
      ? {
          ...step,
          status: "confirmed" as const,
          result: {
            kind: "evm_transaction" as const,
            reference: `0x${"33".repeat(32)}`,
            observedAt: "2026-08-24T00:01:00.000Z",
          },
        }
      : index === 1 ? { ...step, status: "awaiting_signature" as const } : step),
  });
  const executorProgressToken = sealWorkflowPlanV2(executorProgress);
  const storedHandoff = await readWorkflowPlanV3(handoffReadyPlan.workflowId);
  const synchronizedProgress = synchronizeWorkflowExecutionV3(
    storedHandoff,
    executorProgressToken,
  );
  assert.equal(synchronizedProgress.plan.compatibility?.status, "in_progress");
  assert.equal(synchronizedProgress.plan.compatibility?.confirmedCheckpointCount, 1);
  await commitWorkflowExecutionProgressV3({
    expectedPlanHash: workflowPlanV3Hash(storedHandoff),
    previousPlan: storedHandoff,
    nextPlan: synchronizedProgress.plan,
    workflowTokenV2: executorProgressToken,
  });
  const storedProgress = await readWorkflowPlanV3(handoffReadyPlan.workflowId);
  await assert.rejects(
    commitWorkflowExecutionProgressV3({
      expectedPlanHash: workflowPlanV3Hash(storedHandoff),
      previousPlan: storedHandoff,
      nextPlan: synchronizedProgress.plan,
      workflowTokenV2: executorProgressToken,
    }),
    (error: unknown) => (error as { code?: string }).code === "WORKFLOW_V3_TOKEN_STALE",
  );
  assert.throws(
    () => synchronizeWorkflowExecutionV3(storedProgress, handoffBound.handoff.workflowToken),
    (error: unknown) => (error as { code?: string }).code === "WORKFLOW_V3_EXECUTION_SYNC_REGRESSION",
  );

  const terminalGeneratedAt = "2026-08-24T00:02:00.000Z";
  const terminalDraft = rebindWorkflowPlanAuthorization({
    ...executorProgress,
    currentStepIndex: executorProgress.steps.length - 1,
    manifestAuthorization: {
      family: "evm" as const,
      signer: "0x1111111111111111111111111111111111111111",
      signature: `0x${"44".repeat(65)}`,
      manifestSha256: `0x${"55".repeat(32)}`,
      verifiedAt: terminalGeneratedAt,
    },
    steps: executorProgress.steps.map((step) => ({
      ...step,
      status: step.action === "cctp_attestation" ? "filled" as const : "confirmed" as const,
      result: {
        kind: step.action === "cctp_attestation" ? "circle_attestation" as const : "read_result" as const,
        reference: `${step.id}-verified-evidence`,
        observedAt: terminalGeneratedAt,
      },
    })),
    terminalReceipt: {
      schemaVersion: "kletia_workflow_terminal_receipt_v1" as const,
      receiptSha256: `0x${"66".repeat(32)}` as const,
      generatedAt: terminalGeneratedAt,
      checkpointCount: executorProgress.steps.length,
      executorPlanCoreSha256: executorProgress.authorizationBoundary.planCoreSha256,
      externalExecutionTruthProvenByStellar: false as const,
    },
  });
  const exactTerminalHash = computeWorkflowV2TerminalReceiptSha256(terminalDraft);
  assert.ok(exactTerminalHash);
  const terminalExecutor = rebindWorkflowPlanAuthorization({
    ...terminalDraft,
    terminalReceipt: {
      ...terminalDraft.terminalReceipt!,
      receiptSha256: exactTerminalHash!,
      executorPlanCoreSha256: terminalDraft.authorizationBoundary.planCoreSha256,
    },
  });
  const terminalToken = sealWorkflowPlanV2(terminalExecutor);
  const synchronizedTerminal = synchronizeWorkflowExecutionV3(storedProgress, terminalToken);
  assert.equal(synchronizedTerminal.plan.compatibility?.status, "completed");
  assert.equal(
    synchronizedTerminal.plan.compatibility?.terminalReceiptSha256,
    exactTerminalHash,
  );
  assert.equal(
    synchronizedTerminal.plan.routes.find((route) => route.id === handoffRoute.id)?.steps
      .find((step) => step.operation === "receipt_registry_finalize")?.status,
    "awaiting_signature",
  );
  await commitWorkflowExecutionProgressV3({
    expectedPlanHash: workflowPlanV3Hash(storedProgress),
    previousPlan: storedProgress,
    nextPlan: synchronizedTerminal.plan,
    workflowTokenV2: terminalToken,
  });
  const storedTerminal = await readWorkflowPlanV3(handoffReadyPlan.workflowId);
  assert.equal(JSON.stringify(storedTerminal).includes(terminalToken), false);

  const express = (await import("express")).default;
  const workflowRouter = (await import("../cross-chain/v3/routes.js")).default;
  const httpApp = express();
  httpApp.use(express.json());
  httpApp.use("/api/workflows/v3", workflowRouter);
  const server = await new Promise<import("node:http").Server>((resolve) => {
    const started = httpApp.listen(0, "127.0.0.1", () => resolve(started));
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const compileResponse = await fetch(`${origin}/api/workflows/v3/compile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        semanticGoal: "Read my reviewed Base portfolio through a sealed workflow.",
        legs: [{ operation: "portfolio", chain: "base_mainnet", assetIn: "USDC" }],
        walletBindings: { base_mainnet: "0x1111111111111111111111111111111111111111" },
        privacyBudget: {
          defaultLevel: "device_only",
          fields: { wallet_identity: "selected_provider" },
          approvedProviders: ["kletia_api"],
          aiMode: "deterministic_only",
          ledgerMode: "public",
        },
      }),
    });
    assert.equal(compileResponse.status, 201);
    const compiled = await compileResponse.json() as {
      workflowPlan: { workflowId: string };
      workflowToken: string;
    };
    const workflowUrl = `${origin}/api/workflows/v3/${compiled.workflowPlan.workflowId}`;
    assert.equal((await fetch(workflowUrl)).status, 401);
    assert.equal((await fetch(`${workflowUrl}/policy-proof`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ policyProof: {} }),
    })).status, 401);
    assert.equal(
      (await fetch(`${workflowUrl}?workflowToken=${encodeURIComponent(compiled.workflowToken)}`)).status,
      401,
    );
    assert.equal((await fetch(workflowUrl, {
      headers: { Authorization: `Bearer ${compiled.workflowToken}` },
    })).status, 200);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  console.log("Workflow V3 durable-store identity, hash, token-authenticated reads and atomic live-read transition boundaries verified.");
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
