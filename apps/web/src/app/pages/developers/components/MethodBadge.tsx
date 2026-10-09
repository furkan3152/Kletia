import { cx } from "../../../site/ui/styles";

const METHOD_CLASS: Record<string, string> = {
  GET: "bg-[#4ADE80] text-[#0B1120]",
  POST: "bg-[#0052FF] text-white",
  PUT: "bg-[#FFD60A] text-[#1A1A1A]",
  PATCH: "bg-[#FFD60A] text-[#1A1A1A]",
  DELETE: "bg-[#FF5A5F] text-[#1A1A1A]",
};

/** HTTP method chip (the method is also the text, so colour is never the only cue). */
export function MethodBadge({ method, className }: { readonly method: string; readonly className?: string }) {
  return (
    <span
      className={cx(
        "inline-flex min-w-[3.25rem] shrink-0 items-center justify-center px-1.5 py-0.5 font-code text-[10px] font-bold uppercase",
        METHOD_CLASS[method] ?? "bg-[#F1EFE8] text-[#1A1A1A]",
        className,
      )}
    >
      {method}
    </span>
  );
}
