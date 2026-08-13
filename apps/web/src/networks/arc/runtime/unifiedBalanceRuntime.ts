import { getAddress, isAddress, parseUnits, type Address } from "viem";

const ARC_CHAIN_ID = 5_042_002;
const USDC_AMOUNT = /^\d+(?:\.\d{1,6})?$/;
const TRANSACTION_ID = /^[A-Za-z0-9:_-]{16,160}$/;

export type ArcUnifiedBalancePendingTransaction = {
  transactionHash: string;
  amount: string;
  blockTimestamp: string;
};

export type ArcUnifiedBalanceChain = {
  chain: string;
  confirmedBalance: string;
  pendingBalance: string;
  pendingTransactions: ArcUnifiedBalancePendingTransaction[];
};

export type ArcUnifiedBalanceAccount = {
  depositor: Address;
  totalConfirmed: string;
  totalPending: string;
  chains: ArcUnifiedBalanceChain[];
};

export type ArcUnifiedBalanceSnapshot = {
  provider: "Circle Gateway via App Kit";
  networkType: "testnet";
  token: "USDC";
  account: Address;
  totalConfirmedBalance: string;
  totalPendingBalance: string;
  accounts: ArcUnifiedBalanceAccount[];
  observedAt: string;
};

function assertUsdcAmount(
  value: unknown,
  field: string,
): asserts value is string {
  if (typeof value !== "string" || !USDC_AMOUNT.test(value)) {
    throw new Error(`${field} is not a valid USDC amount.`);
  }
}

const usdcUnits = (value: string): bigint => parseUnits(value, 6);

function assertTimestamp(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error("Gateway pending transaction timestamp is invalid.");
  }
}

function assertTransactionId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !TRANSACTION_ID.test(value)) {
    throw new Error("Gateway pending transaction ID is invalid.");
  }
}

export async function readArcUnifiedUsdcBalance(
  account: string,
  activeChainId: number,
): Promise<ArcUnifiedBalanceSnapshot> {
  if (activeChainId !== ARC_CHAIN_ID) {
    throw new Error(
      "Unified Balance can only be queried in an active Arc Testnet session.",
    );
  }
  if (!isAddress(account)) {
    throw new Error("Unified Balance account is not a valid EVM address.");
  }
  const expectedAccount = getAddress(account);
  const { AppKit } = await import("@circle-fin/app-kit");
  const kit = new AppKit({
    disableErrorReporting: true,
  });

  const supportedTestnetChains = new Set(
    kit.unifiedBalance
      .getSupportedChains("USDC")
      .filter((chain) => chain.isTestnet)
      .map((chain) => String(chain.chain)),
  );
  if (!supportedTestnetChains.has("Arc_Testnet")) {
    throw new Error(
      "Installed Circle App Kit does not support Arc Testnet Gateway.",
    );
  }

  const raw = await kit.unifiedBalance.getBalances({
    token: "USDC",
    sources: { address: expectedAccount },
    includePending: true,

    networkType: "testnet",
  });

  if (raw.token !== "USDC") {
    throw new Error("Circle Gateway returned an unexpected token.");
  }
  assertUsdcAmount(raw.totalConfirmedBalance, "Total confirmed balance");
  const totalPendingBalance = raw.totalPendingBalance ?? "0";
  assertUsdcAmount(totalPendingBalance, "Toplam bekleyen bakiye");

  const accounts = raw.breakdown.map((entry): ArcUnifiedBalanceAccount => {
    if (
      !isAddress(entry.depositor) ||
      getAddress(entry.depositor) !== expectedAccount
    ) {
      throw new Error("Circle Gateway response does not match the active account.");
    }
    assertUsdcAmount(entry.totalConfirmed, "Account confirmed balance");
    const totalPending = entry.totalPending ?? "0";
    assertUsdcAmount(totalPending, "Hesap bekleyen bakiyesi");

    const chains = entry.breakdown.map((chain): ArcUnifiedBalanceChain => {
      const chainName = String(chain.chain);
      if (!supportedTestnetChains.has(chainName)) {
        throw new Error(
          `Circle Gateway testnet sorgusunda izin verilmeyen zincir: ${chainName}`,
        );
      }
      assertUsdcAmount(
        chain.confirmedBalance,
        `${chainName} confirmed balance`,
      );
      const pendingBalance = chain.pendingBalance ?? "0";
      assertUsdcAmount(pendingBalance, `${chainName} bekleyen bakiye`);
      const pendingTransactions = (chain.pendingTransactions ?? []).map(
        (transaction): ArcUnifiedBalancePendingTransaction => {
          assertTransactionId(transaction.transactionHash);
          assertUsdcAmount(transaction.amount, "Pending transaction amount");
          assertTimestamp(transaction.blockTimestamp);
          return {
            transactionHash: transaction.transactionHash,
            amount: transaction.amount,
            blockTimestamp: transaction.blockTimestamp,
          };
        },
      );
      return {
        chain: chainName,
        confirmedBalance: chain.confirmedBalance,
        pendingBalance,
        pendingTransactions,
      };
    });
    if (
      chains.reduce(
        (total, chain) => total + usdcUnits(chain.confirmedBalance),
        0n,
      ) !== usdcUnits(entry.totalConfirmed) ||
      chains.reduce(
        (total, chain) => total + usdcUnits(chain.pendingBalance),
        0n,
      ) !== usdcUnits(totalPending)
    ) {
      throw new Error("Circle Gateway chain balance totals are inconsistent.");
    }

    return {
      depositor: expectedAccount,
      totalConfirmed: entry.totalConfirmed,
      totalPending,
      chains,
    };
  });
  if (
    accounts.reduce(
      (total, entry) => total + usdcUnits(entry.totalConfirmed),
      0n,
    ) !== usdcUnits(raw.totalConfirmedBalance) ||
    accounts.reduce(
      (total, entry) => total + usdcUnits(entry.totalPending),
      0n,
    ) !== usdcUnits(totalPendingBalance)
  ) {
    throw new Error("Circle Gateway account balance totals are inconsistent.");
  }

  return {
    provider: "Circle Gateway via App Kit",
    networkType: "testnet",
    token: "USDC",
    account: expectedAccount,
    totalConfirmedBalance: raw.totalConfirmedBalance,
    totalPendingBalance,
    accounts,
    observedAt: new Date().toISOString(),
  };
}
