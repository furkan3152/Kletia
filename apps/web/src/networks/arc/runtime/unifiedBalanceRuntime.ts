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
    throw new Error(`${field} geçerli bir USDC miktarı değil.`);
  }
}

const usdcUnits = (value: string): bigint => parseUnits(value, 6);

function assertTimestamp(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error("Gateway bekleyen işlem zamanı geçersiz.");
  }
}

function assertTransactionId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !TRANSACTION_ID.test(value)) {
    throw new Error("Gateway bekleyen işlem kimliği geçersiz.");
  }
}

export async function readArcUnifiedUsdcBalance(
  account: string,
  activeChainId: number,
): Promise<ArcUnifiedBalanceSnapshot> {
  if (activeChainId !== ARC_CHAIN_ID) {
    throw new Error(
      "Unified Balance yalnızca aktif Arc Testnet oturumunda sorgulanabilir.",
    );
  }
  if (!isAddress(account)) {
    throw new Error("Unified Balance hesabı geçerli bir EVM adresi değil.");
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
      "Kurulu Circle App Kit Arc Testnet Gateway desteği sunmuyor.",
    );
  }

  const raw = await kit.unifiedBalance.getBalances({
    token: "USDC",
    sources: { address: expectedAccount },
    includePending: true,

    networkType: "testnet",
  });

  if (raw.token !== "USDC") {
    throw new Error("Circle Gateway beklenmeyen bir token döndürdü.");
  }
  assertUsdcAmount(raw.totalConfirmedBalance, "Toplam doğrulanmış bakiye");
  const totalPendingBalance = raw.totalPendingBalance ?? "0";
  assertUsdcAmount(totalPendingBalance, "Toplam bekleyen bakiye");

  const accounts = raw.breakdown.map((entry): ArcUnifiedBalanceAccount => {
    if (
      !isAddress(entry.depositor) ||
      getAddress(entry.depositor) !== expectedAccount
    ) {
      throw new Error("Circle Gateway yanıtı aktif hesapla eşleşmiyor.");
    }
    assertUsdcAmount(entry.totalConfirmed, "Hesap doğrulanmış bakiyesi");
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
        `${chainName} doğrulanmış bakiye`,
      );
      const pendingBalance = chain.pendingBalance ?? "0";
      assertUsdcAmount(pendingBalance, `${chainName} bekleyen bakiye`);
      const pendingTransactions = (chain.pendingTransactions ?? []).map(
        (transaction): ArcUnifiedBalancePendingTransaction => {
          assertTransactionId(transaction.transactionHash);
          assertUsdcAmount(transaction.amount, "Bekleyen işlem miktarı");
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
      throw new Error("Circle Gateway zincir bakiye toplamları tutarsız.");
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
    throw new Error("Circle Gateway hesap bakiye toplamları tutarsız.");
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
