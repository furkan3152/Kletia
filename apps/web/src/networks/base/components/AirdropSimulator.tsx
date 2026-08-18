import React, { useRef, useState } from "react";
import {
  Activity,
  Calendar,
  Clock,
  Cpu,
  Database,
  Fingerprint,
  RefreshCw,
  Search,
  Wallet,
} from "lucide-react";
import {
  createPublicClient,
  formatUnits,
  getAddress,
  http,
  isAddress,
  type Address,
} from "viem";
import { NETWORKS } from "../../../shared/config/networks";

const publicClient = createPublicClient({
  chain: NETWORKS.base.chain,
  transport: http(NETWORKS.base.rpcUrl),
});

const BNS_NFT = getAddress("0x03c4738Ee98aE44591e1A4A4F3CaB6641d95DD9a");
const BASE_WETH = getAddress("0x4200000000000000000000000000000000000006");
const BLOCKSCOUT_PAGE_SIZE = 10_000;
const LIVE_FETCH_TIMEOUT_MS = 15_000;

const BNS_ABI = [
  {
    inputs: [{ internalType: "address", name: "owner", type: "address" }],
    name: "balanceOf",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

type ProviderRecord = Record<string, unknown>;
type BasenameStatus = "owned" | "not_owned" | "unavailable";
type ActivityCompleteness = "complete" | "partial_capped";

interface BlockscoutRows {
  records: ProviderRecord[];
  completeness: ActivityCompleteness;
}

interface PriceResult {
  prices: Record<string, number>;
  failedChunks: number;
}

interface AirdropResult {
  address: Address;
  fetchedAt: number;
  nomisScore: number | null;
  kletiaActivityScore: number;
  basenameStatus: BasenameStatus;
  totalVolumeUsd: number;
  contractsCount: number;
  totalGasSpentUsd: number;
  dustTxCount: number;
  outgoingTxCount: number;
  activeMonths: number;
  accountAgeDays: number | null;
  totalTxs: number;
  normalTransactionsCapped: boolean;
  activityCompleteness: ActivityCompleteness;
  cappedSources: string[];
  unpricedTokenContracts: number;
  priceFailedChunks: number;
  volumeStatus: "complete" | "partial";
}

function isProviderRecord(value: unknown): value is ProviderRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeProviderErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const sanitized = error.message
    .replace(/https?:\/\/[^\s"'<>]+/giu, "[redacted-url]")
    .replace(
      /\b(?:authorization|signature|api[-_ ]?key)\b\s*[:=]\s*[^\s,;]+/giu,
      "[redacted-credential]",
    )
    .replace(/\b0x[a-f\d]{96,}\b/giu, "[redacted-payload]")
    .replace(/\b[A-Za-z\d+/_-]{80,}={0,2}\b/gu, "[redacted-payload]")
    .trim();
  return sanitized || fallback;
}

function asFiniteProviderNumber(value: unknown): number | null {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && value.trim() === "")
  ) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeInputAddress(value: string): Address | null {
  const trimmed = value.trim();
  if (!isAddress(trimmed, { strict: true })) return null;
  try {
    return getAddress(trimmed);
  } catch {
    return null;
  }
}

function asOptionalAddress(value: unknown, field: string): Address | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !isAddress(value, { strict: true })) {
    throw new Error(`${field} is not a valid EVM address.`);
  }
  return getAddress(value);
}

function asRequiredAddress(value: unknown, field: string): Address {
  const address = asOptionalAddress(value, field);
  if (!address) throw new Error(`${field} is missing.`);
  return address;
}

