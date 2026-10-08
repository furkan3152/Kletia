import type { IntentStep } from "@kletia/core";
import { ArrowRightLeft, Clock, PenLine, Radio, Receipt, TriangleAlert } from "lucide-react";
import React from "react";

import { Badge } from "../ui/Badge";
import { cx, HARD_SHADOW, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../ui/styles";
import {
  formatAmount,
  formatSeconds,
  formatUsd,
  humanize,
  networkColor,
  networkName,
  protocolName,
  shortAccount,
  STATUS_TONE,
} from "./format";

const MODE_LABEL: Record<IntentStep["mode"], { label: string; icon: React.ReactNode }> = {
  wallet: { label: "Wallet signs", icon: <PenLine className="h-3.5 w-3.5" aria-hidden="true" /> },
  settlement: { label: "Settlement network", icon: <Radio className="h-3.5 w-3.5" aria-hidden="true" /> },
  read: { label: "Read only", icon: <Receipt className="h-3.5 w-3.5" aria-hidden="true" /> },
};

function Row({ label, value, strong = false }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-dashed border-[#1A1A1A]/15 py-1.5 last:border-b-0 dark:border-white/10">
      <dt className={cx(LABEL, "!text-[10px]", TEXT_MUTED)}>{label}</dt>
      <dd className={cx("min-w-0 text-right font-code text-[12.5px]", strong ? "font-bold" : "")}>{value}</dd>
    </div>
  );
}

export interface StepNodeProps {
  readonly step: IntentStep;
  /** Extra content at the bottom of the node (links, execution details). */
  readonly footer?: React.ReactNode;
  readonly className?: string;
  readonly style?: React.CSSProperties;
}

/** One intent step: network, protocol, amounts, fees, timing and warnings. */
export const StepNode = React.forwardRef<HTMLElement, StepNodeProps>(function StepNode(
  { step, footer, className, style },
  ref,
) {
  const color = networkColor(step.network);
  const mode = MODE_LABEL[step.mode];
  const fees = formatUsd(step.feesUsd);
  const eta = formatSeconds(step.estimatedSeconds ?? step.settlement?.expectedSeconds);
  const crossNetwork = step.settlement?.kind === "cross-network";
  return (
    <article
      ref={ref}
      aria-label={`Step ${step.index + 1}: ${step.title}`}
      className={cx("relative flex min-w-0 flex-col", INK_BORDER, HARD_SHADOW, SURFACE, className)}
      style={style}
    >
      <div className="h-2 w-full border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563]" style={{ backgroundColor: color }} aria-hidden="true" />
      <div className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-code text-xs font-bold text-[#45464B] dark:text-[#A9B6C8]">
            {String(step.index + 1).padStart(2, "0")}
          </span>
          <Badge tone="ink">{step.kind}</Badge>
          <Badge tone="outline" dot={color}>
            {networkName(step.network)}
          </Badge>
          <Badge tone={STATUS_TONE[step.status] ?? "neutral"} className="ml-auto">
            {humanize(step.status)}
          </Badge>
        </div>
        <h4 className="font-display text-lg font-bold leading-snug tracking-[-0.01em]">{step.title}</h4>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-bold text-[#45464B] dark:text-[#A9B6C8]">
          <span className="inline-flex items-center gap-1">
            <ArrowRightLeft className="h-3.5 w-3.5" aria-hidden="true" />
            {protocolName(step.protocol)}
          </span>
          <span className="inline-flex items-center gap-1">
            {mode.icon}
            {mode.label}
          </span>
          {eta ? (
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3.5 w-3.5" aria-hidden="true" />
              {eta}
            </span>
          ) : null}
        </p>
        <dl className="text-[#1A1A1A] dark:text-[#E2E8F0]">
          {step.input ? <Row label="Input" value={formatAmount(step.input)} strong /> : null}
          {step.expectedOutput ? <Row label="Expected" value={formatAmount(step.expectedOutput)} strong /> : null}
          {step.minimumOutput ? <Row label="Minimum" value={formatAmount(step.minimumOutput)} /> : null}
          {fees ? <Row label="Fees" value={fees} /> : null}
          {crossNetwork && step.settlement?.destinationNetwork ? (
            <Row label="Settles on" value={networkName(step.settlement.destinationNetwork)} />
          ) : null}
          <Row label="Account" value={<span title={step.account}>{shortAccount(step.account)}</span>} />
          {step.recipient && step.recipient !== step.account ? (
            <Row label="Recipient" value={<span title={step.recipient}>{shortAccount(step.recipient)}</span>} />
          ) : null}
        </dl>
        {step.warnings && step.warnings.length > 0 ? (
          <ul className="space-y-1.5 border-2 border-[#1A1A1A] bg-[#FFF3B0] p-2.5 text-xs font-semibold text-[#1A1A1A] dark:border-[#4B5563]">
            {step.warnings.map((warning) => (
              <li key={warning} className="flex gap-1.5">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{warning}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {step.failure ? (
          <p className="border-2 border-[#1A1A1A] bg-[#FFE4E4] p-2.5 text-xs font-semibold text-[#7F1D1D] dark:border-[#7F1D1D] dark:bg-[#2A1215] dark:text-[#FEE2E2]">
            {step.failure.message}
          </p>
        ) : null}
        {footer}
      </div>
    </article>
  );
});
