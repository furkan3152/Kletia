import { CHAINS } from "@kletia/core";

import { FlowLine } from "../../site/motion/FlowLine";

const NODES = [
  { id: "base", label: "Base", x: 54, y: 78, color: CHAINS.base.color },
  { id: "arbitrum", label: "Arbitrum", x: 54, y: 208, color: CHAINS.arbitrum.color },
  { id: "solana", label: "Solana", x: 262, y: 143, color: CHAINS.solana.color },
] as const;
const ARC = { label: "Arc Testnet", x: 314, y: 236, color: CHAINS.arc.color };

const EDGES = [
  { id: "base-solana", d: "M70 78 C 150 78, 170 143, 246 143", color: CHAINS.base.color },
  { id: "arbitrum-solana", d: "M70 208 C 150 208, 170 143, 246 143", color: CHAINS.arbitrum.color },
  { id: "base-arbitrum", d: "M54 94 V192", color: "#9945FF" },
];

const INK = "stroke-[#1A1A1A]";

export interface CtaMeshProps {
  /** Packets move only while true (on screen, visible tab, not paused). */
  readonly active: boolean;
  /** No packets at all (reduced motion). */
  readonly still: boolean;
}

/**
 * Slow network mesh for the final CTA: production networks joined by edges
 * with one packet each every ~2.2 s, and Arc alone in its testnet lane
 * (never connected). Decorative.
 */
export function CtaMesh({ active, still }: CtaMeshProps) {
  return (
    <svg viewBox="0 0 360 272" className="h-full w-full" aria-hidden="true" focusable="false">
      <line x1={290} x2={290} y1={196} y2={268} strokeDasharray="5 5" strokeWidth={2} className="stroke-[#1A1A1A]/40" />
      {EDGES.map((edge, index) => (
        <FlowLine
          key={edge.id}
          d={edge.d}
          color={edge.color}
          packets={still ? 0 : 1}
          packetDuration={2200 + index * 300}
          active={active}
          inkClassName={INK}
          arrow={edge.id !== "base-arbitrum"}
        />
      ))}
      {NODES.map((node) => (
        <g key={node.id} transform={`translate(${node.x - 16} ${node.y - 16})`}>
          <rect x={4} y={4} width={32} height={32} className="fill-[#1A1A1A]" />
          <rect x={0} y={0} width={32} height={32} strokeWidth={3} fill={node.color} className={INK} />
          <text
            x={16}
            y={node.id === "arbitrum" ? 52 : -9}
            textAnchor="middle"
            className="fill-[#1A1A1A] font-code text-[11px] font-bold uppercase tracking-[0.08em]"
          >
            {node.label}
          </text>
        </g>
      ))}
      <g transform={`translate(${ARC.x - 14} ${ARC.y - 14})`}>
        <rect x={0} y={0} width={28} height={28} strokeWidth={3} strokeDasharray="5 4" fill={ARC.color} fillOpacity={0.35} className={INK} />
        <text x={-8} y={18} textAnchor="end" className="fill-[#1A1A1A] font-code text-[10px] font-bold uppercase tracking-[0.08em]">
          {ARC.label}
        </text>
      </g>
    </svg>
  );
}
