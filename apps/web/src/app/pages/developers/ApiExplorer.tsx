import {
  assetsForNetwork,
  CHAINS,
  formatAccountId,
  NETWORK_KEYS,
  type NetworkKey,
} from "@kletia/core";
import { KletiaApiError } from "@kletia/sdk";
import { Play } from "lucide-react";
import React, { useId, useMemo, useRef, useState } from "react";

import { PLATFORM_ORIGIN, PREVIEW_ACCOUNTS } from "../../../shared/platform/kletiaClient";
import { rawPlatformRequest, type RawExchange } from "../../../shared/platform/platformApi";
import { useApiAction } from "../../../shared/platform/useApiResource";
import { INTENT_EXAMPLES } from "../../site/snippets";
import { ApiErrorPanel } from "../../site/ui/ApiErrorPanel";
import { Badge } from "../../site/ui/Badge";
import { Button } from "../../site/ui/Button";
import { CodeBlock } from "../../site/ui/CodeBlock";
import { SelectField, TextAreaField, TextField } from "../../site/ui/Field";
import { JsonView } from "../../site/ui/JsonView";
import { cx, FOCUS_RING, HARD_SHADOW, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../site/ui/styles";
import { nextTabIndex } from "../../site/ui/tabKeys";

type EndpointId = "networks" | "protocols" | "quotes" | "intents";

interface ExplorerEndpoint {
  readonly id: EndpointId;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly description: string;
}

const ENDPOINTS: readonly ExplorerEndpoint[] = [
  { id: "networks", method: "GET", path: "/networks", description: "Chain registry plus per-network capabilities." },
  { id: "protocols", method: "GET", path: "/protocols", description: "Protocol registry with categories, networks and capabilities." },
  { id: "quotes", method: "POST", path: "/quotes", description: "Best routes for one asset movement, same- or cross-network." },
  {
    id: "intents",
    method: "POST",
    path: "/intents?dryRun=true",
    description: "Plan an intent into an IntentGraph without persisting it.",
  },
];

const NETWORK_OPTIONS = NETWORK_KEYS.map((key) => ({ value: key, label: CHAINS[key].name }));

function assetOptions(network: NetworkKey) {
  return assetsForNetwork(network).map((asset) => ({ value: asset.symbol, label: `${asset.symbol} — ${asset.name}` }));
}

function previewAccountFor(network: NetworkKey): string {
  const address =
    CHAINS[network].vm === "svm"
      ? PREVIEW_ACCOUNTS.solana.slice(PREVIEW_ACCOUNTS.solana.lastIndexOf(":") + 1)
      : PREVIEW_ACCOUNTS.evm.slice(PREVIEW_ACCOUNTS.evm.lastIndexOf(":") + 1);
  return formatAccountId(network, address);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

function curlFor(method: "GET" | "POST", path: string, body: unknown): string {
  const url = `${PLATFORM_ORIGIN}/v1${path}`;
  if (method === "GET") return `curl -s ${shellQuote(url)}`;
  return [
    `curl -s -X POST ${shellQuote(url)} \\`,
    `  -H "content-type: application/json" \\`,
    `  -d ${shellQuote(JSON.stringify(body, null, 2))}`,
  ].join("\n");
}

function StatusLine({ exchange }: { exchange: RawExchange }) {
  const tone = exchange.status >= 500 ? "red" : exchange.status >= 400 ? "yellow" : "green";
  return (
    <div className="flex flex-wrap items-center gap-2 font-code text-xs">
      <Badge tone={tone}>
        {exchange.status} {exchange.statusText}
      </Badge>
      <span className="border-2 border-[#1A1A1A] px-1.5 py-0.5 dark:border-[#4B5563]">{exchange.latencyMs} ms</span>
      {exchange.requestId ? (
        <span className="min-w-0 truncate text-[#45464B] dark:text-[#A9B6C8]" title={exchange.requestId}>
          x-request-id: {exchange.requestId}
        </span>
      ) : null}
    </div>
  );
}

/** Interactive explorer for the public read and planning endpoints. */
export function ApiExplorer() {
  const baseId = useId();
  const [active, setActive] = useState<EndpointId>("intents");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const [quote, setQuote] = useState({
    fromNetwork: "base" as NetworkKey,
    fromAsset: "USDC",
    amount: "10",
    toNetwork: "solana" as NetworkKey,
    toAsset: "USDC",
    slippageBps: "50",
  });
  const [intentText, setIntentText] = useState(INTENT_EXAMPLES[2]!);
  const [accountsText, setAccountsText] = useState(`${PREVIEW_ACCOUNTS.evm}\n${PREVIEW_ACCOUNTS.solana}`);

  const [responseFor, setResponseFor] = useState<EndpointId | null>(null);
  const action = useApiAction(async (_client, signal, method: "GET" | "POST", path: string, body: unknown) => {
    try {
      return await rawPlatformRequest(method, path, body, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      const timedOut = (error as Error)?.name === "TimeoutError";
      throw new KletiaApiError({
        code: timedOut ? "REQUEST_TIMEOUT" : "NETWORK_ERROR",
        message: timedOut ? "The Kletia API did not respond in time." : "The Kletia API is unreachable.",
        status: 0,
      });
    }
  });

  const endpoint = ENDPOINTS.find((item) => item.id === active)!;

  const body = useMemo(() => {
    if (active === "quotes") {
      const slippage = Number.parseInt(quote.slippageBps, 10);
      return {
        from: { network: quote.fromNetwork, asset: quote.fromAsset, amount: quote.amount.trim() },
        to: { network: quote.toNetwork, asset: quote.toAsset },
        account: previewAccountFor(quote.fromNetwork),
        ...(Number.isFinite(slippage) ? { slippageBps: slippage } : {}),
      };
    }
    if (active === "intents") {
      return {
        text: intentText.trim(),
        accounts: accountsText
          .split(/\s+/u)
          .map((line) => line.trim())
          .filter(Boolean),
      };
    }
    return undefined;
  }, [active, quote, intentText, accountsText]);

  const send = (event?: React.FormEvent) => {
    event?.preventDefault();
    setResponseFor(active);
    void action.run(endpoint.method, endpoint.path, body);
  };

  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = nextTabIndex(event.key, index, ENDPOINTS.length);
    if (next === null) return;
    event.preventDefault();
    setActive(ENDPOINTS[next]!.id);
    tabRefs.current[next]?.focus();
  };

  const showing = responseFor === active;
  const exchange = showing && action.status === "success" ? action.data : undefined;

  return (
    <div className={cx("min-w-0", INK_BORDER, HARD_SHADOW, SURFACE)}>
      <div
        role="tablist"
        aria-label="Endpoints"
        className="flex overflow-x-auto border-b-[3px] border-[#1A1A1A] bg-[#F1EFE8] dark:border-[#4B5563] dark:bg-[#0F1A2C]"
      >
        {ENDPOINTS.map((item, index) => {
          const selected = item.id === active;
          return (
            <button
              key={item.id}
              ref={(element) => {
                tabRefs.current[index] = element;
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${item.id}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(item.id)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
              className={cx(
                "flex min-h-14 shrink-0 items-center gap-2 border-r-[3px] border-[#1A1A1A] px-4 font-code text-xs font-bold dark:border-[#4B5563]",
                selected ? "bg-[#1A1A1A] text-white dark:bg-[#FFD60A] dark:text-[#1A1A1A]" : "hover:bg-white dark:hover:bg-[#1A2841]",
                FOCUS_RING,
                "focus-visible:-outline-offset-4",
              )}
            >
              <span className={cx("px-1.5 py-0.5 text-[10px]", item.method === "GET" ? "bg-[#14F195] text-[#0B1120]" : "bg-[#0052FF] text-white")}>
                {item.method}
              </span>
              /v1{item.path}
            </button>
          );
        })}
      </div>

      <div
        id={`${baseId}-panel`}
        role="tabpanel"
        aria-labelledby={`${baseId}-tab-${active}`}
        className="grid min-w-0 lg:grid-cols-2"
      >
        <form
          onSubmit={send}
          className="flex min-w-0 flex-col gap-5 border-b-[3px] border-[#1A1A1A] p-5 dark:border-[#4B5563] lg:border-b-0 lg:border-r-[3px] sm:p-6"
          aria-label={`Request for ${endpoint.method} /v1${endpoint.path}`}
        >
          <div>
            <p className={cx(LABEL, TEXT_MUTED)}>Request</p>
            <p className="mt-1 text-sm">{endpoint.description}</p>
          </div>

          {active === "quotes" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField
                label="From network"
                value={quote.fromNetwork}
                options={NETWORK_OPTIONS}
                onChange={(event) => {
                  const network = event.target.value as NetworkKey;
                  const assets = assetsForNetwork(network);
                  setQuote((previous) => ({
                    ...previous,
                    fromNetwork: network,
                    fromAsset: assets.some((asset) => asset.symbol === previous.fromAsset)
                      ? previous.fromAsset
                      : (assets[0]?.symbol ?? ""),
                  }));
                }}
              />
              <SelectField
                label="From asset"
                value={quote.fromAsset}
                options={assetOptions(quote.fromNetwork)}
                onChange={(event) => setQuote((previous) => ({ ...previous, fromAsset: event.target.value }))}
              />
              <TextField
                label="Amount"
                inputMode="decimal"
                value={quote.amount}
                onChange={(event) => setQuote((previous) => ({ ...previous, amount: event.target.value }))}
                hint="Human units, e.g. 10 or 0.5"
                mono
              />
              <TextField
                label="Slippage (bps)"
                inputMode="numeric"
                value={quote.slippageBps}
                onChange={(event) => setQuote((previous) => ({ ...previous, slippageBps: event.target.value }))}
                mono
              />
              <SelectField
                label="To network"
                value={quote.toNetwork}
                options={NETWORK_OPTIONS}
                onChange={(event) => {
                  const network = event.target.value as NetworkKey;
                  const assets = assetsForNetwork(network);
                  setQuote((previous) => ({
                    ...previous,
                    toNetwork: network,
                    toAsset: assets.some((asset) => asset.symbol === previous.toAsset)
                      ? previous.toAsset
                      : (assets[0]?.symbol ?? ""),
                  }));
                }}
              />
              <SelectField
                label="To asset"
                value={quote.toAsset}
                options={assetOptions(quote.toNetwork)}
                onChange={(event) => setQuote((previous) => ({ ...previous, toAsset: event.target.value }))}
              />
              <p className={cx("text-xs sm:col-span-2", TEXT_MUTED)}>
                Signs as the preview account <code className="break-all font-code">{previewAccountFor(quote.fromNetwork)}</code>.
              </p>
            </div>
          ) : null}

          {active === "intents" ? (
            <div className="flex flex-col gap-4">
              <TextAreaField
                label="Intent"
                rows={3}
                value={intentText}
                onChange={(event) => setIntentText(event.target.value)}
                mono
              />
              <div className="flex flex-wrap gap-2" aria-label="Example intents" role="group">
                {INTENT_EXAMPLES.map((example) => (
                  <button
                    key={example}
                    type="button"
                    onClick={() => setIntentText(example)}
                    aria-pressed={intentText === example}
                    className={cx(
                      "border-2 border-[#1A1A1A] px-2 py-1 text-left font-code text-[11px] dark:border-[#4B5563]",
                      intentText === example ? "bg-[#FFD60A] text-[#1A1A1A]" : "bg-white hover:bg-[#FFF7CC] dark:bg-[#0B1120] dark:hover:bg-[#1A2841]",
                      FOCUS_RING,
                    )}
                  >
                    {example}
                  </button>
                ))}
              </div>
              <TextAreaField
                label="Accounts (CAIP-10, one per line)"
                rows={4}
                value={accountsText}
                onChange={(event) => setAccountsText(event.target.value)}
                hint="Preview accounts by default. A dry run never moves funds."
                mono
                spellCheck={false}
              />
            </div>
          ) : null}

          {active === "networks" || active === "protocols" ? (
            <p className={cx("text-sm", TEXT_MUTED)}>No parameters. Public endpoint, no key required.</p>
          ) : null}

          <CodeBlock code={curlFor(endpoint.method, endpoint.path, body)} language="bash" label="Equivalent curl" filename="curl" maxHeightClassName="max-h-60" />

          <Button type="submit" size="lg" disabled={action.status === "loading"} className="self-start">
            <Play className="h-4 w-4" aria-hidden="true" />
            {action.status === "loading" && showing ? "Sending…" : "Send request"}
          </Button>
        </form>

        <div className="flex min-w-0 flex-col gap-4 p-5 sm:p-6" aria-live="polite" aria-busy={showing && action.status === "loading"}>
          <p className={cx(LABEL, TEXT_MUTED)}>Response</p>
          {!showing || action.status === "idle" ? (
            <div className="flex flex-1 items-center justify-center border-[3px] border-dashed border-[#1A1A1A]/30 p-8 text-center text-sm text-[#45464B] dark:border-white/15 dark:text-[#A9B6C8]">
              Send the request to see the live response from {PLATFORM_ORIGIN}.
            </div>
          ) : action.status === "loading" ? (
            <div className="flex flex-1 items-center justify-center border-[3px] border-dashed border-[#1A1A1A]/30 p-8 text-sm font-bold dark:border-white/15">
              Waiting for {endpoint.method} /v1{endpoint.path}…
            </div>
          ) : action.status === "error" && action.error ? (
            <ApiErrorPanel error={action.error} title="No response" onRetry={() => send()} />
          ) : exchange ? (
            <>
              <StatusLine exchange={exchange} />
              <JsonView value={exchange.body} label={`Response body of ${endpoint.method} /v1${endpoint.path}`} maxHeightClassName="max-h-[34rem]" />
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
