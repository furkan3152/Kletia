import { CHAINS } from "@kletia/core";
import { Check, PenLine, Radio } from "lucide-react";
import React from "react";

import { cx } from "../../site/ui/styles";

const PROMPT = "bridge 50 USDC from Base to Solana and stake it as JitoSOL";
const TYPE_START_MS = 500;
const CHAR_MS = 34;
const TYPED_MS = TYPE_START_MS + PROMPT.length * CHAR_MS;
const COMPILED_MS = TYPED_MS + 350;
const NODE_STAGGER_MS = 260;

const delay = (ms: number): React.CSSProperties => ({ animationDelay: `${ms}ms` });
const nodeDelay = (index: number) => delay(COMPILED_MS + 200 + index * NODE_STAGGER_MS);
const FLOW_START = COMPILED_MS + 200 + 5 * NODE_STAGGER_MS;

interface AssetNodeProps {
  readonly network: "base" | "solana";
  readonly title: string;
  readonly detail: string;
  readonly signer?: string;
  readonly index: number;
  readonly className?: string;
}

function AssetNode({ network, title, detail, signer, index, className }: AssetNodeProps) {
  const chain = CHAINS[network];
  return (
    <div
      className={cx(
        "kl-pop relative border-[3px] border-[#1A1A1A] bg-white shadow-[4px_4px_0_#1A1A1A] dark:border-[#4B5563] dark:bg-[#0F1A2C] dark:shadow-[4px_4px_0_#475569]",
        className,
      )}
      style={nodeDelay(index)}
    >
      <div className="flex">
        <span className="w-2.5 shrink-0 border-r-[3px] border-[#1A1A1A] dark:border-[#4B5563]" style={{ backgroundColor: chain.color }} />
        <div className="min-w-0 flex-1 px-3 py-2">
          <p className="truncate font-code text-[10px] uppercase tracking-wider text-[#45464B] dark:text-[#A9B6C8]">
            {chain.name} · {chain.id.length > 18 ? `${chain.id.slice(0, 16)}…` : chain.id}
          </p>
          <p className="font-display text-lg font-bold leading-tight tracking-tight sm:text-xl">{title}</p>
          <p className="text-[11px] font-semibold text-[#45464B] dark:text-[#A9B6C8]">{detail}</p>
          {signer ? (
            <p className="mt-1 inline-flex items-center gap-1 border-2 border-[#1A1A1A] bg-[#FFD60A] px-1.5 text-[9px] font-black uppercase tracking-[0.12em] text-[#1A1A1A] dark:border-[#4B5563]">
              <PenLine className="h-3 w-3" aria-hidden="true" />
              {signer}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ProtocolNode({
  name,
  action,
  tone,
  index,
  className,
}: {
  name: string;
  action: string;
  tone: "yellow" | "purple";
  index: number;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "kl-pop inline-flex items-center gap-2 border-[3px] border-[#1A1A1A] px-3 py-1.5 shadow-[3px_3px_0_#1A1A1A] dark:border-[#4B5563] dark:shadow-[3px_3px_0_#475569]",
        tone === "yellow" ? "bg-[#FFD60A] text-[#1A1A1A]" : "bg-[#9945FF] text-white",
        className,
      )}
      style={nodeDelay(index)}
    >
      <Radio className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="font-display text-sm font-bold uppercase tracking-wide">{name}</span>
      <span className="font-code text-[10px] uppercase opacity-80">{action}</span>
    </div>
  );
}

function Connector({ index, color, className }: { index: number; color: string; className?: string }) {
  return (
    <div className={cx("kl-fade-in relative mx-auto h-7 w-[3px]", className)} style={nodeDelay(index)} aria-hidden="true">
      <span className="kl-flow-v absolute inset-0 text-[#1A1A1A]/60 dark:text-white/40" />
      <span
        className="kl-packet absolute left-1/2 h-3 w-3 -translate-x-1/2 border-2 border-[#1A1A1A] dark:border-[#0B1120]"
        style={{ backgroundColor: color, ...delay(FLOW_START + index * 400) }}
      />
    </div>
  );
}

/** Lane centres inside the two-column grid (gap 0.75rem). */
const LEFT_LANE = "calc((100% - 0.75rem) / 4)";
const RIGHT_LANE = "calc(100% - (100% - 0.75rem) / 4)";

/** Cross-lane edge: down from the Base lane, across through Relay, down into the Solana lane. */
function BridgeRow({ index, from, to }: { index: number; from: string; to: string }) {
  return (
    <div className="relative col-span-2 h-24" aria-hidden="true">
      <span className="kl-fade-in absolute top-0 h-1/2 w-[3px] -translate-x-1/2" style={{ left: LEFT_LANE, ...nodeDelay(index) }}>
        <span className="kl-flow-v absolute inset-0 text-[#1A1A1A]/60 dark:text-white/40" />
        <span
          className="kl-packet absolute left-1/2 h-3 w-3 -translate-x-1/2 border-2 border-[#1A1A1A] dark:border-[#0B1120]"
          style={{ backgroundColor: from, ...delay(FLOW_START) }}
        />
      </span>
      <span
        className="kl-fade-in kl-flow-h absolute top-1/2 h-[3px] -translate-y-1/2 text-[#1A1A1A]/60 dark:text-white/40"
        style={{ left: LEFT_LANE, right: `calc(100% - ${RIGHT_LANE})`, ...nodeDelay(index) }}
      />
      <span className="kl-fade-in absolute bottom-0 h-1/2 w-[3px] -translate-x-1/2" style={{ left: RIGHT_LANE, ...nodeDelay(index + 1) }}>
        <span className="kl-flow-v absolute inset-0 text-[#1A1A1A]/60 dark:text-white/40" />
        <span
          className="kl-packet absolute left-1/2 h-3 w-3 -translate-x-1/2 border-2 border-[#1A1A1A] dark:border-[#0B1120]"
          style={{ backgroundColor: to, ...delay(FLOW_START + 1200) }}
        />
      </span>
      <div className="absolute inset-0 flex items-center justify-center">
        <ProtocolNode name="Relay" action="bridge" tone="yellow" index={index} />
      </div>
    </div>
  );
}

/**
 * Animated hero illustration: a typed intent resolves into a two-network
 * graph (Base USDC -> Relay -> Solana USDC -> Jupiter -> JitoSOL). Pure
 * CSS; with reduced motion everything renders in its final state.
 */
export function HeroIntentGraph() {
  const base = CHAINS.base;
  const solana = CHAINS.solana;
  return (
    <figure className="relative">
      <figcaption className="sr-only">
        Example intent: “{PROMPT}”. Kletia compiles it into two steps across two networks: bridge 50 USDC
        from Base to Solana through Relay, signed with an EVM wallet, then swap the USDC into JitoSOL through
        Jupiter, signed with a Solana wallet.
      </figcaption>
      <div
        aria-hidden="true"
        className="relative border-[3px] border-[#1A1A1A] bg-[#FBFAF7] shadow-[10px_10px_0_#1A1A1A] dark:border-[#4B5563] dark:bg-[#131E32] dark:shadow-[10px_10px_0_#475569]"
      >
        <div className="flex items-center justify-between gap-2 border-b-[3px] border-[#1A1A1A] bg-[#1A1A1A] px-3 py-2 text-white dark:border-[#4B5563] dark:bg-[#060A14]">
          <span className="flex gap-1.5">
            <span className="h-3 w-3 border-2 border-[#1A1A1A] bg-[#FF5A5F]" />
            <span className="h-3 w-3 border-2 border-[#1A1A1A] bg-[#FFD60A]" />
            <span className="h-3 w-3 border-2 border-[#1A1A1A] bg-[#14F195]" />
          </span>
          <span className="font-code text-[11px] text-white/70">kletia · intent compiler</span>
          <span className="border-2 border-white/30 px-1.5 font-code text-[10px] uppercase text-white/80">dry run</span>
        </div>

        <div className="border-b-[3px] border-[#1A1A1A] bg-white px-4 py-3 dark:border-[#4B5563] dark:bg-[#0B1120]">
          <p className="font-code text-[13px] leading-6 text-[#1A1A1A] dark:text-[#E2E8F0] sm:text-sm">
            <span className="mr-2 font-bold text-[#0052FF] dark:text-[#7EA6FF]">&gt;</span>
            {Array.from(PROMPT).map((char, index) => (
              <span key={index} className="kl-type-char" style={delay(TYPE_START_MS + index * CHAR_MS)}>
                {char}
              </span>
            ))}
            <span className="kl-caret ml-0.5 inline-block h-4 w-2 translate-y-0.5 bg-[#0052FF] dark:bg-[#FFD60A]" />
          </p>
          <p
            className="kl-fade-in mt-2 inline-flex items-center gap-1.5 font-code text-[11px] font-bold text-[#0B7A4B] dark:text-[#14F195]"
            style={delay(COMPILED_MS)}
          >
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
            compiled · 2 steps · 2 networks · deterministic grammar
          </p>
        </div>

        <div className="relative px-3 pb-4 pt-3 sm:px-4">
          <div className="pointer-events-none absolute inset-0 grid grid-cols-2">
            <div className="border-r-2 border-dashed border-[#1A1A1A]/25 dark:border-white/15" style={{ backgroundColor: `${base.color}0F` }} />
            <div style={{ backgroundColor: `${solana.color}14` }} />
          </div>
          <div className="relative grid grid-cols-2 gap-x-3">
            <p className="mb-3 font-code text-[10px] font-bold uppercase tracking-[0.2em]" style={{ color: base.color }}>
              ● Base lane
            </p>
            <p className="mb-3 font-code text-[10px] font-bold uppercase tracking-[0.2em] text-[#0B7A4B] dark:text-[#14F195]">
              ● Solana lane
            </p>

            <AssetNode network="base" title="50 USDC" detail="input" signer="EIP-1193" index={0} />
            <div />

            <BridgeRow index={1} from={base.color} to={solana.color} />

            <div />
            <AssetNode network="solana" title="USDC" detail="settled on Solana" index={2} />

            <div />
            <Connector index={3} color="#9945FF" />

            <div />
            <div className="flex justify-center">
              <ProtocolNode name="Jupiter" action="swap" tone="purple" index={3} />
            </div>

            <div />
            <Connector index={4} color={solana.color} />

            <div />
            <AssetNode network="solana" title="JitoSOL" detail="liquid staking" signer="Wallet Standard" index={4} />
          </div>
        </div>

        <div className="kl-fade-in flex flex-wrap items-center gap-x-4 gap-y-1 border-t-[3px] border-[#1A1A1A] bg-white px-4 py-2.5 font-code text-[11px] text-[#45464B] dark:border-[#4B5563] dark:bg-[#0B1120] dark:text-[#A9B6C8]" style={delay(FLOW_START)}>
          <span>2 wallet signatures</span>
          <span aria-hidden="true">·</span>
          <span>advances on on-chain evidence</span>
        </div>
      </div>
    </figure>
  );
}
