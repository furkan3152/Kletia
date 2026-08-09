import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAccount } from 'wagmi';
import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { Loader2, Zap, CheckCircle2, User, CreditCard, Bot } from 'lucide-react';
import {
  NETWORKS,
  type AppTab,
  type NetworkMode,
} from './config/networks';
import { BACKEND_URL } from './config/runtime';
import {
  hasBaseIntentV2Marker,
  hasExecutableIntentActionBinding,
  isBaseIntentRouterV2ResponseBinding,
  isBaseX402ChallengeEvidence,
  isBaseMcpX402Plan,
  isBaseFeeRouterCoverage,
  isArcPortfolioData,
  isBasePortfolioData,
  isBaseLiquidityRoutingResponse,
  isBaseSwapRoutingEvidence,
  isBaseYieldComparisonResponse,
  isBaseYieldRankingEvidence,
  isBaseX402Search,
  isBaseX402Service,
  type EntityClarification,
  type EntityClarificationOption,
  type IntentResponse,
  type PortfolioData,
  type RouteData,
  type WidgetId,
} from './types';
import { BasenameClaimer } from './components/BasenameClaimer';
import { AirdropSimulator } from './components/widgets/AirdropSimulator';
import { WebacyScanner } from './components/widgets/WebacyScanner';
import { ArcDashboardWidget } from './components/widgets/ArcDashboardWidget';
import { ArcLendingDashboard } from './components/ArcLendingDashboard';
import { ArcAppKitRouteCard } from './components/arc/ArcAppKitRouteCard';
import { BaseMcpHandoffPanel } from './components/base/BaseMcpHandoffPanel';
import { ApprovalReviewCard } from './components/base/ApprovalReviewCard';
import { LaunchTokenPreviewCard } from './components/base/LaunchTokenPreviewCard';
import { BaseMcpX402PlanCard } from './components/x402/BaseMcpX402PlanCard';
import { X402DiscoveryCard } from './components/x402/X402DiscoveryCard';
import { AlloraDashboard } from './components/AlloraDashboard';
import { Navbar } from './components/layout/Navbar';
import { Sidebar } from './components/layout/Sidebar';
import { AppSidebar } from './components/layout/AppSidebar';
import { ChatInput } from './components/chat/ChatInput';
import { AssetClarificationCard } from './components/chat/AssetClarificationCard';
import { EntityResolutionEvidenceCard } from './components/chat/EntityResolutionEvidenceCard';
import { TerminalLogs } from './components/chat/TerminalLogs';
import { useNetwork } from './hooks/useNetwork';
import {
  type TransactionApproval,
  useTransactionExecutor,
} from './hooks/useTransactionExecutor';
import { useAppStore } from './store/useAppStore';
import { validateArcOfficialRoute } from './arc/officialExtensions';
import { isArcAppKitResponseBound } from './arc/appKitEnvelope';
import { containsSensitivePromptMaterial } from './security/promptSecrets';
import {
  isBaseSwapExecutionResponse,
  isBaseSwapResponseAllowedForExecutionPolicy,
  resolveBaseSwapExecutionPolicy,
} from './security/baseSwapExecutionPolicy';
import { normalizeWalletHistoryOwner } from './store/walletHistoryPolicy';
import { currentEpochMs } from './utils/time';
import {
  basenameRecipientEvidence,
  isBasenameRevalidationResponse,
  isEntityClarification,
  isIntentEntityResolution,
  responseIntentAction,
} from './security/entityResolution';
import { isBaseLaunchFactoryV2ResponseBinding } from './security/baseLaunchFactoryV2';
import { resolveIntentHttpResponseBoundary } from './security/intentHttpResponseBoundary';
import './App.css';

const BASE_SWAP_EXECUTION_POLICY_SETTING =
  import.meta.env.VITE_BASE_SWAP_EXECUTION_MODE;
const X402ServiceRouter = React.lazy(() =>
  import('./components/x402/X402ServiceRouter').then((module) => ({
    default: module.X402ServiceRouter,
  })),
);
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APP_TABS: readonly AppTab[] = [
  'chat',
  'basename',
  'allora',
  'airdrop',
  'x402',
  'webacy',
  'arc',
  'lending',
];

type ActiveRequest = {
  controller: AbortController;
  network: NetworkMode;
  requestId: string;
  messageId: string;
  walletAddress: string;
  clarificationSourceMessageId?: string;
};

type ConversationContext = {
  id: string;
  network: NetworkMode;
  chainId: number;
  walletAddress: string;
  sourceRequestId: string;
  sourceMessageId: string;
  expiresAt: number;
  clarification?: EntityClarification;
};

type SubmitIntentOptions = {
  displayText?: string;
  conversation?: ConversationContext;
  clarificationSelection?: { optionId: string };
  clarificationSourceMessageId?: string;
};

const isAppTab = (value: unknown): value is AppTab =>
  typeof value === 'string' && APP_TABS.includes(value as AppTab);

const createRequestId = (): string => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();

  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) =>
    value.toString(16).padStart(2, '0'));
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-');
};

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    const sanitized = error.message
      .replace(/https?:\/\/[^\s"'<>]+/giu, '[redacted-url]')
      .replace(
        /\b(?:authorization|signature|api[-_ ]?key)\b\s*[:=]\s*[^\s,;]+/giu,
        '[redacted-credential]',
      )
      .replace(/\b0x[a-f\d]{96,}\b/giu, '[redacted-payload]')
      .replace(/\b[A-Za-z\d+/_-]{80,}={0,2}\b/gu, '[redacted-payload]')
      .trim();
    return sanitized || 'Unknown system error.';
  }
  return 'Unknown system error.';
};

const parseExpiry = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return undefined;
};

const requiresExplicitLiquiditySelection = (
  response: IntentResponse,
): boolean =>
  response.liquidityRoutingEvidence?.selectionPolicy ===
    'explicit_wallet_position_selection' &&
  (response.allRoutes?.length || 0) > 1;

const isCalldata = (value: unknown): value is Hex =>
  typeof value === 'string' && /^0x(?:[0-9a-fA-F]{2}){4,}$/.test(value);

const isUnsignedIntegerString = (value: unknown): value is string =>
  typeof value === 'string' && /^\d+$/.test(value);

const renderSafeMessage = (text: string) => {
  const cleanText = text.replace(/\[SHOW_ONRAMP\]/g, '');
  const sections = cleanText.split(/(\*\*[^*]+\*\*)/g);

  return (
    <span className="whitespace-pre-wrap">
      {sections.map((section, index) =>
        section.startsWith('**') && section.endsWith('**') ? (
          <strong
            key={`${index}-${section}`}
            className="text-[#1A1A1A] dark:text-white font-black border-b-[3px] border-[#0052FF] pb-0.5"
          >
            {section.slice(2, -2)}
          </strong>
        ) : (
          <React.Fragment key={`${index}-${section}`}>{section}</React.Fragment>
        ),
      )}
    </span>
  );
};

const handleFundClick = async (targetAddress: string, e: React.MouseEvent) => {
  e.preventDefault();
  try {
    const res = await fetch(`${BACKEND_URL}/api/onramp-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kletia-Network': 'base',
        'X-Kletia-Chain-Id': String(NETWORKS.base.chainId),
      },
      body: JSON.stringify({ address: targetAddress })
    });
    const data = await res.json();
    if (data.status === 'success' && data.token) {
      const addresses = encodeURIComponent(JSON.stringify({ [targetAddress]: ['base'] }));
      const appId = "82ee9f72-74ba-4279-bf89-5f212261ce85";
      window.open(
        `https://pay.coinbase.com/buy/select-asset?appId=${appId}&sessionToken=${data.token}&addresses=${addresses}&defaultAsset=USDC`,
        '_blank',
        'noopener,noreferrer',
      );
    } else {
      alert("The funding service is currently unavailable. Please try again later.");
    }
  } catch {
    console.warn('Funding request failed.');
  }
};

