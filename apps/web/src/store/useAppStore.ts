import { create } from "zustand";
import { persist } from "zustand/middleware";

import {
  getNetwork,
  isNetworkMode,
  type NetworkMode,
} from "../config/networks";
import type { ChatMessage } from "../types";
import {
  normalizeWalletHistoryOwner,
  resolveWalletHistoryBinding,
} from "./walletHistoryPolicy";

const STORE_VERSION = 3;

type MessagesByNetwork = Record<NetworkMode, ChatMessage[]>;

interface PersistedAppState {
  isDarkMode: boolean;
  activeNetwork: NetworkMode;
  historyOwner: string | null;
  messagesByNetwork: MessagesByNetwork;
}

interface AppState {
  isDarkMode: boolean;
  toggleTheme: () => void;
  activeNetwork: NetworkMode;
  setActiveNetwork: (network: NetworkMode) => void;
  isArcMode: boolean;
  historyOwner: string | null;
  pendingMessagesByNetwork: MessagesByNetwork;
  messagesByNetwork: MessagesByNetwork;
  messages: ChatMessage[];
  addMessage: (message: ChatMessage) => void;
  updateMessage: (id: string, updates: Partial<ChatMessage>) => void;
  updateMessageForNetwork: (
    network: NetworkMode,
    id: string,
    updates: Partial<ChatMessage>,
  ) => void;
  clearMessages: () => void;
  clearAllMessages: () => void;
  bindWalletHistory: (address?: string) => void;
  addTerminalLog: (msgId: string, log: string) => void;
  addTerminalLogForNetwork: (
    network: NetworkMode,
    msgId: string,
    log: string,
  ) => void;
}

const createEmptyMessageBuckets = (): MessagesByNetwork => ({
  base: [],
  arc: [],
});

const toSafePersistedMessage = (
  message: ChatMessage,
  network: NetworkMode,
  historyOwner?: string | null,
): ChatMessage => ({
  id: message.id,
  role: message.role,
  text: message.text,
  widgetType: message.widgetType,
  network,
  chainId: getNetwork(network).chainId,
  walletAddress:
    historyOwner ??
    normalizeWalletHistoryOwner(message.walletAddress) ??
    undefined,
  requestId: message.requestId,
});

