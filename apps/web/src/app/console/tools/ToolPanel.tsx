/**
 * Hosts one open tool in the desk's main column (console design 3.10). The
 * tool's component is its own lazy chunk, loaded only when the tool opens.
 * Anything a component used to paste into the old chat now goes through
 * `onPrompt(text, { engine })`: the sentence fills the composer with the
 * tool's network engine pinned, and nothing is sent until the user presses
 * Enter. Solana forms run inside SolanaToolHost; the Coinbase onramp runs its
 * session-token flow here (tools/funding.ts).
 */
import { createElement, lazy, Suspense, useState, type ComponentType, type LazyExoticComponent } from "react";
import { ArrowUpRight, LoaderCircle } from "lucide-react";
import { CHAINS, type NetworkKey } from "@kletia/core";

import { LazyBoundary } from "../../../shared/components/LazyBoundary";
import { BACKEND_URL } from "../../../shared/config/runtime";
import { Button } from "../../site/ui/Button";
import { buttonClasses, cx, INK_BORDER, LABEL, SURFACE } from "../../site/ui/styles";
import { useDeskActions } from "../shell/deskContext";
import type { LegacyNetwork } from "../state/deskModel";
import { TOOLS, type DeskTool } from "./catalogue";
import { requestCoinbaseOnramp } from "./funding";
import { SolanaToolHost } from "./solana/SolanaToolHost";
import { TOOL_COPY } from "./toolCopy";

type AnyComponent = ComponentType<Record<string, unknown>>;

/** Wraps a tool's lazy module as a component (its named export). */
function lazyToolComponent(tool: DeskTool): LazyExoticComponent<AnyComponent> {
  const load = tool.load!;
  const exportName = tool.exportName!;
  return lazy(async () => {
    const module = (await load()) as Record<string, unknown>;
    const exported = module[exportName];
    if (typeof exported !== "function" && (typeof exported !== "object" || exported === null)) {
      throw new Error(`Tool ${tool.id}: ${exportName} is not a component.`);
    }
    return { default: exported as AnyComponent };
  });
}

/** One React.lazy per tool, made once: nothing loads until a tool renders, and reopening reuses the chunk. */
const LAZY_TOOLS: ReadonlyMap<string, LazyExoticComponent<AnyComponent>> = new Map(
  TOOLS.filter((tool) => tool.load && tool.exportName).map((tool) => [tool.id, lazyToolComponent(tool)] as const),
);

function Loading({ title }: { readonly title: string }) {
  return (
    <p role="status" className={cx("flex items-center gap-2 p-4 text-sm font-bold", INK_BORDER, SURFACE)}>
      <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      {TOOL_COPY.loading(title)}
    </p>
  );
}

function Failed({ reload }: { readonly reload: () => void }) {
  return (
    <div role="alert" className={cx("flex flex-col gap-3 p-4", INK_BORDER, SURFACE)}>
      <p className="text-sm font-bold">{TOOL_COPY.failed}</p>
      <Button size="sm" onClick={reload} className="self-start">
        {TOOL_COPY.reload}
      </Button>
    </div>
  );
}

/** Base and Arbitrum One for the address risk check: the scanner takes one network and its chain id. */
function NetworkChoice({
  networks,
  value,
  onChange,
}: {
  readonly networks: readonly NetworkKey[];
  readonly value: NetworkKey;
  readonly onChange: (network: NetworkKey) => void;
}) {
  return (
    <div role="group" aria-label={TOOL_COPY.networkChoice} className="flex flex-wrap items-center gap-2">
      <span className={cx(LABEL, "!text-xs")}>{TOOL_COPY.networkChoice}</span>
      {networks.map((network) => (
        <button
          key={network}
          type="button"
          aria-pressed={value === network}
          onClick={() => onChange(network)}
          className="inline-flex min-h-11 items-center border-2 border-control px-3 text-xs font-black uppercase tracking-wider text-fg focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[var(--kl-focus)] aria-[pressed=true]:bg-[#1A1A1A] aria-[pressed=true]:text-white dark:aria-[pressed=true]:bg-[#F1F5F9] dark:aria-[pressed=true]:text-[#0B1120]"
        >
          {CHAINS[network].name}
        </button>
      ))}
    </div>
  );
}