export default function App() {
  const { address, status: accountStatus } = useAccount();
  const {
    networkMode,
    network,
    chainId,
    toggleNetwork,
    isSwitching,
    switchError,
  } = useNetwork();
  const { execute: executeTransaction } = useTransactionExecutor();
  const walletMatchesNetwork = chainId === network.chainId;
  const [isBaseMcpHandoffOpen, setIsBaseMcpHandoffOpen] =
    useState(false);
  const [activeTab, setActiveTab] = useState<AppTab>('chat');
  const [activeArcWidget, setActiveArcWidget] = useState<WidgetId>(null);
  const [isPortfolioOpen, setIsPortfolioOpen] = useState(false);
  const [isAppSidebarOpen, setIsAppSidebarOpen] = useState(false);
  const [input, setInput] = useState('');
  const activeRequestRef = useRef<ActiveRequest | null>(null);
  const conversationContextRef = useRef<ConversationContext | null>(null);
  const clarificationSubmissionRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const {
    isDarkMode,
    historyOwner,
    messages: storedMessages,
    addMessage,
    updateMessage,
    updateMessageForNetwork,
    addTerminalLogForNetwork,
    bindWalletHistory,
  } = useAppStore();
  const activeWalletOwner = normalizeWalletHistoryOwner(address);
  const messages = useMemo(
    () =>
      historyOwner === null || historyOwner === activeWalletOwner
        ? storedMessages
        : [],
    [activeWalletOwner, historyOwner, storedMessages],
  );

  useEffect(() => {
    if (accountStatus === 'connected' && address) {
      bindWalletHistory(address);
    } else if (accountStatus === 'disconnected') {
      bindWalletHistory();
    }
  }, [accountStatus, address, bindWalletHistory]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('kletia-theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('kletia-theme', 'light');
    }
  }, [isDarkMode]);

  useEffect(() => {
    const activeRequest = activeRequestRef.current;
    if (
      activeRequest &&
      (activeRequest.network !== networkMode ||
        activeRequest.walletAddress.toLowerCase() !==
          address?.toLowerCase())
    ) {
      activeRequest.controller.abort();
      updateMessageForNetwork(
        activeRequest.network,
        activeRequest.messageId,
        {
          isLoading: false,
          text: 'ℹ️ Ağ değiştiği için önceki istek güvenli şekilde iptal edildi.',
        },
      );
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
        { clarificationStatus: 'expired' },
      );
      conversationContextRef.current = null;
      clarificationSubmissionRef.current = null;
    }

    document.documentElement.dataset.network = networkMode;
    document.documentElement.classList.toggle(
      'arc-mode',
      networkMode === 'arc',
    );
    setInput('');
    setActiveTab('chat');
    setActiveArcWidget(null);
    setIsPortfolioOpen(false);
    setIsBaseMcpHandoffOpen(false);
  }, [address, networkMode, updateMessageForNetwork]);

  useEffect(
    () => () => {
      activeRequestRef.current?.controller.abort();
    },
    [],
  );

  const supportedTabs = new Set(
    network.navigation.flatMap((section) =>
      section.items.flatMap((item) =>
        item.action.type === 'tab' ? [item.action.tab] : [],
      ),
    ),
  );

  const isCurrentRequest = (request: ActiveRequest): boolean =>
    !request.controller.signal.aborted &&
    activeRequestRef.current?.requestId === request.requestId &&
    useAppStore.getState().activeNetwork === request.network;

  const updateRequestMessage = (
    request: ActiveRequest,
    updates: Parameters<typeof updateMessage>[1],
  ) => {
    if (!isCurrentRequest(request)) return;
    updateMessageForNetwork(request.network, request.messageId, updates);
  };

  const handleWidgetClick = (prompt: string) => {
    const conversationContext = conversationContextRef.current;
    if (conversationContext) {
      updateMessageForNetwork(
        conversationContext.network,
        conversationContext.sourceMessageId,
        { clarificationStatus: 'expired' },
      );
      conversationContextRef.current = null;
      clarificationSubmissionRef.current = null;
    }
    setInput(prompt);
    setActiveTab('chat');
    setIsPortfolioOpen(false);
    setTimeout(() => {
      inputRef.current?.focus();
    }, 10);
  };

  const submitIntent = async (
    rawUserText: string,
    options: SubmitIntentOptions = {},
  ) => {
    const userText = rawUserText.trim();
    if (!userText) return;
    const blockStructuredSelection = () => {
      if (options.clarificationSourceMessageId) {
        updateMessageForNetwork(
          networkMode,
          options.clarificationSourceMessageId,
          { clarificationStatus: 'blocked' },
        );
      }
      clarificationSubmissionRef.current = null;
    };
    if (containsSensitivePromptMaterial(userText)) {
      setInput('');
      addMessage({
        id: createRequestId(),
        role: 'kletia',
        text:
          '🚨 Private key, seed phrase veya API kimlik bilgisi bu alana gönderilemez. Güvenlik için mesaj kaydedilmedi.',
        network: networkMode,
        chainId: network.chainId,
      });
      blockStructuredSelection();
      return;
    }
    if (!address) {
      addMessage({
        id: createRequestId(),
        role: 'kletia',
        text: '🚨 Önce sağ üstten cüzdanınızı bağlayın.',
        network: networkMode,
        chainId: network.chainId,
      });
      blockStructuredSelection();
      return;
    }
    if (!walletMatchesNetwork) {
      addMessage({
        id: createRequestId(),
        role: 'kletia',
        text: `🚨 Cüzdan ${network.name} ağına bağlı değil. Niyet ve işlem oluşturma güvenlik nedeniyle durduruldu.`,
        network: networkMode,
        chainId: network.chainId,
        walletAddress: address,
      });
      blockStructuredSelection();
      return;
    }

    setInput('');
    const requestId = createRequestId();
    const userMsgId = `${requestId}:user`;
    const kletiaMsgId = `${requestId}:kletia`;
    const controller = new AbortController();
    const activeConversation = conversationContextRef.current;
    const requestedConversation = options.conversation || activeConversation;
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
        { clarificationStatus: 'expired' },
      );
      if (activeConversation?.id === requestedConversation.id) {
        conversationContextRef.current = null;
      }
      clarificationSubmissionRef.current = null;
      if (options.clarificationSelection) {
        addMessage({
          id: createRequestId(),
          role: 'kletia',
          text:
            '🛑 Token seçim bağlamının süresi doldu veya ağ/cüzdan değişti. Niyeti yeniden gönderin.',
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
        { clarificationStatus: 'submitting' },
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
          text: 'ℹ️ Daha yeni bir istek gönderildiği için bu istek iptal edildi.',
        },
      );
    }
    activeRequestRef.current = request;

    addMessage({
      id: userMsgId,
      role: 'user',
      text: options.displayText || userText,
      network: networkMode,
      chainId: network.chainId,
      walletAddress: address,
      requestId,
    });
    addMessage({
      id: kletiaMsgId,
      role: 'kletia',
      text: `${network.name} niyet motoru çalışıyor...`,
      isLoading: true,
      network: networkMode,
      chainId: network.chainId,
      walletAddress: address,
      requestId,
    });

    try {
      const response = await fetch(`${BACKEND_URL}/api/intent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Kletia-Network': networkMode,
          'X-Kletia-Chain-Id': String(network.chainId),
        },
        signal: controller.signal,
        body: JSON.stringify({
          prompt: userText,
          userAddress: address,
          requestId,
          conversationId,
          ...(options.clarificationSelection
            ? {
                clarificationSelection:
                  options.clarificationSelection,
              }
            : {}),
          network: networkMode,
          chainId: network.chainId,
        }),
      });

      const data = (await response.json().catch(() => null)) as IntentResponse | null;
      if (!isCurrentRequest(request)) return;
      if (!data) {
        throw new Error(
          `Intent service returned HTTP ${response.status} without a valid response.`,
        );
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
      if (responseBoundary.kind === 'rejection') {
        throw new Error(responseBoundary.message);
      }

      if (
        networkMode === 'base' &&
        data.feeRouterCoverage !== undefined &&
        !isBaseFeeRouterCoverage(data.feeRouterCoverage)
      ) {
        throw new Error(
          'Base Fee Router allowlist kapsamı doğrulanamadı.',
        );
      }
      if (
        networkMode === 'base' &&
        (
          data.actionType === 'add_liquidity' ||
          data.actionType === 'remove_liquidity' ||
          data.action === 'add_liquidity' ||
          data.action === 'remove_liquidity'
        ) &&
        !isBaseLiquidityRoutingResponse(data)
      ) {
        throw new Error(
          'Base likidite rotasının factory, rezerv ve simülasyon kanıtı doğrulanamadı.',
        );
      }

      if (
        networkMode === 'base' &&
        data.yieldRankingEvidence !== undefined &&
        !isBaseYieldRankingEvidence(data.yieldRankingEvidence)
      ) {
        throw new Error(
          'Base lending verim ve risk sıralama kanıtı doğrulanamadı.',
        );
      }

      if (data.status === 'question') {
        if (
          !data.userAddress ||
          !isAddress(data.userAddress) ||
          getAddress(data.userAddress) !== getAddress(address)
        ) {
          throw new Error(
            'Intent question was not bound to the active wallet address.',
          );
        }
        if (
          data.action === 'agent_action' &&
          networkMode === 'base'
        ) {
          if (clarificationSourceMessageId) {
            updateMessageForNetwork(
              networkMode,
              clarificationSourceMessageId,
              { clarificationStatus: 'resolved' },
            );
          }
          conversationContextRef.current = null;
          setIsBaseMcpHandoffOpen(true);
          updateRequestMessage(request, {
            isLoading: false,
            text:
              data.message ||
              'Resmî Base MCP handoff paneli açıldı.',
          });
          return;
        }
        if (
          typeof data.conversationId !== 'string' ||
          !UUID_V4_PATTERN.test(data.conversationId)
        ) {
          throw new Error(
            'Intent service did not return a valid conversation context.',
          );
        }
        const conversationExpiresAt = data.conversationExpiresAt;
        if (
          data.requiresInput !== true ||
          typeof conversationExpiresAt !== 'number' ||
          !Number.isFinite(conversationExpiresAt) ||
          conversationExpiresAt <= currentEpochMs() ||
          conversationExpiresAt > currentEpochMs() + 16 * 60 * 1_000
        ) {
          throw new Error(
            'Intent service returned an invalid or expired clarification window.',
          );
        }
        const clarification = data.clarification;
        if (
          clarification !== undefined &&
          !isEntityClarification(clarification)
        ) {
          throw new Error(
            'Intent service returned an invalid token clarification contract.',
          );
        }
        if (clarificationSourceMessageId) {
          updateMessageForNetwork(
            networkMode,
            clarificationSourceMessageId,
            { clarificationStatus: 'resolved' },
          );
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
        };
        updateRequestMessage(request, {
          isLoading: false,
          text: data.message || 'Daha fazla bilgi gerekiyor.',
          clarification,
          conversationId: data.conversationId,
          conversationExpiresAt,
          clarificationStatus: clarification ? 'pending' : undefined,
        });
        return;
      }

      if (data.status !== 'success') {
        if (clarificationSourceMessageId) {
          updateMessageForNetwork(
            networkMode,
            clarificationSourceMessageId,
            { clarificationStatus: 'blocked' },
          );
        }
        conversationContextRef.current = null;
        updateRequestMessage(request, {
          isLoading: false,
          text: `❌ İşlem iptal edildi: ${data.message || 'Bilinmeyen hata'}`,
        });
        return;
      }

      if (
        !data.userAddress ||
        !isAddress(data.userAddress) ||
        getAddress(data.userAddress) !== getAddress(address)
      ) {
        throw new Error(
          'Intent response was not bound to the active wallet address.',
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
          'Intent response did not include wallet, network and action-bound entity resolution evidence.',
        );
      }
      conversationContextRef.current = null;
      if (clarificationSourceMessageId) {
        updateMessageForNetwork(
          networkMode,
          clarificationSourceMessageId,
          { clarificationStatus: 'resolved' },
        );
      }

      const hasLaunchFactoryV2Marker =
        data.action === 'deploy_token' ||
        data.actionType === 'deploy_token' ||
        data.executionMode === 'kletia_launch_factory_v2' ||
        data.launchFactoryV2Evidence !== undefined;
      if (hasLaunchFactoryV2Marker && networkMode !== 'base') {
        throw new Error(
          'Kletia Launch Factory V2 yalnız Base Mainnet oturumunda kullanılabilir.',
        );
      }
      if (networkMode === 'base' && hasLaunchFactoryV2Marker) {
        if (
          !isBaseLaunchFactoryV2ResponseBinding(data, {
            requestId,
            userAddress: getAddress(address),
            nowMs: currentEpochMs(),
          })
        ) {
          throw new Error(
            'Token launch yanıtı exact Kletia Launch Factory V2 calldata, CREATE2 kimliği, aktif cüzdan ve simülasyon kanıtına bağlanamadı.',
          );
        }
        updateRequestMessage(request, {
          isLoading: false,
          text:
            data.winnerMessage ||
            'Deterministik fixed-supply token planı Base Mainnet için hazır.',
          intentData: data,
          selectedRouteIndex: 0,
          terminalLogs: [],
        });
        return;
      }

      if (networkMode === 'base' && data.action === 'yield_compare') {
        if (!isBaseYieldComparisonResponse(data)) {
          throw new Error(
            'Canlı Base lending karşılaştırması doğrulanmış fırsat döndürmedi.',
          );
        }
        updateRequestMessage(request, {
          isLoading: false,
          text:
            data.winnerMessage ||
            'Canlı Base lending oranları ve likidite karşılaştırıldı.',
          intentData: data,
          terminalLogs: [],
        });
        return;
      }

      if (data.action === 'open_widget') {
         updateRequestMessage(request, {
            isLoading: false, text: data.winnerMessage || "Opening the requested module...", terminalLogs: []
         });
         if (
           isAppTab(data.widgetTarget) &&
           supportedTabs.has(data.widgetTarget)
         ) {
            setActiveTab(data.widgetTarget);
            if (data.widgetTarget === 'arc' && data.subTarget) {
               setActiveArcWidget(data.subTarget);
            }
            if (data.widgetTarget !== 'chat') {
               setIsPortfolioOpen(false);
            }
         } else {
           throw new Error(
             `Backend returned a widget that is not enabled on ${network.name}.`,
           );
         }
         return;
      }

      if (data.action === 'portfolio') {
        if (!data.data || typeof data.data !== 'object') {
          throw new Error('Portföy servisi doğrulanabilir bir veri nesnesi döndürmedi.');
        }
        const portfolioData = {
          ...data.data,
          network: data.network,
          chainId: data.chainId,
        } as PortfolioData;
        const validPortfolio =
          networkMode === 'base'
            ? isBasePortfolioData(portfolioData)
            : isArcPortfolioData(portfolioData);
        if (!validPortfolio) {
          throw new Error(
            `Portföy yanıtı ${network.name} veri şemasıyla eşleşmiyor.`,
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
            'Portföy tarandı. Kaynak ve bütünlük ayrıntıları sağ panelde güncellendi.',
          intentData: portfolioResponse,
          terminalLogs: [],
        });
        setIsPortfolioOpen(true);
        return;
      }

      if (data.action === 'agent_action') {
        if (networkMode === 'base') setIsBaseMcpHandoffOpen(true);
        updateRequestMessage(request, {
          isLoading: false,
          text:
            data.message ||
            data.winnerMessage ||
            'Open the official Base MCP handoff to continue in your OAuth-connected agent client.',
          terminalLogs: [],
        });
        return;
      }

      if (data.action === 'bns_resolve') {
        updateRequestMessage(request, {
          isLoading: false,
          text:
            data.message ||
            data.winnerMessage ||
            'Base name resolution needs more information.',
          terminalLogs: [],
        });
        return;
      }

      if (data.executionKind === 'circle_app_kit') {
        if (networkMode !== 'arc' || !isArcAppKitResponseBound(data, requestId)) {
          throw new Error(
            'Circle App Kit planı aktif Arc Testnet oturumuyla eşleşmiyor.',
          );
        }
        updateRequestMessage(request, {
          isLoading: false,
          text:
            data.winnerMessage ||
            'Circle App Kit rotası hazır; canlı tahmin alınıyor.',
          intentData: data,
          terminalLogs: [],
        });
        return;
      }

      if (data.executionKind === 'base_x402_discovery') {
        if (
          networkMode !== 'base' ||
          data.provider !== 'Coinbase CDP Bazaar' ||
          !Array.isArray(data.services) ||
          data.services.length > 8 ||
          !data.services.every(isBaseX402Service) ||
          !isBaseX402Search(data.search) ||
          (data.trustNotice !== undefined &&
            typeof data.trustNotice !== 'string')
        ) {
          throw new Error(
            'CDP Bazaar sonucu aktif Base Mainnet güvenlik sözleşmesiyle eşleşmiyor.',
          );
        }
        updateRequestMessage(request, {
          isLoading: false,
          text:
            data.winnerMessage ||
            'CDP Bazaar servisleri ödeme tavanı ve Base USDC politikasına göre doğrulandı.',
          intentData: data,
          terminalLogs: [],
        });
        return;
      }

      if (data.executionKind === 'base_mcp_x402') {
        if (
          networkMode !== 'base' ||
          data.provider !== 'Base MCP' ||
          data.approvalRequired !== true ||
          !isBaseMcpX402Plan(data.mcpPlan) ||
          data.mcpPlan.requestId !== requestId ||
          (data.mcpPlan.initiate.method === 'GET' &&
            !isBaseX402ChallengeEvidence(
              data.challengeEvidence,
              data.mcpPlan,
              address,
            )) ||
          (data.trustNotice !== undefined &&
            typeof data.trustNotice !== 'string')
        ) {
          throw new Error(
            'Base MCP x402 planı aktif istek ve kullanıcı onayı politikasına bağlı değil.',
          );
        }
        updateRequestMessage(request, {
          isLoading: false,
          text:
            data.winnerMessage ||
            'Base MCP x402 planı hazır; ödeme için Base Account onayı gerekiyor.',
          intentData: data,
          terminalLogs: [],
        });
        return;
      }

      if (
        networkMode === 'base' &&
        (data.quoteCoverage !== undefined ||
          data.rankingEvidence !== undefined) &&
        !isBaseSwapRoutingEvidence(
          data.quoteCoverage,
          data.rankingEvidence,
        )
      ) {
        throw new Error(
          'Base rota sıralama ve kaynak kapsamı kanıtı doğrulanamadı.',
        );
      }

      if (!data.allRoutes?.length) {
        throw new Error('Intent engine did not return an executable route.');
      }
      if (
        isBaseSwapExecutionResponse(data) &&
        !isBaseSwapResponseAllowedForExecutionPolicy(
          data,
          resolveBaseSwapExecutionPolicy(
            BASE_SWAP_EXECUTION_POLICY_SETTING,
          ),
        )
      ) {
        throw new Error(
          'Base swap yanıtı frontend release execution-mode politikasıyla eşleşmiyor.',
        );
      }
      if (
        hasBaseIntentV2Marker(data) &&
        !isBaseIntentRouterV2ResponseBinding(data)
      ) {
        throw new Error(
          'Base Intent Router V2 yanıt kümesi typed intent, calldata, sıralama ve politika hedeflerine bağlanamadı.',
        );
      }

      updateRequestMessage(request, {
        isLoading: false, 
        text:
          data.winnerMessage ||
          `🏆 ${network.name} rotası hazır: **${data.winner || data.allRoutes[0].name}**`,
        intentData: data,
        selectedRouteIndex: requiresExplicitLiquiditySelection(data)
          ? undefined
          : 0,
        terminalLogs: [],
      });

    } catch (error: unknown) {
      if (clarificationSourceMessageId) {
        updateMessageForNetwork(
          networkMode,
          clarificationSourceMessageId,
          { clarificationStatus: 'blocked' },
        );
      }
      if (conversationContextRef.current?.id === conversationId) {
        conversationContextRef.current = null;
      }
      if ((error as Error).name !== 'AbortError') {
        updateRequestMessage(request, {
          isLoading: false,
          text: `❌ Sistem hatası: ${getErrorMessage(error)}`,
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

  const handleSend = () => {
    void submitIntent(input);
  };

  const handleClarificationSelection = (
    messageId: string,
    option: EntityClarificationOption,
  ) => {
    const message = messages.find((candidate) => candidate.id === messageId);
    const conversation = conversationContextRef.current;
    if (
      !message?.clarification ||
      message.clarificationStatus !== 'pending' ||
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
        clarificationStatus: 'expired',
      });
      conversationContextRef.current = null;
      clarificationSubmissionRef.current = null;
      return;
    }
    if (clarificationSubmissionRef.current !== null) return;
    clarificationSubmissionRef.current = conversation.id;
    updateMessageForNetwork(conversation.network, messageId, {
      clarificationStatus: 'submitting',
    });
    void submitIntent('Doğrulanmış token seçimini uygula.', {
      displayText: `${option.label} (${option.symbol}) seç`,
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
      typeof data.chainId !== 'number' ||
      !data.userAddress ||
      !isAddress(data.userAddress)
    ) {
      throw new Error(
        'Basename yeniden doğrulama bağlamı eksik veya güvenli sınırları aşıyor.',
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
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Kletia-Network': data.network,
              'X-Kletia-Chain-Id': String(data.chainId),
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
              ? 'Basename kaydı plan oluşturulduktan sonra değişti veya artık çözümlenemiyor; yeni niyet oluşturun.'
              : 'Basename imza öncesi yeniden doğrulanamadı; işlem gönderilmedi.',
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
    if (
      route.approvalPolicy === 'explicit' ||
      declared.length > 0
    ) {
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

  const executeRoute = async (msgId: string) => {
    const msg = messages.find(m => m.id === msgId);
    if (!msg?.intentData || !address) return;

    const data = msg.intentData;
    const originNetwork = msg.network;
    if (!originNetwork) return;
    const routes = data.allRoutes;
    if (!routes?.length) return;
    const selectedRouteIndex = requiresExplicitLiquiditySelection(data)
      ? msg.selectedRouteIndex
      : msg.selectedRouteIndex ?? 0;
    const activeRoute =
      typeof selectedRouteIndex === 'number' &&
      Number.isInteger(selectedRouteIndex)
      ? routes[selectedRouteIndex]
      : undefined;

    const updateOriginMessage = (updates: Parameters<typeof updateMessage>[1]) =>
      updateMessageForNetwork(originNetwork, msgId, updates);
    const addOriginLog = (log: string) =>
      addTerminalLogForNetwork(originNetwork, msgId, log);

    updateOriginMessage({ isLoading: true });

    try {
      if (!activeRoute) {
        throw new Error(
          'Seçilen rota indeksi geçersiz. Niyeti yeniden oluşturun.',
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
          'Bu rota farklı bir ağ veya cüzdan oturumuna ait. Niyeti yeniden oluşturun.',
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
          'Seçilen rota bu niyet isteğine ait değil. Niyeti yeniden oluşturun.',
        );
      }

      if (
        activeRoute.network !== networkMode ||
        activeRoute.chainId !== network.chainId
      ) {
        throw new Error(
          'Seçilen rotanın ağ metadatası aktif ağla eşleşmiyor.',
        );
      }

      if (
        isBaseSwapExecutionResponse(data) &&
        !isBaseSwapResponseAllowedForExecutionPolicy(
          data,
          resolveBaseSwapExecutionPolicy(
            BASE_SWAP_EXECUTION_POLICY_SETTING,
          ),
        )
      ) {
        throw new Error(
          'Base swap yanıtı aktif frontend release moduna ait değil. Niyeti yeniden oluşturun.',
        );
      }

      if (!hasExecutableIntentActionBinding(data, activeRoute)) {
        throw new Error(
          'Seçilen rota doğrulanmış bir niyet action alanına bağlı değil.',
        );
      }

      const isLaunchFactoryV2 =
        data.executionMode === 'kletia_launch_factory_v2' ||
        activeRoute.executionMode === 'kletia_launch_factory_v2' ||
        data.action === 'deploy_token' ||
        data.actionType === 'deploy_token' ||
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
          'Launch Factory V2 planı imza öncesi cüzdan, calldata, fee, salt veya CREATE2 adresi doğrulamasını geçemedi.',
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
        throw new Error(
          'Seçilen rota bağlı cüzdan için oluşturulmamış.',
        );
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
          'Seçilen rota güncel cüzdan, ağ ve action alanlarına bağlı varlık kanıtı taşımıyor.',
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
          'Seçilen rotanın teklif süresi geçersiz veya dolmuş. Niyeti yeniden oluşturun.',
        );
      }

      if (!isAddress(activeRoute.router)) {
        throw new Error('Seçilen rota geçerli bir hedef adres taşımıyor.');
      }
      if (!isCalldata(activeRoute.calldata)) {
        throw new Error('Seçilen rota geçerli calldata taşımıyor.');
      }
      if (!isUnsignedIntegerString(activeRoute.value)) {
        throw new Error('Seçilen rota geçerli bir native değer taşımıyor.');
      }

      const targetAddress = getAddress(activeRoute.router);
      const txCalldata = activeRoute.calldata;
      const txValue = BigInt(activeRoute.value);
      const officialArcPolicy = validateArcOfficialRoute(
        activeRoute,
        data.actionType || data.action,
        activeRoute.userAddress,
      );
      const resolvedApprovals = routeApprovals(activeRoute, data);
      if (
        officialArcPolicy.requireEoa &&
        resolvedApprovals.length !== 0
      ) {
        throw new Error(
          'Resmî Arc extension rotası hiçbir token allowance oluşturamaz.',
        );
      }

      addOriginLog(
        `🛡️ ${network.name} güvenlik ve simülasyon hattı devrede.`,
      );
      addOriginLog(`🔗 Hedef: ${targetAddress}`);
      if (txValue > 0n) {
        addOriginLog(
          `⚡ Native ${network.nativeCurrency.symbol} değeri doğrulandı.`,
        );
      }
      if (officialArcPolicy.requireEoa) {
        addOriginLog(
          '🧾 Resmî Arc extension calldata ve original-sender EOA politikası yeniden decode edilerek doğrulandı.',
        );
      }
      const responseUsesIntentRouterV2 =
        data.executionMode === 'kletia_intent_router_v2';
      const routeUsesIntentRouterV2 =
        activeRoute.executionMode === 'kletia_intent_router_v2';
      if (responseUsesIntentRouterV2 !== routeUsesIntentRouterV2) {
        throw new Error(
          'Base V2 yanıtı ile seçilen rotanın executionMode alanı eşleşmiyor.',
        );
      }
      const isIntentRouterV2 =
        responseUsesIntentRouterV2 && routeUsesIntentRouterV2;
      const intentV2Authorities = isIntentRouterV2
        ? (() => {
            if (
              (
                activeRoute.adapterKind !==
                  'uniswap_v2_compatible' &&
                activeRoute.adapterKind !==
                  'uniswap_v3_swaprouter02'
              ) ||
              !activeRoute.adapter ||
              !activeRoute.underlyingTarget ||
              !activeRoute.underlyingSpender ||
              !activeRoute.underlyingFactory ||
              !activeRoute.wrappedNative
            ) {
              throw new Error(
                'Typed Base V2 rota yetkileri eksik; işlem gönderilmedi.',
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
          '🔐 V2 exact approval ve swap yalnızca tek bir Base atomic paketi olarak yürütülecek.',
        );
      }
      const launchFactoryV2Authority = isLaunchFactoryV2
        ? (() => {
            const evidence = data.launchFactoryV2Evidence;
            if (!evidence) {
              throw new Error(
                'Launch Factory V2 runtime kanıtı işlem planında bulunamadı.',
              );
            }
            addOriginLog(
              '🧬 deployToken calldata, creator-scoped salt, full-supply recipient ve CREATE2 tahmini yeniden doğrulandı.',
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
          atomicRequired:
            isIntentRouterV2 && resolvedApprovals.length > 0,
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
          simulationReturnPolicy:
            activeRoute.simulationReturnPolicy,
          beforeSubmit: requiresRecipientRevalidation
            ? async () => {
                await revalidateBasenameRecipients(data);
                addOriginLog(
                  '✅ Basename adresi değişmemiş; güncel resolver kanıtı işlem planıyla eşleşiyor.',
                );
              }
            : undefined,
          intentV2Authorities,
          launchFactoryV2Authority,
        },
        addOriginLog,
      );

      if (originNetwork === 'arc') {
        updateOriginMessage({
          txHash: result.hash,
          text: '✅ Arc Testnet işlemi başarılı receipt ile final oldu.',
        });
        addOriginLog('✅ Arc Testnet işlemi başarılı receipt ile final oldu.');
      } else {
        updateOriginMessage({
          txHash: result.hash,
          text: '✅ Base Mainnet işlemi başarılı receipt ile zincire dahil edildi.',
        });
        addOriginLog(
          '✅ Base Mainnet işlemi başarılı receipt ile zincire dahil edildi; bu ifade ek L1 kesinleşmesi anlamına gelmez.',
        );
      }
    } catch (error: unknown) {
      addOriginLog(`❌ İptal / Hata: ${getErrorMessage(error)}`);
    } finally {
      updateOriginMessage({ isLoading: false });
    }
  };

  const handleContextFunding = (
    targetAddress: string,
    event: React.MouseEvent,
  ) => {
    if (network.funding.kind === 'faucet') {
      event.preventDefault();
      window.open(network.funding.url, '_blank', 'noopener,noreferrer');
      return;
    }
    void handleFundClick(targetAddress, event);
  };

  return (
    <div className="absolute inset-0 flex flex-col bg-[#EFEFEF] dark:bg-[#0B1120] text-[#1A1A1A] dark:text-gray-100 font-sans antialiased overflow-hidden transition-colors duration-300">

      {}
      <div className="fixed inset-0 z-0 pointer-events-none select-none">
        {}
        <div className="absolute inset-0 bg-[radial-gradient(#1A1A1A33_2px,transparent_2px)] dark:bg-[radial-gradient(#ffffff15_2px,transparent_2px)] [background-size:30px_30px] opacity-70"></div>

        {}
        <div className="hidden md:block absolute -left-10 top-[15%] text-[180px] font-black text-black/[0.03] dark:text-white/[0.02] -rotate-12 tracking-tighter">KLETIA</div>
        <div className="hidden md:block absolute right-[-20px] bottom-[20%] text-[160px] font-black text-black/[0.03] dark:text-white/[0.02] rotate-12 tracking-widest">OMNI</div>

        {}
        <div className="hidden md:block absolute top-[15%] right-[10%] w-24 h-24 bg-[#0052FF] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] rotate-12 opacity-80 dark:opacity-50"></div>
        <div className="hidden md:block absolute bottom-[25%] left-[5%] md:left-[10%] w-24 md:w-40 h-12 md:h-16 bg-[#FFD700] dark:bg-[#CCA000] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] rounded-full shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] -rotate-6 opacity-80 dark:opacity-60"></div>
      </div>

      {}
      <Navbar 
        onBaseMcpHandoff={() => setIsBaseMcpHandoffOpen(true)}
        address={address}
        handleFundClick={handleFundClick}
        onMenuClick={() => setIsAppSidebarOpen(!isAppSidebarOpen)}
        networkMode={networkMode}
        onNetworkToggle={toggleNetwork}
        isNetworkSwitching={isSwitching}
        networkSwitchError={switchError}
      />
      <BaseMcpHandoffPanel
        open={networkMode === 'base' && isBaseMcpHandoffOpen}
        appWallet={address}
        onClose={() => setIsBaseMcpHandoffOpen(false)}
      />

      {}
      <div className="flex flex-1 overflow-hidden z-10 relative min-h-0 min-w-0">

        {}
        <AppSidebar 
          activeTab={activeTab} 
          setActiveTab={setActiveTab} 
          isPortfolioOpen={isPortfolioOpen} 
          setIsPortfolioOpen={setIsPortfolioOpen}
          isOpen={isAppSidebarOpen}
          setIsOpen={setIsAppSidebarOpen}
          onWidgetClick={handleWidgetClick}
        />

        <div className="grid grid-rows-[1fr_auto] flex-1 overflow-hidden relative w-full h-full min-h-0 min-w-0">
        {networkMode === 'base' && activeTab === 'allora' ? (
           <AlloraDashboard
             isDarkMode={isDarkMode}
             onActionClick={handleWidgetClick}
           />
        ) : networkMode === 'base' && activeTab === 'basename' ? (
           <BasenameClaimer
             onActionClick={handleWidgetClick}
           />
        ) : networkMode === 'base' && activeTab === 'airdrop' ? (
           <AirdropSimulator />
        ) : networkMode === 'base' && activeTab === 'x402' ? (
           <React.Suspense
             fallback={
               <div className="flex h-full items-center justify-center">
                 <div className="flex items-center gap-3 border-[4px] border-[#1A1A1A] bg-white p-5 font-black uppercase text-[#1A1A1A] shadow-[6px_6px_0_#1A1A1A]">
                   <Loader2 className="h-5 w-5 animate-spin text-[#0052FF]" />
                   Loading x402 workspace
                 </div>
               </div>
             }
           >
             <X402ServiceRouter onIntentTemplate={handleWidgetClick} />
           </React.Suspense>
        ) : networkMode === 'base' && activeTab === 'webacy' ? (
           <WebacyScanner />
        ) : networkMode === 'arc' && activeTab === 'arc' ? (
           <div className="flex-1 overflow-y-auto p-4 md:p-6 custom-scrollbar block">
             <ArcDashboardWidget onWidgetClick={handleWidgetClick} activeWidget={activeArcWidget} setActiveWidget={setActiveArcWidget} />
           </div>
        ) : networkMode === 'arc' && activeTab === 'lending' ? (
           <div className="flex-1 overflow-y-auto p-4 md:p-6 custom-scrollbar block">
             <ArcLendingDashboard
               isDarkMode={isDarkMode}
               onActionClick={handleWidgetClick}
             />
           </div>
        ) : (
          <>
            {}
            <div className="overflow-y-auto p-3 md:p-6 bg-transparent scroll-smooth min-h-0 custom-scrollbar" id="chat-container" style={{ maskImage: 'linear-gradient(to bottom, black 85%, transparent 100%)', WebkitMaskImage: 'linear-gradient(to bottom, black 85%, transparent 100%)' }}>
          <div className="max-w-4xl mx-auto relative w-full pr-1 md:pr-0">

            <div className="space-y-6 md:space-y-8">
            {messages.map((msg) => (
              <div key={msg.id} className={`flex gap-3 md:gap-5 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>

                {}
                {msg.role === 'kletia' && (
                  <div className="w-10 h-10 md:w-12 md:h-12 bg-white dark:bg-slate-800 border-[3px] border-[#4B5563] dark:border-[#4B5563] shadow-[3px_3px_0_#475569] dark:shadow-[3px_3px_0_#475569] flex items-center justify-center shrink-0">
                    {msg.isLoading && !msg.terminalLogs?.length ? <Loader2 className="w-5 h-5 md:w-6 md:h-6 text-[#0052FF] animate-spin" strokeWidth={4} /> : <Bot className="w-5 h-5 md:w-6 md:h-6 text-gray-600 dark:text-slate-300" strokeWidth={4} />}
                  </div>
                )}

                {}
                <div className={`max-w-[85%] sm:w-auto px-4 py-3 md:px-6 md:py-5 border-[3px] border-[#1A1A1A] dark:border-[#4B5563] text-sm md:text-lg font-bold break-words
                  ${msg.role === 'user' 
                    ? 'bg-[#0052FF] text-white ml-auto shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#475569] md:shadow-[4px_4px_0_#1A1A1A] dark:md:shadow-[4px_4px_0_#475569]' 
                    : 'bg-white dark:bg-[#131E32] text-[#1A1A1A] dark:text-gray-100 shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#475569] md:shadow-[4px_4px_0_#1A1A1A] dark:md:shadow-[4px_4px_0_#475569]'}`}>

                  {msg.role === 'kletia' ? (
                    <div>
                      <div>{renderSafeMessage(msg.text)}</div>
                      {msg.clarification &&
                        msg.conversationExpiresAt !== undefined &&
                        msg.clarificationStatus && (
                          <AssetClarificationCard
                            clarification={msg.clarification}
                            expiresAt={msg.conversationExpiresAt}
                            status={msg.clarificationStatus}
                            disabled={
                              msg.network !== networkMode ||
                              msg.chainId !== network.chainId ||
                              msg.walletAddress?.toLowerCase() !==
                                address?.toLowerCase()
                            }
                            onSelect={(option) =>
                              handleClarificationSelection(msg.id, option)
                            }
                          />
                        )}
                      {msg.text.includes('[SHOW_ONRAMP]') && address && (
                        <div className="mt-5 md:mt-6 p-4 md:p-5 bg-white dark:bg-[#0F172A] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#475569] md:shadow-[4px_4px_0_#1A1A1A] dark:md:shadow-[4px_4px_0_#475569] flex flex-col gap-4 w-full sm:w-80 md:w-[450px]">
                          <div className="text-xs md:text-sm text-[#1A1A1A] dark:text-white font-black uppercase tracking-widest border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563] pb-2 flex items-center justify-between">
                             <div className="flex items-center gap-2">
                               <CreditCard className="w-4 h-4 md:w-5 md:h-5 text-[#0052FF]" strokeWidth={3} /> FUND WALLET
                             </div>
                             <div className="text-[10px] bg-gray-100 dark:bg-slate-800 px-2 py-1 border-[2px] border-[#1A1A1A] dark:border-slate-500 truncate max-w-[120px] md:max-w-[150px] font-mono" title={address}>
                                {address}
                             </div>
                          </div>
                          <p className="text-sm md:text-base font-bold text-[#1A1A1A] dark:text-gray-300">
                            {networkMode === 'arc'
                              ? 'Arc Testnet native USDC is required for value and gas. Open the official faucet to fund this testnet wallet.'
                              : 'You need USDC in your connected wallet to continue. Open the Base funding flow to continue.'}
                          </p>
                          <button
                            onClick={(e) => handleContextFunding(address, e)}
                            className="group relative w-full flex items-center justify-center gap-2 md:gap-3 bg-[#0052FF] hover:bg-blue-700 text-white font-black py-3 md:py-4 border-[3px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#475569] active:translate-y-1 active:shadow-none transition-all uppercase tracking-wide text-sm md:text-base cursor-pointer"
                          >
                            <CreditCard className="w-5 h-5 md:w-6 md:h-6" strokeWidth={4} /> {networkMode === 'arc' ? 'OPEN ARC USDC FAUCET' : 'FUND YOUR WALLET NOW'}
                          </button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div>{msg.text}</div>
                  )}

                  {msg.intentData?.entityResolution &&
                    msg.intentData.network === networkMode &&
                    msg.intentData.chainId === network.chainId &&
                    msg.intentData.userAddress?.toLowerCase() ===
                      address?.toLowerCase() && (
                      <EntityResolutionEvidenceCard
                        evidence={msg.intentData.entityResolution}
                      />
                    )}

                  {}
                  {msg.intentData?.executionKind === 'circle_app_kit' &&
                    msg.intentData.executionPlan &&
                    msg.intentData.network === 'arc' &&
                    msg.intentData.userAddress &&
                    parseExpiry(msg.intentData.quoteExpiresAt) !==
                      undefined && (
                      <ArcAppKitRouteCard
                        plan={msg.intentData.executionPlan}
                        expectedAddress={msg.intentData.userAddress}
                        expiresAt={
                          parseExpiry(msg.intentData.quoteExpiresAt) as number
                        }
                        disabled={
                          msg.isLoading ||
                          msg.network !== networkMode ||
                          msg.chainId !== network.chainId ||
                          msg.walletAddress?.toLowerCase() !==
                            address?.toLowerCase()
                        }
                        executionStatus={msg.executionStatus}
                        beforeExecute={() =>
                          revalidateBasenameRecipients(msg.intentData!)
                        }
                        onLog={(log) =>
                          addTerminalLogForNetwork(
                            msg.network || 'arc',
                            msg.id,
                            `[APP KIT] ${log}`,
                          )
                        }
                        onComplete={(result) => {
                          updateMessageForNetwork(
                            msg.network || 'arc',
                            msg.id,
                            {
                              executionStatus: result.state,
                              txHash: result.txHash,
                              text:
                                result.state === 'success'
                                  ? `✅ ${result.statusMessage}`
                                  : result.state === 'pending'
                                    ? `⏳ ${result.statusMessage}`
                                    : result.state === 'recoverable'
                                      ? `🟠 ${result.statusMessage}`
                                      : `🛑 ${result.statusMessage}`,
                            },
                          );
                        }}
                      />
                    )}

                  {msg.intentData?.executionKind ===
                    'base_x402_discovery' &&
                    networkMode === 'base' &&
                    msg.network === 'base' &&
                    msg.chainId === NETWORKS.base.chainId &&
                    msg.intentData.network === 'base' &&
                    msg.intentData.userAddress?.toLowerCase() ===
                      address?.toLowerCase() &&
                    msg.intentData.services &&
                    msg.intentData.search && (
                      <X402DiscoveryCard
                        services={msg.intentData.services}
                        search={msg.intentData.search}
                        trustNotice={msg.intentData.trustNotice}
                        onSeed={handleWidgetClick}
                      />
                    )}

                  {msg.intentData?.executionKind === 'base_mcp_x402' &&
                    networkMode === 'base' &&
                    msg.network === 'base' &&
                    msg.chainId === NETWORKS.base.chainId &&
                    msg.intentData.network === 'base' &&
                    msg.intentData.userAddress?.toLowerCase() ===
                      address?.toLowerCase() &&
                    msg.intentData.mcpPlan && (
                      <BaseMcpX402PlanCard
                        plan={msg.intentData.mcpPlan}
                        challengeEvidence={
                          msg.intentData.challengeEvidence
                        }
                        expectedUserAddress={
                          msg.intentData.userAddress!
                        }
                        trustNotice={msg.intentData.trustNotice}
                      />
                    )}

                  {msg.intentData?.action === 'yield_compare' &&
                    msg.intentData.opportunities &&
                    msg.intentData.opportunities.length > 0 && (
                      <div className="mt-5 w-full sm:w-80 md:w-[450px] border-[3px] border-[#1A1A1A] bg-[#FFF36D] p-4 text-[#1A1A1A] shadow-[4px_4px_0_#1A1A1A]">
                        <div className="mb-3 text-xs font-black uppercase tracking-widest">
                          Live Base{' '}
                          {msg.intentData.comparison === 'borrow'
                            ? 'Borrow Cost'
                            : 'Yield'}{' '}
                          Board
                        </div>
                        <div className="flex flex-col gap-2">
                          {msg.intentData.opportunities.slice(0, 6).map(
                            (opportunity, index) => (
                              <div
                                key={`${opportunity.protocolId}:${opportunity.target}`}
                                className="border-[2px] border-[#1A1A1A] bg-white p-2 text-xs font-bold"
                              >
                                <span className="font-black">
                                  {index + 1}. {opportunity.name}
                                </span>
                                {' · '}
                                {(msg.intentData?.comparison === 'borrow'
                                  ? opportunity.borrowRateBps
                                  : opportunity.supplyRateBps) === null
                                  ? 'rate unavailable'
                                  : `${(
                                      (msg.intentData?.comparison ===
                                      'borrow'
                                        ? opportunity.borrowRateBps!
                                        : opportunity.supplyRateBps!) / 100
                                    ).toFixed(2)}% annualized`}
                                {' · '}
                                {opportunity.riskTier}
                              </div>
                            ),
                          )}
                        </div>
                        <p className="mt-3 text-[10px] font-bold leading-relaxed">
                          Point-in-time contract reads; incentives, gas and
                          guaranteed returns are not assumed.
                        </p>
                      </div>
                    )}

                  {msg.intentData?.executionMode ===
                    'kletia_launch_factory_v2' &&
                    msg.intentData.network === 'base' &&
                    msg.intentData.chainId === NETWORKS.base.chainId &&
                    msg.intentData.launchFactoryV2Evidence && (
                      <LaunchTokenPreviewCard
                        evidence={msg.intentData.launchFactoryV2Evidence}
                        isExecuting={Boolean(msg.isLoading)}
                        txHash={msg.txHash}
                        onExecute={() => void executeRoute(msg.id)}
                        disabled={
                          !address ||
                          !walletMatchesNetwork ||
                          msg.network !== networkMode ||
                          msg.chainId !== network.chainId ||
                          msg.walletAddress?.toLowerCase() !==
                            address.toLowerCase() ||
                          msg.intentData.userAddress?.toLowerCase() !==
                            address.toLowerCase()
                        }
                      />
                    )}

                  {msg.intentData &&
                    msg.intentData.allRoutes &&
                    msg.intentData.action !== 'portfolio' &&
                    msg.intentData.executionMode !==
                      'kletia_launch_factory_v2' && (
                    <div className="mt-5 md:mt-6 p-4 md:p-5 bg-white dark:bg-[#0F172A] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#475569] md:shadow-[4px_4px_0_#1A1A1A] dark:md:shadow-[4px_4px_0_#475569] flex flex-col gap-4 w-full sm:w-80 md:w-[450px]">
                      <div className="text-xs md:text-sm text-[#1A1A1A] dark:text-white font-black uppercase tracking-widest border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563] pb-2 flex items-center gap-2">
                         <Zap className="w-4 h-4 md:w-5 md:h-5" strokeWidth={3}/> Autonomous Route Finder
                      </div>

                      {msg.intentData.quoteCoverage &&
                        msg.intentData.rankingEvidence && (
                          <div className="border-[3px] border-[#1A1A1A] bg-[#EAF0FF] p-3 text-[10px] font-bold text-[#1A1A1A]">
                            <div className="flex flex-wrap gap-2 font-black uppercase">
                              <span>
                                Sources{' '}
                                {
                                  msg.intentData.quoteCoverage
                                    .responsiveSourceCount
                                }
                                /
                                {
                                  msg.intentData.quoteCoverage
                                    .requestedSourceCount
                                }
                              </span>
                              <span>•</span>
                              <span>
                                Eligible routes{' '}
                                {
                                  msg.intentData.rankingEvidence
                                    .eligibleRouteCount
                                }
                              </span>
                              <span>•</span>
                              <span>
                                Quote calls{' '}
                                {
                                  msg.intentData.quoteCoverage
                                    .totalAttemptedQuoteCount
                                }
                              </span>
                              <span>•</span>
                              <span>
                                {msg.intentData.rankingEvidence.stage ===
                                'final_routes_after_fee_router_allowlist_and_simulation'
                                  ? 'Final executable ranking'
                                  : 'Pre-fee quoted ranking'}
                              </span>
                            </div>
                            <p className="mt-2 text-[9px] leading-relaxed">
                              {
                                msg.intentData.rankingEvidence
                                  .limitation
                              }
                            </p>
                          </div>
                        )}

                      {msg.intentData.yieldRankingEvidence && (
                        <div className="border-[3px] border-[#1A1A1A] bg-[#FFF36D] p-3 text-[10px] font-bold text-[#1A1A1A]">
                          <div className="font-black uppercase">
                            Live yield efficiency ·{' '}
                            {msg.intentData.yieldRankingEvidence.riskTolerance}
                          </div>
                          <p className="mt-2 leading-relaxed">
                            {
                              msg.intentData.yieldRankingEvidence
                                .limitation
                            }
                          </p>
                        </div>
                      )}

                      {msg.intentData.liquidityRoutingEvidence && (
                        <div className="border-[3px] border-[#1A1A1A] bg-[#BFF7FF] p-3 text-[10px] font-bold text-[#1A1A1A]">
                          <div className="font-black uppercase">
                            Factory-bound pool evidence
                          </div>
                          <p className="mt-1">
                            Candidates{' '}
                            {
                              msg.intentData.liquidityRoutingEvidence
                                .candidateRouteCount
                            }
                            {' · '}eligible after simulation{' '}
                            {
                              msg.intentData.liquidityRoutingEvidence
                                .eligibleRouteCount
                            }
                            {' · '}snapshot block{' '}
                            {
                              msg.intentData.allRoutes?.[0]?.poolEvidence
                                ?.observedBlock
                            }
                          </p>
                          <p className="mt-2 leading-relaxed">
                            {
                              msg.intentData.liquidityRoutingEvidence
                                .limitation
                            }
                          </p>
                        </div>
                      )}

                      {msg.intentData.feeRouterCoverage && (
                        <div className="border-[3px] border-[#1A1A1A] bg-[#D9F99D] p-3 text-[10px] font-bold text-[#1A1A1A]">
                          <div className="font-black uppercase">
                            Fee Router readiness
                          </div>
                          <p className="mt-1">
                            Approved candidates{' '}
                            {msg.intentData.feeRouterCoverage.approvedRouteCount}/
                            {msg.intentData.feeRouterCoverage.compatibleRouteCount}
                            {' · '}eligible after simulation{' '}
                            {msg.intentData.feeRouterCoverage.eligibleRouteCount}
                            {' · '}unapproved targets{' '}
                            {msg.intentData.feeRouterCoverage.unapprovedTargetCount}
                          </p>
                        </div>
                      )}

                      <select 
                        className="w-full bg-[#EFEFEF] dark:bg-slate-800 border-[3px] border-[#1A1A1A] dark:border-[#4B5563] text-[#1A1A1A] dark:text-white font-black text-sm md:text-base p-2.5 md:p-3 outline-none focus:bg-[#0052FF] dark:focus:bg-[#0052FF] focus:text-white transition-colors cursor-pointer"
                        value={msg.selectedRouteIndex ?? ''}
                        onChange={(e) => {
                          if (e.target.value === '') return;
                          updateMessage(msg.id, {
                            selectedRouteIndex: Number(e.target.value),
                          });
                        }}
                        disabled={
                          msg.isLoading ||
                          !!msg.txHash ||
                          !walletMatchesNetwork ||
                          msg.network !== networkMode ||
                          msg.chainId !== network.chainId
                        }
                      >
                        {requiresExplicitLiquiditySelection(msg.intentData) && (
                          <option value="" disabled>
                            LP pozisyonunu/protokolü seçin
                          </option>
                        )}
                        {msg.intentData.allRoutes.map((route, idx) => {
                          const isSingleAction = msg.intentData?.actionType?.startsWith('basename_');
                          const rankedByQuote =
                            Boolean(msg.intentData?.rankingEvidence);
                          const rankedByYield =
                            Boolean(msg.intentData?.yieldRankingEvidence);
                          let prefix =
                            requiresExplicitLiquiditySelection(msg.intentData!)
                              ? '🧭 Wallet LP position:'
                              : idx === 0
                              ? rankedByYield
                                ? msg.intentData?.yieldRankingEvidence
                                    ?.action === 'borrow'
                                  ? '🏆 Lowest live borrow rate:'
                                  : '🏆 Best live yield route:'
                                : rankedByQuote
                                ? '🏆 Best quoted output:'
                                : '🎯 Primary route:'
                              : '🔄 Alternative:';
                          if (isSingleAction) prefix = '🎯 Transaction Detail:';

                          return (
                            <option key={idx} value={idx}>
                              {prefix} {route.name} ({route.expectedOutput || "No Estimate"})
                            </option>
                          );
                        })}
                      </select>

                      {(() => {
                        const previewIndex =
                          requiresExplicitLiquiditySelection(msg.intentData!)
                            ? msg.selectedRouteIndex
                            : msg.selectedRouteIndex ?? 0;
                        const previewRoute =
                          typeof previewIndex === 'number'
                            ? msg.intentData!.allRoutes?.[previewIndex]
                            : undefined;
                        if (!previewRoute) return null;
                        return (
                          <ApprovalReviewCard
                            approvals={routeApprovals(
                              previewRoute,
                              msg.intentData!,
                            )}
                            network={msg.intentData!.network!}
                          />
                        );
                      })()}

                      <button 
                        onClick={() => executeRoute(msg.id)}
                        disabled={
                          msg.isLoading ||
                          !!msg.txHash ||
                          !address ||
                          !walletMatchesNetwork ||
                          msg.network !== networkMode ||
                          msg.chainId !== network.chainId ||
                          msg.walletAddress?.toLowerCase() !==
                            address?.toLowerCase() ||
                          msg.intentData.network !== networkMode ||
                          msg.intentData.chainId !== network.chainId
                          || (requiresExplicitLiquiditySelection(msg.intentData) &&
                            msg.selectedRouteIndex === undefined)
                        }
                        className={`group relative w-full flex items-center justify-center gap-2 md:gap-3 text-white font-black py-3 md:py-4 border-[3px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#475569] active:translate-y-1 active:shadow-none transition-all uppercase tracking-wide text-sm md:text-base ${
                          msg.txHash
                            ? 'bg-[#10B981]' 
                            : msg.isLoading ||
                                !address ||
                                !walletMatchesNetwork ||
                                msg.network !== networkMode ||
                                msg.chainId !== network.chainId ||
                                msg.walletAddress?.toLowerCase() !==
                                  address?.toLowerCase() ||
                                msg.intentData.network !== networkMode ||
                                msg.intentData.chainId !== network.chainId
                                || (requiresExplicitLiquiditySelection(msg.intentData) &&
                                  msg.selectedRouteIndex === undefined)
                              ? 'bg-gray-400 dark:bg-slate-600' 
                              : 'bg-[#0052FF] hover:bg-blue-700'
                        }`}
                      >
                        {msg.isLoading ? <Loader2 className="w-5 h-5 md:w-6 md:h-6 animate-spin" strokeWidth={4} /> : (msg.txHash ? <CheckCircle2 className="w-5 h-5 md:w-6 md:h-6" strokeWidth={4} /> : <Zap className="w-5 h-5 md:w-6 md:h-6" strokeWidth={4} />)}
                        {msg.isLoading
                          ? 'System Processing'
                          : msg.txHash
                            ? msg.network === 'arc'
                              ? 'Arc Final'
                              : 'Base Zincire Dahil Edildi'
                            : 'Execute Route'}
                      </button>
                    </div>
                  )}

                  {}
                  <TerminalLogs msg={msg} />

                </div>

                {}
                {msg.role === 'user' && (
                  <div className="w-10 h-10 md:w-12 md:h-12 bg-[#0052FF] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#475569] flex items-center justify-center shrink-0">
                    <User className="w-5 h-5 md:w-6 md:h-6 text-white" strokeWidth={4} />
                  </div>
                )}
              </div>
            ))}
            <div ref={messagesEndRef} />
            </div>
          </div>
          </div>

        {}
        <ChatInput
          inputRef={inputRef}
          input={input}
          setInput={setInput}
          handleSend={handleSend}
          networkMode={networkMode}
        />
        </>
        )}
        </div>

        {}
        <Sidebar isPortfolioOpen={isPortfolioOpen} setIsPortfolioOpen={setIsPortfolioOpen} />

      </div>
    </div>
  );
}
