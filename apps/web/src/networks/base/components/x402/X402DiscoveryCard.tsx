import {
  ArrowRight,
  BadgeCheck,
  CircleAlert,
  ExternalLink,
  Search,
  ShieldCheck,
} from "lucide-react";

import type { BaseX402Search, BaseX402Service } from "../../../../shared/types";

type Props = {
  services: BaseX402Service[];
  search: BaseX402Search;
  trustNotice?: string;
  onSeed: (prompt: string) => void;
};

const intentTemplate = (service: BaseX402Service): string => {
  const requestUrl = service.requestUrl || service.resource;
  if (service.method === "GET") {
    return (
      `Call ${requestUrl} with x402 on Base using GET ` +
      `and pay at most ${service.amount} USDC`
    );
  }
  if (service.method === "POST") {
    return (
      `Call ${requestUrl} with x402 on Base using POST, ` +
      `pay at most ${service.amount} USDC, and ask me for the JSON request body`
    );
  }
  return (
    `Prepare an x402 call to ${requestUrl} on Base, ` +
    `pay at most ${service.amount} USDC, and ask me whether it is GET or POST ` +
    "and for any required input"
  );
};

const resourceHost = (resource: string): string => {
  try {
    return new URL(resource).hostname;
  } catch {
    return "invalid-resource";
  }
};

export function X402DiscoveryCard({
  services,
  search,
  trustNotice,
  onSeed,
}: Props) {
  return (
    <div className="mt-5 flex w-full flex-col gap-4 border-[3px] border-[#1A1A1A] bg-white p-4 text-[#1A1A1A] shadow-[4px_4px_0_#1A1A1A] dark:border-[#4B5563] dark:bg-[#0F172A] dark:text-white dark:shadow-[4px_4px_0_#475569] sm:w-80 md:w-[520px] md:p-5">
      <div className="flex items-start justify-between gap-3 border-b-[3px] border-[#1A1A1A] pb-3 dark:border-[#4B5563]">
        <div>
          <div className="flex items-center gap-2 text-sm font-black uppercase tracking-widest">
            <Search className="h-5 w-5 text-[#0052FF]" />
            CDP Bazaar Router
          </div>
          <p className="mt-1 text-xs font-bold text-gray-600 dark:text-slate-300">
            Relevance-ranked discovery; every result is rechecked for Base
            Mainnet USDC and your cap.
          </p>
        </div>
        <span className="shrink-0 border-[2px] border-[#1A1A1A] bg-[#0052FF] px-2 py-1 text-[9px] font-black uppercase text-white">
          {search.method}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs font-bold">
        <div className="border-[2px] border-[#1A1A1A] bg-[#EAF0FF] p-2 text-[#1A1A1A] dark:border-[#4B5563]">
          <span className="block text-[9px] font-black uppercase text-gray-500">
            Payment ceiling
          </span>
          {search.maxPayment} USDC
        </div>
        <div className="border-[2px] border-[#1A1A1A] bg-[#EAF0FF] p-2 text-[#1A1A1A] dark:border-[#4B5563]">
          <span className="block text-[9px] font-black uppercase text-gray-500">
            Scope
          </span>
          Base / exact / USDC
        </div>
      </div>

      {services.length === 0 ? (
        <div className="flex items-start gap-2 border-[3px] border-[#1A1A1A] bg-[#FFD166] p-3 text-sm font-bold text-[#1A1A1A]">
          <CircleAlert className="mt-0.5 h-5 w-5 shrink-0" />
          No compatible service survived the network, asset, URL and price
          checks. Narrow the request or raise the cap explicitly.
        </div>
      ) : (
        <div className="space-y-3">
          {services.map((service) => (
            <article
              key={`${service.resource}:${service.payTo}:${service.amountAtomic}`}
              className="border-[3px] border-[#1A1A1A] bg-[#F8FAFC] p-3 text-[#1A1A1A] dark:border-[#4B5563] dark:bg-[#172033] dark:text-white"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 truncate font-mono text-[11px] font-black text-[#0052FF]">
                  {resourceHost(service.resource)}
                </span>
                <div className="flex items-center gap-1.5">
                  <span className="border-[2px] border-[#1A1A1A] bg-white px-1.5 py-0.5 text-[9px] font-black uppercase text-[#1A1A1A]">
                    {service.method || "METHOD REQUIRED"}
                  </span>
                  {service.requestUrl && (
                    <span className="border-[2px] border-[#1A1A1A] bg-[#EAF0FF] px-1.5 py-0.5 text-[9px] font-black uppercase text-[#1A1A1A]">
                      Bazaar example input
                    </span>
                  )}
                  <span
                    className={`flex items-center gap-1 border-[2px] border-[#1A1A1A] px-1.5 py-0.5 text-[9px] font-black uppercase text-[#1A1A1A] ${
                      service.curated ? "bg-[#86EFAC]" : "bg-[#FFD166]"
                    }`}
                  >
                    {service.curated ? (
                      <BadgeCheck className="h-3 w-3" />
                    ) : (
                      <CircleAlert className="h-3 w-3" />
                    )}
                    {service.curated ? "CDP curated" : "unverified listing"}
                  </span>
                </div>
              </div>

              <p className="mt-2 text-xs font-bold text-gray-700 dark:text-slate-200">
                {service.description}
              </p>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t-[2px] border-[#1A1A1A] pt-2 dark:border-[#4B5563]">
                <div>
                  <span className="block text-[9px] font-black uppercase text-gray-500">
                    Exact advertised price
                  </span>
                  <span className="text-sm font-black">
                    {service.amount} USDC
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <a
                    href={service.requestUrl || service.resource}
                    target="_blank"
                    rel="noreferrer"
                    className="border-[2px] border-[#1A1A1A] bg-white p-2 text-[#1A1A1A] hover:bg-gray-100"
                    aria-label="Open advertised x402 resource without paying"
                    title="Open resource; the server may answer HTTP 402"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </a>
                  <button
                    type="button"
                    onClick={() => onSeed(intentTemplate(service))}
                    className="flex items-center gap-2 border-[3px] border-[#1A1A1A] bg-[#0052FF] px-3 py-2 text-[10px] font-black uppercase text-white shadow-[2px_2px_0_#1A1A1A] active:translate-y-0.5 active:shadow-none"
                  >
                    Build intent
                    <ArrowRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      <div className="flex items-start gap-2 border-[2px] border-[#1A1A1A] bg-[#E2E8F0] p-3 text-[11px] font-bold text-[#1A1A1A]">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#0052FF]" />
        <span>
          {trustNotice ||
            "Discovery is not execution. The selected service becomes an intent draft and still requires an explicit Base Account approval."}
          {search.partialResults
            ? " CDP reported more matches; refine the query instead of trusting a truncated list."
            : ""}
        </span>
      </div>
    </div>
  );
}
