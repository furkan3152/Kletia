/**
 * What every part of the desk can ask the desk to do, without reaching into
 * its siblings: fill the composer (with a tool's engine pin or a follow-up's
 * departure), open a view or a tool, open a wallet's connect flow, and start
 * a network-engine task. DeskApp provides it.
 */
import { createContext, useContext } from "react";
import type { NetworkKey } from "@kletia/core";

import type { DeskView, LegacyNetwork } from "../state/deskModel";
import type { HoldingsSnapshot } from "../state/holdings";
import type { DeskAccounts } from "../hooks/useDeskAccounts";

export interface DeskActions {
  /** Puts a sentence in the composer (nothing is sent). */
  fill(text: string, options?: { readonly engine?: LegacyNetwork | null; readonly departure?: NetworkKey }): void;
  openView(view: DeskView, toolId?: string | null): void;
  openWallet(namespace: "eip155" | "solana"): void;
  /** A task planned by a network engine right away (Holdings scans, the engine offer). */
  startEngineTask(sentence: string, network: LegacyNetwork, why: "tool" | "offer"): void;
  /** Sets the next task's departure ("Start here", "Continue from Solana"). */
  setDeparture(network: NetworkKey): void;
  readonly holdings: HoldingsSnapshot | null;
  readonly accounts: DeskAccounts;
}

export const DeskActionsContext = createContext<DeskActions | null>(null);

export function useDeskActions(): DeskActions {
  const actions = useContext(DeskActionsContext);
  if (!actions) throw new Error("useDeskActions must be used inside DeskApp.");
  return actions;
}
