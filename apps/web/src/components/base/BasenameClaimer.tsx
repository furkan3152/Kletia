import { useState } from "react";
import { formatEther } from "viem";
import { useReadContract } from "wagmi";
import { ArrowRight, RefreshCw, Tag } from "lucide-react";

import { BASE_CONTRACTS, NETWORKS } from "../../config/networks";

const REGISTRAR_READ_ABI = [
  {
    inputs: [
      { internalType: "string", name: "name", type: "string" },
      { internalType: "uint256", name: "duration", type: "uint256" },
    ],
    name: "rentPrice",
    outputs: [
      {
        components: [
          { internalType: "uint256", name: "base", type: "uint256" },
          { internalType: "uint256", name: "premium", type: "uint256" },
        ],
        internalType: "struct IPriceOracle.Price",
        name: "price",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

interface BasenameClaimerProps {
  onActionClick: (prompt: string) => void;
}

export function BasenameClaimer({ onActionClick }: BasenameClaimerProps) {
  const [name, setName] = useState("");
  const cleanName = name
    .toLowerCase()
    .replace(".base.eth", "")
    .replace(/[^a-z0-9-]/g, "");
  const durationDays = 365;
  const duration = BigInt(durationDays) * 86_400n;

  const {
    data: rentPriceData,
    isPending: isPriceLoading,
    isError: isPriceError,
    refetch: refetchPrice,
  } = useReadContract({
    address: BASE_CONTRACTS.basenameRegistrarController,
    abi: REGISTRAR_READ_ABI,
    functionName: "rentPrice",
    args: cleanName ? [cleanName, duration] : undefined,
    chainId: NETWORKS.base.chainId,
    query: {
      enabled: cleanName.length >= 3,
    },
  });

  const basePrice =
    rentPriceData &&
    typeof rentPriceData === "object" &&
    "base" in rentPriceData &&
    typeof rentPriceData.base === "bigint"
      ? rentPriceData.base
      : 0n;
  const premium =
    rentPriceData &&
    typeof rentPriceData === "object" &&
    "premium" in rentPriceData &&
    typeof rentPriceData.premium === "bigint"
      ? rentPriceData.premium
      : 0n;
  const registrationPreview = basePrice + premium;
  const validName = cleanName.length >= 3;

  const createIntent = (action: "register" | "renew") => {
    if (!validName) return;
    onActionClick(
      action === "register"
        ? `Register ${cleanName}.base.eth for ${durationDays} days on Base Mainnet`
        : `Renew ${cleanName}.base.eth for ${durationDays} days on Base Mainnet`,
    );
  };

  return (
    <div className="flex h-full w-full flex-1 items-center justify-center overflow-y-auto p-6">
      <div className="flex w-full max-w-xl flex-col items-center border-[4px] border-[#1A1A1A] bg-white p-8 text-center shadow-[8px_8px_0_#1A1A1A] dark:border-[#4B5563] dark:bg-[#1A2841] dark:shadow-[8px_8px_0_#475569]">
        <div className="mb-6 flex h-20 w-20 -rotate-6 items-center justify-center rounded-full border-[3px] border-[#1A1A1A] bg-[#0052FF] shadow-[4px_4px_0_#1A1A1A] dark:border-[#4B5563] dark:shadow-[4px_4px_0_#475569]">
          <Tag className="h-10 w-10 text-white" strokeWidth={3} />
        </div>

        <h2 className="mb-2 text-3xl font-black uppercase tracking-tighter text-[#1A1A1A] dark:text-white">
          Base identity intent
        </h2>
        <p className="mb-8 px-4 text-sm font-bold text-gray-500 dark:text-gray-400">
          The widget only generates editable intent text. Price, target,
          security, and simulation are re-verified on the main Kletia intent pipeline.
        </p>

        <div className="relative mb-2 w-full">
          <input
            type="text"
            value={name}
            onChange={(event) =>
              setName(
                event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""),
              )
            }
            placeholder="yourname"
            className="w-full border-[3px] border-[#1A1A1A] bg-[#EFEFEF] p-4 pr-32 text-2xl font-black text-[#1A1A1A] outline-none transition-colors focus:bg-white dark:border-[#4B5563] dark:bg-slate-800 dark:text-white dark:focus:bg-slate-700"
          />
          <div className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-xl font-black text-[#0052FF] opacity-80">
            .base.eth
          </div>
        </div>

        <div className="mb-5 min-h-[48px] w-full text-right">
          {cleanName.length > 0 && !validName && (
            <span className="text-sm font-bold text-red-500">
              Name must be at least 3 characters
            </span>
          )}
          {validName && isPriceLoading && (
            <span className="text-sm font-bold text-gray-500">
              Live preview is loading…
            </span>
          )}
          {validName && !isPriceLoading && registrationPreview > 0n && (
            <span className="text-sm font-black text-green-600 dark:text-green-400">
              Registration preview: {formatEther(registrationPreview)} ETH
            </span>
          )}
          {validName && isPriceError && (
            <button
              type="button"
              onClick={() => void refetchPrice()}
              className="inline-flex items-center gap-2 text-sm font-black text-red-500 underline"
            >
              <RefreshCw className="h-4 w-4" />
              Preview unavailable — retry
            </button>
          )}
        </div>

        <div className="grid w-full gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => createIntent("register")}
            disabled={!validName}
            className="flex items-center justify-center gap-2 border-[3px] border-[#1A1A1A] bg-[#0052FF] py-4 text-sm font-black uppercase text-white shadow-[4px_4px_0_#1A1A1A] transition-all hover:bg-blue-700 active:translate-y-1 active:shadow-none disabled:cursor-not-allowed disabled:bg-gray-300 disabled:text-gray-500 dark:border-[#4B5563] dark:shadow-[4px_4px_0_#475569] dark:disabled:bg-slate-700"
          >
            Register intent
            <ArrowRight className="h-5 w-5" strokeWidth={4} />
          </button>
          <button
            type="button"
            onClick={() => createIntent("renew")}
            disabled={!validName}
            className="flex items-center justify-center gap-2 border-[3px] border-[#1A1A1A] bg-[#FFD700] py-4 text-sm font-black uppercase text-[#1A1A1A] shadow-[4px_4px_0_#1A1A1A] transition-all hover:bg-yellow-300 active:translate-y-1 active:shadow-none disabled:cursor-not-allowed disabled:bg-gray-300 disabled:text-gray-500 dark:border-[#4B5563] dark:bg-[#CCA000] dark:shadow-[4px_4px_0_#475569]"
          >
            Renew intent
            <ArrowRight className="h-5 w-5" strokeWidth={4} />
          </button>
        </div>

        <div className="mt-5 w-full border-[2px] border-[#1A1A1A] bg-blue-50 p-3 text-left text-xs font-bold text-[#1A1A1A] dark:border-[#4B5563] dark:bg-slate-900 dark:text-gray-300">
          Canonical target: Base ENSIP-19 Upgradeable Registrar Controller. This
          preview is not a transaction proposal.
        </div>
      </div>
    </div>
  );
}
