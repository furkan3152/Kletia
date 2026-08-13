import React from "react";
import { Shield, AlertTriangle, DollarSign, Coins } from "lucide-react";
import { ethers } from "ethers";
import {
  useAccount,
  useBalance,
  useChainId,
  useReadContract,
  useReadContracts,
} from "wagmi";
import {
  ARC_CONTRACTS,
  ARC_SWAP_ABI,
  ARC_LENDING_ABI,
} from "../../networks/arc/config";
import { NETWORKS } from "../../config/networks";

const ARC_CHAIN_ID = NETWORKS.arc.chainId;

interface LendingDashboardProps {
  isDarkMode: boolean;
  onActionClick: (prompt: string) => void;
}

export const ArcLendingDashboard: React.FC<LendingDashboardProps> = ({
  onActionClick,
}) => {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const isArcConnected = isConnected && chainId === ARC_CHAIN_ID;
  const balance = useBalance({ address, chainId: ARC_CHAIN_ID });
  const { data: kletRawBalance, isError: isKletBalanceError } = useReadContract(
    {
      address: ARC_CONTRACTS.Token as `0x${string}`,
      abi: [
        {
          inputs: [
            { internalType: "address", name: "account", type: "address" },
          ],
          name: "balanceOf",
          outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
          stateMutability: "view",
          type: "function",
        },
      ],
      functionName: "balanceOf",
      args: address ? [address] : undefined,
      chainId: ARC_CHAIN_ID,
      query: { enabled: Boolean(address) },
    },
  );

  const {
    data: swapReserves,
    isError: isPriceReadError,
    isPending: isPriceReadPending,
  } = useReadContracts({
    contracts: [
      {
        address: ARC_CONTRACTS.Swap as `0x${string}`,
        abi: ARC_SWAP_ABI,
        functionName: "usdcReserve",
        chainId: ARC_CHAIN_ID,
      },
      {
        address: ARC_CONTRACTS.Swap as `0x${string}`,
        abi: ARC_SWAP_ABI,
        functionName: "tokenReserve",
        chainId: ARC_CHAIN_ID,
      },
    ],
  });

  const kletPrice = React.useMemo(() => {
    if (
      !swapReserves ||
      swapReserves[0]?.status !== "success" ||
      swapReserves[1]?.status !== "success"
    ) {
      return null;
    }
    const usdc = swapReserves[0].result as bigint;
    const klet = swapReserves[1].result as bigint;
    if (klet <= 0n) return null;
    return Number(ethers.formatEther((usdc * 10n ** 18n) / klet));
  }, [swapReserves]);

  const { data: collateralBig, isError: isCollateralReadError } =
    useReadContract({
      address: ARC_CONTRACTS.Lending as `0x${string}`,
      abi: ARC_LENDING_ABI,
      functionName: "collateralBalance",
      args: [address || "0x0000000000000000000000000000000000000000"],
      chainId: ARC_CHAIN_ID,
      query: { enabled: Boolean(address) },
    });

  const { data: borrowedBig, isError: isBorrowedReadError } = useReadContract({
    address: ARC_CONTRACTS.Lending as `0x${string}`,
    abi: ARC_LENDING_ABI,
    functionName: "getBorrowedBalance",
    args: [address || "0x0000000000000000000000000000000000000000"],
    chainId: ARC_CHAIN_ID,
    query: { enabled: Boolean(address) },
  });

  const { data: ltvBips, isError: isLtvReadError } = useReadContract({
    address: ARC_CONTRACTS.Lending as `0x${string}`,
    abi: ARC_LENDING_ABI,
    functionName: "LTV_BIPS",
    chainId: ARC_CHAIN_ID,
  });

  const { data: healthFactorRaw, isError: isHealthReadError } = useReadContract(
    {
      address: ARC_CONTRACTS.Lending as `0x${string}`,
      abi: ARC_LENDING_ABI,
      functionName: "healthFactor",
      args: [address || "0x0000000000000000000000000000000000000000"],
      chainId: ARC_CHAIN_ID,
      query: { enabled: Boolean(address) },
    },
  );

  const collateral =
    collateralBig === undefined
      ? null
      : Number(ethers.formatEther(collateralBig as bigint));
  const borrowed =
    borrowedBig === undefined
      ? null
      : Number(ethers.formatEther(borrowedBig as bigint));

  const colUsdValue =
    collateral === null || kletPrice === null ? null : collateral * kletPrice;
  const ltvPercent = ltvBips === undefined ? null : Number(ltvBips) / 100;
  const maxBorrowUsd =
    ltvPercent === null || colUsdValue === null
      ? null
      : colUsdValue * (ltvPercent / 100);
  const healthFactor =
    healthFactorRaw === undefined
      ? null
      : Number(ethers.formatEther(healthFactorRaw as bigint));
  const isHealthy = healthFactor !== null && healthFactor >= 1;
  const hasReadError =
    isHealthReadError ||
    isPriceReadError ||
    isCollateralReadError ||
    isBorrowedReadError ||
    isLtvReadError;
  const protocolStatus = hasReadError
    ? "UNAVAILABLE"
    : !isConnected
      ? "CONNECT WALLET"
      : !isArcConnected
        ? "SWITCH TO ARC"
        : borrowed === null
          ? "CHECKING"
          : borrowed === 0
            ? "NO DEBT"
            : isHealthy
              ? "HEALTHY"
              : "AT RISK";

  return (
    <div className="w-full max-w-7xl mx-auto space-y-8 p-4 md:p-8 animate-fade-in pb-20">
      <div className="bg-[#0052FF] border-[4px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[8px_8px_0_#1A1A1A] dark:shadow-[8px_8px_0_#475569] p-6 md:p-10 flex flex-col lg:flex-row gap-8 justify-between relative overflow-hidden">
        <div className="absolute -right-10 -top-10 w-40 h-40 bg-white border-[4px] border-[#1A1A1A] rotate-12 opacity-20 pointer-events-none"></div>
        <div className="absolute right-40 -bottom-10 w-24 h-24 rounded-full bg-[#10B981] border-[4px] border-[#1A1A1A] pointer-events-none"></div>

        <div className="z-10 flex flex-col gap-4 max-w-2xl">
          <div className="inline-block bg-white text-[#1A1A1A] border-[3px] border-[#1A1A1A] font-black uppercase tracking-widest text-xs px-3 py-1 shadow-[3px_3px_0_#1A1A1A] w-max">
            KLETIA LENDING PROTOCOL
          </div>
          <h2 className="text-4xl md:text-6xl font-black text-white tracking-tight uppercase leading-none drop-shadow-[4px_4px_0_#1A1A1A]">
            KLETIA LENDING
          </h2>
          <p className="text-lg md:text-xl font-bold text-white bg-[#1A1A1A] p-2 inline-block shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] w-max">
            Built on Arc Testnet — live on-chain risk and lending data
          </p>

          <div className="flex flex-wrap gap-4 mt-6">
            <div className="bg-white border-[3px] border-[#1A1A1A] p-4 shadow-[4px_4px_0_#1A1A1A] min-w-[140px]">
              <span className="text-xs font-black text-gray-500 uppercase block mb-1">
                KLET Price
              </span>
              <span className="text-xl font-black text-[#1A1A1A] flex items-center gap-2">
                {isPriceReadPending
                  ? "Checking…"
                  : kletPrice === null
                    ? "Unavailable"
                    : `$${kletPrice.toFixed(8)}`}{" "}
                <span className="text-xs text-[#10B981] bg-[#D1FAE5] px-2 py-0.5 border-[2px] border-[#10B981]">
                  USDC
                </span>
              </span>
            </div>
            <div className="bg-white border-[3px] border-[#1A1A1A] p-4 shadow-[4px_4px_0_#1A1A1A] min-w-[140px]">
              <div className="flex flex-col">
                <span className="text-xs font-black text-gray-500 uppercase block mb-1">
                  Protocol Status
                </span>
                <span
                  className={`text-2xl font-black flex items-center gap-2 ${protocolStatus === "AT RISK" || protocolStatus === "UNAVAILABLE" ? "text-[#EF4444]" : "text-[#10B981]"}`}
                >
                  <span
                    className={`w-3 h-3 border-[2px] border-[#1A1A1A] rounded-full ${protocolStatus === "AT RISK" || protocolStatus === "UNAVAILABLE" ? "bg-[#EF4444]" : "bg-[#10B981] animate-pulse"}`}
                  ></span>
                  {protocolStatus}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="z-10 bg-white dark:bg-[#0F172A] border-[4px] border-[#1A1A1A] shadow-[6px_6px_0_#1A1A1A] p-6 lg:min-w-[300px] flex flex-col justify-center">
          <div className="mb-4">
            <span className="text-xs font-black text-gray-500 uppercase block mb-1">
              Balance
            </span>
            <div className="text-4xl font-black text-[#1A1A1A] dark:text-white flex items-end gap-2">
              {isArcConnected && balance.data
                ? Number(ethers.formatEther(balance.data.value)).toFixed(6)
                : "—"}
              <span className="text-lg text-[#3B82F6] mb-1">USDC</span>
            </div>
            <div className="text-xl font-bold text-gray-600 dark:text-gray-400 mt-2 flex items-center gap-2">
              {isArcConnected &&
              !isKletBalanceError &&
              kletRawBalance !== undefined
                ? Number(ethers.formatEther(kletRawBalance as bigint)).toFixed(
                    6,
                  )
                : "—"}
              <span className="text-sm text-[#8B5CF6] font-black">KLET</span>
            </div>
          </div>
          <div className="pt-4 border-t-[3px] border-[#1A1A1A] dark:border-slate-700 flex items-center gap-2">
            <div
              className={`w-4 h-4 border-[2px] border-[#1A1A1A] ${isArcConnected ? "bg-[#10B981]" : "bg-[#EF4444]"}`}
            ></div>
            <span className="font-black text-[#1A1A1A] dark:text-white uppercase text-sm">
              {isArcConnected
                ? "ARC WALLET CONNECTED"
                : isConnected
                  ? "WRONG NETWORK"
                  : "NOT CONNECTED"}
            </span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white dark:bg-[#1E293B] border-[4px] border-[#1A1A1A] dark:border-[#4B5563] p-6 shadow-[6px_6px_0_#1A1A1A] dark:shadow-[6px_6px_0_#475569]">
          <div className="flex items-center gap-3 mb-4 border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563] pb-3">
            <div className="p-2 border-[3px] border-[#1A1A1A] shadow-[2px_2px_0_#1A1A1A] bg-white dark:bg-[#1A2841]">
              <Shield className="w-6 h-6 text-[#10B981]" />
            </div>
            <h3 className="text-xl font-black text-[#1A1A1A] dark:text-white uppercase">
              Health Score
            </h3>
          </div>
          <div>
            <div className="flex justify-between items-end mb-2">
              <span className="font-bold text-gray-600 dark:text-gray-400">
                LTV Usage{" "}
                {ltvPercent === null
                  ? "(loading on-chain limit)"
                  : `(Max ${ltvPercent.toFixed(0)}%)`}
              </span>
              <span
                className={`text-2xl font-black ${!isHealthy ? "text-[#EF4444]" : "text-[#10B981]"}`}
              >
                {borrowed !== null && maxBorrowUsd !== null && maxBorrowUsd > 0
                  ? ((borrowed / maxBorrowUsd) * 100).toFixed(1)
                  : "—"}
                %
              </span>
            </div>
            <div className="w-full bg-gray-200 border-[3px] border-[#1A1A1A] h-4">
              <div
                className={`h-full border-r-[3px] border-[#1A1A1A] ${!isHealthy ? "bg-[#EF4444]" : "bg-[#10B981]"}`}
                style={{
                  width: `${
                    borrowed !== null &&
                    maxBorrowUsd !== null &&
                    maxBorrowUsd > 0
                      ? Math.min((borrowed / maxBorrowUsd) * 100, 100)
                      : 0
                  }%`,
                }}
              />
            </div>
            {!isHealthy &&
              healthFactor !== null &&
              borrowed !== null &&
              borrowed > 0 && (
                <div className="mt-4 bg-[#FEE2E2] border-[3px] border-[#EF4444] p-3 flex items-start gap-2 shadow-[2px_2px_0_#EF4444]">
                  <AlertTriangle className="w-5 h-5 text-[#EF4444] shrink-0" />
                  <span className="text-xs font-bold text-[#EF4444] uppercase tracking-wide">
                    Liquidation Risk! Please add collateral or repay debt.
                  </span>
                </div>
              )}
          </div>
        </div>

        <div className="bg-white dark:bg-[#1E293B] border-[4px] border-[#1A1A1A] dark:border-[#4B5563] p-6 shadow-[6px_6px_0_#1A1A1A] dark:shadow-[6px_6px_0_#475569]">
          <div className="flex items-center gap-3 mb-4 border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563] pb-3">
            <div className="p-2 border-[3px] border-[#1A1A1A] shadow-[2px_2px_0_#1A1A1A] bg-white dark:bg-[#1A2841]">
              <Coins className="w-6 h-6 text-[#0052FF]" />
            </div>
            <h3 className="text-xl font-black text-[#1A1A1A] dark:text-white uppercase">
              Your Collateral
            </h3>
          </div>
          <div>
            <div className="text-3xl font-black text-[#1A1A1A] dark:text-white">
              {collateral === null ? "—" : collateral.toFixed(2)} KLET
            </div>
            <div className="text-lg font-bold text-gray-500 mt-1">
              {colUsdValue === null
                ? "Live value unavailable"
                : `≈ $${colUsdValue.toFixed(2)}`}
            </div>
            <button
              onClick={() =>
                onActionClick(
                  "Add collateral with my KLET to Kletia lending protocol",
                )
              }
              disabled={!isArcConnected}
              className="mt-6 w-full p-3 bg-[#0052FF] text-white font-black uppercase tracking-widest border-[3px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] hover:-translate-y-1 hover:shadow-[6px_6px_0_#1A1A1A] dark:hover:shadow-[6px_6px_0_#475569] active:translate-y-0 active:shadow-[1px_1px_0_#1A1A1A] transition-all"
            >
              Collateral Management
            </button>
          </div>
        </div>

        <div className="bg-white dark:bg-[#1E293B] border-[4px] border-[#1A1A1A] dark:border-[#4B5563] p-6 shadow-[6px_6px_0_#1A1A1A] dark:shadow-[6px_6px_0_#475569]">
          <div className="flex items-center gap-3 mb-4 border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563] pb-3">
            <div className="p-2 border-[3px] border-[#1A1A1A] shadow-[2px_2px_0_#1A1A1A] bg-white dark:bg-[#1A2841]">
              <DollarSign className="w-6 h-6 text-[#0052FF]" />
            </div>
            <h3 className="text-xl font-black text-[#1A1A1A] dark:text-white uppercase">
              Your Debt
            </h3>
          </div>
          <div>
            <div className="text-3xl font-black text-[#1A1A1A] dark:text-white">
              {borrowed === null ? "—" : borrowed.toFixed(2)} USDC
            </div>
            <div className="text-lg font-bold text-gray-500 mt-1">
              Max Borrowable:{" "}
              {maxBorrowUsd === null
                ? "Unavailable"
                : `$${maxBorrowUsd.toFixed(2)}`}
            </div>
            <button
              onClick={() => onActionClick("Borrow USDC via Kletia lending")}
              disabled={!isArcConnected}
              className="mt-6 w-full p-3 bg-[#0052FF] text-white font-black uppercase tracking-widest border-[3px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] hover:-translate-y-1 hover:shadow-[6px_6px_0_#1A1A1A] dark:hover:shadow-[6px_6px_0_#475569] active:translate-y-0 active:shadow-[1px_1px_0_#1A1A1A] transition-all"
            >
              Borrowing Operations
            </button>
          </div>
        </div>
      </div>

      <div className="mt-12">
        <h3 className="text-xl font-black text-[#1A1A1A] dark:text-white uppercase tracking-widest mb-6 border-b-[4px] border-[#1A1A1A] dark:border-[#4B5563] pb-2 inline-block">
          ⚡ Prepare Lending Operations
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {[
            {
              icon: "💰",
              title: "Add Collateral",
              prompt: "Add KLET collateral to Kletia lending protocol",
            },
            {
              icon: "💸",
              title: "Borrow",
              prompt: "Borrow USDC via Kletia lending",
            },
            {
              icon: "💳",
              title: "Repay",
              prompt: "Repay my USDC debt on Kletia lending",
            },
            {
              icon: "🔓",
              title: "Withdraw Collateral",
              prompt: "Withdraw KLET collateral via Kletia lending",
            },
          ].map((action, idx) => (
            <button
              key={idx}
              onClick={() => onActionClick(action.prompt)}
              disabled={!isArcConnected}
              className="group flex flex-col items-center justify-center p-6 bg-white dark:bg-[#1E293B] border-[4px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[6px_6px_0_#1A1A1A] dark:shadow-[6px_6px_0_#475569] hover:-translate-y-1 hover:shadow-[8px_8px_0_#1A1A1A] active:translate-y-0 active:shadow-[2px_2px_0_#1A1A1A] transition-all"
            >
              <div
                className={`w-14 h-14 flex items-center justify-center border-[3px] border-[#1A1A1A] shadow-[3px_3px_0_#1A1A1A] text-2xl bg-[#0052FF] dark:bg-slate-700 text-white group-hover:-translate-y-1 transition-transform mb-4`}
              >
                {action.icon}
              </div>
              <span className="font-black text-[#1A1A1A] dark:text-white uppercase tracking-tight text-center">
                {action.title}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
