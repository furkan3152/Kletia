import { FlowLine } from "../../site/motion/FlowLine";
import { cx } from "../../site/ui/styles";
import {
  HERO_ASSETS,
  HERO_EDGES,
  HERO_NODES,
  hopsShown,
  LANE_DIVIDER_X,
  MAP_HEIGHT,
  MAP_WIDTH,
  type HeroBox,
  type HeroScenario,
} from "./heroScenarios";

/** Delays inside one hop (ms after the hop starts). */
const CHIP_DELAY = 220;
const DROP_DELAY = 360;

const INK_STROKE = "stroke-[#1A1A1A] dark:stroke-[#4B5563]";
const INK_FILL = "fill-[#1A1A1A] dark:fill-[#475569]";
const TEXT_FILL = "fill-[#1A1A1A] dark:fill-[#F1F5F9]";
const MUTED_FILL = "fill-[#45464B] dark:fill-[#A9B6C8]";
const ANIMATED_G = "[transform-box:fill-box]";

function Ring({ box }: { box: HeroBox }) {
  return (
    <rect
      x={-5}
      y={-5}
      width={box.w + 10}
      height={box.h + 10}
      fill="none"
      stroke="#FFD60A"
      strokeWidth={3}
      opacity={0}
      className="origin-center animate-[kl-attn_1100ms_var(--kl-ease-out)_1] [transform-box:fill-box] motion-reduce:hidden"
    />
  );
}

export interface NetworkMapProps {
  readonly scenario: HeroScenario;
  readonly stage: number;
  /** Packets travel only while true. */
  readonly packets: boolean;
  /** Skip entrance effects (reduced motion or a jump straight to the final state). */
  readonly still: boolean;
}

/**
 * The hero's network map: four fixed network nodes in a production lane and
 * a testnet lane, the edges an example intent draws, protocol chips and
 * travelling packets. Decorative (`aria-hidden`); the figure caption
 * describes every example in text.
 */
