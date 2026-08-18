import { useEffect, useRef, useState } from "react";
import {
  Bot,
  CircleAlert,
  Loader2,
  Search,
  ServerCog,
  Sparkles,
} from "lucide-react";
import { formatUnits, parseUnits } from "viem";

import { NETWORKS } from "../../../../shared/config/networks";
import {
  isBaseX402Search,
  isBaseX402Service,
  type BaseX402Search,
  type BaseX402Service,
} from "../../../../shared/types";
import { X402ConsoleWidget } from "./X402ConsoleWidget";
import { X402AttestationRegistryStatus } from "./X402AttestationRegistryStatus";
import { X402DiscoveryCard } from "./X402DiscoveryCard";
import { containsSensitivePromptMaterial } from "../../../../shared/security/promptSecrets";
import { BACKEND_URL } from "../../../../shared/config/runtime";

const USDC_PATTERN = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1_048_576;

type Props = {
  onIntentTemplate: (prompt: string) => void;
};

type DiscoveryResult = {
  services: BaseX402Service[];
  search: BaseX402Search;
  trustNotice?: string;
};

type DiscoveryRequestSnapshot = {
  query: string;
  curatedOnly: boolean;
  maxPayment: string;
  maxPaymentAtomic: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isVisibleQuery = (value: string): boolean =>
  value.length >= 2 &&
  value.length <= 120 &&
  [...value].every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint > 31 && codePoint !== 127;
  });

const readBoundedJson = async (response: Response): Promise<unknown> => {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("x402 discovery returned an empty response.");
  const decoder = new TextDecoder();
  let body = "";
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("x402 discovery response exceeded the safe size limit.");
    }
    body += decoder.decode(value, { stream: true });
  }
  body += decoder.decode();
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error("x402 discovery returned invalid JSON.");
  }
};

const validateDiscoveryEnvelope = (
  value: unknown,
  expected: DiscoveryRequestSnapshot,
): DiscoveryResult => {
  if (
    !isRecord(value) ||
    value.success !== true ||
    value.network !== "base" ||
    value.chainId !== NETWORKS.base.chainId ||
    !isRecord(value.data) ||
    value.data.executionKind !== "base_x402_discovery" ||
    value.data.provider !== "Coinbase CDP Bazaar" ||
    !Array.isArray(value.data.services) ||
    !value.data.services.every(isBaseX402Service) ||
    !isBaseX402Search(value.data.search) ||
    value.data.search.query !== expected.query ||
    value.data.search.curatedOnly !== expected.curatedOnly ||
    value.data.search.maxPayment !== expected.maxPayment ||
    value.data.search.maxPaymentAtomic !== expected.maxPaymentAtomic ||
    value.data.services.some(
      (service) =>
        BigInt(service.amountAtomic) > BigInt(expected.maxPaymentAtomic) ||
        (expected.curatedOnly && service.curated !== true),
    ) ||
    (value.data.trustNotice !== undefined &&
      typeof value.data.trustNotice !== "string")
  ) {
    throw new Error(
      "x402 discovery response did not match the Base Mainnet safety contract.",
    );
  }
  return {
    services: value.data.services,
    search: value.data.search,
    trustNotice: value.data.trustNotice as string | undefined,
  };
};

const quickQueries = [
  "wallet risk and security report",
  "market and token data",
  "weather or travel data",
  "AI text and productivity utility",
] as const;

