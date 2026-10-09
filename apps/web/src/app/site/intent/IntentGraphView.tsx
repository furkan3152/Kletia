import type { IntentGraph, IntentStep } from "@kletia/core";
import { Sparkles, TriangleAlert, Wand2 } from "lucide-react";
import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { LocalStepPhase } from "../../../shared/platform/useIntentExecution";
import { AnimatedNumber } from "../motion/AnimatedNumber";
import { FlowLine } from "../motion/FlowLine";
import { cssVars } from "../motion/tokens";
import { useAutoPause } from "../motion/useAutoPause";
import { Badge } from "../ui/Badge";
import { cx, HARD_SHADOW, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../ui/styles";
import {
  formatAmount,
  formatSeconds,
  formatUsd,
  graphEdges,
  humanize,
  laneOrder,
  networkColor,
  networkName,
  onNetworkColor,
  STATUS_TONE,
} from "./format";
import { edgeBuildDelay, graphBuildDuration, nodeBuildDelay, stepDepths } from "./graphDepth";
import { StepNode } from "./StepNode";
import { useGraphBuild } from "./useGraphBuild";

export interface IntentGraphViewProps {
  readonly intent: IntentGraph;
  /** Optional slot rendered under the summary (e.g. an execute panel). */
  readonly actions?: React.ReactNode;
  /** Optional content rendered at the bottom of each step node (e.g. explorer links). */
  readonly stepFooter?: (step: IntentStep) => React.ReactNode;
  /**
   * Execution view: live phases per step (what the wallet and the browser are
   * doing). Turns on phase visuals in the nodes and packets on active edges.
   */
  readonly phases?: Readonly<Record<string, LocalStepPhase>>;
  /** Dry-run preview entrance: the summary card drops in and the step and signature counts count up. */
  readonly entrance?: boolean;
  readonly className?: string;
}

interface EdgePath {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly d: string;
  readonly kind: "funds" | "orders";
  readonly color: string;
}

/** API statuses of a source step while its funds are moving towards the next step. */
const MOVING = new Set<IntentStep["status"]>(["submitted", "confirmed", "settling"]);
const EDGE_FILL = "transition-opacity duration-240 ease-kl-standard motion-reduce:transition-none";

function SummaryItem({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0 px-4 py-3">
      <dt className={cx(LABEL, "!text-[10px]", TEXT_MUTED)}>{label}</dt>
      <dd className="mt-1 break-words font-display text-lg font-bold leading-tight">{value}</dd>
    </div>
  );
}

/**
 * Renders an IntentGraph: a summary bar, the planner's interpretation, and
 * the steps as nodes grouped into network lanes with dependency edges.
 * Read-only; pass `actions` to attach controls (e.g. wallet execution).
 */
export function IntentGraphView({ intent, actions, stepFooter, phases, entrance = false, className }: IntentGraphViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const nodeRefs = useRef(new Map<string, HTMLElement>());
  const [paths, setPaths] = useState<EdgePath[]>([]);
  const [box, setBox] = useState({ width: 0, height: 0 });

  const lanes = useMemo(() => laneOrder(intent), [intent]);
  const steps = useMemo(() => [...intent.steps].sort((a, b) => a.index - b.index), [intent]);
  const edges = useMemo(() => graphEdges(intent), [intent]);
  const networkOf = useMemo(() => new Map(intent.steps.map((step) => [step.id, step.network])), [intent]);
  const statusOf = useMemo(() => new Map(intent.steps.map((step) => [step.id, step.status])), [intent]);
  const depths = useMemo(() => stepDepths(intent), [intent]);
  const live = phases !== undefined;
  const building = useGraphBuild(intent.id, graphBuildDuration(depths, lanes.length));
  const { ref: pauseRef } = useAutoPause<HTMLDivElement>();
  const setContainer = useCallback(
    (node: HTMLDivElement | null) => {
      containerRef.current = node;
      pauseRef(node);
    },
    [pauseRef],
  );

  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    // Layout offsets, not client rects: nodes may be mid-animation (build-in,
    // shake), and transforms must not bend the edges.
    const next: EdgePath[] = [];
    for (const edge of edges) {
      const from = nodeRefs.current.get(edge.from);
      const to = nodeRefs.current.get(edge.to);
      if (!from || !to) continue;
      const x1 = from.offsetLeft + from.offsetWidth / 2;
      const y1 = from.offsetTop + from.offsetHeight;
      const x2 = to.offsetLeft + to.offsetWidth / 2;
      const y2 = to.offsetTop - 6;
      const mid = y1 + Math.max(12, (y2 - y1) / 2);
      const dx = x2 - x1;
      const radius = Math.min(10, Math.abs(dx) / 2, Math.abs(mid - y1));
      const direction = Math.sign(dx);
      // Orthogonal elbow: down, across, down (rounded corners); straight when aligned.
      const d =
        Math.abs(dx) < 1
          ? `M ${x1} ${y1} V ${y2}`
          : [
              `M ${x1} ${y1}`,
              `V ${mid - radius}`,
              `Q ${x1} ${mid} ${x1 + direction * radius} ${mid}`,
              `H ${x2 - direction * radius}`,
              `Q ${x2} ${mid} ${x2} ${mid + radius}`,
              `V ${y2}`,
            ].join(" ");
      next.push({
        id: `${edge.from}->${edge.to}`,
        from: edge.from,
        to: edge.to,
        d,
        kind: edge.kind,
        color: networkColor(networkOf.get(edge.to) ?? ""),
      });
    }
    setPaths(next);
    setBox({ width: container.offsetWidth, height: container.offsetHeight });
  }, [edges, networkOf]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => measure());
    observer.observe(container);
    for (const node of nodeRefs.current.values()) observer.observe(node);
    return () => observer.disconnect();
  }, [measure, steps]);

  const { summary, interpretation } = intent;
  const fees = formatUsd(summary.totalFeesUsd);
  const eta = formatSeconds(summary.estimatedSeconds);
  const confidence = Number.isFinite(interpretation.confidence)
    ? `${Math.round(Math.min(1, Math.max(0, interpretation.confidence)) * 100)}%`
    : null;
  const laneCount = Math.max(1, lanes.length);

  return (
    <div className={cx("flex min-w-0 flex-col gap-6", className)}>
      <section aria-label="Intent summary" className={cx(INK_BORDER, HARD_SHADOW, SURFACE, entrance && "kl-drop")}>
        <div className="flex flex-col gap-3 border-b-[3px] border-[#1A1A1A] p-4 dark:border-[#4B5563] sm:flex-row sm:items-start sm:justify-between sm:p-5">
          <div className="min-w-0">
            <p className={cx(LABEL, "text-[#0052FF] dark:text-[#7EA6FF]")}>Intent graph · {intent.spec}</p>
            <h3 className="mt-1 font-display text-2xl font-bold leading-tight tracking-[-0.02em] sm:text-3xl">
              {summary.title}
            </h3>
            <p className="mt-2 break-all font-code text-[11px] text-[#45464B] dark:text-[#A9B6C8]">{intent.id}</p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Badge tone={STATUS_TONE[intent.status] ?? "neutral"}>{humanize(intent.status)}</Badge>
            {summary.crossNetwork ? <Badge tone="purple">Cross-network</Badge> : <Badge tone="neutral">Single network</Badge>}
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-[2px] bg-[#1A1A1A] dark:bg-[#4B5563] sm:grid-cols-3 [&>div]:bg-white dark:[&>div]:bg-[#131E32]">
          <SummaryItem label="Steps" value={entrance ? <AnimatedNumber value={intent.steps.length} duration={600} /> : intent.steps.length} />
          <SummaryItem label="Networks" value={summary.networks.map(networkName).join(" → ") || "—"} />
          <SummaryItem
            label="Signatures"
            value={entrance ? <AnimatedNumber value={summary.signaturesRequired} duration={600} /> : summary.signaturesRequired}
          />
          <SummaryItem label="Est. fees" value={fees ?? "—"} />
          <SummaryItem label="Est. time" value={eta ?? "—"} />
          <SummaryItem
            label="You receive"
            value={summary.outputs.map((output) => formatAmount(output)).join(" + ") || "—"}
          />
        </dl>
        {actions ? <div className="border-t-[3px] border-[#1A1A1A] p-4 dark:border-[#4B5563]">{actions}</div> : null}
      </section>

      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <section aria-label="Interpretation" className={cx(INK_BORDER, SURFACE, "p-4 sm:p-5")}>
          <h4 className={cx(LABEL, "flex items-center gap-2")}>
            <Wand2 className="h-4 w-4 text-[#0052FF] dark:text-[#7EA6FF]" aria-hidden="true" />
            Interpretation
          </h4>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="font-bold text-[#45464B] dark:text-[#A9B6C8]">Compiler</dt>
            <dd className="font-code">{interpretation.source}</dd>
            {confidence ? (
              <>
                <dt className="font-bold text-[#45464B] dark:text-[#A9B6C8]">Confidence</dt>
                <dd className="font-code">{confidence}</dd>
              </>
            ) : null}
            {interpretation.normalizedText ? (
              <>
                <dt className="font-bold text-[#45464B] dark:text-[#A9B6C8]">Normalised</dt>
                <dd className="break-words font-code">{interpretation.normalizedText}</dd>
              </>
            ) : null}
          </dl>
        </section>
        <section aria-label="Planner optimizations" className={cx(INK_BORDER, SURFACE, "p-4 sm:p-5")}>
          <h4 className={cx(LABEL, "flex items-center gap-2")}>
            <Sparkles className="h-4 w-4 text-[#9945FF]" aria-hidden="true" />
            Optimizations
          </h4>
          {interpretation.optimizations && interpretation.optimizations.length > 0 ? (
            <ul className="mt-3 space-y-2 text-sm">
              {interpretation.optimizations.map((item) => (
                <li key={item} className="flex gap-2">
                  <span aria-hidden="true" className="mt-1.5 h-2 w-2 shrink-0 bg-[#9945FF]" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className={cx("mt-3 text-sm", TEXT_MUTED)}>No rewrites were needed for this plan.</p>
          )}
        </section>
      </div>

      {intent.warnings.length > 0 ? (
        <section
          aria-label="Plan warnings"
          className="border-[3px] border-[#1A1A1A] bg-[#FFF3B0] p-4 text-[#1A1A1A] dark:border-[#4B5563]"
        >
          <h4 className={cx(LABEL, "flex items-center gap-2")}>
            <TriangleAlert className="h-4 w-4" aria-hidden="true" />
            Warnings
          </h4>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm font-semibold">
            {intent.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-label="Steps by network">
        <div
          ref={setContainer}
          className={cx(
            "relative grid grid-cols-1 gap-y-12 md:gap-x-8 md:gap-y-16 md:[grid-template-columns:repeat(var(--kl-lanes),minmax(0,1fr))]",
            laneCount === 1 && "md:max-w-2xl",
          )}
          style={{ ["--kl-lanes" as string]: String(laneCount) }}
        >
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 z-0 overflow-visible"
            width={box.width}
            height={box.height}
          >
            {paths.map((path) => {
              const source = statusOf.get(path.from);
              const settled = live && source === "settled";
              const moving = live && source !== undefined && MOVING.has(source);
              return (
                // Keyed by edge id (not by `d`), so a re-measure keeps the path and never replays the draw.
                <g key={path.id}>
                  {/* Settled: a solid band in the destination network's colour fills in under the ink line
                      (the ink stays on top, so the edge keeps its contrast on light network colours). */}
                  <path
                    d={path.d}
                    fill="none"
                    stroke={path.color}
                    strokeWidth={7}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className={cx(EDGE_FILL, settled ? "opacity-100" : "opacity-0")}
                  />
                  <FlowLine
                    d={path.d}
                    color={path.color}
                    kind={path.kind}
                    // The arrow head lands once the edge has drawn in (it would sit alone at the far end otherwise).
                    arrow={!building}
                    draw={building}
                    drawDelay={edgeBuildDelay(depths.get(path.to) ?? 0)}
                    packets={moving ? 2 : 0}
                    active={moving}
                  />
                </g>
              );
            })}
          </svg>

          {/* Lane headers (desktop) */}
          {lanes.map((lane, laneIndex) => (
            <div
              key={`lane-${lane}`}
              aria-hidden="true"
              className="relative z-[1] hidden md:-mb-8 md:block"
              style={{ gridColumn: laneIndex + 1, gridRow: 1 }}
            >
              <div
                className={cx(
                  "inline-flex items-center gap-2 border-[3px] border-[#1A1A1A] px-3 py-1.5 text-[11px] font-black uppercase tracking-[0.16em] shadow-[3px_3px_0_#1A1A1A] dark:border-[#4B5563] dark:shadow-[3px_3px_0_#475569]",
                  building && "kl-node-in",
                )}
                style={{
                  backgroundColor: networkColor(lane),
                  color: onNetworkColor(lane),
                  ...(building ? cssVars({ "--kl-delay": `${laneIndex * 40}ms` }) : {}),
                }}
              >
                {networkName(lane)}
              </div>
            </div>
          ))}

          {steps.map((step) => {
            const laneIndex = Math.max(0, lanes.indexOf(step.network));
            return (
              <StepNode
                key={step.id}
                step={step}
                live={live}
                {...(phases?.[step.id] ? { localPhase: phases[step.id] } : {})}
                footer={stepFooter?.(step)}
                ref={(element) => {
                  if (element) nodeRefs.current.set(step.id, element);
                  else nodeRefs.current.delete(step.id);
                }}
                className={cx("z-[1] md:[grid-column:var(--kl-col)] md:[grid-row:var(--kl-row)]", building && "kl-node-in")}
                style={cssVars({
                  "--kl-col": String(laneIndex + 1),
                  "--kl-row": String(step.index + 2),
                  "--kl-delay": building ? `${nodeBuildDelay(depths.get(step.id) ?? 0, laneIndex)}ms` : undefined,
                })}
              />
            );
          })}
        </div>
      </section>
    </div>
  );
}
