import React, { useState } from "react";
import { useAccount, useBalance, useChainId, useReadContract } from "wagmi";
import { formatEther, isAddress, parseEther } from "viem";
import {
  ARC_CONTRACTS,
  ARC_VAULT_EXECUTION_MODE,
  ARC_SWAP_ABI,
  ARC_LENDING_ABI,
} from "../../networks/arc/config";
import { NETWORKS } from "../../config/networks";
import {
  ACTIVE_WALLET_ADDRESS,
  materializeIntentExample,
  requiresActiveWalletAddress,
} from "../../config/intentExamples";
import { WidgetId } from "../../types";
import { ArcUnifiedBalanceCard } from "./ArcUnifiedBalanceCard";

const ARC_CHAIN_ID = NETWORKS.arc.chainId;

const WIDGETS: Array<{
  id: Exclude<WidgetId, null>;
  icon: string;
  name: string;
  desc: string;
  color: string;
}> = [
  {
    id: "swap" as const,
    icon: "🔄",
    name: "Swap",
    desc: "USDC / KLET Swap",
    color: "bg-[#3B82F6]",
  },
  {
    id: "vault" as const,
    icon: "🔒",
    name: "Vault",
    desc: "Time-Locked Vault",
    color: "bg-[#8B5CF6]",
  },
  {
    id: "lending" as const,
    icon: "🏦",
    name: "Lending",
    desc: "Lend & Borrow",
    color: "bg-[#EF4444]",
  },
  {
    id: "staking" as const,
    icon: "💎",
    name: "Staking",
    desc: "Stake Native USDC",
    color: "bg-[#06B6D4]",
  },
  {
    id: "liquidity" as const,
    icon: "💧",
    name: "Liquidity",
    desc: "Provide LP",
    color: "bg-[#10B981]",
  },
  {
    id: "batch" as const,
    icon: "📦",
    name: "Batch Pay",
    desc: "Batch Transfer",
    color: "bg-[#F59E0B]",
  },
  {
    id: "memo" as const,
    icon: "📝",
    name: "Memo",
    desc: "Memo Transfer",
    color: "bg-[#EC4899]",
  },
];

const InputLabel = ({ children }: { children: React.ReactNode }) => (
  <label className="block text-xs font-black uppercase tracking-wider text-[#1A1A1A] dark:text-white mb-2">
    {children}
  </label>
);

const InputField = (props: React.InputHTMLAttributes<HTMLInputElement>) => (
  <input
    {...props}
    className={`w-full p-3 bg-white dark:bg-[#0F172A] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#475569] focus:outline-none focus:-translate-y-0.5 focus:shadow-[5px_5px_0_#1A1A1A] dark:focus:shadow-[5px_5px_0_#8B5CF6] transition-all font-bold text-[#1A1A1A] dark:text-white disabled:opacity-50 disabled:cursor-not-allowed ${props.className || ""}`}
  />
);