export function X402ServiceRouter({ onIntentTemplate }: Props) {
  const [query, setQuery] = useState<string>(quickQueries[0]);
  const [maxPayment, setMaxPayment] = useState("0.05");
  const [curatedOnly, setCuratedOnly] = useState(true);
  const [result, setResult] = useState<DiscoveryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const requestRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      requestRef.current?.abort();
      requestRef.current = null;
    },
    [],
  );

  const discover = async () => {
    const normalizedQuery = query.trim();
    const normalizedCap = maxPayment.trim();
    setError(null);
    setResult(null);
    if (!isVisibleQuery(normalizedQuery)) {
      setError("Describe the service in 2–120 visible characters.");
      return;
    }
    if (containsSensitivePromptMaterial(normalizedQuery)) {
      setError(
        "Do not include private keys, seed phrases, or API credentials in discovery.",
      );
      return;
    }
    if (!USDC_PATTERN.test(normalizedCap)) {
      setError("Use a positive USDC cap with at most 6 decimals.");
      return;
    }
    let maxPaymentAtomic: bigint;
    try {
      maxPaymentAtomic = parseUnits(normalizedCap, 6);
      if (maxPaymentAtomic <= 0n) {
        setError("The USDC payment cap must be greater than zero.");
        return;
      }
    } catch {
      setError("The USDC payment cap is invalid.");
      return;
    }

    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const timeout = window.setTimeout(
      () => controller.abort(),
      FETCH_TIMEOUT_MS,
    );
    setIsSearching(true);
    try {
      const snapshot: DiscoveryRequestSnapshot = {
        query: normalizedQuery,
        maxPayment: formatUnits(maxPaymentAtomic, 6),
        maxPaymentAtomic: maxPaymentAtomic.toString(),
        curatedOnly,
      };
      const response = await fetch(`${BACKEND_URL}/api/base/x402/services`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Kletia-Network": "base",
          "X-Kletia-Chain-Id": String(NETWORKS.base.chainId),
        },
        body: JSON.stringify({
          query: snapshot.query,
          maxPayment: snapshot.maxPayment,
          curatedOnly: snapshot.curatedOnly,
        }),
        signal: controller.signal,
        redirect: "error",
        credentials: "omit",
      });
      const payload = await readBoundedJson(response);
      if (requestRef.current !== controller) return;
      if (!response.ok) {
        const code =
          isRecord(payload) && typeof payload.code === "string"
            ? payload.code
            : "";
        if (code === "X402_DISCOVERY_SENSITIVE_QUERY") {
          throw new Error("Discovery rejected sensitive credential material.");
        }
        throw new Error(
          `x402 discovery was rejected (HTTP ${response.status}).`,
        );
      }
      setResult(validateDiscoveryEnvelope(payload, snapshot));
    } catch (searchError) {
      if (requestRef.current !== controller) return;
      if ((searchError as Error).name === "AbortError") {
        setError("CDP Bazaar search timed out or was safely cancelled.");
      } else {
        const controlledMessage =
          searchError instanceof Error &&
          (searchError.message.startsWith("x402 discovery ") ||
            searchError.message.startsWith("Discovery rejected ") ||
            searchError.message.startsWith("CDP Bazaar "))
            ? searchError.message
            : "CDP Bazaar search is unavailable.";
        setError(controlledMessage);
      }
    } finally {
      window.clearTimeout(timeout);
      if (requestRef.current === controller) {
        requestRef.current = null;
        setIsSearching(false);
      }
    }
  };

  return (
    <div className="w-full overflow-y-auto p-4 md:p-8 custom-scrollbar">
      <div className="mx-auto w-full max-w-5xl space-y-8">
        <section className="border-[4px] border-[#1A1A1A] bg-white p-5 shadow-[8px_8px_0_#1A1A1A] dark:border-[#4B5563] dark:bg-[#131E32] dark:shadow-[8px_8px_0_#475569] md:p-6">
          <div className="flex flex-col justify-between gap-4 md:flex-row md:items-start">
            <div>
              <h1 className="flex items-center gap-3 text-2xl font-black uppercase text-[#1A1A1A] dark:text-white md:text-3xl">
                <Sparkles className="text-[#0052FF]" />
                x402 Service Router
              </h1>
              <p className="mt-2 max-w-3xl text-sm font-bold text-gray-600 dark:text-slate-300">
                Find useful paid APIs through Coinbase CDP Bazaar, enforce a
                Base USDC ceiling, then turn one result into a normal Kletia
                sentence. Discovery never spends funds.
              </p>
            </div>
            <span className="w-fit border-[3px] border-[#1A1A1A] bg-[#86EFAC] px-3 py-1 text-[10px] font-black uppercase text-[#1A1A1A]">
              Buyer mode / read only
            </span>
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-[1fr_150px_auto]">
            <label className="block">
              <span className="mb-1 block text-[10px] font-black uppercase text-gray-500">
                What do you need?
              </span>
              <input
                value={query}
                maxLength={120}
                onChange={(event) => setQuery(event.target.value)}
                className="w-full border-[3px] border-[#1A1A1A] bg-[#F8FAFC] p-3 text-sm font-black text-[#1A1A1A] outline-none focus:bg-[#EAF0FF] dark:border-[#4B5563]"
                placeholder="wallet risk, weather, research…"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] font-black uppercase text-gray-500">
                Max USDC / call
              </span>
              <input
                value={maxPayment}
                maxLength={20}
                inputMode="decimal"
                onChange={(event) => setMaxPayment(event.target.value)}
                className="w-full border-[3px] border-[#1A1A1A] bg-[#F8FAFC] p-3 text-sm font-black text-[#1A1A1A] outline-none focus:bg-[#EAF0FF] dark:border-[#4B5563]"
                placeholder="0.05"
              />
            </label>
            <button
              type="button"
              disabled={isSearching}
              onClick={() => void discover()}
              className="mt-auto flex items-center justify-center gap-2 border-[3px] border-[#1A1A1A] bg-[#0052FF] px-5 py-3 text-xs font-black uppercase text-white shadow-[4px_4px_0_#1A1A1A] active:translate-y-0.5 active:shadow-none disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSearching ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Search className="h-4 w-4" />
              )}
              {isSearching ? "Searching" : "Find services"}
            </button>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {quickQueries.map((quickQuery) => (
              <button
                key={quickQuery}
                type="button"
                onClick={() => setQuery(quickQuery)}
                className="border-[2px] border-[#1A1A1A] bg-[#E2E8F0] px-2 py-1 text-[9px] font-black uppercase text-[#1A1A1A] hover:bg-[#FFD166]"
              >
                {quickQuery}
              </button>
            ))}
            <label className="ml-auto flex cursor-pointer items-center gap-2 text-[10px] font-black uppercase text-gray-600 dark:text-slate-300">
              <input
                type="checkbox"
                checked={curatedOnly}
                onChange={(event) => setCuratedOnly(event.target.checked)}
                className="h-4 w-4 accent-[#0052FF]"
              />
              Coinbase-curated only
            </label>
          </div>

          <X402AttestationRegistryStatus />

          {error && (
            <div className="mt-4 flex items-start gap-2 border-[3px] border-[#1A1A1A] bg-[#FF6B6B] p-3 text-sm font-black text-[#1A1A1A]">
              <CircleAlert className="mt-0.5 h-5 w-5 shrink-0" />
              {error}
            </div>
          )}

          {result && (
            <X402DiscoveryCard
              services={result.services}
              search={result.search}
              trustNotice={result.trustNotice}
              onSeed={onIntentTemplate}
            />
          )}
        </section>

        <section className="grid gap-4 md:grid-cols-2">
          <div className="border-[4px] border-[#1A1A1A] bg-[#EAF0FF] p-5 text-[#1A1A1A] shadow-[6px_6px_0_#1A1A1A]">
            <h2 className="flex items-center gap-2 text-lg font-black uppercase">
              <Bot className="h-5 w-5 text-[#0052FF]" />
              Official agent handoff
            </h2>
            <p className="mt-2 text-sm font-bold">
              The intent engine compiles a two-step Base MCP plan: initiate,
              show the Base Account approval link, then complete only after
              approval. Kletia never creates a custodial agent wallet.
            </p>
            <button
              type="button"
              onClick={() =>
                onIntentTemplate(
                  "Find a useful Coinbase-curated x402 service on Base for wallet security and cap one call at 0.05 USDC",
                )
              }
              className="mt-4 border-[3px] border-[#1A1A1A] bg-white px-3 py-2 text-[10px] font-black uppercase shadow-[3px_3px_0_#1A1A1A] active:translate-y-0.5 active:shadow-none"
            >
              Start from one sentence
            </button>
          </div>
          <div className="border-[4px] border-[#1A1A1A] bg-[#FFD166] p-5 text-[#1A1A1A] shadow-[6px_6px_0_#1A1A1A]">
            <h2 className="flex items-center gap-2 text-lg font-black uppercase">
              <ServerCog className="h-5 w-5" />
              Seller Studio below
            </h2>
            <p className="mt-2 text-sm font-bold">
              The gateway console is for service owners testing Kletia’s
              payment-required endpoint. It is separate from Bazaar buyer
              results and never turns arbitrary API content into an executable
              wallet instruction.
            </p>
          </div>
        </section>

        <section className="border-t-[5px] border-[#1A1A1A] pt-8 dark:border-[#4B5563]">
          <X402ConsoleWidget />
        </section>
      </div>
    </div>
  );
}
