import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { ChatMessage } from '../types';
import { io, Socket } from 'socket.io-client';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';
const socket: Socket = io(BACKEND_URL);

interface AppState {
  isDarkMode: boolean;
  toggleTheme: () => void;
  isArcMode: boolean;
  toggleArcMode: () => void;
  messages: ChatMessage[];
  addMessage: (message: ChatMessage) => void;
  updateMessage: (id: string, updates: Partial<ChatMessage>) => void;
  clearMessages: () => void;
  addTerminalLog: (msgId: string, log: string) => void;
  initSocket: () => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      isDarkMode: true,
      toggleTheme: () => set((state) => ({ isDarkMode: !state.isDarkMode })),
      isArcMode: true,
      toggleArcMode: () => {},
      messages: [],
      addMessage: (message) => set((state) => ({ messages: [...state.messages, message] })),
      updateMessage: (id, updates) => set((state) => ({
        messages: state.messages.map((msg) =>
          msg.id === id ? { ...msg, ...updates } : msg
        ),
      })),
      clearMessages: () => set({ messages: [] }),
      addTerminalLog: (msgId, log) => {
        const { updateMessage, messages } = get();
        const msg = messages.find(m => m.id === msgId);
        if (msg) {
          const logs = msg.terminalLogs || [];
          updateMessage(msgId, { terminalLogs: [...logs, log] });
        }
      },
      initSocket: () => {
        socket.off('agentLog');
        socket.on('agentLog', (data: { userAddress: string; log: string; msgId?: string }) => {

           const { addTerminalLog, messages } = get();

           const targetMsgId = data.msgId || (messages.length > 0 ? messages[messages.length - 1].id : null);
           if (targetMsgId) {
             addTerminalLog(targetMsgId, data.log);
           }
        });
      }
    }),
    {
      name: 'kletia-storage',
      partialize: (state) => ({ isDarkMode: state.isDarkMode, messages: state.messages }),
    }
  )
);