function OnrampPanel() {
  const actions = useDeskActions();
  const address = actions.accounts.evm?.address ?? null;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const open = async () => {
    if (!address) return;
    setBusy(true);
    setProblem(null);
    const result = await requestCoinbaseOnramp(address, { backendUrl: BACKEND_URL });
    setBusy(false);
    if (!result.ok) {
      setProblem(result.reason);
      return;
    }
    // With noopener the browser returns null even when the tab opened, so the result is not checked.
    window.open(result.url, "_blank", "noopener,noreferrer");
  };
  return (
    <div className={cx("flex flex-col gap-3 p-4", INK_BORDER, SURFACE)}>
      <p className="text-sm">{TOOL_COPY.onramp.lead}</p>
      {address ? (
        <Button onClick={() => void open()} loading={busy} className="self-start">
          <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
          {TOOL_COPY.onramp.open}
        </Button>
      ) : (
        <>
          <p className="text-sm font-semibold">{TOOL_COPY.onramp.connectLead}</p>
          <Button onClick={() => actions.openWallet("eip155")} className="self-start">
            {TOOL_COPY.onramp.connect}
          </Button>
        </>
      )}
      {problem ? (
        <p role="alert" className="text-sm font-bold text-[#B91C1C] dark:text-[#FCA5A5]">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

/** Renders a tool's lazy component (made once at module load, see LAZY_TOOLS) with the props the host adapted. */
function LoadedTool({ toolId, props }: { readonly toolId: string; readonly props: Record<string, unknown> }) {
  const component = LAZY_TOOLS.get(toolId);
  return component ? createElement(component, props) : null;
}

function HostedComponent({ tool, onPrompt }: { readonly tool: DeskTool; readonly onPrompt: (text: string) => void }) {
  const [network, setNetwork] = useState<NetworkKey>(tool.networks[0] ?? "base");
  const props: Record<string, unknown> = {};
  if (tool.promptProp) props[tool.promptProp] = onPrompt;
  if (tool.networkProp) {
    props.network = network;
    props.chainId = CHAINS[network].evmChainId;
  }
  if (tool.host === "solana") {
    return (
      <SolanaToolHost needsWallet={tool.needs === "solana"}>
        {({ owner, portfolio }) => <LoadedTool toolId={tool.id} props={{ ...props, owner, portfolio }} />}
      </SolanaToolHost>
    );
  }
  if (tool.networkProp && tool.networks.length > 1) {
    return (
      <div className="flex flex-col gap-4">
        <NetworkChoice networks={tool.networks} value={network} onChange={setNetwork} />
        <LoadedTool key={network} toolId={tool.id} props={props} />
      </div>
    );
  }
  return <LoadedTool toolId={tool.id} props={props} />;
}

export interface ToolPanelProps {
  readonly tool: DeskTool;
}

/** The body of an open panel, form, read-only or onramp tool. */
export function ToolPanel({ tool }: ToolPanelProps) {
  const actions = useDeskActions();
  const [filled, setFilled] = useState(false);
  const engine: LegacyNetwork | null = tool.engine;
  const onPrompt = (text: string) => {
    actions.fill(text, { engine });
    setFilled(true);
  };

  if (tool.flow === "coinbase-onramp") return <OnrampPanel />;
  if (tool.kind === "link" && tool.href) {
    // A deep link to a link tool (/app/tools/arc-faucet): the destination, one click away.
    return (
      <a
        href={tool.href}
        {...(tool.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        className={cx(buttonClasses("primary", "md"), "self-start")}
      >
        {tool.title}
        {tool.external ? <ArrowUpRight className="h-4 w-4" aria-hidden="true" /> : null}
        {tool.external ? <span className="sr-only"> ({TOOL_COPY.opensInNewTab})</span> : null}
      </a>
    );
  }
  if (!tool.load) return null;

  return (
    <div className="flex flex-col gap-4">
      {engine && tool.promptProp ? (
        <p className="text-sm text-muted">{TOOL_COPY.promptHint(TOOL_COPY.engineNames[engine])}</p>
      ) : null}
      <p className="sr-only" role="status" aria-live="polite">
        {filled ? TOOL_COPY.promptFilled : ""}
      </p>
      <LazyBoundary resetKey={tool.id} fallback={(reload) => <Failed reload={reload} />}>
        <Suspense fallback={<Loading title={tool.title} />}>
          <HostedComponent tool={tool} onPrompt={onPrompt} />
        </Suspense>
      </LazyBoundary>
    </div>
  );
}
