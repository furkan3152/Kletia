/**
 * One message of a network engine's thread (the legacy Base, Arbitrum One
 * and Arc chat engines), moved from the old console shell (`App.tsx`): the
 * text, privacy trace, token clarification, agents and hand-off cards,
 * funding, entity evidence, workflow timeline, policy agent, Circle App Kit,
 * x402 and launch cards, the route finder with its approval review and
 * Execute button, and the terminal log.
 *
 * Every disabled check compares the message with the engine's network and
 * the wallet's chain. `inlinePortfolio` prints a verified
 * portfolio scan in the message (the desk has no portfolio drawer).
 */
import "./legacyConsole.css";
import React from "react";
import { formatUnits } from "viem";
import { Bot, CheckCircle2, CreditCard, Loader2, User, Zap } from "lucide-react";
import {
  NETWORKS,
  getNetwork,
  type NetworkMode,
} from "../../../shared/config/networks";
import {
  isArbitrumPortfolioData,
  isArcPortfolioData,
  isBasePortfolioData,
  type ChatMessage,
} from "../../../shared/types";
import { ArcAppKitRouteCard } from "../../../networks/arc/components/ArcAppKitRouteCard";
import { ApprovalReviewCard } from "../../../networks/base/components/ApprovalReviewCard";
import { LaunchTokenPreviewCard } from "../../../networks/base/components/LaunchTokenPreviewCard";
import { BaseMcpX402PlanCard } from "../../../networks/base/components/x402/BaseMcpX402PlanCard";
import { X402DiscoveryCard } from "../../../networks/base/components/x402/X402DiscoveryCard";
import PortfolioViewer from "../../../networks/base/components/PortfolioViewer";
import ArcPortfolioViewer from "../../../networks/arc/components/ArcPortfolioViewer";
import { ArbitrumPortfolioViewer } from "../../../networks/arbitrum/components/ArbitrumPortfolioViewer";
import { AgentsHandoffCard } from "../../../shared/components/chat/AgentsHandoffCard";
import { AGENTS_HANDOFF_WIDGET } from "../../../shared/components/chat/agentsHandoff";
import { AssetClarificationCard } from "../../../shared/components/chat/AssetClarificationCard";
import { IntentPrivacyTraceCard } from "../../../shared/components/chat/IntentPrivacyTraceCard";
import { EntityResolutionEvidenceCard } from "../../../shared/components/chat/EntityResolutionEvidenceCard";
import { TerminalLogs } from "../../../shared/components/chat/TerminalLogs";
import { WorkflowTimeline } from "../../../cross-chain/components/WorkflowTimeline";
import { PolicyAgentCard } from "../../../shared/components/policy/PolicyAgentCard";
import { useAppStore } from "../../../shared/state/useAppStore";
import {
  getErrorMessage,
  parseExpiry,
  recordEvmActivity,
  renderSafeMessage,
  requiresExplicitLiquiditySelection,
} from "./legacyHelpers";
import type { LegacyEngine } from "./useLegacyEngine";

export interface LegacyMessageRowProps {
  readonly msg: ChatMessage;
  /** The engine of the message's network. */
  readonly engine: LegacyEngine;
  /** Fills the composer with a sentence for this engine. */
  readonly onPrompt: (prompt: string) => void;
  /** Funds the wallet for a `[SHOW_ONRAMP]` message (onramp, faucet or bridge-in). */
  readonly onFund: (targetAddress: string, event: React.MouseEvent) => void;
  /** Asks the wallet to switch networks (the Arbitrum gas step hands over to Base). */
  readonly switchNetwork: (mode: NetworkMode) => Promise<boolean>;
  /** Prints a verified portfolio scan in the message instead of a drawer. */
  readonly inlinePortfolio?: boolean;
}

