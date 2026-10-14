/**
 * A network-engine task in the desk (console design 3.7): the wrong-chain bar
 * and the task's messages, without the first user bubble (the ticket prints
 * the sentence). The bar appears only while an EVM wallet is connected and on
 * another chain; its button asks the wallet to switch to the engine's
 * network. Execution is refused on the wrong chain whatever the bar shows
 * (the engine's executeRoute and the executor check the chain again).
 *
 * `LegacyEngineHost` owns one engine per network and hands it to its task
 * bodies; `LegacyEngineControls` shows that engine's pending AI-consent
 * decision and its natural-language session.
 */
import React, { useState } from "react";
import { CHAINS, resolveChain } from "@kletia/core";
import { useAccount, useSwitchChain } from "wagmi";

import { NETWORKS, type NetworkMode } from "../../../shared/config/networks";
import { IntentPrivacyDecisionCard } from "../../../shared/components/chat/IntentPrivacyDecisionCard";
import type { ChatMessage } from "../../../shared/types";
import { DESK_COPY } from "../content/copy";
import { LegacyMessageRow } from "./LegacyMessageBody";
import { useLegacyEngine, type LegacyEngine, type LegacyEngineOptions } from "./useLegacyEngine";

/** The task's messages without the opening user bubble. */
function taskThreadMessages(messages: readonly ChatMessage[]): readonly ChatMessage[] {
  return messages[0]?.role === "user" ? messages.slice(1) : messages;
}

/** Name of the chain an EVM wallet is on, from the registry ("OP Mainnet"); null when unknown. */
function walletChainName(chainId: number): string | null {
  return resolveChain(chainId)?.name ?? null;
}

export interface LegacyTaskBodyProps {
  readonly engine: LegacyEngine;
  /** The task's messages, oldest first (the host selects the task's thread). */
  readonly messages: readonly ChatMessage[];
  /** Fills the composer with a sentence for this engine. */
  readonly onPrompt: (prompt: string) => void;
  /** Funds the wallet for a `[SHOW_ONRAMP]` message; without it the button does nothing. */
  readonly onFund?: (targetAddress: string, event: React.MouseEvent) => void;
}

export function LegacyTaskBody({ engine, messages, onPrompt, onFund }: LegacyTaskBodyProps) {
  const { isConnected } = useAccount();
  const { switchChainAsync, isPending } = useSwitchChain();
  const [switchFailed, setSwitchFailed] = useState(false);
  const copy = DESK_COPY.engine;
  const taskNetwork = CHAINS[engine.network].name;
  const wrongChain = isConnected && !engine.walletMatchesNetwork;

  // Chains are limited to the wagmi config; a refusal leaves the wallet where it is.
  const switchNetwork = async (mode: NetworkMode): Promise<boolean> => {
    setSwitchFailed(false);
    try {
      const switched = await switchChainAsync({ chainId: NETWORKS[mode].chainId });
      return switched.id === NETWORKS[mode].chainId;
    } catch {
      setSwitchFailed(true);
      return false;
    }
  };
  const fund = onFund ?? ((_address: string, event: React.MouseEvent) => event.preventDefault());

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {wrongChain ? (
        <div role="status" className="flex flex-wrap items-center justify-between gap-3 border-[3px] border-[#1A1A1A] bg-[#FFD60A] p-3 text-sm font-bold text-[#1A1A1A]">
          <span className="min-w-0">
            {copy.wrongChain(walletChainName(engine.walletChainId) ?? copy.unknownChain, taskNetwork)}
            {switchFailed ? <span className="block">{copy.switchFailed}</span> : null}
          </span>
          <button
            type="button"
            disabled={isPending}
            onClick={() => void switchNetwork(engine.network)}
            className="min-h-11 border-[3px] border-[#1A1A1A] bg-white px-3 text-xs font-black uppercase shadow-[2px_2px_0_#1A1A1A] focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#0052FF] disabled:cursor-wait disabled:opacity-60"
          >
            {isPending ? copy.switching : copy.switchTo(taskNetwork)}
          </button>
        </div>
      ) : null}
      <div className="space-y-5 sm:space-y-6">
        {taskThreadMessages(messages).map((msg) => (
          <LegacyMessageRow
            key={msg.id}
            msg={msg}
            engine={engine}
            onPrompt={onPrompt}
            onFund={fund}
            switchNetwork={switchNetwork}
            inlinePortfolio
          />
        ))}
      </div>
    </div>
  );
}

/** The engine's pending AI-consent decision and its natural-language session, as the old chat showed them. */
export function LegacyEngineControls({ engine }: { readonly engine: LegacyEngine }) {
  return (
    <>
      {engine.pendingPrivacyDecision ? (
        <IntentPrivacyDecisionCard
          decision={engine.pendingPrivacyDecision.decision}
          busy={false}
          onSelect={engine.handlePrivacyDecisionSelection}
        />
      ) : null}
      {engine.activeSemanticAiSession ? (
        <div className="flex w-full items-center justify-between gap-3 text-[10px] font-black uppercase">
          <span className="border-2 border-[#1A1A1A] bg-[#EDE7FF] px-2 py-1 text-[#4F2A9B] dark:border-[#64748B] dark:bg-[#231C3D] dark:text-[#D8CCFF]">
            Natural language on · this tab · expires automatically
          </span>
          <button
            type="button"
            onClick={engine.turnOffSemanticSession}
            className="min-h-8 border-2 border-[#1A1A1A] bg-white px-2 py-1 text-[#1A1A1A] shadow-[2px_2px_0_#1A1A1A] dark:border-[#64748B] dark:bg-[#1A2841] dark:text-white dark:shadow-[2px_2px_0_#475569]"
          >
            Turn off
          </button>
        </div>
      ) : null}
    </>
  );
}

export interface LegacyEngineHostProps extends LegacyEngineOptions {
  /** Renders the engine's tasks; the engine is one instance for the network. */
  readonly children: (engine: LegacyEngine) => React.ReactNode;
}

/**
 * Owns one network engine (one instance per engine network) inside the lazily
 * loaded engine chunk and renders whatever the host needs with it, so the
 * desk's own chunk never imports the engines.
 */
export function LegacyEngineHost({ children, ...options }: LegacyEngineHostProps) {
  const engine = useLegacyEngine(options);
  return <>{children(engine)}</>;
}