export function NetworkMap({ scenario, stage, packets, still }: NetworkMapProps) {
  const shown = hopsShown(scenario, stage);
  const hops = scenario.hops.slice(0, shown);
  const involved = new Set<string>(scenario.hops.flatMap((hop) => [hop.from, hop.to]));
  const lit = new Set<string>();
  if (stage >= 1 && scenario.hops[0]) lit.add(scenario.hops[0].from);
  for (const hop of hops) {
    lit.add(hop.from);
    lit.add(hop.to);
  }
  const activeHop = shown > 0 && !still ? scenario.hops[shown - 1] : undefined;
  const ringFor = activeHop?.from ?? (stage === 1 && !still ? scenario.hops[0]?.from : undefined);

  return (
    <svg
      viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
      className="block h-auto w-full select-none overflow-visible"
      aria-hidden="true"
      focusable="false"
    >
      {/* Lanes */}
      <rect x={0} y={0} width={LANE_DIVIDER_X} height={MAP_HEIGHT} className="fill-[#0052FF]/[0.04] dark:fill-[#7EA6FF]/[0.05]" />
      <rect x={LANE_DIVIDER_X} y={0} width={MAP_WIDTH - LANE_DIVIDER_X} height={MAP_HEIGHT} className="fill-[#FFD60A]/[0.10] dark:fill-[#FFD60A]/[0.05]" />
      <line
        x1={LANE_DIVIDER_X}
        x2={LANE_DIVIDER_X}
        y1={0}
        y2={MAP_HEIGHT}
        strokeWidth={2}
        strokeDasharray="6 5"
        className="stroke-[#1A1A1A]/40 dark:stroke-white/25"
      />
      <text x={12} y={20} className="fill-[#0046DB] font-code text-[10px] font-bold uppercase tracking-[0.18em] dark:fill-[#7EA6FF]">
        Production lane
      </text>
      <text x={LANE_DIVIDER_X + 12} y={20} className="fill-[#8A5A00] font-code text-[10px] font-bold uppercase tracking-[0.18em] dark:fill-[#FFD60A]">
        Testnet lane
      </text>
      <text x={LANE_DIVIDER_X + 12} y={34} className={cx(MUTED_FILL, "font-code text-[9px]")}>
        separate capital
      </text>

      {/* Idle guides for every route the map knows */}
      {Object.values(HERO_EDGES).map((edge) => (
        <path
          key={edge.id}
          d={edge.d}
          fill="none"
          strokeWidth={2}
          strokeDasharray="2 6"
          strokeLinecap="round"
          className="stroke-[#1A1A1A]/25 dark:stroke-white/20"
        />
      ))}

      {/* Active hops */}
      {hops.map((hop) => (
        <FlowLine
          key={`${scenario.id}-${hop.edge}`}
          d={HERO_EDGES[hop.edge]!.d}
          color={hop.color}
          draw={!still}
          packets={packets ? 2 : 0}
          active={packets}
          arrow
        />
      ))}

      {/* Network nodes */}
      {HERO_NODES.map((node) => {
        const isLit = lit.has(node.id);
        const dim = !isLit;
        const dropIn = !still && activeHop?.to === node.id;
        return (
          <g key={node.id} transform={`translate(${node.box.x} ${node.box.y})`}>
            <g
              key={dropIn ? `${scenario.id}-drop` : "rest"}
              className={cx(
                "transition-opacity duration-300 motion-reduce:transition-none",
                ANIMATED_G,
                dim ? (involved.has(node.id) ? "opacity-60" : "opacity-40") : "opacity-100",
                dropIn && "kl-node-in",
              )}
              style={dropIn ? { animationDelay: `${DROP_DELAY}ms` } : undefined}
            >
              {ringFor === node.id ? <Ring key={`${scenario.id}-${stage}`} box={node.box} /> : null}
              <rect x={4} y={4} width={node.box.w} height={node.box.h} className={INK_FILL} />
              <rect
                x={0}
                y={0}
                width={node.box.w}
                height={node.box.h}
                strokeWidth={3}
                className={cx("fill-white dark:fill-[#0F1A2C]", INK_STROKE)}
              />
              <rect x={1.5} y={1.5} width={9} height={node.box.h - 3} fill={node.color} />
              <line x1={10.5} x2={10.5} y1={1.5} y2={node.box.h - 1.5} strokeWidth={2.5} className={INK_STROKE} />
              <text x={20} y={20} className={cx(TEXT_FILL, "font-display text-[15px] font-bold")}>
                {node.name}
              </text>
              <text x={20} y={34} className={cx(MUTED_FILL, "font-code text-[9px]")}>
                {node.sub}
              </text>
            </g>
          </g>
        );
      })}

      {/* Output assets and recipients */}
      {HERO_ASSETS.map((asset) => {
        const hop = hops.find((candidate) => candidate.to === asset.id);
        if (!hop) return null;
        const dropIn = !still && activeHop === hop;
        return (
          <g key={asset.id} transform={`translate(${asset.box.x} ${asset.box.y})`}>
            <g className={cx(ANIMATED_G, dropIn && "kl-node-in")} style={dropIn ? { animationDelay: `${DROP_DELAY}ms` } : undefined}>
              <rect x={3} y={3} width={asset.box.w} height={asset.box.h} className={INK_FILL} />
              <rect x={0} y={0} width={asset.box.w} height={asset.box.h} strokeWidth={3} className={cx("fill-[#FFD60A]", INK_STROKE)} />
              <text
                x={asset.box.w / 2}
                y={asset.box.h / 2 + 4.5}
                textAnchor="middle"
                className="fill-[#1A1A1A] font-code text-[12px] font-bold"
              >
                {asset.label}
              </text>
            </g>
          </g>
        );
      })}

      {/* Protocol / action chips */}
      {hops.map((hop) => {
        const edge = HERO_EDGES[hop.edge]!;
        const width = Math.max(64, hop.chip.length * 7 + 18);
        const pop = !still && activeHop === hop;
        return (
          <g key={`${scenario.id}-${hop.edge}-chip`} transform={`translate(${edge.chip.x - width / 2} ${edge.chip.y - 11})`}>
            <g className={cx(ANIMATED_G, pop && "kl-pop")} style={pop ? { animationDelay: `${CHIP_DELAY}ms` } : undefined}>
              <rect x={2.5} y={2.5} width={width} height={22} className={INK_FILL} />
              <rect x={0} y={0} width={width} height={22} strokeWidth={2.5} className={cx("fill-[#1A1A1A] dark:fill-[#F1F5F9]", INK_STROKE)} />
              <text
                x={width / 2}
                y={15}
                textAnchor="middle"
                className="fill-white font-code text-[10.5px] font-bold uppercase tracking-[0.04em] dark:fill-[#0B1120]"
              >
                {hop.chip}
              </text>
            </g>
          </g>
        );
      })}
    </svg>
  );
}
