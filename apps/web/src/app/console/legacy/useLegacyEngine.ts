/**
 * One network engine (the legacy Base, Arbitrum One or Arc chat engine behind
 * `POST /api/intent`): request state, `submitIntent` with every response
 * boundary, the AI-consent decision, token clarification, Basename
 * revalidation, approvals, workflow advance and `executeRoute`. Moved from
 * the old console shell (`App.tsx`) with only these substitutions:
 *
 * - the engine's network is the hook's `network` (one instance per engine
 *   network), and `network` below is `NETWORKS[network]`;
 * - a response is current while its request is (no check of the store's
 *   active network: an instance never changes network in the desk);
 * - the reset effect reacts to the wallet address (and the engine's own
 *   network), never to the wallet's chain;
 * - the plan-time "wallet must be on the chain" stop runs only for the
 *   classic shell; execution keeps refusing a route on another chain;
 * - the open conversation is attached to a sentence only in Answering mode
 *   (`answering`), or always for the classic shell;
 * - composer, tab and drawer updates go to the host through callbacks;
 * - every message carries the desk task's `threadId` (the sentence's
 *   `threadId` option; a consent, a token selection or a workflow step keeps
 *   the thread of the message it continues).
 *
 * Every response boundary, signing guard and executor check is unchanged.
 * Terminal log lines keep their leading tone marks (shield, check, cross):
 * `TerminalLogs` colours a line by them.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useChainId } from "wagmi";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import {
  NETWORKS,
  type AppTab,
  type NetworkMode,
} from "../../../shared/config/networks";
import { BACKEND_URL } from "../../../shared/config/runtime";
import {
  hasBaseIntentV2Marker,
  hasExecutableIntentActionBinding,
  isBaseIntentRouterV2ResponseBinding,
  isBaseX402ChallengeEvidence,
  isBaseMcpX402Plan,
  isBaseFeeRouterCoverage,
  isArcPortfolioData,
  isArbitrumPortfolioData,
  isBasePortfolioData,
  isBaseLiquidityRoutingResponse,
  isBaseSwapRoutingEvidence,
  isBaseYieldComparisonResponse,
  isBaseYieldRankingEvidence,
  isBaseX402Search,
  isBaseX402Service,
  type ChatMessage,
  type EntityClarification,
  type EntityClarificationOption,
  type IntentResponse,
  type PortfolioData,
  type RouteData,
} from "../../../shared/types";
import {
  AGENTS_HANDOFF_MESSAGE,
  AGENTS_HANDOFF_WIDGET,
} from "../../../shared/components/chat/agentsHandoff";
import {
  CROSS_NETWORK_HANDOFF_MESSAGE,
  CROSS_NETWORK_HANDOFF_WIDGET,
} from "../../../shared/components/chat/crossNetworkHandoff";
import { detectCrossNetworkPrompt } from "../../../shared/platform/crossNetworkPrompt";
import {
  type TransactionApproval,
  useTransactionExecutor,
} from "../../../shared/hooks/useTransactionExecutor";
import { useAppStore } from "../../../shared/state/useAppStore";
import { validateArcOfficialRoute } from "../../../networks/arc/runtime/officialExtensions";
import { isArcAppKitResponseBound } from "../../../networks/arc/runtime/appKitEnvelope";
import { containsSensitivePromptMaterial } from "../../../shared/security/promptSecrets";
import {
  isBaseSwapExecutionResponse,
  isBaseSwapResponseAllowedForExecutionPolicy,
  resolveBaseSwapExecutionPolicy,
} from "../../../networks/base/security/swapExecutionPolicy";
import { normalizeWalletHistoryOwner } from "../../../shared/state/walletHistoryPolicy";
import { currentEpochMs } from "../../../shared/utils/time";
import {
  basenameRecipientEvidence,
  isBasenameRevalidationResponse,
  isEntityClarification,
  isIntentEntityResolution,
  responseIntentAction,
} from "../../../shared/security/entityResolution";
import { isBaseLaunchFactoryV2ResponseBinding } from "../../../networks/base/security/launchFactoryV2";
import { resolveIntentHttpResponseBoundary } from "../../../shared/security/intentHttpResponseBoundary";
import { isWorkflowPlanV1, isWorkflowToken } from "../../../shared/security/workflowBoundary";
import {
  isIntentPrivacyDecision,
  redactIntentForPersistentHistory,
  type IntentPrivacyDecisionOptionV1,
  type IntentPrivacyDecisionV1,
  type IntentSemanticPlannerMode,
} from "../../../shared/privacy/defaultIntentPrivacy";
import { isIntentPrivacyTrace } from "../../../shared/privacy/intentPrivacyTrace";
import {
  BASE_SWAP_EXECUTION_POLICY_SETTING,
  UUID_V4_PATTERN,
  createRequestId,
  describeAction,
  getErrorMessage,
  isAppTab,
  isCalldata,
  isUnsignedIntegerString,
  parseExpiry,
  recordEvmActivity,
  requiresExplicitLiquiditySelection,
} from "./legacyHelpers";

export type ActiveRequest = {
  controller: AbortController;
  network: NetworkMode;
  requestId: string;
  messageId: string;
  walletAddress: string;
  clarificationSourceMessageId?: string;
};

export type ConversationContext = {
  id: string;
  network: NetworkMode;
  chainId: number;
  walletAddress: string;
  sourceRequestId: string;
  sourceMessageId: string;
  expiresAt: number;
  clarification?: EntityClarification;
  semanticPlanner: IntentSemanticPlannerMode;
};

export type SubmitIntentOptions = {
  displayText?: string;
  conversation?: ConversationContext;
  clarificationSelection?: { optionId: string };
  clarificationSourceMessageId?: string;
  semanticPlanner?: IntentSemanticPlannerMode;
  semanticPlannerConsentToken?: string;
  /**
   * Answering mode: attach the open clarification conversation to this
   * sentence. Only the classic shell attaches it to every sentence.
   */
  answering?: boolean;
  /** The desk task the sentence belongs to: every message it produces carries it. */
  threadId?: string;
};

export type PendingPrivacyDecision = {
  readonly prompt: string;
  /** The desk task the consent belongs to. */
  readonly threadId?: string;
  readonly network: NetworkMode;
  readonly chainId: number;
  readonly walletAddress: string;
  readonly decision: IntentPrivacyDecisionV1;
};

export type SemanticAiSession = {
  readonly token: string;
  readonly network: NetworkMode;
  readonly chainId: number;
  readonly walletAddress: string;
  readonly expiresAt: number;
};

export interface LegacyEngineOptions {
  /** The engine's network: one instance per engine network. */
  readonly network: NetworkMode;
  /**
   * The old console's behaviour, kept while it exists for the parity run:
   * refuse to plan while the wallet is on another chain, and attach the open
   * clarification conversation to every sentence.
   */
  readonly classic?: boolean;
  /** The composer's sentence was taken (or refused for holding a secret). */
  readonly onInputConsumed?: () => void;
  /** The engine asked to open one of its modules (`open_widget`, already checked against the network's tabs). */
  readonly onOpenWidget?: (tab: AppTab, subTarget: IntentResponse["subTarget"]) => void;
  /** A verified portfolio scan arrived. */
  readonly onPortfolio?: () => void;
  /** The user chose to edit the sentence instead of allowing AI interpretation. */
  readonly onEditPrompt?: (prompt: string) => void;
}

export type LegacyEngine = ReturnType<typeof useLegacyEngine>;

