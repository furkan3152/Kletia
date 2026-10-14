/** "Planning with your accounts.": a placeholder shaped like the review that follows (Studio's ReviewSkeleton). */
import { Skeleton, SkeletonGroup, SkeletonText } from "../../site/ui/Skeleton";
import { cx, HARD_SHADOW, INK_BORDER, LABEL, SURFACE } from "../../site/ui/styles";

export function PlanningSkeleton({ label }: { readonly label: string }) {
  return (
    <SkeletonGroup label={label} className="flex flex-col gap-4">
      <div className={cx("flex flex-col gap-4 p-4 sm:p-5", INK_BORDER, HARD_SHADOW, SURFACE)}>
        <p className={cx(LABEL, "text-[var(--kl-accent-text)]")}>{label}</p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="flex flex-col gap-1.5">
              <Skeleton surface="card" className="h-2.5 w-16 border-2" />
              <Skeleton surface="card" className="h-4 w-24 border-2" />
            </div>
          ))}
        </div>
      </div>
      <div className={cx("flex flex-col gap-3 p-4", INK_BORDER, SURFACE)}>
        <Skeleton surface="card" className="h-5 w-2/3" />
        <SkeletonText surface="card" lines={2} />
      </div>
    </SkeletonGroup>
  );
}