function asUnsignedBigInt(value: unknown, field: string): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${field} is not an unsigned integer.`);
  }
  return BigInt(value);
}

function asTokenDecimals(value: unknown, field: string): number {
  const decimals = asUnsignedBigInt(value, field);
  if (decimals > 255n) {
    throw new Error(`${field} exceeds the ERC-20 uint8 range.`);
  }
  return Number(decimals);
}

function atomicAmountToNumber(
  value: unknown,
  decimals: number,
  field: string,
): number {
  const formatted = formatUnits(asUnsignedBigInt(value, field), decimals);
  const amount = Number(formatted);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`${field} cannot be represented safely for display.`);
  }
  return amount;
}

function timestampToMillis(value: unknown, field: string): number {
  const seconds = asUnsignedBigInt(value, field);
  const maxDateSeconds = 8_640_000_000_000n;
  if (seconds === 0n || seconds > maxDateSeconds) {
    throw new Error(`${field} is outside the supported date range.`);
  }
  const milliseconds = Number(seconds) * 1_000;
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds > Date.now() + 5 * 60 * 1_000
  ) {
    throw new Error(`${field} is not a valid historical timestamp.`);
  }
  return milliseconds;
}

function safeAdd(total: number, value: number, field: string): number {
  const next = total + value;
  if (!Number.isFinite(next) || next < 0) {
    throw new Error(`${field} exceeds the supported display range.`);
  }
  return next;
}

function safeMultiply(left: number, right: number, field: string): number {
  const product = left * right;
  if (!Number.isFinite(product) || product < 0) {
    throw new Error(`${field} exceeds the supported display range.`);
  }
  return product;
}

async function fetchLiveJson(url: string, source: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    LIVE_FETCH_TIMEOUT_MS,
  );
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`${source} returned HTTP ${response.status}.`);
    }
    return await response.json();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`${source} timed out.`, { cause: error });
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function blockscoutList(payload: unknown, source: string): BlockscoutRows {
  if (
    isProviderRecord(payload) &&
    payload.status === "1" &&
    Array.isArray(payload.result)
  ) {
    if (!payload.result.every(isProviderRecord)) {
      throw new Error(`${source} returned malformed records.`);
    }
    return {
      records: payload.result,
      completeness:
        payload.result.length >= BLOCKSCOUT_PAGE_SIZE
          ? "partial_capped"
          : "complete",
    };
  }

  const message = isProviderRecord(payload)
    ? String(payload.message || payload.result || "")
    : "";
  if (
    isProviderRecord(payload) &&
    payload.status === "0" &&
    /no (transactions|records) found/i.test(message)
  ) {
    return { records: [], completeness: "complete" };
  }
  throw new Error(`${source} did not return a valid live result.`);
}

function blockscoutUrl(action: string, address: Address): string {
  const query = new URLSearchParams({
    module: "account",
    action,
    address,
    startblock: "0",
    endblock: "99999999",
    page: "1",
    offset: String(BLOCKSCOUT_PAGE_SIZE),
    sort: "asc",
  });
  return `https://base.blockscout.com/api?${query.toString()}`;
}

async function fetchPrices(addresses: Address[]): Promise<PriceResult> {
  const requestedAddresses = new Set(
    addresses.map((address) => address.toLowerCase()),
  );
  const bestByToken = new Map<
    string,
    { readonly priceUsd: number; readonly liquidityUsd: number }
  >();
  let failedChunks = 0;

  for (let index = 0; index < addresses.length; index += 30) {
    const chunk = addresses.slice(index, index + 30).join(",");
    try {
      const payload = await fetchLiveJson(
        `https://api.dexscreener.com/latest/dex/tokens/${chunk}`,
        "DexScreener",
      );
      if (!isProviderRecord(payload) || !Array.isArray(payload.pairs)) {
        throw new Error("DexScreener returned an invalid pair list.");
      }

      for (const value of payload.pairs) {
        if (!isProviderRecord(value) || value.chainId !== "base") continue;
        const baseToken = isProviderRecord(value.baseToken)
          ? value.baseToken
          : null;
        const quoteToken = isProviderRecord(value.quoteToken)
          ? value.quoteToken
          : null;
        const liquidity = isProviderRecord(value.liquidity)
          ? asFiniteProviderNumber(value.liquidity.usd)
          : null;
        if (!baseToken || !quoteToken || liquidity === null || liquidity < 0) {
          continue;
        }

        let baseAddress: Address | null = null;
        let quoteAddress: Address | null = null;
        try {
          baseAddress =
            typeof baseToken.address === "string" &&
            isAddress(baseToken.address, { strict: true })
              ? getAddress(baseToken.address)
              : null;
          quoteAddress =
            typeof quoteToken.address === "string" &&
            isAddress(quoteToken.address, { strict: true })
              ? getAddress(quoteToken.address)
              : null;
        } catch {
          continue;
        }

        const basePriceUsd =
          asFiniteProviderNumber(value.priceUsd) ?? Number.NaN;
        const basePriceInQuote =
          asFiniteProviderNumber(value.priceNative) ?? Number.NaN;
        const candidates: Array<{
          address: Address | null;
          priceUsd: number;
        }> = [
          { address: baseAddress, priceUsd: basePriceUsd },
          {
            address: quoteAddress,
            priceUsd:
              basePriceInQuote > 0
                ? basePriceUsd / basePriceInQuote
                : Number.NaN,
          },
        ];

        for (const candidate of candidates) {
          if (!candidate.address) continue;
          const key = candidate.address.toLowerCase();
          if (
            !requestedAddresses.has(key) ||
            !Number.isFinite(candidate.priceUsd) ||
            candidate.priceUsd <= 0
          ) {
            continue;
          }
          const current = bestByToken.get(key);
          if (!current || liquidity > current.liquidityUsd) {
            bestByToken.set(key, {
              priceUsd: candidate.priceUsd,
              liquidityUsd: liquidity,
            });
          }
        }
      }
    } catch {
      failedChunks += 1;
      console.warn("DexScreener live price chunk unavailable.");
    }
  }

  return {
    prices: Object.fromEntries(
      Array.from(bestByToken.entries()).map(([address, value]) => [
        address,
        value.priceUsd,
      ]),
    ),
    failedChunks,
  };
}