export function useLegacyEngine({
  network: networkMode,
  classic = false,
  onInputConsumed,
  onOpenWidget,
  onPortfolio,
  onEditPrompt,
}: LegacyEngineOptions) {
  const { address } = useAccount();
  const chainId = useChainId();
  const network = NETWORKS[networkMode];
  const { execute: executeTransaction } = useTransactionExecutor();
  const walletMatchesNetwork = chainId === network.chainId;

  const [pendingPrivacyDecision, setPendingPrivacyDecision] =
    useState<PendingPrivacyDecision | null>(null);
  const [semanticAiSession, setSemanticAiSession] =
    useState<SemanticAiSession | null>(null);
  const activeRequestRef = useRef<ActiveRequest | null>(null);
  const conversationContextRef = useRef<ConversationContext | null>(null);
  const clarificationSubmissionRef = useRef<string | null>(null);

  const {
    historyOwner,
    messagesByNetwork,
    addMessage,
    updateMessageForNetwork,
    addTerminalLogForNetwork,
    setWorkflowResume,
    clearWorkflowResume,
  } = useAppStore();
  const storedMessages = messagesByNetwork[networkMode];

  const activeWalletOwner = normalizeWalletHistoryOwner(address);
  const messages = useMemo(
    () =>
      historyOwner === null || historyOwner === activeWalletOwner
        ? storedMessages
        : [],
    [activeWalletOwner, historyOwner, storedMessages],
  );
  const activeSemanticAiSession =
    semanticAiSession &&
    semanticAiSession.network === networkMode &&
    semanticAiSession.chainId === network.chainId &&
    semanticAiSession.walletAddress.toLowerCase() === address?.toLowerCase() &&
    semanticAiSession.expiresAt > currentEpochMs()
      ? semanticAiSession
      : null;

  useEffect(() => {
    const activeRequest = activeRequestRef.current;
    if (
      activeRequest &&
      (activeRequest.network !== networkMode ||
        activeRequest.walletAddress.toLowerCase() !== address?.toLowerCase())
    ) {
      activeRequest.controller.abort();
      updateMessageForNetwork(activeRequest.network, activeRequest.messageId, {
        isLoading: false,
        text: "Previous request safely aborted due to network change.",
      });
      activeRequestRef.current = null;
    }
    const conversationContext = conversationContextRef.current;
    if (
      conversationContext &&
      (conversationContext.network !== networkMode ||
        conversationContext.walletAddress.toLowerCase() !==
          address?.toLowerCase())
    ) {
      updateMessageForNetwork(
        conversationContext.network,
        conversationContext.sourceMessageId,
        { clarificationStatus: "expired" },
      );
      conversationContextRef.current = null;
      clarificationSubmissionRef.current = null;
    }

    // The classic shell also clears its composer, tab and drawer on these
    // changes (and on a wallet chain change); the engine keeps only its own
    // state, so a task's engine reacts to the wallet address, not its chain.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- moved verbatim from App.tsx
    setPendingPrivacyDecision(null);
    if (
      semanticAiSession &&
      (semanticAiSession.network !== networkMode ||
        semanticAiSession.chainId !== network.chainId ||
        semanticAiSession.walletAddress.toLowerCase() !== address?.toLowerCase() ||
        semanticAiSession.expiresAt <= currentEpochMs())
    ) {
      setSemanticAiSession(null);
    }
  }, [address, network.chainId, networkMode, semanticAiSession, updateMessageForNetwork]);

  useEffect(
    () => () => {
      activeRequestRef.current?.controller.abort();
    },
    [],
  );

  const supportedTabs = new Set(
    network.navigation.flatMap((section) =>
      section.items.flatMap((item) =>
        item.action.type === "tab" ? [item.action.tab] : [],
      ),
    ),
  );

  const isCurrentRequest = (request: ActiveRequest): boolean =>
    !request.controller.signal.aborted &&
    activeRequestRef.current?.requestId === request.requestId;

  const updateRequestMessage = (
    request: ActiveRequest,
    updates: Partial<ChatMessage>,
  ) => {
    if (!isCurrentRequest(request)) return;
    updateMessageForNetwork(request.network, request.messageId, updates);
  };

  /** Expires the open clarification and drops a pending consent before a new sentence fills the composer. */
  const resetForNewPrompt = useCallback(() => {
    setPendingPrivacyDecision(null);
    const conversationContext = conversationContextRef.current;
    if (conversationContext) {
      updateMessageForNetwork(
        conversationContext.network,
        conversationContext.sourceMessageId,
        { clarificationStatus: "expired" },
      );
      conversationContextRef.current = null;
      clarificationSubmissionRef.current = null;
    }
  }, [updateMessageForNetwork]);
  const dismissPrivacyDecision = useCallback(() => setPendingPrivacyDecision(null), []);
  const turnOffSemanticSession = useCallback(() => setSemanticAiSession(null), []);

  const submitIntent = async (
    rawUserText: string,
    options: SubmitIntentOptions = {},
  ) => {
    const userText = rawUserText.trim();
    if (!userText) return;
    setPendingPrivacyDecision(null);
    const thread = options.threadId ? { threadId: options.threadId } : {};
    const semanticPlanner =
      options.semanticPlanner ??
      options.conversation?.semanticPlanner ??
      (activeSemanticAiSession ? "ai_assisted" : "deterministic_only");
    const semanticPlannerConsentToken =
      options.semanticPlannerConsentToken ?? activeSemanticAiSession?.token;
    const persistentDisplayText =
      options.displayText || redactIntentForPersistentHistory(userText);
    const blockStructuredSelection = () => {
      if (options.clarificationSourceMessageId) {
        updateMessageForNetwork(
          networkMode,
          options.clarificationSourceMessageId,
          { clarificationStatus: "blocked" },
        );
      }
      clarificationSubmissionRef.current = null;
    };
    if (containsSensitivePromptMaterial(userText)) {
      onInputConsumed?.();
      addMessage({
        ...thread,
        id: createRequestId(),
        role: "kletia",
        text: "Private key, seed phrase, or API credentials cannot be sent here. Message not saved for security.",
        network: networkMode,
        chainId: network.chainId,
      });
      blockStructuredSelection();
      return;
    }
    // Solana and cross-network prompts are outside the EVM chat engines:
    // hand them to the platform planner (Studio, or inline) instead of
    // sending them to /api/intent. Structured follow-ups keep their flow.
    if (
      !options.clarificationSelection &&
      !options.conversation &&
      !options.clarificationSourceMessageId &&
      detectCrossNetworkPrompt(userText)
    ) {
      onInputConsumed?.();
      const handoffRequestId = createRequestId();
      addMessage({
        ...thread,
        id: `${handoffRequestId}:user`,
        role: "user",
        text: persistentDisplayText,
        network: networkMode,
        chainId: network.chainId,
        walletAddress: address,
        requestId: handoffRequestId,
      });
      addMessage({
        ...thread,
        id: `${handoffRequestId}:kletia`,
        role: "kletia",
        text: CROSS_NETWORK_HANDOFF_MESSAGE,
        widgetType: CROSS_NETWORK_HANDOFF_WIDGET,
        widgetData: { prompt: userText },
        network: networkMode,
        chainId: network.chainId,
        walletAddress: address,
        requestId: handoffRequestId,
      });
      return;
    }
    if (!address) {
      addMessage({
        ...thread,
        id: createRequestId(),
        role: "kletia",
        text: "Please connect your wallet from the top right first.",
        network: networkMode,
        chainId: network.chainId,
      });
      blockStructuredSelection();
      return;
    }
    // Classic shell only: the desk plans on any chain and keeps the execution
    // guard (executeRoute and the executor refuse a route on another chain).
    if (classic && !walletMatchesNetwork) {
      addMessage({
        ...thread,
        id: createRequestId(),
        role: "kletia",
        text: `Wallet is not connected to the ${network.name} network. Intent and transaction creation halted for security.`,
        network: networkMode,
        chainId: network.chainId,
        walletAddress: address,
      });
      blockStructuredSelection();
      return;
    }

    onInputConsumed?.();
    const requestId = createRequestId();
    const userMsgId = `${requestId}:user`;
    const kletiaMsgId = `${requestId}:kletia`;
    const controller = new AbortController();
    const activeConversation = conversationContextRef.current;
    const requestedConversation =
      options.conversation ||
      (classic || options.answering ? activeConversation : null);
    const conversationIsValid = Boolean(
      requestedConversation &&
      activeConversation?.id === requestedConversation.id &&
      requestedConversation.network === networkMode &&
      requestedConversation.chainId === network.chainId &&
      requestedConversation.walletAddress.toLowerCase() ===
        address.toLowerCase() &&
      requestedConversation.expiresAt > currentEpochMs(),
    );
    if (requestedConversation && !conversationIsValid) {
      updateMessageForNetwork(
        requestedConversation.network,
        requestedConversation.sourceMessageId,
        { clarificationStatus: "expired" },
      );
      if (activeConversation?.id === requestedConversation.id) {
        conversationContextRef.current = null;
      }
      clarificationSubmissionRef.current = null;
      if (options.clarificationSelection) {
        addMessage({
          ...thread,
          id: createRequestId(),
          role: "kletia",
          text: "Token selection context expired or network/wallet changed. Please resend the intent.",
          network: networkMode,
          chainId: network.chainId,
          walletAddress: address,
        });
        return;
      }
    }
    const conversationId = conversationIsValid
      ? requestedConversation!.id
      : undefined;
    if (options.clarificationSelection && !conversationId) {
      clarificationSubmissionRef.current = null;
      return;
    }
    const clarificationSourceMessageId =
      options.clarificationSourceMessageId ||
      (conversationIsValid && requestedConversation?.clarification
        ? requestedConversation.sourceMessageId
        : undefined);
    if (
      conversationIsValid &&
      requestedConversation?.clarification &&
      !options.clarificationSelection
    ) {
      if (clarificationSubmissionRef.current !== null) return;
      clarificationSubmissionRef.current = requestedConversation.id;
      updateMessageForNetwork(
        requestedConversation.network,
        requestedConversation.sourceMessageId,
        { clarificationStatus: "submitting" },
      );
    }
    const request: ActiveRequest = {
      controller,
      network: networkMode,
      requestId,
      messageId: kletiaMsgId,
      walletAddress: address,
      clarificationSourceMessageId,
    };

    const previousRequest = activeRequestRef.current;
    if (previousRequest) {
      previousRequest.controller.abort();
      updateMessageForNetwork(
        previousRequest.network,
        previousRequest.messageId,
        {
          isLoading: false,
          text: "This request was canceled because a newer request was sent.",
        },
      );
    }
    activeRequestRef.current = request;

    addMessage({
      ...thread,
      id: userMsgId,
      role: "user",
      text: persistentDisplayText,
      network: networkMode,
      chainId: network.chainId,
      walletAddress: address,
      requestId,
    });
    addMessage({
      ...thread,
      id: kletiaMsgId,
      role: "kletia",
      text: `${network.name} intent engine is running...`,
      isLoading: true,
      network: networkMode,
      chainId: network.chainId,
      walletAddress: address,
      requestId,
    });

    try {
      const response = await fetch(`${BACKEND_URL}/api/intent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Kletia-Network": networkMode,
          "X-Kletia-Chain-Id": String(network.chainId),
        },
        signal: controller.signal,
        body: JSON.stringify({
          prompt: userText,
          userAddress: address,
          requestId,
          conversationId,
          ...(options.clarificationSelection
            ? {
                clarificationSelection: options.clarificationSelection,
              }
            : {}),
          semanticPlanner,
          ...(semanticPlannerConsentToken
            ? {
                semanticPlannerConsentToken,
              }
            : {}),
          network: networkMode,
          chainId: network.chainId,
        }),
      });

      const data = (await response
        .json()
        .catch(() => null)) as IntentResponse | null;
      if (!isCurrentRequest(request)) return;
      if (!data) {
        throw new Error(
          `Intent service returned HTTP ${response.status} without a valid response.`,
        );
      }

      const privacyTraceRequired =
        data.status === "success" ||
        data.status === "question" ||
        data.code === "AI_SEMANTIC_CONSENT_REQUIRED";
      if (
        privacyTraceRequired &&
        !isIntentPrivacyTrace(data.privacyTrace, {
          requestId,
          network: networkMode,
          chainId: network.chainId,
        })
      ) {
        throw new Error(
          "Intent response did not include a valid privacy boundary receipt.",
        );
      }

      if (
        response.status === 409 &&
        data.code === "AI_SEMANTIC_CONSENT_REQUIRED" &&
        data.network === networkMode &&
        data.chainId === network.chainId &&
        data.requestId === requestId &&
        typeof data.userAddress === "string" &&
        isAddress(data.userAddress) &&
        getAddress(data.userAddress) === getAddress(address) &&
        isIntentPrivacyDecision(data.privacyDecision, networkMode)
      ) {
        updateRequestMessage(request, {
          isLoading: false,
          text:
            "This wording needs smart intent interpretation. Turn it on once for this browser session or edit the request.",
          intentData: data,
        });
        setPendingPrivacyDecision({
          prompt: userText,
          ...thread,
          network: networkMode,
          chainId: network.chainId,
          walletAddress: address,
          decision: data.privacyDecision,
        });
        activeRequestRef.current = null;
        return;
      }

      const responseBoundary = resolveIntentHttpResponseBoundary(
        data,
        {
          network: networkMode,
          chainId: network.chainId,
          requestId,
        },
        response,
      );
      if (responseBoundary.kind === "rejection") {
        throw new Error(responseBoundary.message);
      }

      if (
        networkMode === "base" &&
        data.feeRouterCoverage !== undefined &&
        !isBaseFeeRouterCoverage(data.feeRouterCoverage)
      ) {
        throw new Error("Base Fee Router allowlist coverage could not be verified.");
      }

      if (data.action === "workflow") {
        if (
          data.executionKind !== "workflow_plan_v1" ||
          !data.workflowToken ||
          !isWorkflowToken(data.workflowToken) ||
          !isWorkflowPlanV1(data.workflowPlan, {
            requestId,
            userAddress: address,
            nowMs: currentEpochMs(),
          }) ||
          data.workflowPlan.steps[0]?.network !== networkMode
        ) {
          throw new Error(
            "Staged workflow was not bound to the active network, wallet and request.",
          );
        }
        setWorkflowResume({
          workflowId: data.workflowPlan.workflowId,
          requestId: data.workflowPlan.requestId,
          workflowToken: data.workflowToken,
          walletAddress: normalizeWalletHistoryOwner(address)!,
          expiresAt: data.workflowPlan.expiresAt,
        });
      }
      if (
        networkMode === "base" &&
        (data.actionType === "add_liquidity" ||
          data.actionType === "remove_liquidity" ||
          data.action === "add_liquidity" ||
          data.action === "remove_liquidity") &&
        !isBaseLiquidityRoutingResponse(data)
      ) {
        throw new Error(
          "Base liquidity routing factory, reserve, and simulation proof could not be verified.",
        );
      }

      if (
        networkMode === "base" &&
        data.yieldRankingEvidence !== undefined &&
        !isBaseYieldRankingEvidence(data.yieldRankingEvidence)
      ) {
        throw new Error(
          "Base lending yield and risk ranking evidence could not be verified.",
        );
      }

      if (data.status === "question") {
        if (
          !data.userAddress ||
          !isAddress(data.userAddress) ||
          getAddress(data.userAddress) !== getAddress(address)
        ) {
          throw new Error(
            "Intent question was not bound to the active wallet address.",
          );
        }
        if (data.action === "agent_action" && networkMode === "base") {
          if (clarificationSourceMessageId) {
            updateMessageForNetwork(networkMode, clarificationSourceMessageId, {
              clarificationStatus: "resolved",
            });
          }
          conversationContextRef.current = null;
          updateRequestMessage(request, {
            isLoading: false,
            text: AGENTS_HANDOFF_MESSAGE,
            widgetType: AGENTS_HANDOFF_WIDGET,
          });
          return;
        }
        if (
          typeof data.conversationId !== "string" ||
          !UUID_V4_PATTERN.test(data.conversationId)
        ) {
          throw new Error(
            "Intent service did not return a valid conversation context.",
          );
        }
        const conversationExpiresAt = data.conversationExpiresAt;
        if (
          data.requiresInput !== true ||
          typeof conversationExpiresAt !== "number" ||
          !Number.isFinite(conversationExpiresAt) ||
          conversationExpiresAt <= currentEpochMs() ||
          conversationExpiresAt > currentEpochMs() + 16 * 60 * 1_000
        ) {
          throw new Error(
            "Intent service returned an invalid or expired clarification window.",
          );
        }
        const clarification = data.clarification;
        if (
          clarification !== undefined &&
          !isEntityClarification(clarification)
        ) {
          throw new Error(
            "Intent service returned an invalid token clarification contract.",
          );
        }
        if (clarificationSourceMessageId) {
          updateMessageForNetwork(networkMode, clarificationSourceMessageId, {
            clarificationStatus: "resolved",
          });
        }
        conversationContextRef.current = {
          id: data.conversationId,
          network: networkMode,
          chainId: network.chainId,
          walletAddress: address,
          sourceRequestId: requestId,
          sourceMessageId: kletiaMsgId,
          expiresAt: conversationExpiresAt,
          clarification,
          semanticPlanner,
        };
        updateRequestMessage(request, {
          isLoading: false,
          text: data.message || "More information is required.",
          intentData: data,
          clarification,
          conversationId: data.conversationId,
          conversationExpiresAt,
          clarificationStatus: clarification ? "pending" : undefined,
        });
        return;
      }

      if (data.status !== "success") {
        if (clarificationSourceMessageId) {
          updateMessageForNetwork(networkMode, clarificationSourceMessageId, {
            clarificationStatus: "blocked",
          });
        }
        conversationContextRef.current = null;
        updateRequestMessage(request, {
          isLoading: false,
          text: `Transaction cancelled: ${data.message || "Unknown error"}`,
        });
        return;
      }

      if (
        !data.userAddress ||
        !isAddress(data.userAddress) ||
        getAddress(data.userAddress) !== getAddress(address)
      ) {
        throw new Error(
          "Intent response was not bound to the active wallet address.",
        );
      }
      const resolvedAction = responseIntentAction(data);
      if (
        !resolvedAction ||
        !isIntentEntityResolution(data.entityResolution, {
          network: networkMode,
          chainId: network.chainId,
          requestId,
          userAddress: address,
          action: resolvedAction,
        })
      ) {
        throw new Error(
          "Intent response did not include wallet, network and action-bound entity resolution evidence.",
        );
      }
      conversationContextRef.current = null;
      if (clarificationSourceMessageId) {
        updateMessageForNetwork(networkMode, clarificationSourceMessageId, {
          clarificationStatus: "resolved",
        });
      }

      const hasLaunchFactoryV2Marker =
        data.action === "deploy_token" ||
        data.actionType === "deploy_token" ||
        data.executionMode === "kletia_launch_factory_v2" ||
        data.launchFactoryV2Evidence !== undefined;
      if (hasLaunchFactoryV2Marker && networkMode !== "base") {
        throw new Error(
          "Kletia Launch Factory V2 is only available in Base Mainnet sessions.",
        );
      }
      if (networkMode === "base" && hasLaunchFactoryV2Marker) {
        if (
          !isBaseLaunchFactoryV2ResponseBinding(data, {
            requestId,
            userAddress: getAddress(address),
            nowMs: currentEpochMs(),
          })
        ) {
          throw new Error(
            "Token launch response could not be bound to exact Kletia Launch Factory V2 calldata, CREATE2 ID, active wallet, and simulation proof.",
          );
        }
        updateRequestMessage(request, {
          isLoading: false,
          text:
            data.winnerMessage ||
            "Deterministic fixed-supply token plan is ready for Base Mainnet.",
          intentData: data,
          selectedRouteIndex: 0,
          terminalLogs: [],
        });
        return;
      }

      if (networkMode === "base" && data.action === "yield_compare") {
        if (!isBaseYieldComparisonResponse(data)) {
          throw new Error(
            "Live Base lending comparison did not return verified opportunities.",
          );
        }
        updateRequestMessage(request, {
          isLoading: false,
          text:
            data.winnerMessage ||
            "Live Base lending rates and liquidity have been compared.",
          intentData: data,
          terminalLogs: [],
        });
        return;
      }

      if (networkMode === "arbitrum" && data.action === "yield_compare") {
        const comparison = data.yieldComparison;
        if (
          !comparison ||
          comparison.policyVersion !== "arbitrum_aave_v3_live_rates_v1" ||
          comparison.protocolId !== "aave-v3" ||
          !isAddress(comparison.asset) ||
          !Number.isFinite(comparison.supplyApyBps) ||
          !Number.isFinite(comparison.variableBorrowApyBps) ||
          !/^\d+$/u.test(comparison.availableLiquidityAtomic) ||
          comparison.mockData !== false
        ) {
          throw new Error("Arbitrum yield response did not contain live Aave V3 evidence.");
        }
        updateRequestMessage(request, {
          isLoading: false,
          text: data.winnerMessage || "Live Arbitrum Aave V3 rates loaded.",
          intentData: data,
          terminalLogs: [],
        });
        return;
      }

      if (data.action === "open_widget") {
        updateRequestMessage(request, {
          isLoading: false,
          text: data.winnerMessage || "Opening the requested module...",
          terminalLogs: [],
        });
        if (
          isAppTab(data.widgetTarget) &&
          supportedTabs.has(data.widgetTarget)
        ) {
          onOpenWidget?.(data.widgetTarget, data.subTarget);
        } else {
          throw new Error(
            `Backend returned a widget that is not enabled on ${network.name}.`,
          );
        }
        return;
      }

      if (data.action === "portfolio") {
        if (!data.data || typeof data.data !== "object") {
          throw new Error(
            "Portfolio service did not return a verifiable data object.",
          );
        }
        const portfolioData = {
          ...data.data,
          network: data.network,
          chainId: data.chainId,
        } as PortfolioData;
        const validPortfolio = networkMode === "base"
          ? isBasePortfolioData(portfolioData)
          : networkMode === "arc"
            ? isArcPortfolioData(portfolioData)
            : isArbitrumPortfolioData(portfolioData);
        if (!validPortfolio) {
          throw new Error(
            `Portfolio response does not match the ${network.name} data schema.`,
          );
        }
        const portfolioResponse: IntentResponse = {
          ...data,
          data: portfolioData,
        };
        updateRequestMessage(request, {
          isLoading: false,
          text:
            data.message ||
            "Portfolio scanned. Source and integrity details updated in the right panel.",
          intentData: portfolioResponse,
          terminalLogs: [],
        });
        onPortfolio?.();
        return;
      }

      if (data.action === "agent_action") {
        updateRequestMessage(request, {
          isLoading: false,
          text: AGENTS_HANDOFF_MESSAGE,
          widgetType: AGENTS_HANDOFF_WIDGET,
          terminalLogs: [],
        });
        return;
      }

      if (data.action === "policy_agent") {
        const policy = data.policyAgent;
        if (
          networkMode === "arc" ||
          !policy ||
          policy.version !== 1 ||
          !/^0x[0-9a-f]{64}$/iu.test(policy.policyId) ||
          !isAddress(policy.owner) ||
          getAddress(policy.owner) !== getAddress(address) ||
          policy.authority !== "planning_only_no_transaction_authority" ||
          policy.requiresPerStepWalletApproval !== true ||
          policy.expiresAt <= Math.floor(currentEpochMs() / 1_000)
        ) {
          throw new Error("Policy agent response failed its non-custodial authority boundary.");
        }
        updateRequestMessage(request, {
          isLoading: false,
          text: data.winnerMessage || "Planning policy is ready for wallet signature.",
          intentData: data,
          terminalLogs: [],
        });
        return;
      }

      if (data.action === "bns_resolve") {
        updateRequestMessage(request, {
          isLoading: false,
          text:
            data.message ||
            data.winnerMessage ||
            "Base name resolution needs more information.",
          terminalLogs: [],
        });
        return;
      }

      if (data.executionKind === "circle_app_kit") {
        if (
          networkMode !== "arc" ||
          !isArcAppKitResponseBound(data, requestId)
        ) {
          throw new Error(
            "Circle App Kit plan does not match the active Arc Testnet session.",
          );
        }
        updateRequestMessage(request, {
          isLoading: false,
          text:
            data.winnerMessage ||
            "Circle App Kit route is ready; live forecast is being fetched.",
          intentData: data,
          terminalLogs: [],
        });
        return;
      }

      if (data.executionKind === "base_x402_discovery") {
        if (
          networkMode !== "base" ||
          data.provider !== "Coinbase CDP Bazaar" ||
          !Array.isArray(data.services) ||
          data.services.length > 8 ||
          !data.services.every(isBaseX402Service) ||
          !isBaseX402Search(data.search) ||
          (data.trustNotice !== undefined &&
            typeof data.trustNotice !== "string")
        ) {
          throw new Error(
            "CDP Bazaar result does not match the active Base Mainnet security contract.",
          );
        }
        updateRequestMessage(request, {
          isLoading: false,
          text:
            data.winnerMessage ||
            "CDP Bazaar services verified against payment cap and Base USDC policy.",
          intentData: data,
          terminalLogs: [],
        });
        return;
      }

      if (
        data.executionKind === "workflow_plan_v1" &&
        data.workflowPlan?.steps[data.workflowPlan.currentStepIndex]?.action ===
          "data_purchase"
      ) {
        if (
          networkMode !== "base" ||
          data.provider !== "Base MCP" ||
          data.approvalRequired !== true ||
          !isBaseMcpX402Plan(data.mcpPlan) ||
          data.mcpPlan.requestId !== requestId ||
          !isBaseX402ChallengeEvidence(
            data.challengeEvidence,
            data.mcpPlan,
            address,
          )
        ) {
          throw new Error(
            "Workflow data purchase is not bound to the live Base x402 challenge.",
          );
        }
        updateRequestMessage(request, {
          isLoading: false,
          text:
            data.winnerMessage ||
            "The workflow data purchase is ready for explicit Base USDC approval.",
          intentData: data,
          terminalLogs: [],
        });
        return;
      }

      if (data.executionKind === "base_mcp_x402") {
        if (
          networkMode !== "base" ||
          data.provider !== "Base MCP" ||
          data.approvalRequired !== true ||
          !isBaseMcpX402Plan(data.mcpPlan) ||
          data.mcpPlan.requestId !== requestId ||
          (data.mcpPlan.initiate.method === "GET" &&
            !isBaseX402ChallengeEvidence(
              data.challengeEvidence,
              data.mcpPlan,
              address,
            )) ||
          (data.trustNotice !== undefined &&
            typeof data.trustNotice !== "string")
        ) {
          throw new Error(
            "Base MCP x402 plan is not bound to the active request and user approval policy.",
          );
        }
        updateRequestMessage(request, {
          isLoading: false,
          text:
            data.winnerMessage ||
            "Base MCP x402 plan is ready; Base Account approval is required for payment.",
          intentData: data,
          terminalLogs: [],
        });
        return;
      }

      if (
        networkMode === "base" &&
        (data.quoteCoverage !== undefined ||
          data.rankingEvidence !== undefined) &&
        !isBaseSwapRoutingEvidence(data.quoteCoverage, data.rankingEvidence)
      ) {
        throw new Error(
          "Base route ranking and source coverage evidence could not be verified.",
        );
      }

      if (!data.allRoutes?.length) {
        throw new Error("Intent engine did not return an executable route.");
      }
      if (
        isBaseSwapExecutionResponse(data) &&
        !isBaseSwapResponseAllowedForExecutionPolicy(
          data,
          resolveBaseSwapExecutionPolicy(BASE_SWAP_EXECUTION_POLICY_SETTING),
        )
      ) {
        throw new Error(
          "Base swap response does not match frontend release execution-mode policy.",
        );
      }
      if (
        hasBaseIntentV2Marker(data) &&
        !isBaseIntentRouterV2ResponseBinding(data)
      ) {
        throw new Error(
          "Base Intent Router V2 response set could not be bound to typed intent, calldata, ranking, and policy targets.",
        );
      }

      updateRequestMessage(request, {
        isLoading: false,
        text:
          data.winnerMessage ||
          `${network.name} route ready: **${data.winner || data.allRoutes[0].name}**`,
        intentData: data,
        selectedRouteIndex: requiresExplicitLiquiditySelection(data)
          ? undefined
          : 0,
        terminalLogs: [],
      });
    } catch (error: unknown) {
      if (clarificationSourceMessageId) {
        updateMessageForNetwork(networkMode, clarificationSourceMessageId, {
          clarificationStatus: "blocked",
        });
      }
      if (conversationContextRef.current?.id === conversationId) {
        conversationContextRef.current = null;
      }
      if ((error as Error).name !== "AbortError") {
        updateRequestMessage(request, {
          isLoading: false,
          text: `Action stopped safely: ${getErrorMessage(error)}`,
        });
      }
    } finally {
      if (activeRequestRef.current?.requestId === requestId) {
        activeRequestRef.current = null;
      }
      if (
        clarificationSubmissionRef.current === conversationId ||
        clarificationSourceMessageId
      ) {
        clarificationSubmissionRef.current = null;
      }
    }
  };

  const handlePrivacyDecisionSelection = (
    option: IntentPrivacyDecisionOptionV1,
  ) => {
    const pending = pendingPrivacyDecision;
    if (!pending) return;

    const stillBoundToActiveContext =
      pending.network === networkMode &&
      pending.chainId === network.chainId &&
      chainId === network.chainId &&
      pending.walletAddress.toLowerCase() === address?.toLowerCase() &&
      pending.decision.expiresAt > currentEpochMs();

    setPendingPrivacyDecision(null);
    const thread = pending.threadId ? { threadId: pending.threadId } : {};
    if (!stillBoundToActiveContext) {
      addMessage({
        ...thread,
        id: createRequestId(),
        role: "kletia",
        text: "This disclosure decision expired or the wallet/network context changed. Review and resend the intent before Kletia shares it with an AI provider.",
        network: networkMode,
        chainId: network.chainId,
        ...(address ? { walletAddress: address } : {}),
      });
      return;
    }

    if (option.id === "allow_ai_for_this_intent") {
      void submitIntent(pending.prompt, {
        ...thread,
        displayText: "Allow AI semantic parsing for this intent only.",
        semanticPlanner: "ai_assisted",
        semanticPlannerConsentToken: pending.decision.decisionToken,
      });
      return;
    }

    if (option.id === "allow_ai_for_session") {
      const session: SemanticAiSession = {
        token: pending.decision.sessionDecisionToken,
        network: pending.network,
        chainId: pending.chainId,
        walletAddress: pending.walletAddress,
        expiresAt: pending.decision.sessionExpiresAt,
      };
      setSemanticAiSession(session);
      void submitIntent(pending.prompt, {
        ...thread,
        displayText: "Smart intent interpretation enabled for this browser session.",
        semanticPlanner: "ai_assisted",
        semanticPlannerConsentToken: session.token,
      });
      return;
    }

    onEditPrompt?.(pending.prompt);
  };

  const handleClarificationSelection = (
    messageId: string,
    option: EntityClarificationOption,
  ) => {
    const message = messages.find((candidate) => candidate.id === messageId);
    const conversation = conversationContextRef.current;
    if (
      !message?.clarification ||
      message.clarificationStatus !== "pending" ||
      !conversation ||
      conversation.sourceMessageId !== messageId ||
      message.conversationId !== conversation.id ||
      message.conversationExpiresAt !== conversation.expiresAt ||
      conversation.network !== networkMode ||
      conversation.chainId !== network.chainId ||
      conversation.walletAddress.toLowerCase() !== address?.toLowerCase() ||
      !message.clarification.options.some(
        (candidate) => candidate.id === option.id,
      )
    ) {
      return;
    }
    if (currentEpochMs() >= conversation.expiresAt) {
      updateMessageForNetwork(conversation.network, messageId, {
        clarificationStatus: "expired",
      });
      conversationContextRef.current = null;
      clarificationSubmissionRef.current = null;
      return;
    }
    if (clarificationSubmissionRef.current !== null) return;
    clarificationSubmissionRef.current = conversation.id;
    updateMessageForNetwork(conversation.network, messageId, {
      clarificationStatus: "submitting",
    });
    void submitIntent("Apply verified token selection.", {
      ...(message.threadId ? { threadId: message.threadId } : {}),
      displayText: `Select ${option.label} (${option.symbol})`,
      conversation: { ...conversation },
      clarificationSelection: { optionId: option.id },
      clarificationSourceMessageId: messageId,
    });
  };

  const revalidateBasenameRecipients = async (
    data: IntentResponse,
  ): Promise<void> => {
    const recipients = basenameRecipientEvidence(data.entityResolution);
    if (recipients.length === 0) return;
    if (
      recipients.length > 4 ||
      !data.requestId ||
      !UUID_V4_PATTERN.test(data.requestId) ||
      !data.network ||
      typeof data.chainId !== "number" ||
      !data.userAddress ||
      !isAddress(data.userAddress)
    ) {
      throw new Error(
        "Basename revalidation context is missing or exceeds safe boundaries.",
      );
    }

    const uniqueRecipients = [
      ...new Map(
        recipients.map((recipient) => [
          `${recipient.basename!.toLowerCase()}:${recipient.resolvedAddress.toLowerCase()}`,
          recipient,
        ]),
      ).values(),
    ];

    for (const recipient of uniqueRecipients) {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetch(
          `${BACKEND_URL}/api/intent/revalidate-recipient`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Kletia-Network": data.network,
              "X-Kletia-Chain-Id": String(data.chainId),
            },
            signal: controller.signal,
            body: JSON.stringify({
              requestId: data.requestId,
              userAddress: data.userAddress,
              name: recipient.basename,
              expectedAddress: recipient.resolvedAddress,
            }),
          },
        );
        const payload: unknown = await response.json().catch(() => null);
        if (
          !response.ok ||
          !isBasenameRevalidationResponse(payload, {
            network: data.network,
            chainId: data.chainId,
            requestId: data.requestId,
            userAddress: data.userAddress,
            basename: recipient.basename!,
            resolvedAddress: recipient.resolvedAddress,
          })
        ) {
          throw new Error(
            response.status === 409
              ? "Basename record changed or is no longer resolvable after plan creation; create a new intent."
              : "Basename could not be revalidated before signing; transaction not sent.",
          );
        }
      } finally {
        window.clearTimeout(timer);
      }
    }
  };

  const routeApprovals = (
    route: RouteData,
    data: IntentResponse,
  ): TransactionApproval[] => {
    const declared = route.approvals || [];
    if (route.approvalPolicy === "explicit" || declared.length > 0) {
      return declared.map((approval) => ({
        token: approval.token as Address,
        spender: approval.spender as Address,
        amount: BigInt(approval.amount),
        symbol: approval.symbol,
      }));
    }

    const approvals: TransactionApproval[] = [];
    const spender = route.router as Address;
    if (route.primaryTokenAddress && route.primaryAmountInWei) {
      approvals.push({
        token: route.primaryTokenAddress as Address,
        spender,
        amount: BigInt(route.primaryAmountInWei),
      });
    }
    if (route.secondaryTokenAddress && route.secondaryAmountInWei) {
      approvals.push({
        token: route.secondaryTokenAddress as Address,
        spender,
        amount: BigInt(route.secondaryAmountInWei),
      });
    }
    if (
      approvals.length === 0 &&
      data.tokenInAddress &&
      data.amountInWei &&
      !data.isNativeIn
    ) {
      approvals.push({
        token: data.tokenInAddress as Address,
        spender,
        amount: BigInt(data.amountInWei),
      });
    }
    return approvals;
  };

  const advanceWorkflowForMessage = async (
    messageId: string,
    submittedTxHash?: Hex,
    authorizationNonce?: Hex,
  ) => {
    const message = useAppStore.getState().messagesByNetwork[
      useAppStore.getState().activeNetwork
    ].find((candidate) => candidate.id === messageId) ||
      Object.values(useAppStore.getState().messagesByNetwork)
        .flat()
        .find((candidate) => candidate.id === messageId);
    const currentData = message?.intentData;
    if (
      !message ||
      !currentData?.workflowPlan ||
      !currentData.workflowToken ||
      !address ||
      !isWorkflowToken(currentData.workflowToken) ||
      !isWorkflowPlanV1(currentData.workflowPlan, {
        requestId: currentData.requestId || "",
        userAddress: address,
        nowMs: currentEpochMs(),
      })
    ) {
      throw new Error("Workflow state is missing or no longer bound to this wallet.");
    }
    const originNetwork = message.network || "base";
    if (submittedTxHash) {
      setWorkflowResume({
        workflowId: currentData.workflowPlan.workflowId,
        requestId: currentData.workflowPlan.requestId,
        workflowToken: currentData.workflowToken,
        walletAddress: normalizeWalletHistoryOwner(address)!,
        expiresAt: currentData.workflowPlan.expiresAt,
        pendingCheckpoint: {
          txHash: submittedTxHash,
          ...(authorizationNonce ? { authorizationNonce } : {}),
        },
      });
    }
    const response = await fetch(`${BACKEND_URL}/api/workflows/advance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowToken: currentData.workflowToken,
        userAddress: address,
        ...(submittedTxHash ? { txHash: submittedTxHash } : {}),
        ...(authorizationNonce ? { authorizationNonce } : {}),
      }),
    });
    const body = await response.json().catch(() => null) as null | {
      success?: boolean;
      message?: string;
      code?: string;
      workflowPlan?: unknown;
      workflowToken?: unknown;
      execution?: unknown;
    };
    if (!response.ok || body?.success !== true) {
      throw new Error(body?.message || "Workflow checkpoint verification failed.");
    }
    if (
      !isWorkflowToken(body.workflowToken) ||
      !isWorkflowPlanV1(body.workflowPlan, {
        requestId: currentData.requestId || "",
        userAddress: address,
        nowMs: currentEpochMs(),
      })
    ) {
      throw new Error("Workflow service returned an invalid sealed state.");
    }
    const updatedPlan = body.workflowPlan;
    const updatedToken = body.workflowToken;
    const currentStep = updatedPlan.steps[updatedPlan.currentStepIndex];
    const terminal =
      updatedPlan.currentStepIndex === updatedPlan.steps.length - 1 &&
      ["confirmed", "filled", "ready", "failed", "refunded"].includes(
        currentStep.status,
      );
    if (terminal) {
      clearWorkflowResume();
    } else {
      setWorkflowResume({
        workflowId: updatedPlan.workflowId,
        requestId: updatedPlan.requestId,
        workflowToken: updatedToken,
        walletAddress: normalizeWalletHistoryOwner(address)!,
        expiresAt: updatedPlan.expiresAt,
      });
    }
    updateMessageForNetwork(originNetwork, messageId, {
      text: body.message || "Workflow checkpoint verified.",
      intentData: {
        ...currentData,
        workflowPlan: updatedPlan,
        workflowToken: updatedToken,
      },
    });
    if (body.execution === null || body.execution === undefined) return;
    const execution = body.execution as IntentResponse;
    const nextStep = updatedPlan.steps[updatedPlan.currentStepIndex];
    const expectedExecutionAction =
      nextStep.action === "bridge" || nextStep.action === "gas_acquire"
        ? "workflow"
        : nextStep.action;
    if (
      execution.status !== "success" ||
      execution.network !== nextStep.network ||
      execution.chainId !== nextStep.chainId ||
      execution.requestId !== updatedPlan.requestId ||
      execution.userAddress?.toLowerCase() !== address.toLowerCase() ||
      responseIntentAction(execution) !== expectedExecutionAction ||
      !execution.allRoutes?.length ||
      !isIntentEntityResolution(execution.entityResolution, {
        network: nextStep.network,
        chainId: nextStep.chainId,
        requestId: updatedPlan.requestId,
        userAddress: address,
        action: expectedExecutionAction,
      })
    ) {
      throw new Error("Next workflow step failed the network and entity boundary.");
    }
    const nextIntent: IntentResponse = {
      ...execution,
      workflowPlan: updatedPlan,
      workflowToken: updatedToken,
    };
    if (nextStep.network === originNetwork) {
      updateMessageForNetwork(originNetwork, messageId, {
        text: body.message || `Workflow step ${nextStep.order} is ready.`,
        intentData: nextIntent,
        selectedRouteIndex: 0,
        txHash: undefined,
        terminalLogs: [],
      });
      return;
    }
    const nextMessageId = `${updatedPlan.workflowId}:${nextStep.id}`;
    addMessage({
      ...(message.threadId ? { threadId: message.threadId } : {}),
      id: nextMessageId,
      role: "kletia",
      text: body.message || `Workflow step ${nextStep.order} is ready on ${nextStep.network}.`,
      intentData: nextIntent,
      selectedRouteIndex: 0,
      terminalLogs: [],
      network: nextStep.network,
      chainId: nextStep.chainId,
      walletAddress: address,
      requestId: updatedPlan.requestId,
    });
    addOriginLogForWorkflow(originNetwork, messageId, `Step ${nextStep.order} is ready in the ${nextStep.network} workspace.`);
  };

  const addOriginLogForWorkflow = (
    originNetwork: NetworkMode,
    messageId: string,
    log: string,
  ) => addTerminalLogForNetwork(originNetwork, messageId, log);

  const executeRoute = async (msgId: string) => {
    const msg = messages.find((m) => m.id === msgId);
    if (!msg?.intentData || !address) return;

    const data = msg.intentData;
    const originNetwork = msg.network;
    if (!originNetwork) return;
    const routes = data.allRoutes;
    if (!routes?.length) return;
    const selectedRouteIndex = requiresExplicitLiquiditySelection(data)
      ? msg.selectedRouteIndex
      : (msg.selectedRouteIndex ?? 0);
    const activeRoute =
      typeof selectedRouteIndex === "number" &&
      Number.isInteger(selectedRouteIndex)
        ? routes[selectedRouteIndex]
        : undefined;

    const updateOriginMessage = (
      updates: Partial<ChatMessage>,
    ) => updateMessageForNetwork(originNetwork, msgId, updates);
    const addOriginLog = (log: string) =>
      addTerminalLogForNetwork(originNetwork, msgId, log);

    updateOriginMessage({ isLoading: true });

    try {
      if (!activeRoute) {
        throw new Error(
          "Selected route index is invalid. Recreate the intent.",
        );
      }

      if (
        !walletMatchesNetwork ||
        msg.network !== networkMode ||
        msg.chainId !== network.chainId ||
        msg.walletAddress?.toLowerCase() !== address.toLowerCase() ||
        data.network !== networkMode ||
        data.chainId !== network.chainId
      ) {
        throw new Error(
          "This route belongs to a different network or wallet session. Recreate the intent.",
        );
      }

      if (
        !msg.requestId ||
        !data.requestId ||
        !activeRoute.requestId ||
        msg.requestId !== data.requestId ||
        activeRoute.requestId !== data.requestId
      ) {
        throw new Error(
          "Selected route does not belong to this intent request. Recreate the intent.",
        );
      }

      if (
        activeRoute.network !== networkMode ||
        activeRoute.chainId !== network.chainId
      ) {
        throw new Error("Selected route's network metadata does not match the active network.");
      }

      if (
        isBaseSwapExecutionResponse(data) &&
        !isBaseSwapResponseAllowedForExecutionPolicy(
          data,
          resolveBaseSwapExecutionPolicy(BASE_SWAP_EXECUTION_POLICY_SETTING),
        )
      ) {
        throw new Error(
          "Base swap response does not belong to the active frontend release mode. Recreate the intent.",
        );
      }

      if (!hasExecutableIntentActionBinding(data, activeRoute)) {
        throw new Error(
          "Selected route is not bound to a verified intent action field.",
        );
      }

      const isLaunchFactoryV2 =
        data.executionMode === "kletia_launch_factory_v2" ||
        activeRoute.executionMode === "kletia_launch_factory_v2" ||
        data.action === "deploy_token" ||
        data.actionType === "deploy_token" ||
        data.launchFactoryV2Evidence !== undefined ||
        activeRoute.launchFactoryV2Evidence !== undefined;
      if (
        isLaunchFactoryV2 &&
        !isBaseLaunchFactoryV2ResponseBinding(data, {
          requestId: msg.requestId,
          userAddress: getAddress(address),
          nowMs: currentEpochMs(),
        })
      ) {
        throw new Error(
          "Launch Factory V2 plan failed pre-signature wallet, calldata, fee, salt, or CREATE2 address verification.",
        );
      }

      if (
        !data.userAddress ||
        !activeRoute.userAddress ||
        !isAddress(data.userAddress) ||
        !isAddress(activeRoute.userAddress) ||
        getAddress(data.userAddress) !== getAddress(address) ||
        getAddress(activeRoute.userAddress) !== getAddress(address)
      ) {
        throw new Error("Selected route was not created for the connected wallet.");
      }
      const executionAction = responseIntentAction(data);
      const executionEntityResolution = data.entityResolution;
      if (
        !executionAction ||
        !msg.requestId ||
        !isIntentEntityResolution(executionEntityResolution, {
          network: networkMode,
          chainId: network.chainId,
          requestId: msg.requestId,
          userAddress: address,
          action: executionAction,
        })
      ) {
        throw new Error(
          "Selected route does not carry asset proof bound to the current wallet, network, and action fields.",
        );
      }
      const requiresRecipientRevalidation =
        basenameRecipientEvidence(executionEntityResolution).length > 0;

      const envelopeExpiry = parseExpiry(data.quoteExpiresAt);
      const routeExpiry = parseExpiry(activeRoute.quoteExpiresAt);
      if (
        envelopeExpiry === undefined ||
        routeExpiry === undefined ||
        routeExpiry !== envelopeExpiry ||
        routeExpiry <= currentEpochMs()
      ) {
        throw new Error(
          "Selected route's quote expiry is invalid or expired. Recreate the intent.",
        );
      }

      if (!isAddress(activeRoute.router)) {
        throw new Error("Selected route does not carry a valid target address.");
      }
      const isNativeTransfer =
        (data.actionType === "transfer" || data.action === "transfer") &&
        data.isNativeIn === true &&
        activeRoute.calldata === "0x";
      if (!isNativeTransfer && !isCalldata(activeRoute.calldata)) {
        throw new Error("Selected route does not carry valid calldata.");
      }
      if (!isUnsignedIntegerString(activeRoute.value)) {
        throw new Error("The selected route does not carry a valid native value.");
      }

      const targetAddress = getAddress(activeRoute.router);
      const txCalldata = activeRoute.calldata as Hex;
      const txValue = BigInt(activeRoute.value);
      const officialArcPolicy = validateArcOfficialRoute(
        activeRoute,
        data.actionType || data.action,
        activeRoute.userAddress,
      );
      const resolvedApprovals = routeApprovals(activeRoute, data);
      if (officialArcPolicy.requireEoa && resolvedApprovals.length !== 0) {
        throw new Error(
          "The official Arc extension route cannot create any token allowance.",
        );
      }

      addOriginLog(`🛡️ ${network.name} security and simulation line is active.`);
      addOriginLog(`Target: ${targetAddress}`);
      if (txValue > 0n) {
        addOriginLog(
          `Native ${network.nativeCurrency.symbol} value verified.`,
        );
      }
      if (officialArcPolicy.requireEoa) {
        addOriginLog(
          "Official Arc extension calldata and original-sender EOA policy re-decoded and verified.",
        );
      }
      const responseUsesIntentRouterV2 =
        data.executionMode === "kletia_intent_router_v2";
      const routeUsesIntentRouterV2 =
        activeRoute.executionMode === "kletia_intent_router_v2";
      if (responseUsesIntentRouterV2 !== routeUsesIntentRouterV2) {
        throw new Error(
          "The executionMode field of the selected route does not match the Base V2 response.",
        );
      }
      const isIntentRouterV2 =
        responseUsesIntentRouterV2 && routeUsesIntentRouterV2;
      const intentV2Authorities = isIntentRouterV2
        ? (() => {
            if (
              (activeRoute.adapterKind !== "uniswap_v2_compatible" &&
                activeRoute.adapterKind !== "uniswap_v3_swaprouter02") ||
              !activeRoute.adapter ||
              !activeRoute.underlyingTarget ||
              !activeRoute.underlyingSpender ||
              !activeRoute.underlyingFactory ||
              !activeRoute.wrappedNative
            ) {
              throw new Error(
                "Typed Base V2 route authorities are missing; transaction not sent.",
              );
            }
            return {
              adapterKind: activeRoute.adapterKind,
              router: targetAddress,
              adapter: getAddress(activeRoute.adapter),
              target: getAddress(activeRoute.underlyingTarget),
              spender: getAddress(activeRoute.underlyingSpender),
              factory: getAddress(activeRoute.underlyingFactory),
              wrappedNative: getAddress(activeRoute.wrappedNative),
            };
          })()
        : undefined;
      if (isIntentRouterV2 && resolvedApprovals.length > 0) {
        addOriginLog(
          "V2 exact approval and swap will be executed only as a single Base atomic package.",
        );
      }
      const launchFactoryV2Authority = isLaunchFactoryV2
        ? (() => {
            const evidence = data.launchFactoryV2Evidence;
            if (!evidence) {
              throw new Error(
                "Launch Factory V2 runtime proof not found in the transaction plan.",
              );
            }
            addOriginLog(
              "deployToken calldata, creator-scoped salt, full-supply recipient, and CREATE2 prediction re-verified.",
            );
            return {
              factory: getAddress(evidence.factory),
              runtimeCodehash: evidence.factoryCodehash as Hex,
              predictedAddress: getAddress(evidence.predictedAddress),
              recipient: getAddress(evidence.recipient),
              totalSupply: BigInt(evidence.totalSupply),
              name: evidence.name,
              symbol: evidence.symbol,
            };
          })()
        : undefined;

      const result = await executeTransaction(
        {
          network: networkMode,
          chainId: network.chainId,
          action: (data.actionType || data.action)!.trim().toLowerCase(),
          executionMode: activeRoute.executionMode,
          atomicRequired: isIntentRouterV2 && resolvedApprovals.length > 0,
          to: targetAddress,
          data: txCalldata,
          value: txValue,
          approvals: resolvedApprovals,
          expiresAt: routeExpiry,
          userAddress: getAddress(activeRoute.userAddress),
          requireEoa: officialArcPolicy.requireEoa,
          policyTargets: isIntentRouterV2
            ? (activeRoute.policyTargets || []).map((target: string) =>
                getAddress(target),
              )
            : [
                ...officialArcPolicy.policyTargets,
                ...(activeRoute.policyTargets || []).map((target: string) =>
                  getAddress(target),
                ),
              ],
          simulationReturnPolicy: activeRoute.simulationReturnPolicy,
          beforeSubmit: requiresRecipientRevalidation
            ? async () => {
                await revalidateBasenameRecipients(data);
                addOriginLog(
                  "✅ Basename address unchanged; matches current resolver proof in the transaction plan.",
                );
              }
            : undefined,
          intentV2Authorities,
          launchFactoryV2Authority,
        },
        addOriginLog,
      );

      if (originNetwork === "arc") {
        updateOriginMessage({
          txHash: result.hash,
          text: "Arc Testnet transaction finalized with a successful receipt.",
        });
        addOriginLog("✅ Arc Testnet transaction finalized with a successful receipt.");
      } else if (originNetwork === "arbitrum") {
        updateOriginMessage({
          txHash: result.hash,
          text: "Arbitrum One transaction finalized with a successful receipt.",
        });
        addOriginLog("✅ Arbitrum One transaction finalized with a successful receipt.");
      } else {
        updateOriginMessage({
          txHash: result.hash,
          text: "Base Mainnet transaction included on-chain with a successful receipt.",
        });
        addOriginLog(
          "✅ Base Mainnet transaction included on-chain with a successful receipt; this does not imply additional L1 finality.",
        );
      }
      recordEvmActivity({
        network: originNetwork,
        hash: result.hash,
        title: `${describeAction(data.actionType || data.action)} via ${activeRoute.name || "Kletia route"}`,
        walletAddress: address,
      });
      if (data.workflowPlan && data.workflowToken) {
        addOriginLog("Advancing only after the submitted transaction matches the sealed workflow step.");
        await advanceWorkflowForMessage(msgId, result.hash);
      }
    } catch (error: unknown) {
      addOriginLog(`❌ Cancel/Error: ${getErrorMessage(error)}`);
    } finally {
      updateOriginMessage({ isLoading: false });
    }
  };

  return {
    network: networkMode,
    chain: network,
    address,
    walletChainId: chainId,
    walletMatchesNetwork,
    messages,
    pendingPrivacyDecision,
    semanticAiSession,
    activeSemanticAiSession,
    submitIntent,
    handlePrivacyDecisionSelection,
    handleClarificationSelection,
    revalidateBasenameRecipients,
    routeApprovals,
    advanceWorkflowForMessage,
    executeRoute,
    resetForNewPrompt,
    dismissPrivacyDecision,
    turnOffSemanticSession,
  };
}
