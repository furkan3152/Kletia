import { Skeleton, SkeletonGroup, SkeletonText } from "../../site/ui/Skeleton";
import { cx, HARD_SHADOW, INK_BORDER, SURFACE, TEXT_MUTED } from "../../site/ui/styles";

const STAT_CELLS = ["w-10", "w-24", "w-8", "w-16", "w-14", "w-28"];

function NodeSkeleton({ className }: { className?: string }) {
  return (
    <div className={cx("relative flex min-w-0 flex-col", INK_BORDER, HARD_SHADOW, SURFACE, className)}>
      <div className="h-2 w-full border-b-[3px] border-[#1A1A1A]/30 bg-[#E7E2D6] dark:border-[#4B5563] dark:bg-[#1A2841]" />
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-2">
          <Skeleton surface="card" className="h-4 w-6 border-2" />
          <Skeleton surface="card" className="h-6 w-14 border-2" />
          <Skeleton surface="card" className="h-6 w-20 border-2" />
          <Skeleton surface="card" className="ml-auto h-6 w-16 border-2" />
        </div>
        <Skeleton surface="card" className="h-6 w-3/4" />
        <Skeleton surface="card" className="h-3 w-1/2 border-2" />
        <SkeletonText surface="card" lines={4} lineClassName="h-3" className="gap-3 pt-1" />
      </div>
    </div>
  );
}

/**
 * Planning placeholder that mirrors the result: badges, the summary card
 * with its six stats, interpretation and optimizations, and two step nodes in
 * lanes joined by a dashed edge. Announced once as "Planning intent".
 */
export function StudioSkeleton({ prompt }: { prompt: string }) {
  return (
    <SkeletonGroup label="Planning intent" className="flex flex-col gap-6">
      <p className={cx("font-code text-xs leading-relaxed", TEXT_MUTED)}>
        Compiling “
        <span className="kl-shimmer kl-loop inline-block max-w-full break-words bg-[#FFF3B0] px-1 align-bottom text-[#1A1A1A] dark:bg-[#2A2410] dark:text-[#FDE68A]">
          {prompt || "your intent"}
        </span>
        ”…
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-6 w-[4.5rem] border-2" />
        <Skeleton className="h-6 w-36 border-2" />
        <Skeleton className="h-3 w-24 border-2" />
      </div>
      <div className={cx(INK_BORDER, HARD_SHADOW, SURFACE)}>
        <div className="flex flex-col gap-3 border-b-[3px] border-[#1A1A1A] p-4 dark:border-[#4B5563] sm:flex-row sm:items-start sm:justify-between sm:p-5">
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <Skeleton surface="card" className="h-3 w-44 border-2" />
            <Skeleton surface="card" className="h-8 w-[60%]" />
            <Skeleton surface="card" className="h-3 w-[30%] border-2" />
          </div>
          <div className="flex shrink-0 gap-2">
            <Skeleton surface="card" className="h-6 w-20 border-2" />
            <Skeleton surface="card" className="h-6 w-28 border-2" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-[2px] bg-[#1A1A1A] dark:bg-[#4B5563] sm:grid-cols-3">
          {STAT_CELLS.map((width, index) => (
            <div key={index} className="flex flex-col gap-2 bg-white px-4 py-3 dark:bg-[#131E32]">
              <Skeleton surface="card" className="h-2.5 w-14 border-2" />
              <Skeleton surface="card" className={cx("h-5 border-2", width)} />
            </div>
          ))}
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {[3, 1].map((lines, index) => (
          <div key={index} className={cx("flex flex-col gap-3 p-4 sm:p-5", INK_BORDER, SURFACE)}>
            <Skeleton surface="card" className="h-3 w-32 border-2" />
            <SkeletonText surface="card" lines={lines} />
          </div>
        ))}
      </div>
      <div className="flex flex-col">
        <div className="hidden gap-8 pb-4 md:flex">
          <div className="flex-1">
            <Skeleton className="h-8 w-28" />
          </div>
          <div className="flex-1">
            <Skeleton className="h-8 w-24" />
          </div>
        </div>
        <NodeSkeleton className="md:w-[calc(50%-1rem)]" />
        {/* Dashed placeholder edge: down, across, down (straight down on one column). */}
        <svg aria-hidden="true" viewBox="0 0 100 64" preserveAspectRatio="none" className="hidden h-16 w-full md:block">
          <path
            d="M 25 0 V 32 H 75 V 64"
            fill="none"
            strokeWidth={3}
            strokeDasharray="6 6"
            vectorEffect="non-scaling-stroke"
            className="stroke-[#1A1A1A]/35 dark:stroke-white/25"
          />
        </svg>
        <div className="flex h-12 justify-center md:hidden">
          <span className="h-full border-l-[3px] border-dashed border-[#1A1A1A]/35 dark:border-white/25" />
        </div>
        <NodeSkeleton className="md:ml-auto md:w-[calc(50%-1rem)]" />
      </div>
    </SkeletonGroup>
  );
}