const readPersistedMessages = (
  value: unknown,
  network: NetworkMode,
  historyOwner?: string | null,
): ChatMessage[] => {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry): ChatMessage[] => {
    if (!entry || typeof entry !== "object") return [];

    const message = entry as Partial<ChatMessage>;
    if (
      typeof message.id !== "string" ||
      (message.role !== "user" && message.role !== "kletia") ||
      typeof message.text !== "string"
    ) {
      return [];
    }

    return [
      toSafePersistedMessage(
        {
          id: message.id,
          role: message.role,
          text: message.text,
          widgetType: message.widgetType,
          walletAddress: message.walletAddress,
          requestId: message.requestId,
        },
        network,
        historyOwner,
      ),
    ];
  });
};

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      isDarkMode: true,
      toggleTheme: () => set((state) => ({ isDarkMode: !state.isDarkMode })),
      activeNetwork: "base",
      isArcMode: false,
      historyOwner: null,
      pendingMessagesByNetwork: createEmptyMessageBuckets(),
      messagesByNetwork: createEmptyMessageBuckets(),
      messages: [],

      setActiveNetwork: (network) => {
        set((state) => ({
          activeNetwork: network,
          isArcMode: network === "arc",
          messages: state.messagesByNetwork[network],
        }));
      },

      addMessage: (message) =>
        set((state) => {
          const network =
            message.network && isNetworkMode(message.network)
              ? message.network
              : state.activeNetwork;
          const taggedMessage: ChatMessage = {
            ...message,
            network,
            chainId: message.chainId ?? getNetwork(network).chainId,
          };
          const networkMessages = [
            ...state.messagesByNetwork[network],
            taggedMessage,
          ];

          return {
            messagesByNetwork: {
              ...state.messagesByNetwork,
              [network]: networkMessages,
            },
            messages:
              network === state.activeNetwork
                ? networkMessages
                : state.messages,
          };
        }),

      updateMessageForNetwork: (network, id, updates) =>
        set((state) => {
          const networkMessages = state.messagesByNetwork[network].map(
            (message) =>
              message.id === id
                ? {
                    ...message,
                    ...updates,
                    network,
                    chainId: getNetwork(network).chainId,
                  }
                : message,
          );

          return {
            messagesByNetwork: {
              ...state.messagesByNetwork,
              [network]: networkMessages,
            },
            messages:
              network === state.activeNetwork
                ? networkMessages
                : state.messages,
          };
        }),

      updateMessage: (id, updates) => {
        const state = get();
        state.updateMessageForNetwork(state.activeNetwork, id, updates);
      },

      clearMessages: () =>
        set((state) => ({
          messagesByNetwork: {
            ...state.messagesByNetwork,
            [state.activeNetwork]: [],
          },
          messages: [],
        })),

      clearAllMessages: () =>
        set({
          historyOwner: null,
          pendingMessagesByNetwork: createEmptyMessageBuckets(),
          messagesByNetwork: createEmptyMessageBuckets(),
          messages: [],
        }),

      bindWalletHistory: (address) =>
        set((state) => {
          const binding = resolveWalletHistoryBinding(
            state.historyOwner,
            address,
          );
          if (!binding.activeOwner) {
            return {
              historyOwner: null,
              pendingMessagesByNetwork: createEmptyMessageBuckets(),
              messagesByNetwork: createEmptyMessageBuckets(),
              messages: [],
            };
          }

          if (binding.restorePersistedHistory) {
            const restored = state.pendingMessagesByNetwork;
            if (restored.base.length > 0 || restored.arc.length > 0) {
              return {
                historyOwner: binding.activeOwner,
                pendingMessagesByNetwork: createEmptyMessageBuckets(),
                messagesByNetwork: restored,
                messages: restored[state.activeNetwork],
              };
            }
          }

          if (state.historyOwner === binding.activeOwner) {
            return { historyOwner: binding.activeOwner };
          }

          return {
            historyOwner: binding.activeOwner,
            pendingMessagesByNetwork: createEmptyMessageBuckets(),
            messagesByNetwork: createEmptyMessageBuckets(),
            messages: [],
          };
        }),

      addTerminalLog: (msgId, log) => {
        const state = get();
        state.addTerminalLogForNetwork(state.activeNetwork, msgId, log);
      },

      addTerminalLogForNetwork: (network, msgId, log) => {
        const state = get();
        const message = state.messagesByNetwork[network].find(
          (item) => item.id === msgId,
        );
        if (!message) return;

        state.updateMessageForNetwork(network, msgId, {
          terminalLogs: [...(message.terminalLogs ?? []), log],
        });
      },
    }),
    {
      name: "kletia-storage",
      version: STORE_VERSION,
      partialize: (state): PersistedAppState => ({
        isDarkMode: state.isDarkMode,
        activeNetwork: state.activeNetwork,
        historyOwner: state.historyOwner,
        messagesByNetwork: {
          base: state.historyOwner
            ? state.messagesByNetwork.base.map((message) =>
                toSafePersistedMessage(message, "base", state.historyOwner),
              )
            : [],
          arc: state.historyOwner
            ? state.messagesByNetwork.arc.map((message) =>
                toSafePersistedMessage(message, "arc", state.historyOwner),
              )
            : [],
        },
      }),
      migrate: (persistedState, version): PersistedAppState => {
        const persisted =
          persistedState && typeof persistedState === "object"
            ? (persistedState as Record<string, unknown>)
            : {};
        const legacyNetwork = persisted.isArcMode === true ? "arc" : "base";
        const activeNetwork = isNetworkMode(persisted.activeNetwork)
          ? persisted.activeNetwork
          : legacyNetwork;

        if (version < STORE_VERSION) {
          return {
            isDarkMode:
              typeof persisted.isDarkMode === "boolean"
                ? persisted.isDarkMode
                : true,
            activeNetwork,
            historyOwner: null,
            messagesByNetwork: createEmptyMessageBuckets(),
          };
        }

        const persistedBuckets =
          persisted.messagesByNetwork &&
          typeof persisted.messagesByNetwork === "object"
            ? (persisted.messagesByNetwork as Record<string, unknown>)
            : {};

        const historyOwner = normalizeWalletHistoryOwner(
          persisted.historyOwner,
        );
        return {
          isDarkMode:
            typeof persisted.isDarkMode === "boolean"
              ? persisted.isDarkMode
              : true,
          activeNetwork,
          historyOwner,
          messagesByNetwork: {
            base: historyOwner
              ? readPersistedMessages(
                  persistedBuckets.base,
                  "base",
                  historyOwner,
                )
              : [],
            arc: historyOwner
              ? readPersistedMessages(persistedBuckets.arc, "arc", historyOwner)
              : [],
          },
        };
      },
      merge: (persistedState, currentState): AppState => {
        if (!persistedState || typeof persistedState !== "object") {
          return currentState;
        }

        const persisted = persistedState as Partial<PersistedAppState>;
        const activeNetwork = isNetworkMode(persisted.activeNetwork)
          ? persisted.activeNetwork
          : "base";
        const persistedBuckets = persisted.messagesByNetwork;
        const historyOwner = normalizeWalletHistoryOwner(
          persisted.historyOwner,
        );
        const pendingMessagesByNetwork: MessagesByNetwork = historyOwner
          ? {
              base: readPersistedMessages(
                persistedBuckets?.base,
                "base",
                historyOwner,
              ),
              arc: readPersistedMessages(
                persistedBuckets?.arc,
                "arc",
                historyOwner,
              ),
            }
          : createEmptyMessageBuckets();
        const messagesByNetwork = createEmptyMessageBuckets();

        return {
          ...currentState,
          isDarkMode:
            typeof persisted.isDarkMode === "boolean"
              ? persisted.isDarkMode
              : currentState.isDarkMode,
          activeNetwork,
          isArcMode: activeNetwork === "arc",
          historyOwner,
          pendingMessagesByNetwork,
          messagesByNetwork,
          messages: [],
        };
      },
    },
  ),
);
