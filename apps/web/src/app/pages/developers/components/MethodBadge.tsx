import { cx } from "../../../site/ui/styles";

const METHOD_CLASS: Record<string, string> = {
  GET: "bg-[#4ADE80] text-[#0E0E10]",
  POST: "bg-[#2F5BFF] text-white",
  PUT: "bg-[#C6FF3A] text-[#121212]",
  PATCH: "bg-[#C6FF3A] text-[#121212]",
  DELETE: "bg-[#FF5A5F] text-[#121212]",
};

/** HTTP method chip (the method is also the text, so colour is never the only cue). */
export function MethodBadge({ method, className }: { readonly method: string; readonly className?: string }) {
  return (
    <span
      className={cx(
        "inline-flex min-w-[3.25rem] shrink-0 items-center justify-center px-1.5 py-0.5 font-code text-[10px] font-bold uppercase",
        METHOD_CLASS[method] ?? "bg-[#E6E2D9] text-[#121212]",
        className,
      )}
    >
      {method}
    </span>
  );
}