const ActionButton = ({
  onClick,
  disabled,
  children,
  colorClass,
  className = "",
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  colorClass?: string;
  className?: string;
}) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className={`w-full py-3 px-4 font-black uppercase tracking-widest text-white transition-all duration-200 border-[3px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] ${disabled ? "bg-gray-400 dark:bg-slate-600 opacity-80 cursor-not-allowed shadow-[1px_1px_0_#1A1A1A] translate-y-0.5" : `${colorClass || "bg-[#0052FF]"} hover:-translate-y-1 hover:shadow-[6px_6px_0_#1A1A1A] dark:hover:shadow-[6px_6px_0_#475569] active:translate-y-0 active:shadow-[1px_1px_0_#1A1A1A]`} ${className}`}
  >
    {children}
  </button>
);

function parsePositiveAmount(
  value: string,
  label: string,
  userDecimals = 6,
): string {
  const normalized = value.trim();
  if (!normalized || !/^\d+(\.\d+)?$/.test(normalized)) {
    throw new Error(`Enter a valid amount for ${label}.`);
  }
  const fraction = normalized.split(".")[1] || "";
  if (fraction.length > userDecimals) {
    throw new Error(
      `${label} user input can have up to ${userDecimals} decimal places.`,
    );
  }
  const parsed = parseEther(normalized);
  if (parsed <= 0n) throw new Error(`${label} must be greater than zero.`);
  return normalized;
}

export const ArcDashboardWidget: React.FC<{
  onWidgetClick: (prompt: string) => void;
  activeWidget?: WidgetId;
  setActiveWidget?: (w: WidgetId) => void;
  minimal?: boolean;
}> = ({
  onWidgetClick,
  activeWidget: propsActiveWidget,
  setActiveWidget: propsSetActiveWidget,
  minimal = false,
}) => {
  const [localActiveWidget, setLocalActiveWidget] = useState<WidgetId>(null);
  const activeWidget =
    propsActiveWidget !== undefined ? propsActiveWidget : localActiveWidget;
  const setActiveWidget = propsSetActiveWidget || setLocalActiveWidget;
  const { isConnected, address } = useAccount();
  const chainId = useChainId();
  const isArcConnected = isConnected && chainId === ARC_CHAIN_ID;
  const balance = useBalance({ address, chainId: ARC_CHAIN_ID });
  const { data: kletRawBalance } = useReadContract({
    address: ARC_CONTRACTS.Token as `0x${string}`,
    abi: [
      {
        inputs: [{ internalType: "address", name: "account", type: "address" }],
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
  });

  const { data: swapRate, isError: isSwapInfoError } = useReadContract({
    address: ARC_CONTRACTS.Swap as `0x${string}`,
    abi: ARC_SWAP_ABI,
    functionName: "consultKletPrice",
    chainId: ARC_CHAIN_ID,
  });

  const { data: usdcReserve } = useReadContract({
    address: ARC_CONTRACTS.Swap as `0x${string}`,
    abi: ARC_SWAP_ABI,
    functionName: "usdcReserve",
    chainId: ARC_CHAIN_ID,
  });

  // --- Portfolio Data ---
  const { data: lendingCollateral, isError: isLendingCollateralError } =
    useReadContract({
      address: ARC_CONTRACTS.Lending as `0x${string}`,
      abi: ARC_LENDING_ABI,
      functionName: "collateralBalance",
      args: address ? [address] : undefined,
      chainId: ARC_CHAIN_ID,
      query: { enabled: Boolean(address) },
    });

  const { data: lendingBorrow, isError: isLendingBorrowError } =
    useReadContract({
      address: ARC_CONTRACTS.Lending as `0x${string}`,
      abi: ARC_LENDING_ABI,
      functionName: "getBorrowedBalance",
      args: address ? [address] : undefined,
      chainId: ARC_CHAIN_ID,
      query: { enabled: Boolean(address) },
    });

  // --- Form States ---
  const [swapAmount, setSwapAmount] = useState("1");
  const [isUsdcToToken, setIsUsdcToToken] = useState(true);
  const [batchAddresses, setBatchAddresses] = useState("");
  const [batchAmount, setBatchAmount] = useState("0.1");
  const [vaultAmount, setVaultAmount] = useState("1");
  const [memoTo, setMemoTo] = useState("");
  const [memoAmount, setMemoAmount] = useState("0.1");
  const [memoText, setMemoText] = useState("KLETIA-DEMO-001");
  const [stakeAmount, setStakeAmount] = useState("1");
  const [lpUsdcAmount, setLpUsdcAmount] = useState("1");
  const [lpTokenAmount, setLpTokenAmount] = useState("10");
  const [intentError, setIntentError] = useState<string | null>(null);
  const previousAddressRef = React.useRef<string | undefined>(undefined);

  React.useEffect(() => {
    const previousAddress = previousAddressRef.current;
    const nextAddress = address ?? "";
    setBatchAddresses((current) =>
      !current || current === previousAddress ? nextAddress : current,
    );
    setMemoTo((current) =>
      !current || current === previousAddress ? nextAddress : current,
    );
    previousAddressRef.current = nextAddress;
  }, [address]);

  let previewAmount: bigint | undefined;
  try {
    previewAmount = swapAmount ? parseEther(swapAmount) : undefined;
  } catch {
    previewAmount = undefined;
  }

  const { data: usdcToKletPreview, isFetching: isUsdcPreviewLoading } =
    useReadContract({
      address: ARC_CONTRACTS.Swap as `0x${string}`,
      abi: ARC_SWAP_ABI,
      functionName: "previewSwapUSDCForToken",
      args: previewAmount ? [previewAmount] : undefined,
      chainId: ARC_CHAIN_ID,
      query: { enabled: isUsdcToToken && Boolean(previewAmount) },
    });

  const { data: kletToUsdcPreview, isFetching: isKletPreviewLoading } =
    useReadContract({
      address: ARC_CONTRACTS.Swap as `0x${string}`,
      abi: ARC_SWAP_ABI,
      functionName: "previewSwapTokenForUSDC",
      args: previewAmount ? [previewAmount] : undefined,
      chainId: ARC_CHAIN_ID,
      query: { enabled: !isUsdcToToken && Boolean(previewAmount) },
    });

  const seedIntent = (buildPrompt: () => string) => {
    setIntentError(null);
    try {
      onWidgetClick(buildPrompt());
    } catch (err) {
      setIntentError(
        err instanceof Error
          ? err.message
          : "Arc Testnet intent could not be prepared.",
      );
    }
  };

  const renderIntentError = () => {
    if (!intentError) return null;
    return (
      <div
        role="alert"
        className="mt-4 border-[3px] border-[#1A1A1A] bg-[#EF4444] p-4 font-bold text-white shadow-[4px_4px_0_#1A1A1A] dark:border-[#4B5563] dark:shadow-[4px_4px_0_#475569]"
      >
        ❌ INPUT ERROR: {intentError}
      </div>
    );
  };

  const renderForm = () => {
    switch (activeWidget) {
      case "lending":
        return (
          <div className="bg-[#F3F4F6] dark:bg-[#1A2841] border-[4px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] p-4 flex flex-col md:flex-row items-center justify-between animate-slide-up">
            <div className="mb-6 border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563] pb-4 flex items-center justify-between">
              <div>
                <h3 className="text-2xl font-black text-[#1A1A1A] dark:text-white uppercase tracking-tight">
                  🏦 KLETIA LENDING{" "}
                  <span className="text-sm text-gray-500">(built on Arc)</span>
                </h3>
                <p className="text-sm font-bold text-gray-600 dark:text-gray-400 mt-1">
                  Provide KLET Collateral, Borrow USDC
                </p>
              </div>
              <div className="bg-white border-[3px] border-[#1A1A1A] p-2 shadow-[2px_2px_0_#1A1A1A]">
                <div className="text-xs font-black text-gray-500 uppercase">
                  Collateral / Borrow
                </div>
                <div className="text-sm font-bold">
                  {isLendingCollateralError
                    ? "Unavailable"
                    : lendingCollateral === undefined
                      ? "Checking…"
                      : `${Number(formatEther(lendingCollateral as bigint)).toFixed(2)} KLET`}{" "}
                  /{" "}
                  {isLendingBorrowError
                    ? "Unavailable"
                    : lendingBorrow === undefined
                      ? "Checking…"
                      : `${Number(formatEther(lendingBorrow as bigint)).toFixed(2)} USDC`}
                </div>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <InputLabel>Add Collateral (KLET)</InputLabel>
                <InputField
                  type="number"
                  value={vaultAmount}
                  onChange={(e) => setVaultAmount(e.target.value)}
                  placeholder="0.00"
                />
                <ActionButton
                  disabled={!vaultAmount}
                  colorClass="bg-[#10B981] hover:bg-[#059669]"
                  onClick={() =>
                    seedIntent(() => {
                      const amount = parsePositiveAmount(
                        vaultAmount,
                        "Collateral",
                        18,
                      );
                      return `Deposit ${amount} KLET as collateral in Kletia Lending on Arc Testnet; prepare the route and simulate it before wallet approval`;
                    })
                  }
                >
                  🟢 Prepare Collateral Intent
                </ActionButton>
              </div>
              <div>
                <InputLabel>Borrow (USDC)</InputLabel>
                <InputField
                  type="number"
                  value={stakeAmount}
                  onChange={(e) => setStakeAmount(e.target.value)}
                  placeholder="0.00"
                />
                <ActionButton
                  disabled={!stakeAmount}
                  colorClass="bg-[#EF4444] hover:bg-[#DC2626]"
                  onClick={() =>
                    seedIntent(() => {
                      const amount = parsePositiveAmount(stakeAmount, "Borrow");
                      return `Borrow ${amount} native USDC from Kletia Lending on Arc Testnet; prepare the route and simulate it before wallet approval`;
                    })
                  }
                >
                  🔴 Prepare Borrow Intent
                </ActionButton>
              </div>
            </div>
          </div>
        );

      case "swap":
        return (
          <div className="p-6 bg-[#F3F4F6] dark:bg-[#1A2841] border-[4px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[6px_6px_0_#1A1A1A] dark:shadow-[6px_6px_0_#475569]">
            <div className="mb-6 border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563] pb-4">
              <h3 className="text-2xl font-black text-[#1A1A1A] dark:text-white uppercase tracking-tight">
                🔄 KLETIA SWAP{" "}
                <span className="text-sm text-gray-500">(built on Arc)</span>
              </h3>
              <p className="text-sm font-bold text-gray-600 dark:text-gray-400 mt-1">
                Quickly swap between USDC and Tokens.
              </p>
            </div>
            <div className="mb-4">
              <InputLabel>
                {isUsdcToToken ? "Send — USDC" : "Send — KLET"}
              </InputLabel>
              <InputField
                type="number"
                value={swapAmount}
                onChange={(e) => setSwapAmount(e.target.value)}
                placeholder="0.00"
              />
            </div>
            <div className="flex justify-center my-4">
              <button
                onClick={() => setIsUsdcToToken(!isUsdcToToken)}
                className="w-10 h-10 flex items-center justify-center bg-white dark:bg-[#0F172A] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#475569] hover:-translate-y-0.5 active:translate-y-1 active:shadow-none transition-all font-black text-lg text-[#1A1A1A] dark:text-white"
              >
                ⇅
              </button>
            </div>
            <div className="mb-4">
              <InputLabel>
                {isUsdcToToken ? "Receive — KLET" : "Receive — USDC"}
              </InputLabel>
              <InputField
                type="text"
                disabled
                value={
                  isUsdcPreviewLoading || isKletPreviewLoading
                    ? "On-chain quote loading..."
                    : isUsdcToToken && usdcToKletPreview !== undefined
                      ? formatEther(usdcToKletPreview as bigint)
                      : !isUsdcToToken && kletToUsdcPreview !== undefined
                        ? formatEther(kletToUsdcPreview as bigint)
                        : ""
                }
                placeholder="Enter an amount for a live quote"
                className="bg-gray-200 dark:bg-slate-800"
              />
            </div>
            <div className="mb-4 border-[3px] border-[#1A1A1A] bg-[#FACC15] p-3 text-xs font-black text-[#1A1A1A] shadow-[3px_3px_0_#1A1A1A]">
              TESTNET NOTICE: The deployed swap entrypoint does not accept a
              client-side minimum output or deadline. This quote is read live
              from Arc, while the button only prepares an editable intent. The
              intent engine must rebuild and simulate the route before wallet
              approval; re-check the final wallet details before signing.
            </div>
            <ActionButton
              disabled={!swapAmount}
              colorClass="bg-[#3B82F6] hover:bg-[#2563EB]"
              onClick={() =>
                seedIntent(() => {
                  const amount = parsePositiveAmount(
                    swapAmount,
                    "Swap",
                    isUsdcToToken ? 6 : 18,
                  );
                  const tokenIn = isUsdcToToken ? "native USDC" : "KLET";
                  const tokenOut = isUsdcToToken ? "KLET" : "native USDC";
                  return `Swap ${amount} ${tokenIn} to ${tokenOut} on Arc Testnet using the live on-chain Kletia route; simulate it before wallet approval`;
                })
              }
            >
              ⚡ Prepare Swap Intent
            </ActionButton>
          </div>
        );

      case "vault":
        return (
          <div className="p-6 bg-[#F3F4F6] dark:bg-[#1A2841] border-[4px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[6px_6px_0_#1A1A1A] dark:shadow-[6px_6px_0_#475569]">
            <div className="mb-6 border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563] pb-4">
              <h3 className="text-2xl font-black text-[#1A1A1A] dark:text-white uppercase tracking-tight">
                🔒 KLETIA VAULT{" "}
                <span className="text-sm text-gray-500">(built on Arc)</span>
              </h3>
              <p className="text-sm font-bold text-gray-600 dark:text-gray-400 mt-1">
                Deposit your USDC into a secure time vault and earn interest.
              </p>
            </div>
            <div className="mb-4">
              <InputLabel>USDC to Deposit</InputLabel>
              <InputField
                type="number"
                value={vaultAmount}
                onChange={(e) => setVaultAmount(e.target.value)}
                placeholder="0.00"
              />
            </div>
            <ActionButton
              disabled={!vaultAmount}
              colorClass="bg-[#8B5CF6] hover:bg-[#7C3AED]"
              onClick={() =>
                seedIntent(() => {
                  const amount = parsePositiveAmount(
                    vaultAmount,
                    "Vault deposit",
                  );
                  return `Deposit ${amount} native USDC into the Kletia Vault on Arc Testnet; prepare the time-locked vault route and simulate it before wallet approval`;
                })
              }
            >
              🔒 Prepare Vault Deposit Intent
            </ActionButton>
            <ActionButton
              colorClass="bg-[#0052FF] hover:bg-[#0040DD] dark:bg-blue-600 dark:hover:bg-blue-500"
              onClick={() =>
                seedIntent(
                  () =>
                    "Withdraw my full Kletia Vault position, including available principal and interest, on Arc Testnet; simulate it before wallet approval",
                )
              }
            >
              🔓 Prepare Full Withdrawal Intent
            </ActionButton>
            {ARC_VAULT_EXECUTION_MODE === "vault_v2" && (
              <ActionButton
                colorClass="bg-[#F59E0B] hover:bg-[#D97706]"
                onClick={() =>
                  seedIntent(
                    () =>
                      "Withdraw my full legacy Kletia Vault position for migration on Arc Testnet; preserve every other depositor's principal and simulate it before wallet approval",
                  )
                }
              >
                ↗ Prepare Legacy Migration Withdrawal
              </ActionButton>
            )}
          </div>
        );

      case "staking":
        return (
          <div className="p-6 bg-[#F3F4F6] dark:bg-[#1A2841] border-[4px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[6px_6px_0_#1A1A1A] dark:shadow-[6px_6px_0_#475569]">
            <div className="mb-6 border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563] pb-4">
              <h3 className="text-2xl font-black text-[#1A1A1A] dark:text-white uppercase tracking-tight">
                💎 KLETIA STAKING{" "}
                <span className="text-sm text-gray-500">(built on Arc)</span>
              </h3>
              <p className="text-sm font-bold text-gray-600 dark:text-gray-400 mt-1">
                Stake native USDC. Unstaking starts the contract-defined
                cooldown before funds can be claimed.
              </p>
            </div>
            <div className="mb-4">
              <InputLabel>Stake Amount (USDC)</InputLabel>
              <InputField
                type="number"
                value={stakeAmount}
                onChange={(e) => setStakeAmount(e.target.value)}
                placeholder="0.00"
              />
            </div>
            <ActionButton
              disabled={!stakeAmount}
              colorClass="bg-[#06B6D4] hover:bg-[#0891B2]"
              onClick={() =>
                seedIntent(() => {
                  const amount = parsePositiveAmount(stakeAmount, "Stake");
                  return `Stake ${amount} native USDC in Kletia Staking on Arc Testnet; prepare the route and simulate it before wallet approval`;
                })
              }
            >
              💎 Prepare Stake Intent
            </ActionButton>
            <div className="flex gap-4 mt-4">
              <ActionButton
                colorClass="bg-[#10B981] hover:bg-[#059669]"
                className="mt-0"
                onClick={() =>
                  seedIntent(
                    () =>
                      "Claim all available rewards from Kletia Staking on Arc Testnet; simulate it before wallet approval",
                  )
                }
              >
                🎁 Claim Rewards
              </ActionButton>
              <ActionButton
                disabled={!stakeAmount}
                colorClass="bg-[#EF4444] hover:bg-[#DC2626]"
                className="mt-0"
                onClick={() =>
                  seedIntent(() => {
                    const amount = parsePositiveAmount(stakeAmount, "Unstake");
                    return `Unstake ${amount} native USDC from Kletia Staking on Arc Testnet and start the contract-defined cooldown; simulate it before wallet approval`;
                  })
                }
              >
                🔓 Prepare Unstake Intent
              </ActionButton>
              <ActionButton
                colorClass="bg-[#0052FF] hover:bg-[#0040DD]"
                className="mt-0"
                onClick={() =>
                  seedIntent(
                    () =>
                      "Claim my cooled-down unstaked native USDC from Kletia Staking on Arc Testnet; simulate it before wallet approval",
                  )
                }
              >
                📤 Claim Unstaked
              </ActionButton>
            </div>
            <div className="mt-4 border-[3px] border-[#1A1A1A] bg-[#FACC15] p-3 text-xs font-black uppercase text-[#1A1A1A] shadow-[3px_3px_0_#1A1A1A]">
              Claim intents read the connected wallet's live staking state,
              reject empty positions or active cooldowns, verify reward-pool
              coverage, and simulate the exact claim before wallet approval.
            </div>
          </div>
        );

      case "liquidity":
        return (
          <div className="p-6 bg-[#F3F4F6] dark:bg-[#1A2841] border-[4px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[6px_6px_0_#1A1A1A] dark:shadow-[6px_6px_0_#475569]">
            <div className="mb-6 border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563] pb-4">
              <h3 className="text-2xl font-black text-[#1A1A1A] dark:text-white uppercase tracking-tight">
                💧 KLETIA LIQUIDITY{" "}
                <span className="text-sm text-gray-500">(built on Arc)</span>
              </h3>
              <p className="text-sm font-bold text-gray-600 dark:text-gray-400 mt-1">
                Provide liquidity to USDC/Token pair and earn a share of swap
                fees.
              </p>
            </div>
            <div className="mb-4">
              <InputLabel>USDC Amount</InputLabel>
              <InputField
                type="number"
                value={lpUsdcAmount}
                onChange={(e) => setLpUsdcAmount(e.target.value)}
                placeholder="0.00"
              />
            </div>
            <div className="mb-4">
              <InputLabel>Maximum KLET Spend (hard cap)</InputLabel>
              <InputField
                type="number"
                value={lpTokenAmount}
                onChange={(e) => setLpTokenAmount(e.target.value)}
                placeholder="0.00"
              />
            </div>
            <div className="mb-4 border-[3px] border-[#1A1A1A] bg-[#FACC15] p-3 text-xs font-black text-[#1A1A1A] shadow-[3px_3px_0_#1A1A1A]">
              The intent engine derives the live KLET requirement from pool
              reserves and refuses the route if it exceeds this hard cap. The
              encoded calldata and exact approval are additionally bounded to at
              most 5% movement from the live ratio.
            </div>
            <ActionButton
              disabled={!lpUsdcAmount || !lpTokenAmount}
              colorClass="bg-[#10B981] hover:bg-[#059669]"
              onClick={() =>
                seedIntent(() => {
                  const nativeAmount = parsePositiveAmount(
                    lpUsdcAmount,
                    "USDC liquidity",
                  );
                  const tokenMaximum = parsePositiveAmount(
                    lpTokenAmount,
                    "KLET liquidity",
                    18,
                  );
                  return `Add ${nativeAmount} native USDC liquidity to the KLET/USDC pool on Arc Testnet and spend at most ${tokenMaximum} KLET; calculate and show the live requirement and enforce that hard cap before wallet approval`;
                })
              }
            >
              💧 Prepare Liquidity Intent
            </ActionButton>
          </div>
        );

      case "batch":
        return (
          <div className="p-6 bg-[#F3F4F6] dark:bg-[#1A2841] border-[4px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[6px_6px_0_#1A1A1A] dark:shadow-[6px_6px_0_#475569]">
            <div className="mb-6 border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563] pb-4">
              <h3 className="text-2xl font-black text-[#1A1A1A] dark:text-white uppercase tracking-tight">
                📦 KLETIA BATCH PAY{" "}
                <span className="text-sm text-gray-500">(built on Arc)</span>
              </h3>
              <p className="text-sm font-bold text-gray-600 dark:text-gray-400 mt-1">
                Send USDC to multiple wallets in a single transaction.
              </p>
            </div>
            <div className="mb-4">
              <InputLabel>Recipients (comma separated)</InputLabel>
              <InputField
                type="text"
                value={batchAddresses}
                onChange={(e) => setBatchAddresses(e.target.value)}
                placeholder="0x123..., 0x456..."
              />
            </div>
            <div className="mb-4">
              <InputLabel>USDC per Person</InputLabel>
              <InputField
                type="number"
                value={batchAmount}
                onChange={(e) => setBatchAmount(e.target.value)}
                placeholder="0.00"
              />
            </div>
            <div className="mb-4 border-[3px] border-[#1A1A1A] bg-[#D1FAE5] p-3 text-xs font-black uppercase text-[#1A1A1A] shadow-[3px_3px_0_#1A1A1A]">
              Supported intent route: atomic_payout through Arc&apos;s official
              Multicall3From extension. The widget never writes directly to
              BatchPay.
            </div>
            <ActionButton
              disabled={!batchAddresses || !batchAmount}
              colorClass="bg-[#F59E0B] hover:bg-[#D97706]"
              onClick={() =>
                seedIntent(() => {
                  const addrs = batchAddresses
                    .split(",")
                    .map((entry) => entry.trim())
                    .filter(Boolean);
                  if (
                    addrs.length === 0 ||
                    addrs.some((entry) => !isAddress(entry))
                  ) {
                    throw new Error(
                      "All batch recipients must be valid EVM addresses.",
                    );
                  }
                  if (
                    new Set(addrs.map((entry) => entry.toLowerCase())).size !==
                    addrs.length
                  ) {
                    throw new Error(
                      "The same recipient cannot appear more than once in the batch list.",
                    );
                  }
                  if (addrs.length > 25) {
                    throw new Error(
                      "Atomic payment can include up to 25 unique recipients.",
                    );
                  }
                  const perRecipient = parsePositiveAmount(
                    batchAmount,
                    "USDC per recipient",
                  );
                  const payouts = addrs
                    .map(
                      (recipient) =>
                        `${perRecipient} native USDC to ${recipient}`,
                    )
                    .join(", ");
                  return `Atomically pay ${payouts} on Arc Testnet through the official Multicall3From route; fail the whole batch if any payment fails and simulate it before wallet approval`;
                })
              }
            >
              📦 Prepare Atomic Payout Intent
            </ActionButton>
          </div>
        );

      case "memo":
        return (
          <div className="p-6 bg-[#F3F4F6] dark:bg-[#1A2841] border-[4px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[6px_6px_0_#1A1A1A] dark:shadow-[6px_6px_0_#475569]">
            <div className="mb-6 border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563] pb-4">
              <h3 className="text-2xl font-black text-[#1A1A1A] dark:text-white uppercase tracking-tight">
                📝 KLETIA MEMO PAY{" "}
                <span className="text-sm text-gray-500">(built on Arc)</span>
              </h3>
              <p className="text-sm font-bold text-gray-600 dark:text-gray-400 mt-1">
                Send USDC with a permanent public on-chain message. Never
                include personal or sensitive information.
              </p>
            </div>
            <div className="mb-4">
              <InputLabel>Recipient Address</InputLabel>
              <InputField
                type="text"
                value={memoTo}
                onChange={(e) => setMemoTo(e.target.value)}
                placeholder="0x..."
              />
            </div>
            <div className="mb-4">
              <InputLabel>USDC Amount</InputLabel>
              <InputField
                type="number"
                value={memoAmount}
                onChange={(e) => setMemoAmount(e.target.value)}
                placeholder="0.00"
              />
            </div>
            <div className="mb-4">
              <InputLabel>Your On-chain Memo</InputLabel>
              <InputField
                type="text"
                value={memoText}
                onChange={(e) => setMemoText(e.target.value)}
                placeholder="PUBLIC-REFERENCE-001"
              />
            </div>
            <ActionButton
              disabled={!memoTo || !memoAmount || !memoText}
              colorClass="bg-[#EC4899] hover:bg-[#DB2777]"
              onClick={() =>
                seedIntent(() => {
                  const recipient = memoTo.trim();
                  if (!isAddress(recipient))
                    throw new Error("Enter a valid recipient address.");
                  const amount = parsePositiveAmount(
                    memoAmount,
                    "Memo transfer",
                  );
                  const memo = memoText.trim();
                  if (!memo) throw new Error("Memo text cannot be empty.");
                  if (new TextEncoder().encode(memo).length > 256) {
                    throw new Error(
                      "Memo can contain at most 256 UTF-8 bytes.",
                    );
                  }
                  return `Send ${amount} native USDC to ${recipient} through Kletia Memo Pay on Arc Testnet with the permanent public on-chain memo ${JSON.stringify(memo)}; simulate it before wallet approval`;
                })
              }
            >
              📝 Prepare Memo Intent
            </ActionButton>
          </div>
        );

      default:
        return null;
    }
  };

  if (minimal) {
    return activeWidget ? (
      <div className="w-full">
        {renderForm()}
        {renderIntentError()}
      </div>
    ) : null;
  }

  return (
    <div className="w-full max-w-7xl mx-auto space-y-8 p-4 md:p-8 animate-fade-in pb-20">
      <div className="bg-[#8B5CF6] border-[4px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[8px_8px_0_#1A1A1A] dark:shadow-[8px_8px_0_#475569] p-6 md:p-10 flex flex-col lg:flex-row gap-8 justify-between relative overflow-hidden">
        <div className="absolute -right-10 -top-10 w-40 h-40 bg-white border-[4px] border-[#1A1A1A] rotate-12 opacity-20 pointer-events-none"></div>
        <div className="absolute right-40 -bottom-10 w-24 h-24 rounded-full bg-[#10B981] border-[4px] border-[#1A1A1A] pointer-events-none"></div>

        <div className="z-10 flex flex-col gap-4 max-w-2xl">
          <div className="inline-block bg-white text-[#1A1A1A] border-[3px] border-[#1A1A1A] font-black uppercase tracking-widest text-xs px-3 py-1 shadow-[3px_3px_0_#1A1A1A] w-max">
            KLETIA OMNI-ENGINE
          </div>
          <h2 className="text-4xl md:text-6xl font-black text-white tracking-tight uppercase leading-none drop-shadow-[4px_4px_0_#1A1A1A]">
            DASHBOARD
          </h2>
          <p className="text-lg md:text-xl font-bold text-white bg-[#1A1A1A] p-2 inline-block shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] w-max">
            USDC-native Arc Testnet • Chain ID 5042002
          </p>

          <div className="flex flex-wrap gap-4 mt-6">
            <div className="bg-white border-[3px] border-[#1A1A1A] p-4 shadow-[4px_4px_0_#1A1A1A] min-w-[140px]">
              <span className="text-xs font-black text-gray-500 uppercase block mb-1">
                KLET Price
              </span>
              <span className="text-xl font-black text-[#1A1A1A] flex items-center gap-2">
                {swapRate && (swapRate as bigint) > 0n
                  ? `${Number(formatEther(swapRate as bigint)).toLocaleString("en-US", { maximumFractionDigits: 8 })} USDC`
                  : "—"}{" "}
                <span className="text-xs text-[#10B981] bg-[#D1FAE5] px-2 py-0.5 border-[2px] border-[#10B981]">
                  On-Chain
                </span>
              </span>
            </div>
            <div className="bg-white border-[3px] border-[#1A1A1A] p-4 shadow-[4px_4px_0_#1A1A1A] min-w-[140px]">
              <span className="text-xs font-black text-gray-500 uppercase block mb-1">
                Total Liquidity (USDC)
              </span>
              <span className="text-xl font-black text-[#1A1A1A]">
                {usdcReserve === undefined
                  ? "—"
                  : `$${Number(
                      formatEther(usdcReserve as bigint),
                    ).toLocaleString("en-US", {
                      minimumFractionDigits: 0,
                      maximumFractionDigits: 6,
                    })}`}
              </span>
            </div>
            <div className="bg-white border-[3px] border-[#1A1A1A] p-4 shadow-[4px_4px_0_#1A1A1A] min-w-[140px]">
              <span className="text-xs font-black text-gray-500 uppercase block mb-1">
                Network Status
              </span>
              <span
                className={`text-xl font-black flex items-center gap-2 ${isSwapInfoError ? "text-[#EF4444]" : "text-[#10B981]"}`}
              >
                <span
                  className={`w-3 h-3 border-[2px] border-[#1A1A1A] rounded-full ${isSwapInfoError ? "bg-[#EF4444]" : "bg-[#10B981] animate-pulse"}`}
                ></span>
                {isSwapInfoError
                  ? "UNAVAILABLE"
                  : swapRate === undefined
                    ? "CHECKING"
                    : "ACTIVE"}
              </span>
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
                ? Number(formatEther(balance.data.value)).toFixed(6)
                : "—"}
              <span className="text-lg text-[#3B82F6] mb-1">USDC</span>
            </div>
            <div className="text-xl font-bold text-gray-600 dark:text-gray-400 mt-2 flex items-center gap-2">
              {isArcConnected && kletRawBalance !== undefined
                ? Number(formatEther(kletRawBalance as bigint)).toFixed(6)
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

      <ArcUnifiedBalanceCard />

      <div className="border-[4px] border-[#1A1A1A] bg-[#FACC15] p-5 shadow-[8px_8px_0_#1A1A1A] dark:border-[#4B5563] dark:shadow-[8px_8px_0_#475569] md:p-7">
        <div className="mb-5 flex flex-col justify-between gap-3 border-b-[4px] border-[#1A1A1A] pb-4 md:flex-row md:items-end">
          <div>
            <div className="mb-2 inline-block border-[2px] border-[#1A1A1A] bg-white px-2 py-1 text-[10px] font-black uppercase tracking-widest text-[#1A1A1A]">
              Powered by official Arc primitives
            </div>
            <h3 className="text-2xl font-black uppercase text-[#1A1A1A] md:text-4xl">
              Arc Money Studio
            </h3>
            <p className="mt-1 max-w-3xl text-sm font-bold text-[#1A1A1A]">
              Select a prefilled example to place an editable sentence in the
              intent box. Recipient examples use the connected wallet; no
              transaction is sent from this widget.
            </p>
          </div>
          <span className="w-max rotate-1 border-[3px] border-[#1A1A1A] bg-[#8B5CF6] px-3 py-2 text-xs font-black uppercase text-white shadow-[3px_3px_0_#1A1A1A]">
            Intent First
          </span>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {[
            {
              icon: "💱",
              title: "Stable FX Guard",
              detail: "Circle App Kit • live stop limit",
              prompt:
                "Swap 1 USDC to EURC on Arc Testnet, use 0.5% slippage and do not accept less than 0.99 EURC",
            },
            {
              icon: "🚀",
              title: "Testnet Bridge",
              detail: "CCTP • Circle Forwarder • SLOW",
              prompt:
                `Bridge 1 USDC from Arc Testnet to Base Sepolia for ${ACTIVE_WALLET_ADDRESS} using SLOW mode`,
            },
            {
              icon: "🧾",
              title: "Intent Invoice",
              detail: "Official Memo • public opaque reference",
              prompt:
                `Pay 0.1 USDC on Arc to ${ACTIVE_WALLET_ADDRESS} with official memo reference KLETIA-DEMO-001`,
            },
            {
              icon: "⚛️",
              title: "Atomic Treasury",
              detail: "Multicall3From • all or nothing",
              prompt:
                `Atomically pay 0.1 native USDC to ${ACTIVE_WALLET_ADDRESS} on Arc Testnet through the official Multicall3From route; fail the whole batch if any payment fails and simulate it before wallet approval`,
            },
            {
              icon: "✉️",
              title: "App Kit Send",
              detail: "USDC / EURC • official SDK",
              prompt:
                `Send 1 EURC on Arc Testnet to ${ACTIVE_WALLET_ADDRESS} through Circle App Kit`,
            },
            {
              icon: "🧠",
              title: "Route Proof",
              detail: "fee • output • policy evidence",
              prompt:
                "Show my Arc portfolio and explain which Arc money routes are available without sending a transaction",
            },
          ].map((blueprint) => {
            const prompt = materializeIntentExample(blueprint.prompt, address);
            const needsWallet = requiresActiveWalletAddress(blueprint.prompt);
            return (
              <button
                key={blueprint.title}
                type="button"
                disabled={!prompt}
                onClick={() => prompt && onWidgetClick(prompt)}
                title={
                  needsWallet && !address
                    ? "Connect a wallet to insert its address into this editable example."
                    : undefined
                }
                className="group flex min-h-20 items-start gap-3 border-[3px] border-[#1A1A1A] bg-white p-3 text-left text-[#1A1A1A] shadow-[4px_4px_0_#1A1A1A] transition-[transform,box-shadow,background-color] duration-100 hover:-translate-y-0.5 hover:shadow-[5px_5px_0_#1A1A1A] focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#8B5CF6] active:translate-y-0.5 active:shadow-none disabled:cursor-not-allowed disabled:translate-y-0 disabled:opacity-55 disabled:shadow-none sm:p-4"
              >
                <span className="flex h-11 w-11 shrink-0 items-center justify-center border-[3px] border-[#1A1A1A] bg-[#EDE9FE] text-xl shadow-[2px_2px_0_#1A1A1A]">
                  {blueprint.icon}
                </span>
                <span>
                  <span className="block text-sm font-black uppercase">
                    {blueprint.title}
                  </span>
                  <span className="mt-1 block text-xs font-bold text-gray-600">
                    {blueprint.detail}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 md:gap-5 lg:grid-cols-4">
        {WIDGETS.map((w) => (
          <button
            key={w.id}
            type="button"
            className={`group relative flex min-h-[116px] flex-col justify-between border-[4px] border-[#1A1A1A] bg-white p-3 text-left shadow-[5px_5px_0_#1A1A1A] transition-[transform,box-shadow,background-color] duration-100 hover:-translate-y-0.5 hover:shadow-[6px_6px_0_#1A1A1A] focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#8B5CF6] active:translate-y-0.5 active:shadow-none dark:border-[#4B5563] dark:bg-[#1E293B] dark:shadow-[5px_5px_0_#475569] sm:min-h-[132px] sm:p-4 ${activeWidget === w.id ? "translate-y-0.5 bg-[#E2E8F0] shadow-[2px_2px_0_#1A1A1A] dark:bg-[#334155] dark:shadow-[2px_2px_0_#475569]" : ""}`}
            onClick={() =>
              setActiveWidget(activeWidget === w.id ? null : w.id)
            }
          >
            <div
              className={`flex h-11 w-11 items-center justify-center border-[3px] border-[#1A1A1A] text-xl shadow-[3px_3px_0_#1A1A1A] transition-transform duration-100 group-hover:-translate-y-0.5 dark:border-[#4B5563] dark:shadow-[3px_3px_0_#475569] sm:h-12 sm:w-12 sm:text-2xl ${w.color}`}
            >
              {w.icon}
            </div>
            <div className="mt-4">
              <span
                className="block text-base font-black uppercase tracking-tight text-[#1A1A1A] dark:text-white sm:text-lg"
              >
                {w.name}
              </span>
              <span className="block text-xs font-bold text-gray-500 mt-1">
                {w.desc}
              </span>
            </div>
          </button>
        ))}
      </div>

      {activeWidget && (
        <div className="relative mt-8 animate-fade-in-up">
          <button
            className="absolute -top-4 -right-4 w-10 h-10 bg-white dark:bg-[#0F172A] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] hover:-translate-y-1 active:translate-y-0 transition-all font-black text-xl text-[#1A1A1A] dark:text-white z-10 flex items-center justify-center"
            onClick={() => setActiveWidget(null)}
          >
            ✕
          </button>
          {renderForm()}
          {renderIntentError()}
        </div>
      )}

      <div className="bg-[#F8FAFC] dark:bg-[#111827] border-[4px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[8px_8px_0_#1A1A1A] dark:shadow-[8px_8px_0_#475569] p-6 md:p-8 mt-12">
        <h3 className="text-2xl font-black text-[#1A1A1A] dark:text-white uppercase tracking-tight mb-6 flex items-center gap-3">
          <span className="w-8 h-8 bg-[#FACC15] border-[3px] border-[#1A1A1A] flex items-center justify-center shadow-[2px_2px_0_#1A1A1A]">
            ⚡
          </span>
          Kletia Omni-Features
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[
            {
              icon: "🔒",
              name: "Vault",
              desc: "Deposit / Withdraw",
              widget: "vault" as const,
            },
            {
              icon: "✉️",
              name: "Memo Pay",
              desc: "On-chain Memo",
              widget: "memo" as const,
            },
            {
              icon: "💦",
              name: "Liquidity",
              desc: "USDC / KLET Pool",
              widget: "liquidity" as const,
            },
            {
              icon: "🔄",
              name: "Swap",
              desc: "Live On-chain Quote",
              widget: "swap" as const,
            },
            {
              icon: "💎",
              name: "Stake",
              desc: "Stake / Cooldown",
              widget: "staking" as const,
            },
            {
              icon: "🏦",
              name: "Lending",
              desc: "Collateral / Borrow",
              widget: "lending" as const,
            },
            {
              icon: "📦",
              name: "Batch Pay",
              desc: "Multiple Recipients",
              widget: "batch" as const,
            },
          ].map((f, i) => (
            <button
              key={i}
              className="flex items-center gap-4 bg-white dark:bg-[#1E293B] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] p-3 shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] hover:-translate-y-1 hover:shadow-[6px_6px_0_#1A1A1A] active:translate-y-0 active:shadow-[1px_1px_0_#1A1A1A] transition-all text-left"
              onClick={() => setActiveWidget(f.widget)}
            >
              <span className="w-10 h-10 flex items-center justify-center bg-[#E2E8F0] dark:bg-[#0F172A] border-[2px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[2px_2px_0_#1A1A1A] text-xl shrink-0">
                {f.icon}
              </span>
              <div>
                <span className="block text-sm font-black text-[#1A1A1A] dark:text-white uppercase">
                  {f.name}
                </span>
                <span className="block text-xs font-bold text-gray-500">
                  {f.desc}
                </span>
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-4 mt-8">
        {[
          {
            name: "🔍 ArcScan Explorer",
            url: "https://testnet.arcscan.app",
            color: "bg-[#3B82F6]",
          },
          {
            name: "🚰 USDC Faucet",
            url: "https://faucet.circle.com",
            color: "bg-[#10B981]",
          },
          {
            name: "📖 Arc Docs",
            url: "https://docs.arc.io",
            color: "bg-[#F59E0B]",
          },
        ].map((link, i) => (
          <a
            key={i}
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            className={`px-4 py-2 border-[3px] border-[#1A1A1A] ${link.color} text-white font-black uppercase text-sm shadow-[4px_4px_0_#1A1A1A] hover:-translate-y-1 hover:shadow-[6px_6px_0_#1A1A1A] active:translate-y-0 active:shadow-[1px_1px_0_#1A1A1A] transition-all`}
          >
            {link.name}
          </a>
        ))}
      </div>
    </div>
  );
};
