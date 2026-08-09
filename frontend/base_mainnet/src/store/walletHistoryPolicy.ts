import { getAddress, isAddress } from 'viem';

export const normalizeWalletHistoryOwner = (
  value: unknown,
): string | null => {
  if (typeof value !== 'string' || !isAddress(value)) return null;
  try {
    return getAddress(value);
  } catch {
    return null;
  }
};

export type WalletHistoryBinding = {
  activeOwner: string | null;
  restorePersistedHistory: boolean;
};

export const resolveWalletHistoryBinding = (
  persistedOwner: unknown,
  activeAddress: unknown,
): WalletHistoryBinding => {
  const activeOwner = normalizeWalletHistoryOwner(activeAddress);
  if (!activeOwner) {
    return {
      activeOwner: null,
      restorePersistedHistory: false,
    };
  }

  return {
    activeOwner,
    restorePersistedHistory:
      normalizeWalletHistoryOwner(persistedOwner) === activeOwner,
  };
};
