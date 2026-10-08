import { ArrowUpRight, ChevronDown, LoaderCircle, Waypoints } from "lucide-react";
import React, { useId, useState } from "react";

import { Link } from "../../../app/routes/Link";
import { LazyBoundary } from "../LazyBoundary";
import { studioHrefFor } from "./crossNetworkHandoff";

const InlineIntentPlanner = React.lazy(() => import("./InlineIntentPlanner"));

const buttonBase =
  "inline-flex min-h-11 items-center justify-center gap-2 border-[3px] border-[#1A1A1A] px-3 py-2 text-xs font-black uppercase tracking-wider shadow-[3px_3px_0_#1A1A1A] transition-[transform,box-shadow] duration-100 ease-out hover:-translate-y-0.5 hover:shadow-[4px_4px_0_#1A1A1A] focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#FFD700] active:translate-y-0.5 active:shadow-none dark:border-[#4B5563] dark:shadow-[3px_3px_0_#475569]";

export interface CrossNetworkHandoffCardProps {
  /** The prompt as typed; absent after a reload (history keeps only a redacted copy). */
  readonly prompt: string | null;
}

/**
 * Shown in the EVM chat when a prompt involves Solana. The chat's EVM engines
 * cannot execute it, so the user can open it in Intent Studio or plan it in
 * place through Kletia Platform API v1.
 */
export function CrossNetworkHandoffCard({ prompt }: CrossNetworkHandoffCardProps) {
  // Once opened the planner stays mounted (hidden when collapsed) so a running
  // execution is never torn down by a toggle.
  const [planning, setPlanning] = useState(false);
  const [opened, setOpened] = useState(false);
  const panelId = useId();

  return (
    <div
      className={`mt-5 flex w-full min-w-0 flex-col gap-3 border-[3px] border-[#1A1A1A] bg-[#F3E8FF] p-4 text-[#1A1A1A] shadow-[3px_3px_0_#1A1A1A] dark:border-[#4B5563] dark:bg-[#1C1433] dark:text-white dark:shadow-[3px_3px_0_#475569] md:shadow-[4px_4px_0_#1A1A1A] dark:md:shadow-[4px_4px_0_#475569] ${
        planning ? "md:w-[min(46rem,100%)]" : "sm:w-80 md:w-[450px]"
      }`}
    >
      <p className="flex items-center gap-2 border-b-[3px] border-[#1A1A1A] pb-2 text-xs font-black uppercase tracking-widest dark:border-[#4B5563] md:text-sm">
        <Waypoints className="h-4 w-4 text-[#9945FF] md:h-5 md:w-5" aria-hidden="true" />
        This is a cross-network intent
      </p>
      <p className="text-sm font-bold leading-relaxed">
        It touches Solana, so Kletia plans it with the platform planner: network-bound steps, live quotes and one
        wallet signature per step, across EVM and Solana.
      </p>
      {prompt ? (
        <p className="break-words border-2 border-dashed border-[#1A1A1A]/40 bg-white/70 px-2 py-1.5 font-mono text-xs font-bold dark:border-white/20 dark:bg-[#0B1120]/60">
          {prompt}
        </p>
      ) : (
        <p className="text-xs font-bold text-gray-700 dark:text-slate-300">
          The original prompt is not kept in chat history. Open Studio and type it again.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Link to={prompt ? studioHrefFor(prompt) : "/studio"} className={`${buttonBase} bg-[#0052FF] text-white`}>
          {prompt ? "Plan in Studio" : "Open Studio"}
          <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
        </Link>
        {prompt ? (
          <button
            type="button"
            onClick={() => {
              setOpened(true);
              setPlanning((value) => !value);
            }}
            aria-expanded={planning}
            aria-controls={panelId}
            className={`${buttonBase} bg-white text-[#1A1A1A] dark:bg-[#1A2841] dark:text-white`}
          >
            Plan here
            <ChevronDown className={`h-4 w-4 transition-transform ${planning ? "rotate-180" : ""}`} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {prompt && opened ? (
        <div id={panelId} hidden={!planning} className="min-w-0 border-t-[3px] border-[#1A1A1A] pt-4 dark:border-[#4B5563]">
          <LazyBoundary
            fallback={() => (
              <p role="alert" className="text-sm font-bold">
                The planner could not load here. Use “Plan in Studio” instead, or reload the page.
              </p>
            )}
          >
            <React.Suspense
              fallback={
                <p role="status" className="flex items-center gap-2 text-sm font-bold">
                  <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Loading the planner…
                </p>
              }
            >
              <InlineIntentPlanner prompt={prompt} />
            </React.Suspense>
          </LazyBoundary>
        </div>
      ) : null}
    </div>
  );
}

export default CrossNetworkHandoffCard;