/** A verified portfolio scan of the engine's network and the connected wallet, checked as the old drawer did. */
function InlinePortfolio({
  msg,
  network,
  address,
}: {
  readonly msg: ChatMessage;
  readonly network: NetworkMode;
  readonly address: string | undefined;
}) {
  const chainId = NETWORKS[network].chainId;
  if (
    msg.intentData?.action !== "portfolio" ||
    msg.network !== network ||
    msg.chainId !== chainId ||
    msg.intentData.network !== network ||
    msg.intentData.chainId !== chainId ||
    !address ||
    msg.walletAddress?.toLowerCase() !== address.toLowerCase()
  ) {
    return null;
  }
  const data = msg.intentData.data;
  if (network === "base" && isBasePortfolioData(data)) {
    return <div className="mt-4 min-w-0"><PortfolioViewer data={data} /></div>;
  }
  if (network === "arc" && isArcPortfolioData(data)) {
    return <div className="mt-4 min-w-0"><ArcPortfolioViewer data={data} /></div>;
  }
  if (network === "arbitrum" && isArbitrumPortfolioData(data)) {
    return <div className="mt-4 min-w-0"><ArbitrumPortfolioViewer data={data} /></div>;
  }
  return null;
}

export function LegacyMessageRow({
  msg,
  engine,
  onPrompt: handleWidgetClick,
  onFund: handleContextFunding,
  switchNetwork,
  inlinePortfolio = false,
}: LegacyMessageRowProps) {
  const {
    network: networkMode,
    chain: network,
    address,
    walletMatchesNetwork,
    handleClarificationSelection,
    advanceWorkflowForMessage,
    revalidateBasenameRecipients,
    executeRoute,
    routeApprovals,
  } = engine;
  const updateMessageForNetwork = useAppStore((state) => state.updateMessageForNetwork);
  const addTerminalLogForNetwork = useAppStore((state) => state.addTerminalLogForNetwork);

  return (
    <div
      data-from={msg.role}
      className={`kl-msg-in flex min-w-0 items-start gap-2.5 sm:gap-3 md:gap-5 ${msg.role === "user" ? "justify-end" : "justify-start"}`}
    >
      {msg.role === "kletia" && (
        <div className="flex h-9 w-9 shrink-0 items-center justify-center border-[3px] border-[#4A4A52] bg-[#FBFAF6] shadow-[3px_3px_0_#2A2A30] dark:border-[#4A4A52] dark:bg-slate-800 dark:shadow-[3px_3px_0_#2A2A30] sm:h-10 sm:w-10 md:h-12 md:w-12">
          {msg.isLoading && !msg.terminalLogs?.length ? (
            <Loader2
              className="w-5 h-5 md:w-6 md:h-6 text-[#1A36B0] animate-spin"
              strokeWidth={4}
            />
          ) : (
            <Bot
              className="w-5 h-5 md:w-6 md:h-6 text-gray-600 dark:text-slate-300"
              strokeWidth={4}
            />
          )}
        </div>
      )}

      <div
          className={`min-w-0 max-w-[calc(100%-2.875rem)] overflow-x-hidden break-words border-[3px] border-[#121212] px-3 py-3 text-[15px] font-bold leading-6 dark:border-[#4A4A52] sm:max-w-[calc(100%-3.25rem)] sm:w-auto sm:px-4 md:max-w-[85%] md:px-6 md:py-5 md:text-lg
                  ${
                    msg.role === "user"
    ? "bg-[#2F5BFF] text-white ml-auto shadow-[3px_3px_0_#121212] dark:shadow-[3px_3px_0_#2A2A30] md:shadow-[4px_4px_0_#121212] dark:md:shadow-[4px_4px_0_#2A2A30]"
    : "bg-[#FBFAF6] dark:bg-[#19191C] text-[#121212] dark:text-gray-100 shadow-[3px_3px_0_#121212] dark:shadow-[3px_3px_0_#2A2A30] md:shadow-[4px_4px_0_#121212] dark:md:shadow-[4px_4px_0_#2A2A30]"
                  }`}
      >
        {msg.role === "kletia" ? (
          <div>
            <div>{renderSafeMessage(msg.text)}</div>
            {msg.intentData?.privacyTrace &&
            msg.intentData.requestId === msg.requestId &&
            msg.intentData.network === msg.network &&
            msg.intentData.chainId === msg.chainId ? (
              <IntentPrivacyTraceCard
                trace={msg.intentData.privacyTrace}
              />
            ) : null}
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
                    handleClarificationSelection(
                      msg.id,
                      option,
                    )
                  }
                />
              )}
            {msg.widgetType === AGENTS_HANDOFF_WIDGET ? (
              <AgentsHandoffCard />
            ) : null}
            {inlinePortfolio ? (
              <InlinePortfolio msg={msg} network={networkMode} address={address} />
            ) : null}
            {msg.text.includes("[SHOW_ONRAMP]") &&
              address && (
                <div className="mt-5 md:mt-6 p-4 md:p-5 bg-[#FBFAF6] dark:bg-[#121212] border-[3px] border-[#121212] dark:border-[#4A4A52] shadow-[3px_3px_0_#121212] dark:shadow-[3px_3px_0_#2A2A30] md:shadow-[4px_4px_0_#121212] dark:md:shadow-[4px_4px_0_#2A2A30] flex flex-col gap-4 w-full sm:w-80 md:w-[450px]">
                  <div className="text-xs md:text-sm text-[#121212] dark:text-white font-black uppercase tracking-widest border-b-[3px] border-[#121212] dark:border-[#4A4A52] pb-2 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <CreditCard
                        className="w-4 h-4 md:w-5 md:h-5 text-[#1A36B0]"
                        strokeWidth={3}
                      />{" "}
                      FUND WALLET
                    </div>
                    <div
                      className="text-[10px] bg-gray-100 dark:bg-slate-800 px-2 py-1 border-[2px] border-[#121212] dark:border-slate-500 truncate max-w-[120px] md:max-w-[150px] font-mono"
                      title={address}
                    >
                      {address}
                    </div>
                  </div>
                  <p className="text-sm md:text-base font-bold text-[#121212] dark:text-gray-300">
                    {networkMode === "arc"
                      ? "Arc Testnet native USDC is required for value and gas. Open the official faucet to fund this testnet wallet."
                      : networkMode === "base"
                        ? "You need USDC in your connected wallet to continue. Open the Base funding flow to continue."
                        : `You need funds on ${network.name} to continue. Bridge them in from another network with Kletia Studio.`}
                  </p>
                  <button
                    onClick={(e) =>
                      handleContextFunding(address, e)
                    }
                    className="group relative w-full flex items-center justify-center gap-2 md:gap-3 bg-[#2F5BFF] hover:bg-blue-700 text-white font-black py-3 md:py-4 border-[3px] border-[#121212] dark:border-[#4A4A52] shadow-[3px_3px_0_#121212] dark:shadow-[3px_3px_0_#2A2A30] active:translate-y-1 active:shadow-none transition-all uppercase tracking-wide text-sm md:text-base cursor-pointer"
                  >
                    <CreditCard
                      className="w-5 h-5 md:w-6 md:h-6"
                      strokeWidth={4}
                    />{" "}
                    {networkMode === "arc"
                      ? "OPEN ARC USDC FAUCET"
                      : networkMode === "base"
                        ? "FUND YOUR WALLET NOW"
                        : "BRIDGE FUNDS"}
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

        {msg.intentData?.workflowPlan &&
          msg.intentData.workflowToken && (
            <div>
              <WorkflowTimeline plan={msg.intentData.workflowPlan} />
              {msg.txHash &&
                ["submitted", "confirmed"].includes(
                  msg.intentData.workflowPlan.steps[
                    msg.intentData.workflowPlan.currentStepIndex
                  ]?.status || "",
                ) && (
                  <button
                    type="button"
                    disabled={msg.isLoading || !address}
                    onClick={() => {
                      updateMessageForNetwork(msg.network || "base", msg.id, { isLoading: true });
                      void advanceWorkflowForMessage(msg.id)
                        .catch((error) =>
                          addTerminalLogForNetwork(
                            msg.network || "base",
                            msg.id,
                            `❌ ${getErrorMessage(error)}`,
                          ),
                        )
                        .finally(() =>
                          updateMessageForNetwork(msg.network || "base", msg.id, { isLoading: false }),
                        );
                    }}
                    className="mt-3 w-full border-[3px] border-[#121212] bg-[#FFF36D] px-3 py-2 text-xs font-black uppercase shadow-[3px_3px_0_#121212] disabled:opacity-50"
                  >
                    Refresh cross-chain checkpoint
                  </button>
                )}
            </div>
          )}

        {msg.intentData?.policyAgent &&
          msg.intentData.network !== "arc" && (
            <PolicyAgentCard
              policy={msg.intentData.policyAgent}
              network={msg.intentData.network || "base"}
            />
          )}

        {msg.intentData?.executionKind === "circle_app_kit" &&
          msg.intentData.executionPlan &&
          msg.intentData.network === "arc" &&
          msg.intentData.userAddress &&
          parseExpiry(msg.intentData.quoteExpiresAt) !==
            undefined && (
            <ArcAppKitRouteCard
              plan={msg.intentData.executionPlan}
              expectedAddress={msg.intentData.userAddress}
              expiresAt={
                parseExpiry(
                  msg.intentData.quoteExpiresAt,
                ) as number
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
                  msg.network || "arc",
                  msg.id,
                  `[APP KIT] ${log}`,
                )
              }
              onComplete={(result) => {
                if (
                  result.state === "success" &&
                  result.txHash &&
                  address
                ) {
                  recordEvmActivity({
                    network: "arc",
                    hash: result.txHash,
                    title: "Circle App Kit route on Arc",
                    walletAddress: address,
                  });
                }
                updateMessageForNetwork(
                  msg.network || "arc",
                  msg.id,
                  {
                    executionStatus: result.state,
                    txHash: result.txHash,
                    // The state itself is in executionStatus (the card prints it).
                    text: result.statusMessage,
                  },
                );
              }}
            />
          )}

        {msg.intentData?.executionKind ===
          "base_x402_discovery" &&
          networkMode === "base" &&
          msg.network === "base" &&
          msg.chainId === NETWORKS.base.chainId &&
          msg.intentData.network === "base" &&
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

        {(msg.intentData?.executionKind === "base_mcp_x402" ||
          (msg.intentData?.executionKind === "workflow_plan_v1" &&
            msg.intentData.workflowPlan?.steps[
              msg.intentData.workflowPlan.currentStepIndex
            ]?.action === "data_purchase")) &&
          networkMode === "base" &&
          msg.network === "base" &&
          msg.chainId === NETWORKS.base.chainId &&
          msg.intentData.network === "base" &&
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
              onSettlementVerified={
                msg.intentData.executionKind ===
                "workflow_plan_v1"
                  ? async ({
                      transactionHash,
                      authorizationNonce,
                    }) =>
                      advanceWorkflowForMessage(
                        msg.id,
                        transactionHash,
                        authorizationNonce,
                      )
                  : undefined
              }
            />
          )}

        {msg.intentData?.action === "yield_compare" &&
          msg.intentData.opportunities &&
          msg.intentData.opportunities.length > 0 && (
            <div className="mt-5 w-full sm:w-80 md:w-[450px] border-[3px] border-[#121212] bg-[#FFF36D] p-4 text-[#121212] shadow-[4px_4px_0_#121212]">
              <div className="mb-3 text-xs font-black uppercase tracking-widest">
                Live Base{" "}
                {msg.intentData.comparison === "borrow"
                  ? "Borrow Cost"
                  : "Yield"}{" "}
                Board
              </div>
              <div className="flex flex-col gap-2">
                {msg.intentData.opportunities
                  .slice(0, 6)
                  .map((opportunity, index) => (
                    <div
                      key={`${opportunity.protocolId}:${opportunity.target}`}
                      className="border-[2px] border-[#121212] bg-[#FBFAF6] p-2 text-xs font-bold"
                    >
                      <span className="font-black">
                        {index + 1}. {opportunity.name}
                      </span>
                      {" · "}
                      {(msg.intentData?.comparison ===
                      "borrow"
                        ? opportunity.borrowRateBps
                        : opportunity.supplyRateBps) === null
                        ? "rate unavailable"
                        : `${(
                            (msg.intentData?.comparison ===
                            "borrow"
                              ? opportunity.borrowRateBps!
                              : opportunity.supplyRateBps!) /
                            100
                          ).toFixed(2)}% annualized`}
                      {" · "}
                      {opportunity.riskTier}
                    </div>
                  ))}
              </div>
              <p className="mt-3 text-[10px] font-bold leading-relaxed">
                Point-in-time contract reads; incentives, gas
                and guaranteed returns are not assumed.
              </p>
            </div>
          )}

        {msg.intentData?.executionMode ===
          "kletia_launch_factory_v2" &&
          msg.intentData.network === "base" &&
          msg.intentData.chainId === NETWORKS.base.chainId &&
          msg.intentData.launchFactoryV2Evidence && (
            <LaunchTokenPreviewCard
              evidence={
                msg.intentData.launchFactoryV2Evidence
              }
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
          msg.intentData.action !== "portfolio" &&
          msg.intentData.executionMode !==
            "kletia_launch_factory_v2" && (
            <div className="mt-5 md:mt-6 p-4 md:p-5 bg-[#FBFAF6] dark:bg-[#121212] border-[3px] border-[#121212] dark:border-[#4A4A52] shadow-[3px_3px_0_#121212] dark:shadow-[3px_3px_0_#2A2A30] md:shadow-[4px_4px_0_#121212] dark:md:shadow-[4px_4px_0_#2A2A30] flex flex-col gap-4 w-full sm:w-80 md:w-[450px]">
              <div className="text-xs md:text-sm text-[#121212] dark:text-white font-black uppercase tracking-widest border-b-[3px] border-[#121212] dark:border-[#4A4A52] pb-2 flex items-center gap-2">
                <Zap
                  className="w-4 h-4 md:w-5 md:h-5"
                  strokeWidth={3}
                />{" "}
                Autonomous Route Finder
              </div>

              {msg.intentData.quoteCoverage &&
                msg.intentData.rankingEvidence && (
                  <div className="border-[3px] border-[#121212] bg-[#E1E8FF] p-3 text-[10px] font-bold text-[#121212]">
                    <div className="flex flex-wrap gap-2 font-black uppercase">
                      <span>
                        Sources{" "}
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
                        Eligible routes{" "}
                        {
                          msg.intentData.rankingEvidence
                            .eligibleRouteCount
                        }
                      </span>
                      <span>•</span>
                      <span>
                        Quote calls{" "}
                        {
                          msg.intentData.quoteCoverage
                            .totalAttemptedQuoteCount
                        }
                      </span>
                      <span>•</span>
                      <span>
                        {msg.intentData.rankingEvidence
                          .stage ===
                        "final_routes_after_fee_router_allowlist_and_simulation"
                          ? "Final executable ranking"
                          : "Pre-fee quoted ranking"}
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
                <div className="border-[3px] border-[#121212] bg-[#FFF36D] p-3 text-[10px] font-bold text-[#121212]">
                  <div className="font-black uppercase">
                    Live yield efficiency ·{" "}
                    {
                      msg.intentData.yieldRankingEvidence
                        .riskTolerance
                    }
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
                <div className="border-[3px] border-[#121212] bg-[#BFF7FF] p-3 text-[10px] font-bold text-[#121212]">
                  <div className="font-black uppercase">
                    Factory-bound pool evidence
                  </div>
                  <p className="mt-1">
                    Candidates{" "}
                    {
                      msg.intentData.liquidityRoutingEvidence
                        .candidateRouteCount
                    }
                    {" · "}eligible after simulation{" "}
                    {
                      msg.intentData.liquidityRoutingEvidence
                        .eligibleRouteCount
                    }
                    {" · "}snapshot block{" "}
                    {
                      msg.intentData.allRoutes?.[0]
                        ?.poolEvidence?.observedBlock
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
                <div className="border-[3px] border-[#121212] bg-[#D9F99D] p-3 text-[10px] font-bold text-[#121212]">
                  <div className="font-black uppercase">
                    Fee Router readiness
                  </div>
                  <p className="mt-1">
                    Approved candidates{" "}
                    {
                      msg.intentData.feeRouterCoverage
                        .approvedRouteCount
                    }
                    /
                    {
                      msg.intentData.feeRouterCoverage
                        .compatibleRouteCount
                    }
                    {" · "}eligible after simulation{" "}
                    {
                      msg.intentData.feeRouterCoverage
                        .eligibleRouteCount
                    }
                    {" · "}unapproved targets{" "}
                    {
                      msg.intentData.feeRouterCoverage
                        .unapprovedTargetCount
                    }
                  </p>
                </div>
              )}

              {msg.intentData.gasReadiness && (
                <div className={`border-[3px] border-[#121212] p-3 text-[10px] font-bold text-[#121212] ${msg.intentData.gasReadiness.gasAcquisitionRequired ? "bg-[#FECACA]" : "bg-[#D9F99D]"}`}>
                  <div className="font-black uppercase">Arbitrum gas readiness</div>
                  <p className="mt-1">
                    Balance {msg.intentData.gasReadiness.balanceAtomic} wei · recommended buffer {msg.intentData.gasReadiness.recommendedBufferAtomic} wei
                  </p>
                  {msg.intentData.gasReadiness.gasAcquisitionRequired ? (
                    <div className="mt-2">
                      <p className="leading-relaxed">
                        Execution is paused. Kletia will not spend USDC automatically. Prepare a separately capped Across gas step, then review it in the Base workspace.
                      </p>
                      <button
                        type="button"
                        onClick={() => void (async () => {
                          const needed =
                            BigInt(msg.intentData!.gasReadiness!.recommendedBufferAtomic) -
                            BigInt(msg.intentData!.gasReadiness!.balanceAtomic);
                          if (!(await switchNetwork("base"))) return;
                          window.setTimeout(
                            () => handleWidgetClick(
                              `Acquire exactly ${formatUnits(needed > 0n ? needed : 0n, 18)} ETH gas on Arbitrum through Across, spending at most [EDIT MAX USDC] Base USDC`,
                            ),
                            50,
                          );
                        })()}
                        className="mt-2 w-full border-2 border-[#121212] bg-[#FBFAF6] px-2 py-2 text-[9px] font-black uppercase shadow-[2px_2px_0_#121212] active:translate-y-0.5 active:shadow-none"
                      >
                        Prepare capped gas step
                      </button>
                    </div>
                  ) : null}
                </div>
              )}

              <select
                className="w-full bg-[#EFEFEF] dark:bg-slate-800 border-[3px] border-[#121212] dark:border-[#4A4A52] text-[#121212] dark:text-white font-black text-sm md:text-base p-2.5 md:p-3 outline-none focus:bg-[#2F5BFF] dark:focus:bg-[#2F5BFF] focus:text-white transition-colors cursor-pointer"
                value={msg.selectedRouteIndex ?? ""}
                onChange={(e) => {
                  if (e.target.value === "") return;
                  updateMessageForNetwork(networkMode, msg.id, {
                    selectedRouteIndex: Number(
                      e.target.value,
                    ),
                  });
                }}
                disabled={
                  msg.isLoading ||
                  !!msg.txHash ||
                  msg.intentData.gasReadiness?.gasAcquisitionRequired === true ||
                  !walletMatchesNetwork ||
                  msg.network !== networkMode ||
                  msg.chainId !== network.chainId
                }
              >
                {requiresExplicitLiquiditySelection(
                  msg.intentData,
                ) && (
                  <option value="" disabled>
                    Select LP position/protocol</option>
                )}
                {msg.intentData.allRoutes.map(
                  (route, idx) => {
                    const isSingleAction =
                      msg.intentData?.actionType?.startsWith(
                        "basename_",
                      );
                    const rankedByQuote = Boolean(
                      msg.intentData?.rankingEvidence,
                    );
                    const rankedByYield = Boolean(
                      msg.intentData?.yieldRankingEvidence,
                    );
                    let prefix =
                      requiresExplicitLiquiditySelection(
                        msg.intentData!,
                      )
                        ? "Wallet LP position:"
                        : idx === 0
                          ? rankedByYield
                            ? msg.intentData
                                ?.yieldRankingEvidence
                                ?.action === "borrow"
                              ? "Lowest live borrow rate:"
                              : "Best live yield route:"
                            : rankedByQuote
                              ? "Best quoted output:"
                              : "Primary route:"
                          : "Alternative:";
                    if (isSingleAction)
                      prefix = "Transaction Detail:";

                    return (
                      <option key={idx} value={idx}>
                        {prefix} {route.name} (
                        {route.expectedOutput ||
                          "No Estimate"}
                        )
                      </option>
                    );
                  },
                )}
              </select>

              {(() => {
                const previewIndex =
                  requiresExplicitLiquiditySelection(
                    msg.intentData!,
                  )
                    ? msg.selectedRouteIndex
                    : (msg.selectedRouteIndex ?? 0);
                const previewRoute =
                  typeof previewIndex === "number"
                    ? msg.intentData!.allRoutes?.[
                        previewIndex
                      ]
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
                  msg.intentData.gasReadiness?.gasAcquisitionRequired === true ||
                  !address ||
                  !walletMatchesNetwork ||
                  msg.network !== networkMode ||
                  msg.chainId !== network.chainId ||
                  msg.walletAddress?.toLowerCase() !==
                    address?.toLowerCase() ||
                  msg.intentData.network !== networkMode ||
                  msg.intentData.chainId !==
                    network.chainId ||
                  (requiresExplicitLiquiditySelection(
                    msg.intentData,
                  ) &&
                    msg.selectedRouteIndex === undefined)
                }
                className={`group relative w-full flex items-center justify-center gap-2 md:gap-3 text-white font-black py-3 md:py-4 border-[3px] border-[#121212] dark:border-[#4A4A52] shadow-[3px_3px_0_#121212] dark:shadow-[3px_3px_0_#2A2A30] active:translate-y-1 active:shadow-none transition-all uppercase tracking-wide text-sm md:text-base ${
                  msg.txHash
                    ? "bg-[#10B981]"
                    : msg.isLoading ||
                        msg.intentData.gasReadiness?.gasAcquisitionRequired === true ||
                        !address ||
                        !walletMatchesNetwork ||
                        msg.network !== networkMode ||
                        msg.chainId !== network.chainId ||
                        msg.walletAddress?.toLowerCase() !==
                          address?.toLowerCase() ||
                        msg.intentData.network !==
                          networkMode ||
                        msg.intentData.chainId !==
                          network.chainId ||
                        (requiresExplicitLiquiditySelection(
                          msg.intentData,
                        ) &&
                          msg.selectedRouteIndex ===
                            undefined)
                      ? "bg-gray-400 dark:bg-slate-600"
                      : "bg-[#2F5BFF] hover:bg-blue-700"
                }`}
              >
                {msg.isLoading ? (
                  <Loader2
                    className="w-5 h-5 md:w-6 md:h-6 animate-spin"
                    strokeWidth={4}
                  />
                ) : msg.txHash ? (
                  <CheckCircle2
                    className="w-5 h-5 md:w-6 md:h-6"
                    strokeWidth={4}
                  />
                ) : (
                  <Zap
                    className="w-5 h-5 md:w-6 md:h-6"
                    strokeWidth={4}
                  />
                )}
                {msg.isLoading
                  ? "System Processing"
                  : msg.txHash
                    ? (msg.network ?? networkMode) === "arc"
                      ? "Final on Arc"
                      : `Included on ${getNetwork(msg.network ?? networkMode).shortName}`
                    : "Execute Route"}
              </button>
            </div>
          )}

        <TerminalLogs msg={msg} />
      </div>

      {msg.role === "user" && (
        <div className="flex h-9 w-9 shrink-0 items-center justify-center border-[3px] border-[#121212] bg-[#2F5BFF] shadow-[3px_3px_0_#121212] dark:border-[#4A4A52] dark:shadow-[3px_3px_0_#2A2A30] sm:h-10 sm:w-10 md:h-12 md:w-12">
          <User
            className="w-5 h-5 md:w-6 md:h-6 text-white"
            strokeWidth={4}
          />
        </div>
      )}
    </div>
  );
}