function displayScore(score: number): string {
  return Number.isInteger(score) ? String(score) : score.toFixed(2);
}

export const AirdropSimulator: React.FC = () => {
  const [inputAddress, setInputAddress] = useState("");
  const [isScanning, setIsScanning] = useState(false);
  const [result, setResult] = useState<AirdropResult | null>(null);
  const scanRevision = useRef(0);

  const normalizedInputAddress = normalizeInputAddress(inputAddress);
  const visibleResult =
    result &&
    normalizedInputAddress &&
    result.address.toLowerCase() === normalizedInputAddress.toLowerCase()
      ? result
      : null;

  const handleAddressChange = (value: string) => {
    scanRevision.current += 1;
    setInputAddress(value);
    setResult(null);
    setIsScanning(false);
  };

  const handleScan = async () => {
    const address = normalizeInputAddress(inputAddress);
    if (!address) {
      alert("Please enter a valid EVM wallet address.");
      return;
    }

    const revision = scanRevision.current + 1;
    scanRevision.current = revision;
    setInputAddress(address);
    setIsScanning(true);
    setResult(null);

    try {
      let nomisScore: number | null = null;
      try {
        const nomisPayload = await fetchLiveJson(
          `https://api.nomis.cc/api/v1/base/wallet/${address}/score`,
          "Nomis",
        );
        const nomisData =
          isProviderRecord(nomisPayload) && isProviderRecord(nomisPayload.data)
            ? nomisPayload.data
            : null;
        const receivedScore = asFiniteProviderNumber(nomisData?.score);
        if (
          receivedScore === null ||
          receivedScore < 0 ||
          receivedScore > 100
        ) {
          throw new Error("Nomis did not return a score in the 0-100 range.");
        }
        nomisScore = receivedScore;
      } catch {
        console.warn("Nomis score unavailable.");
      }

      let basenameStatus: BasenameStatus = "unavailable";
      try {
        const bnsBalance = await publicClient.readContract({
          address: BNS_NFT,
          abi: BNS_ABI,
          functionName: "balanceOf",
          args: [address],
        });
        basenameStatus = bnsBalance > 0n ? "owned" : "not_owned";
      } catch {
        console.warn("Basename live read unavailable.");
      }

      const [
        txPayload,
        internalPayload,
        tokenPayload,
        nftPayload,
        nft1155Payload,
        pricePayload,
      ] = await Promise.all([
        fetchLiveJson(
          blockscoutUrl("txlist", address),
          "Blockscout normal transactions",
        ),
        fetchLiveJson(
          blockscoutUrl("txlistinternal", address),
          "Blockscout internal transactions",
        ),
        fetchLiveJson(
          blockscoutUrl("tokentx", address),
          "Blockscout ERC-20 transfers",
        ),
        fetchLiveJson(
          blockscoutUrl("tokennfttx", address),
          "Blockscout ERC-721 transfers",
        ),
        fetchLiveJson(
          blockscoutUrl("token1155tx", address),
          "Blockscout ERC-1155 transfers",
        ),
        fetchLiveJson(
          "https://api.coinbase.com/v2/prices/ETH-USD/spot",
          "Coinbase ETH/USD",
        ),
      ]);

      const txSource = blockscoutList(
        txPayload,
        "Blockscout normal transactions",
      );
      const internalSource = blockscoutList(
        internalPayload,
        "Blockscout internal transactions",
      );
      const tokenSource = blockscoutList(
        tokenPayload,
        "Blockscout ERC-20 transfers",
      );
      const nftSource = blockscoutList(
        nftPayload,
        "Blockscout ERC-721 transfers",
      );
      const nft1155Source = blockscoutList(
        nft1155Payload,
        "Blockscout ERC-1155 transfers",
      );

      const blockscoutSources: Array<{
        readonly name: string;
        readonly source: BlockscoutRows;
      }> = [
        { name: "normal transactions", source: txSource },
        { name: "internal transactions", source: internalSource },
        { name: "ERC-20 transfers", source: tokenSource },
        { name: "ERC-721 transfers", source: nftSource },
        { name: "ERC-1155 transfers", source: nft1155Source },
      ];
      const cappedSources = blockscoutSources
        .filter(({ source }) => source.completeness === "partial_capped")
        .map(({ name }) => name);
      const activityCompleteness: ActivityCompleteness =
        cappedSources.length > 0 ? "partial_capped" : "complete";

      const coinbaseData =
        isProviderRecord(pricePayload) && isProviderRecord(pricePayload.data)
          ? pricePayload.data
          : null;
      const ethPrice = asFiniteProviderNumber(coinbaseData?.amount);
      if (ethPrice === null || ethPrice <= 0) {
        throw new Error("Coinbase did not return a valid live ETH/USD price.");
      }

      const lowerAddress = address.toLowerCase();
      const uniqueContracts = new Set<string>();
      const tokenAddressesToFetch = new Map<string, Address>();
      const activeMonthsSet = new Set<string>();
      let totalEthVolume = 0;
      let totalTokenVolumeUsd = 0;
      let totalGasSpentEth = 0;
      let dustTxCount = 0;
      let outgoingTxCount = 0;
      let firstTxTimestamp: number | null = null;

      for (const tx of txSource.records) {
        const from = asRequiredAddress(tx.from, "normal transaction from");
        const to = asOptionalAddress(tx.to, "normal transaction to");
        const isFromMe = from.toLowerCase() === lowerAddress;
        const isToMe = to?.toLowerCase() === lowerAddress;
        const timestamp = timestampToMillis(
          tx.timeStamp,
          "normal transaction timestamp",
        );
        firstTxTimestamp =
          firstTxTimestamp === null
            ? timestamp
            : Math.min(firstTxTimestamp, timestamp);
        const date = new Date(timestamp);
        activeMonthsSet.add(`${date.getUTCFullYear()}-${date.getUTCMonth()}`);

        const input = typeof tx.input === "string" ? tx.input : "";
        const hasContractCalldata =
          /^0x[0-9a-fA-F]*$/.test(input) && !/^0x(?:0+)?$/i.test(input);
        if (to && to.toLowerCase() !== lowerAddress && hasContractCalldata) {
          uniqueContracts.add(to.toLowerCase());
        }
        const createdContract = asOptionalAddress(
          tx.contractAddress,
          "normal transaction contractAddress",
        );
        if (createdContract) {
          uniqueContracts.add(createdContract.toLowerCase());
        }

        if (isFromMe || isToMe) {
          totalEthVolume = safeAdd(
            totalEthVolume,
            atomicAmountToNumber(tx.value, 18, "normal transaction value"),
            "ETH transfer volume",
          );
        }

        if (isFromMe) {
          outgoingTxCount += 1;
          const gasUsed = asUnsignedBigInt(
            tx.gasUsed,
            "normal transaction gasUsed",
          );
          const gasPrice = asUnsignedBigInt(
            tx.gasPrice,
            "normal transaction gasPrice",
          );
          totalGasSpentEth = safeAdd(
            totalGasSpentEth,
            atomicAmountToNumber(
              gasUsed * gasPrice,
              18,
              "normal transaction execution gas",
            ),
            "execution gas total",
          );
          const valueEth = atomicAmountToNumber(
            tx.value,
            18,
            "normal transaction value",
          );
          if (valueEth > 0 && valueEth < 0.001) dustTxCount += 1;
        }
      }

      for (const tx of internalSource.records) {
        const from = asOptionalAddress(tx.from, "internal transaction from");
        const to = asOptionalAddress(tx.to, "internal transaction to");
        const isFromMe = from?.toLowerCase() === lowerAddress;
        const isToMe = to?.toLowerCase() === lowerAddress;

        if (isFromMe || isToMe) {
          totalEthVolume = safeAdd(
            totalEthVolume,
            atomicAmountToNumber(tx.value, 18, "internal transaction value"),
            "ETH transfer volume",
          );
        }
      }

      for (const tx of tokenSource.records) {
        const tokenAddress = asRequiredAddress(
          tx.contractAddress,
          "ERC-20 contractAddress",
        );
        const key = tokenAddress.toLowerCase();
        uniqueContracts.add(key);
        tokenAddressesToFetch.set(key, tokenAddress);
      }

      const tokenPriceResult = await fetchPrices(
        Array.from(tokenAddressesToFetch.values()),
      );
      const unpricedTokenContracts = new Set<string>();

      for (const tx of tokenSource.records) {
        const from = asRequiredAddress(tx.from, "ERC-20 transfer from");
        const to = asRequiredAddress(tx.to, "ERC-20 transfer to");
        if (
          from.toLowerCase() !== lowerAddress &&
          to.toLowerCase() !== lowerAddress
        ) {
          continue;
        }

        const tokenAddress = asRequiredAddress(
          tx.contractAddress,
          "ERC-20 contractAddress",
        );
        const decimals = asTokenDecimals(
          tx.tokenDecimal,
          "ERC-20 tokenDecimal",
        );
        const amount = atomicAmountToNumber(
          tx.value,
          decimals,
          "ERC-20 transfer value",
        );
        const tokenKey = tokenAddress.toLowerCase();

        if (tokenKey === BASE_WETH.toLowerCase()) {
          totalEthVolume = safeAdd(
            totalEthVolume,
            amount,
            "WETH transfer volume",
          );
          continue;
        }

        const price = tokenPriceResult.prices[tokenKey];
        if (price === undefined) {
          unpricedTokenContracts.add(tokenKey);
          continue;
        }
        totalTokenVolumeUsd = safeAdd(
          totalTokenVolumeUsd,
          safeMultiply(amount, price, "ERC-20 USD transfer value"),
          "ERC-20 USD transfer volume",
        );
      }

      for (const tx of nftSource.records) {
        const contractAddress = asRequiredAddress(
          tx.contractAddress,
          "ERC-721 contractAddress",
        );
        uniqueContracts.add(contractAddress.toLowerCase());
      }
      for (const tx of nft1155Source.records) {
        const contractAddress = asRequiredAddress(
          tx.contractAddress,
          "ERC-1155 contractAddress",
        );
        uniqueContracts.add(contractAddress.toLowerCase());
      }

      const totalVolumeUsd = safeAdd(
        safeMultiply(totalEthVolume, ethPrice, "ETH USD transfer volume"),
        totalTokenVolumeUsd,
        "total USD transfer volume",
      );
      const totalGasSpentUsd = safeMultiply(
        totalGasSpentEth,
        ethPrice,
        "execution gas USD total",
      );
      const activeMonths = activeMonthsSet.size;
      const accountAgeDays =
        firstTxTimestamp === null
          ? null
          : Math.max(
              0,
              Math.floor(
                (Date.now() - firstTxTimestamp) / (24 * 60 * 60 * 1_000),
              ),
            );
      const totalTxs = txSource.records.length;

      let kletiaActivityScore = totalTxs > 0 ? 20 : 0;
      if (totalVolumeUsd > 1_000) kletiaActivityScore += 15;
      if (totalVolumeUsd > 10_000) kletiaActivityScore += 20;
      if (uniqueContracts.size > 20) kletiaActivityScore += 10;
      if (uniqueContracts.size > 100) kletiaActivityScore += 15;
      if (activeMonths > 3) kletiaActivityScore += 10;
      if (outgoingTxCount > 0 && dustTxCount / outgoingTxCount < 0.1) {
        kletiaActivityScore += 10;
      }
      kletiaActivityScore = Math.min(100, kletiaActivityScore);

      if (scanRevision.current !== revision) return;
      setResult({
        address,
        fetchedAt: Date.now(),
        nomisScore,
        kletiaActivityScore,
        basenameStatus,
        totalVolumeUsd,
        contractsCount: uniqueContracts.size,
        totalGasSpentUsd,
        dustTxCount,
        outgoingTxCount,
        activeMonths,
        accountAgeDays,
        totalTxs,
        normalTransactionsCapped: txSource.completeness === "partial_capped",
        activityCompleteness,
        cappedSources,
        unpricedTokenContracts: unpricedTokenContracts.size,
        priceFailedChunks: tokenPriceResult.failedChunks,
        volumeStatus:
          activityCompleteness === "partial_capped" ||
          unpricedTokenContracts.size > 0 ||
          tokenPriceResult.failedChunks > 0
            ? "partial"
            : "complete",
      });
    } catch (error) {
      console.error("Live Base analysis failed.");
      if (scanRevision.current === revision) {
        const message = safeProviderErrorMessage(
          error,
          "An unknown live provider error occurred.",
        );
        alert(`Live Base analysis could not be completed: ${message}`);
      }
    } finally {
      if (scanRevision.current === revision) {
        setIsScanning(false);
      }
    }
  };

  return (
    <div className="w-full h-full p-4 md:p-8 overflow-y-auto custom-scrollbar flex flex-col items-center">
      <div className="w-full max-w-5xl space-y-6">
        <div className="bg-white dark:bg-[#131E32] border-[4px] border-[#1A1A1A] dark:border-[#4B5563] p-6 md:p-8 shadow-[8px_8px_0_#1A1A1A] dark:shadow-[8px_8px_0_#475569] flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl md:text-4xl font-black text-[#1A1A1A] dark:text-white uppercase tracking-tighter flex items-center gap-3">
              <Database className="w-8 h-8 md:w-10 md:h-10 text-indigo-500" />
              Multi-API Aggregator
            </h1>
            <p className="text-gray-600 dark:text-slate-400 font-bold mt-2 text-sm md:text-base">
              Live Base activity from Blockscout, Base market pairs, the
              Basename contract and optional raw Nomis reputation.
            </p>
          </div>
        </div>

        <div className="flex flex-col md:flex-row gap-4">
          <div className="flex-1 relative">
            <Fingerprint className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 w-6 h-6" />
            <input
              type="text"
              placeholder="Enter wallet address (0x...) to analyze"
              value={inputAddress}
              onChange={(event) => handleAddressChange(event.target.value)}
              className="w-full bg-white dark:bg-[#1A2841] border-[4px] border-[#1A1A1A] dark:border-[#4B5563] p-4 pl-12 font-bold text-lg text-[#1A1A1A] dark:text-white placeholder-gray-400 outline-none shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] focus:translate-y-1 focus:shadow-none transition-all"
            />
          </div>
          <button
            onClick={handleScan}
            disabled={isScanning || !normalizedInputAddress}
            className="shrink-0 bg-[#0052FF] hover:bg-blue-700 disabled:bg-gray-400 text-white font-black px-8 py-4 border-[4px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] active:translate-y-1 active:shadow-none transition-all flex items-center gap-2 justify-center uppercase"
          >
            {isScanning ? <RefreshCw className="animate-spin" /> : <Search />}
            {isScanning ? "Reading Live APIs..." : "Analyze Live Activity"}
          </button>
        </div>

        {visibleResult && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-in slide-in-from-bottom-4 duration-500">
            <div className="lg:col-span-3 bg-indigo-100 dark:bg-indigo-950 border-[3px] border-[#1A1A1A] dark:border-[#4B5563] p-4 shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569]">
              <div className="font-black uppercase text-indigo-900 dark:text-indigo-200">
                Analyzed Base Mainnet Address
              </div>
              <div className="font-mono text-xs md:text-sm break-all text-[#1A1A1A] dark:text-white mt-1">
                {visibleResult.address}
              </div>
              <div className="text-xs font-bold mt-2 text-indigo-800 dark:text-indigo-300">
                Coverage:{" "}
                {visibleResult.activityCompleteness === "complete"
                  ? "complete for the returned first pages"
                  : `partial_capped — ${visibleResult.cappedSources.join(", ")} reached the ${BLOCKSCOUT_PAGE_SIZE.toLocaleString("en-US")}-row API cap`}
              </div>
            </div>

            <div className="lg:col-span-1 bg-white dark:bg-[#131E32] border-[4px] border-[#1A1A1A] dark:border-[#4B5563] p-6 flex flex-col items-center justify-center shadow-[6px_6px_0_#1A1A1A] dark:shadow-[6px_6px_0_#475569] text-center">
              <h3 className="text-xl font-black uppercase tracking-wide text-gray-500 dark:text-slate-400 mb-4">
                Kletia Activity Score
              </h3>
              <div className="w-40 h-40 flex flex-col items-center justify-center rounded-full border-[8px] border-indigo-500 bg-indigo-50 dark:bg-indigo-950">
                <div className="text-6xl font-black text-[#1A1A1A] dark:text-white">
                  {visibleResult.kletiaActivityScore}
                </div>
                <div className="text-xs font-black text-indigo-600 dark:text-indigo-300">
                  / 100
                </div>
              </div>
              <p className="mt-6 font-bold text-xs text-gray-600 dark:text-slate-300">
                Live formula: 20 for any normal transaction; +15/+20 for
                observed priced volume above $1k/$10k; +10/+15 for more than
                20/100 observed contract addresses; +10 for more than 3 active
                months; +10 when outgoing dust-transfer ratio is below 10%.
              </p>
              <p className="mt-3 text-xs font-black text-[#B45309] dark:text-amber-400">
                Activity summary only — not airdrop eligibility, identity or
                risk prediction.
              </p>
            </div>

            <div className="lg:col-span-2 flex flex-col gap-4">
              <div className="bg-white dark:bg-[#131E32] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] p-5 shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <Cpu className="w-8 h-8 text-purple-500" />
                  <div>
                    <h4 className="font-black text-[#1A1A1A] dark:text-white text-lg uppercase tracking-tight">
                      Nomis Reputation
                    </h4>
                    <p className="text-xs font-bold text-gray-500">
                      Raw optional provider score; never blended with Kletia
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-xl font-black text-purple-600 dark:text-purple-400">
                    {visibleResult.nomisScore === null
                      ? "Not returned"
                      : `${displayScore(visibleResult.nomisScore)}/100`}
                  </div>
                  <div className="text-xs font-bold text-gray-600 dark:text-slate-400">
                    No Kletia risk classification
                  </div>
                </div>
              </div>

              <div className="bg-white dark:bg-[#131E32] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] p-5 shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <Database className="w-8 h-8 text-blue-500" />
                  <div>
                    <h4 className="font-black text-[#1A1A1A] dark:text-white text-lg uppercase tracking-tight">
                      Blockscout API
                    </h4>
                    <p className="text-xs font-bold text-gray-500">
                      Observed Base rows; internal counterparties excluded from
                      contract count
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-lg font-black text-[#1A1A1A] dark:text-white">
                    {visibleResult.contractsCount.toLocaleString("en-US")} observed
                    contract addresses
                  </div>
                  <div className="text-sm font-bold text-gray-600 dark:text-slate-400">
                    Priced transfer volume: $
                    {Math.round(visibleResult.totalVolumeUsd).toLocaleString(
                      "en-US",
                    )}
                  </div>
                  {visibleResult.volumeStatus === "partial" && (
                    <div className="text-xs font-black text-[#B45309] dark:text-amber-400 mt-1">
                      Partial value
                      {visibleResult.unpricedTokenContracts > 0
                        ? ` — ${visibleResult.unpricedTokenContracts} token contract${visibleResult.unpricedTokenContracts === 1 ? "" : "s"} had no verified Base pair price`
                        : ""}
                      {visibleResult.priceFailedChunks > 0
                        ? ` — ${visibleResult.priceFailedChunks} price request${visibleResult.priceFailedChunks === 1 ? "" : "s"} unavailable`
                        : ""}
                      {visibleResult.activityCompleteness === "partial_capped"
                        ? " — one or more transfer sources were capped"
                        : ""}
                    </div>
                  )}
                </div>
              </div>

              {/* BASENAME + GAS */}
              <div className="bg-white dark:bg-[#131E32] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] p-5 shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <Wallet className="w-8 h-8 text-[#0052FF]" />
                  <div>
                    <h4 className="font-black text-[#1A1A1A] dark:text-white text-lg uppercase tracking-tight">
                      Basename Contract
                    </h4>
                    <p className="text-xs font-bold text-gray-500">
                      Direct Base Mainnet identity contract read
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-lg font-black text-[#1A1A1A] dark:text-white">
                    {visibleResult.basenameStatus === "owned"
                      ? "Basename token observed"
                      : visibleResult.basenameStatus === "not_owned"
                        ? "No Basename token observed"
                        : "Identity read unavailable"}
                  </div>
                  <div className="text-sm font-bold text-gray-600 dark:text-slate-400">
                    Execution gas: ${visibleResult.totalGasSpentUsd.toFixed(2)}{" "}
                    (L1 fee excluded)
                  </div>
                </div>
              </div>

              <div className="bg-white dark:bg-[#131E32] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] p-5 shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <Activity className="w-8 h-8 text-emerald-500" />
                  <div>
                    <h4 className="font-black text-[#1A1A1A] dark:text-white text-lg uppercase tracking-tight">
                      Observed Footprint
                    </h4>
                    <p className="text-xs font-bold text-gray-500">
                      Descriptive activity metrics, not Sybil proof
                    </p>
                  </div>
                </div>
                <div className="flex gap-4 md:gap-8 text-right">
                  <div>
                    <div className="text-lg font-black text-[#1A1A1A] dark:text-white flex items-center justify-end gap-1">
                      <Calendar className="w-4 h-4 text-gray-400" />{" "}
                      {visibleResult.activeMonths}
                    </div>
                    <div className="text-xs font-bold text-gray-500">
                      Active months
                    </div>
                  </div>
                  <div>
                    <div className="text-lg font-black text-[#1A1A1A] dark:text-white flex items-center justify-end gap-1">
                      <Clock className="w-4 h-4 text-gray-400" />{" "}
                      {visibleResult.accountAgeDays === null
                        ? "N/A"
                        : visibleResult.accountAgeDays}
                    </div>
                    <div className="text-xs font-bold text-gray-500">
                      Wallet age days
                    </div>
                  </div>
                  <div>
                    <div className="text-lg font-black text-[#1A1A1A] dark:text-white">
                      {visibleResult.normalTransactionsCapped ? "≥" : ""}
                      {visibleResult.totalTxs.toLocaleString("en-US")}
                    </div>
                    <div className="text-xs font-bold text-gray-500">
                      Normal tx rows
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="lg:col-span-3 mt-4 bg-[#FFD700] dark:bg-[#CCA000] border-[4px] border-[#1A1A1A] dark:border-[#4B5563] p-5 shadow-[6px_6px_0_#1A1A1A] dark:shadow-[6px_6px_0_#475569] flex items-start gap-3">
              <Cpu
                className="w-7 h-7 shrink-0 text-[#1A1A1A]"
                strokeWidth={3}
              />
              <div>
                <div className="font-black uppercase text-[#1A1A1A]">
                  Interpretation Boundary
                </div>
                <p className="text-sm font-bold text-[#1A1A1A] mt-1">
                  These are live descriptive observations for{" "}
                  {visibleResult.address}. Neither score predicts airdrop
                  eligibility, identity, misconduct or future rewards.
                  Unavailable prices and provider scores remain unavailable; no
                  mock value is inserted.
                </p>
                <p className="text-xs font-black text-[#1A1A1A] mt-2">
                  Snapshot:{" "}
                  {new Date(visibleResult.fetchedAt).toLocaleString("en-US")}
                  {" · "}Outgoing dust rows: {visibleResult.dustTxCount}/
                  {visibleResult.outgoingTxCount}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
