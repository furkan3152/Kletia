import { randomUUID } from "crypto";
import { Router } from "express";
import { getAddress, zeroAddress } from "viem";

import {
  IntentDisclosureConsentRequiredError,
  parseUserIntent,
  type IntentSemanticPlannerMode,
  type ParsedIntent,
} from "../../shared/ai/parser.js";
import {
  resolveIntentEntities,
  type IntentEntityResolutionEvidence,
} from "../../shared/assets/resolver.js";
import { executeKletiaEngine } from "../../networks/base/engine.js";
import { executeArcEngine } from "../../networks/arc/engine.js";
import { executeArbitrumEngine } from "../../networks/arbitrum/engine.js";
import { compileWorkflow } from "../../cross-chain/workflow.js";
import { createVerifiedIntentResultEnvelope } from "../../shared/intent/responseEnvelope.js";
import { verifySemanticConsentToken } from "../../shared/intent/semanticConsent.js";
import { privacyDecisionContract } from "../../shared/intent/privacyDecision.js";
import {
  CONVERSATION_TTL_MS,
  PENDING_RESOLUTION_TTL_MS,
  UUID_V4_PATTERN,
  allocateConversationId,
  applyPendingIntentCompletion,
  conversationSessions,
  pendingIntentCompletion,
} from "../../shared/intent/conversationStore.js";
import { createIntentPrivacyTrace } from "../../shared/privacy/intentPrivacyTrace.js";
import {
  RequestIdValidationError,
  requireIntentRequestId,
  resolveIntentRequestId,
} from "../../shared/security/requestId.js";
import { resolveIntentPublicError } from "../../shared/security/intentError.js";
import { validateAddress, sanitizePrompt } from "../../shared/http/security.js";
import { requireIntentNetwork } from "../../shared/http/network.js";
import { resolveBasenameEvidence } from "../../networks/base/intent/basenameResolver.js";

/**
 * Natural-language intent endpoints:
 *   POST /api/intent/revalidate-recipient  re-resolve a Basename right before signing
 *   POST /api/intent                       prompt -> parsed intent -> resolved entities
 *                                          -> network engine -> verified envelope
 *
 * Gates on POST /api/intent, in order: strict network + chainId, request id,
 * wallet address screening, prompt sanitisation.
 */

function resolveIntentSemanticPlanner(
  value: unknown,
): IntentSemanticPlannerMode {
  const mode = String(value ?? "deterministic_only").trim();
  if (mode === "deterministic_only" || mode === "ai_assisted") return mode;
  throw Object.assign(new Error("Unsupported semantic planner mode."), {
    code: "INTENT_SEMANTIC_PLANNER_INVALID",
    statusCode: 400,
  });
}

const router = Router();

