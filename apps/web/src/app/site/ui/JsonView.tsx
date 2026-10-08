import { CopyButton } from "./CopyButton";
import { highlightCode } from "./highlight";
import { cx, FOCUS_RING, INK_BORDER } from "./styles";

export interface JsonViewProps {
  readonly value: unknown;
  /** Accessible name of the scroll region. */
  readonly label: string;
  readonly className?: string;
  readonly maxHeightClassName?: string;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Pretty-printed, highlighted JSON with copy support. */
export function JsonView({ value, label, className, maxHeightClassName = "max-h-[26rem]" }: JsonViewProps) {
  const text = stringify(value);
  return (
    <div className={cx("relative min-w-0 bg-[#0D1117] text-[#E6EDF3]", INK_BORDER, className)}>
      <div className="absolute right-2 top-2 z-10">
        <CopyButton text={text} label={`Copy ${label}`} />
      </div>
      <div
        role="region"
        aria-label={label}
        tabIndex={0}
        className={cx("min-w-0 overflow-auto", maxHeightClassName, FOCUS_RING, "focus-visible:-outline-offset-4")}
      >
        <pre className="p-4 pr-24 font-code text-[12px] leading-5">
          <code>{highlightCode(text, typeof value === "string" ? "text" : "json")}</code>
        </pre>
      </div>
    </div>
  );
}
