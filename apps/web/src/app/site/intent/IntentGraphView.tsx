import type { IntentGraph } from "@kletia/core";
import { Sparkles, TriangleAlert, Wand2 } from "lucide-react";
import React, { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

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
import { StepNode } from "./StepNode";

export interface IntentGraphViewProps {
  readonly intent: IntentGraph;
  /** Optional slot rendered under the summary (e.g. an execute panel). */
  readonly actions?: React.ReactNode;
  readonly className?: string;
}

interface EdgePath {
  readonly id: string;
  readonly d: string;
  readonly kind: "funds" | "orders";
  readonly color: string;
}

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
export function IntentGraphView({ intent, actions, className }: IntentGraphViewProps) {
  const markerId = useId().replace(/:/gu, "");
  const containerRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<string, HTMLElement>());
  const [paths, setPaths] = useState<EdgePath[]>([]);
  const [box, setBox] = useState({ width: 0, height: 0 });

  const lanes = useMemo(() => laneOrder(intent), [intent]);
  const steps = useMemo(() => [...intent.steps].sort((a, b) => a.index - b.index), [intent]);
  const edges = useMemo(() => graphEdges(intent), [intent]);
  const networkOf = useMemo(() => new Map(intent.steps.map((step) => [step.id, step.network])), [intent]);

  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const origin = container.getBoundingClientRect();
    const next: EdgePath[] = [];
    for (const edge of edges) {
      const from = nodeRefs.current.get(edge.from)?.getBoundingClientRect();
      const to = nodeRefs.current.get(edge.to)?.getBoundingClientRect();
      if (!from || !to) continue;
      const x1 = from.left - origin.left + from.width / 2;
      const y1 = from.bottom - origin.top;
      const x2 = to.left - origin.left + to.width / 2;
      const y2 = to.top - origin.top - 6;
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
        d,
        kind: edge.kind,
        color: networkColor(networkOf.get(edge.to) ?? ""),
      });
    }
    setPaths(next);
    setBox({ width: origin.width, height: origin.height });
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
      <section aria-label="Intent summary" className={cx(INK_BORDER, HARD_SHADOW, SURFACE)}>
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
          <SummaryItem label="Steps" value={intent.steps.length} />
          <SummaryItem label="Networks" value={summary.networks.map(networkName).join(" → ") || "—"} />
          <SummaryItem label="Signatures" value={summary.signaturesRequired} />
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
          ref={containerRef}
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
            <defs>
              <marker id={markerId} viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" className="fill-[#1A1A1A] dark:fill-[#CBD5E1]" />
              </marker>
            </defs>
            {paths.map((path) => (
              <g key={path.id}>
                <path d={path.d} fill="none" strokeWidth={7} stroke={path.color} strokeOpacity={0.35} />
                <path
                  d={path.d}
                  fill="none"
                  strokeWidth={2.5}
                  strokeDasharray={path.kind === "orders" ? "6 6" : undefined}
                  className="stroke-[#1A1A1A] dark:stroke-[#CBD5E1]"
                  markerEnd={`url(#${markerId})`}
                />
              </g>
            ))}
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
                className="inline-flex items-center gap-2 border-[3px] border-[#1A1A1A] px-3 py-1.5 text-[11px] font-black uppercase tracking-[0.16em] shadow-[3px_3px_0_#1A1A1A] dark:border-[#4B5563] dark:shadow-[3px_3px_0_#475569]"
                style={{ backgroundColor: networkColor(lane), color: onNetworkColor(lane) }}
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
                ref={(element) => {
                  if (element) nodeRefs.current.set(step.id, element);
                  else nodeRefs.current.delete(step.id);
                }}
                className="z-[1] md:[grid-column:var(--kl-col)] md:[grid-row:var(--kl-row)]"
                style={
                  {
                    ["--kl-col" as string]: String(laneIndex + 1),
                    ["--kl-row" as string]: String(step.index + 2),
                  } as React.CSSProperties
                }
              />
            );
          })}
        </div>
      </section>
    </div>
  );
}