router.post(
  "/api/intent/revalidate-recipient",
  requireIntentNetwork,
  async (req, res) => {
    const network = req.kletiaNetwork!;
    let requestId: string;
    try {
      requestId = resolveIntentRequestId(
        req.body?.requestId,
        req.body?.msgId,
        randomUUID,
      );
    } catch (error) {
      if (error instanceof RequestIdValidationError) {
        return res.status(error.statusCode).json({
          success: false,
          code: error.code,
          message: error.message,
          network: network.id,
          chainId: network.chainId,
        });
      }
      throw error;
    }

    const name =
      typeof req.body?.name === "string"
        ? req.body.name.trim().toLowerCase()
        : "";
    if (
      name.length < 6 ||
      name.length > 80 ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.base(?:\.eth)?$/u.test(name)
    ) {
      return res.status(400).json({
        success: false,
        code: "INVALID_BASENAME",
        message:
          "Recipient to be revalidated must be a valid .base or .base.eth name.",
        network: network.id,
        chainId: network.chainId,
        requestId,
      });
    }

    let expectedAddress;
    let userAddress;
    try {
      expectedAddress = getAddress(String(req.body?.expectedAddress || ""));
      userAddress = getAddress(String(req.body?.userAddress || ""));
      if (expectedAddress === zeroAddress || userAddress === zeroAddress) {
        throw new Error("zero_address");
      }
    } catch {
      return res.status(400).json({
        success: false,
        code: "INVALID_REVALIDATION_ADDRESS",
        message:
          "Expected recipient and active wallet must be valid, non-zero EVM addresses.",
        network: network.id,
        chainId: network.chainId,
        requestId,
      });
    }

    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const evidence = await Promise.race([
        resolveBasenameEvidence(name),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("basename_revalidation_timeout")),
            8_000,
          );
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      if (!evidence) {
        return res.status(409).json({
          success: false,
          code: "BASENAME_UNRESOLVED",
          message:
            "Basename could not be re-resolved immediately before signing; transaction plan was not used.",
          network: network.id,
          chainId: network.chainId,
          requestId,
          userAddress,
        });
      }
      if (evidence.address !== expectedAddress) {
        return res.status(409).json({
          success: false,
          code: "BASENAME_RECORD_CHANGED",
          message:
            "Basename address record changed after plan creation; a new intent must be created.",
          network: network.id,
          chainId: network.chainId,
          requestId,
          userAddress,
        });
      }
      return res.json({
        success: true,
        status: "resolved",
        network: network.id,
        chainId: network.chainId,
        requestId,
        userAddress,
        recipientResolution: {
          role: "recipient",
          originalReference: name,
          resolvedAddress: evidence.address,
          matchedBy: "basename",
          basename: evidence.name,
          resolver: evidence.resolver,
          observedAtBlock: evidence.observedAtBlock,
          observedAt: evidence.observedAt,
          expiresAt: evidence.expiresAt,
          crossNetworkIdentity: network.id !== "base",
        },
      });
    } catch {
      return res.status(503).json({
        success: false,
        code: "BASENAME_REVALIDATION_UNAVAILABLE",
        message:
          "Basename revalidation could not be completed; transaction was not sent.",
        network: network.id,
        chainId: network.chainId,
        requestId,
        userAddress,
      });
    }
  },
);

router.post(
  "/api/intent",
  requireIntentNetwork,
  requireIntentRequestId,
  validateAddress,
  sanitizePrompt,
  async (req, res) => {
    const { prompt, userAddress } = req.body;
    const network = req.kletiaNetwork!;
    const requestId = req.kletiaRequestId!;
    const responseMetadata = {
      network: network.id,
      chainId: network.chainId,
      requestId,
    };
    let semanticPlanner: IntentSemanticPlannerMode;
    try {
      semanticPlanner = resolveIntentSemanticPlanner(req.body?.semanticPlanner);
    } catch (error) {
      const candidate = error as { code?: string; statusCode?: number; message?: string };
      return res.status(candidate.statusCode || 400).json({
        success: false,
        code: candidate.code || "INTENT_SEMANTIC_PLANNER_INVALID",
        message: candidate.message || "Unsupported semantic planner mode.",
        ...responseMetadata,
      });
    }

    if (!prompt || !userAddress) {
      return res.status(400).json({
        success: false,
        code: "INVALID_INTENT_REQUEST",
        error: "The prompt and userAddress fields are required.",
        message: "The prompt and userAddress fields are required.",
        ...responseMetadata,
      });
    }

    let semanticProviderRequestAttempted = false;
    let semanticModelInfluencedPlan = false;
    const privacyTrace = (
      stage: Parameters<typeof createIntentPrivacyTrace>[0]["stage"],
      options: {
        readonly intent?: Pick<ParsedIntent, "action">;
        readonly clarificationStored?: boolean;
      } = {},
    ) =>
      createIntentPrivacyTrace({
        requestId,
        network: network.id,
        chainId: network.chainId,
        prompt: String(prompt),
        stage,
        semanticPlanner,
        semanticProviderRequestAttempted,
        semanticModelInfluencedPlan,
        intent: options.intent,
        clarificationStored: options.clarificationStored === true,
      });

    const suppliedConversationId = req.body.conversationId;
    if (
      suppliedConversationId !== undefined &&
      (typeof suppliedConversationId !== "string" ||
        !UUID_V4_PATTERN.test(suppliedConversationId))
    ) {
      return res.status(400).json({
        success: false,
        code: "INVALID_CONVERSATION_ID",
        error: "Invalid conversationId.",
        message: "Invalid conversationId.",
        ...responseMetadata,
      });
    }

    const suppliedClarificationSelection = req.body.clarificationSelection;
    if (
      suppliedClarificationSelection !== undefined &&
      (!suppliedClarificationSelection ||
        typeof suppliedClarificationSelection !== "object" ||
        Array.isArray(suppliedClarificationSelection) ||
        typeof suppliedClarificationSelection.optionId !== "string" ||
        suppliedClarificationSelection.optionId.length < 1 ||
        suppliedClarificationSelection.optionId.length > 160 ||
        Object.keys(suppliedClarificationSelection).some(
          (key) => key !== "optionId",
        ))
    ) {
      return res.status(400).json({
        success: false,
        code: "INVALID_CLARIFICATION_SELECTION",
        error: "Invalid token selection.",
        message: "Invalid token selection.",
        ...responseMetadata,
      });
    }

    console.log(
      `
📡 [NEW ORDER][${network.id}:${network.chainId}][${requestId}] ` +
        `promptLength=${String(prompt).length} wallet=${userAddress.substring(0, 6)}…`,
    );

    try {
      let conversationId =
        typeof suppliedConversationId === "string"
          ? suppliedConversationId
          : null;
      let session = conversationId
        ? conversationSessions.get(conversationId)
        : undefined;
      if (
        session &&
        (Date.now() - session.lastAccess > CONVERSATION_TTL_MS ||
          (session.pendingResolution !== undefined &&
            Date.now() > session.pendingResolution.expiresAt) ||
          (session.pendingCompletion !== undefined &&
            Date.now() > session.pendingCompletion.expiresAt) ||
          session.network !== network.id ||
          session.userAddress !== String(userAddress).toLowerCase())
      ) {
        conversationSessions.delete(conversationId!);
        session = undefined;
      }
      semanticModelInfluencedPlan =
        session?.semanticModelInfluencedPlan === true;
      if (conversationId && !session) {
        return res.status(409).json({
          success: false,
          code: "CONVERSATION_CONTEXT_INVALID",
          error:
            "Conversation context not found, expired, or does not match wallet/network.",
          message:
            "Conversation context not found, expired, or does not match wallet/network.",
          ...responseMetadata,
        });
      }

      const history = session ? [...session.history] : [];
      let aiConsentExpiresAt = session?.aiConsentExpiresAt;
      let parsedIntent: ParsedIntent;
      let resolutionPrompt = String(prompt);
      if (session?.pendingCompletion) {
        const pending = session.pendingCompletion;
        const completed = applyPendingIntentCompletion(pending, String(prompt));
        if (!completed) {
          session.lastAccess = Date.now();
          conversationSessions.set(conversationId!, session);
          return res.json({
            success: false,
            status: "question",
            requiresInput: true,
            question: pending.question,
            message: pending.question,
            conversationId,
            conversationExpiresAt: pending.expiresAt,
            privacyTrace: privacyTrace("clarification", {
              intent: pending.intent,
              clarificationStored: true,
            }),
            userAddress: getAddress(userAddress),
            ...responseMetadata,
          });
        }
        parsedIntent = completed;
        resolutionPrompt = `${pending.originalPrompt}\n${pending.field}: ${String(prompt).trim()}`;
        conversationSessions.delete(conversationId!);
        session = undefined;
      } else if (session?.pendingResolution) {
        const pending = session.pendingResolution;
        const field = pending.clarification.field;
        if (!field) {
          conversationSessions.delete(conversationId!);
          return res.status(409).json({
            success: false,
            code: "CLARIFICATION_CONTEXT_INVALID",
            error: "Token selection context is invalid.",
            message: "Token selection context is invalid.",
            ...responseMetadata,
          });
        }
        const selectedOption = suppliedClarificationSelection
          ? pending.clarification.options.find(
              ({ id }) => id === suppliedClarificationSelection.optionId,
            )
          : undefined;
        if (suppliedClarificationSelection && !selectedOption) {
          return res.status(409).json({
            success: false,
            code: "CLARIFICATION_OPTION_INVALID",
            error: "Selected token is not among the candidates for the pending intent.",
            message:
              "Selected token is not among the candidates for the pending intent.",
            ...responseMetadata,
          });
        }
        const workflowField = /^workflowSteps\.(\d+)\.(tokenIn|tokenOut|collateralToken|borrowToken)$/u.exec(field);
        if (workflowField) {
          const stepIndex = Number(workflowField[1]);
          const assetField = workflowField[2] as "tokenIn" | "tokenOut";
          if (
            !selectedOption ||
            !pending.intent.workflowSteps ||
            !Number.isSafeInteger(stepIndex) ||
            stepIndex < 0 ||
            stepIndex >= pending.intent.workflowSteps.length ||
            (assetField !== "tokenIn" && assetField !== "tokenOut")
          ) {
            return res.status(409).json({
              success: false,
              code: "CLARIFICATION_CONTEXT_INVALID",
              error: "Workflow asset selection context is invalid.",
              message: "Workflow asset selection context is invalid.",
              ...responseMetadata,
            });
          }
          const workflowSteps = pending.intent.workflowSteps.map((step, index) =>
            index === stepIndex
              ? { ...step, [assetField]: selectedOption.symbol }
              : step,
          );
          parsedIntent = {
            ...pending.intent,
            workflowSteps,
            isComplete: true,
          };
        } else {
          const selectedReference = selectedOption
            ? selectedOption.address || selectedOption.symbol
            : String(prompt).trim();
          parsedIntent = {
            ...pending.intent,
            [field]: selectedReference,
            isComplete: true,
          };
        }
        resolutionPrompt = pending.originalPrompt;

        conversationSessions.delete(conversationId!);
        session = undefined;
      } else {
        if (suppliedClarificationSelection) {
          return res.status(409).json({
            success: false,
            code: "CLARIFICATION_CONTEXT_REQUIRED",
            error: "A valid and pending intent is required for token selection.",
            message: "A valid and pending intent is required for token selection.",
            ...responseMetadata,
          });
        }
        if (semanticPlanner === "ai_assisted") {
          const existingConsentIsActive =
            session?.semanticPlanner === "ai_assisted" &&
            typeof session.aiConsentExpiresAt === "number" &&
            session.aiConsentExpiresAt > Date.now();
          if (!existingConsentIsActive) {
            const consent = verifySemanticConsentToken(
              req.body?.semanticPlannerConsentToken,
              {
                network: network.id,
                chainId: network.chainId,
                userAddress: getAddress(userAddress),
                prompt: String(prompt),
              },
            );
            aiConsentExpiresAt = consent.expiresAt;
          }
        }
        try {
          parsedIntent = await parseUserIntent(prompt, history, network.id, {
            semanticPlanner,
            onSemanticProviderRequest: () => {
              semanticProviderRequestAttempted = true;
            },
          });
          if (semanticProviderRequestAttempted) {
            semanticModelInfluencedPlan = true;
          }
        } catch (error) {
          if (error instanceof IntentDisclosureConsentRequiredError) {
            const privacyDecision = privacyDecisionContract({
              network: network.id,
              chainId: network.chainId,
              userAddress: getAddress(userAddress),
              prompt: String(prompt),
            });
            return res.status(error.statusCode).json({
              success: false,
              status: "question",
              requiresInput: true,
              code: error.code,
              question: privacyDecision.question,
              message: error.message,
              privacyDecision,
              privacyTrace: privacyTrace("semantic_consent"),
              userAddress: getAddress(userAddress),
              ...responseMetadata,
            });
          }
          throw error;
        }
      }

      history.push({ role: "user", content: prompt });
      history.push({
        role: "assistant",
        content: parsedIntent.message || "Understood.",
      });
      console.log(
        `[PARSED INTENT][${network.id}:${network.chainId}][${requestId}] ` +
          `action=${parsedIntent.action} complete=${parsedIntent.isComplete}`,
      );
      if (!parsedIntent.isComplete) {
        if (!conversationId) conversationId = allocateConversationId();
        const completion = pendingIntentCompletion(parsedIntent);
        conversationSessions.set(conversationId, {
          network: network.id,
          userAddress: String(userAddress).toLowerCase(),
          history: history.slice(-6),
          lastAccess: Date.now(),
          semanticPlanner,
          semanticModelInfluencedPlan,
          ...(semanticPlanner === "ai_assisted" && aiConsentExpiresAt
            ? { aiConsentExpiresAt }
            : {}),
          ...(completion
            ? {
                pendingCompletion: {
                  ...completion,
                  originalPrompt: String(prompt),
                },
              }
            : {}),
        });
        const conversationExpiresAt = completion?.expiresAt ||
          Date.now() + CONVERSATION_TTL_MS;
        return res.json({
          success: false,
          status: "question",
          requiresInput: true,
          question:
            parsedIntent.question ||
            parsedIntent.message ||
            "A little more information is required.",
          message: parsedIntent.message,
          conversationId,
          conversationExpiresAt,
          privacyTrace: privacyTrace("clarification", {
            intent: parsedIntent,
            clarificationStored: true,
          }),
          userAddress: getAddress(userAddress),
          ...responseMetadata,
        });
      }

      const entityResolution = await resolveIntentEntities(parsedIntent, {
        network: network.id,
        userAddress,
        originalPrompt: resolutionPrompt,
        requestId,
      });
      if (entityResolution.status === "clarification") {
        if (!conversationId) conversationId = allocateConversationId();
        const conversationExpiresAt = Date.now() + PENDING_RESOLUTION_TTL_MS;
        conversationSessions.set(conversationId, {
          network: network.id,
          userAddress: String(userAddress).toLowerCase(),
          history: [],
          lastAccess: Date.now(),
          semanticPlanner,
          semanticModelInfluencedPlan,
          ...(semanticPlanner === "ai_assisted" && aiConsentExpiresAt
            ? { aiConsentExpiresAt }
            : {}),
          pendingResolution: {
            intent: parsedIntent,
            originalPrompt: resolutionPrompt,
            clarification: entityResolution.clarification,
            expiresAt: conversationExpiresAt,
          },
        });
        return res.json({
          success: false,
          status: "question",
          requiresInput: true,
          question: entityResolution.clarification.question,
          message: entityResolution.clarification.question,
          clarification: entityResolution.clarification,
          conversationId,
          conversationExpiresAt,
          privacyTrace: privacyTrace("clarification", {
            intent: parsedIntent,
            clarificationStored: true,
          }),
          userAddress: getAddress(userAddress),
          ...responseMetadata,
        });
      }

      if (conversationId) conversationSessions.delete(conversationId);
      const executableIntent = entityResolution.intent;
      const resolutionEvidence: IntentEntityResolutionEvidence =
        entityResolution.evidence;

      const rawResult =
        executableIntent.action === "workflow"
          ? await compileWorkflow(
              executableIntent,
              userAddress,
              requestId,
              resolutionPrompt,
              req.kletiaBaseX402Challenge,
              network.id,
            )
        : network.id === "arc"
          ? await executeArcEngine(
              executableIntent,
              userAddress,
              resolutionPrompt,
              requestId,
            )
          : network.id === "arbitrum"
            ? await executeArbitrumEngine(
                executableIntent,
                userAddress,
                resolutionPrompt,
                requestId,
              )
            : await executeKletiaEngine(
              executableIntent,
              userAddress,
              resolutionPrompt,
              requestId,
              req.kletiaBaseX402Challenge,
            );

      const result =
        rawResult.executionKind === "workflow_plan_v1" &&
        rawResult.action === "workflow" &&
        rawResult.entityResolution
          ? {
              message: rawResult.winnerMessage || executableIntent.message,
              ...rawResult,
            }
          : createVerifiedIntentResultEnvelope(
              {
                message: rawResult.winnerMessage || executableIntent.message,
                ...rawResult,
              },
              network.id,
              requestId,
              userAddress,
              resolutionEvidence,
            );

      const resultWithPrivacy = {
        ...result,
        privacyTrace: privacyTrace("planned", { intent: executableIntent }),
      };
      return res.json({
        success: true,
        result: resultWithPrivacy,
        ...resultWithPrivacy,
      });
    } catch (error: any) {
      const publicError = resolveIntentPublicError(error, network.id);
      console.log(
        `[Intent error][${network.id}:${network.chainId}][${requestId}] ` +
          `code=${error?.code || error?.name || "ENGINE_ERROR"}`,
      );

      return res.status(publicError.statusCode).json({
        success: false,
        code: publicError.code,
        error: publicError.message,
        message: publicError.message,
        privacyTrace: privacyTrace("rejected"),
        ...responseMetadata,
      });
    }
  },
);

export default router;
