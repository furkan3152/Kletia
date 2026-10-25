import { cx } from "./ui/styles";

/**
 * The Kletia logo tile (Card machine): an ink keycap with the mark masked in lime.
 * The PNG is the mask, so the mark takes any colour. Inside a `group` link the mark turns a
 * quarter on hover and focus.
 */
export function KletiaMark({ size = "md", className }: { size?: "sm" | "md" | "lg"; className?: string }) {
  const box = size === "lg" ? "h-14 w-14 rounded-[12px]" : size === "sm" ? "h-9 w-9 rounded-[9px]" : "h-11 w-11 rounded-[10px]";
  const inset = size === "lg" ? "inset-[8px]" : size === "sm" ? "inset-[5px]" : "inset-[6px]";
  return (
    <span className={cx("relative flex shrink-0 bg-[#121212] shadow-[inset_0_1px_0_rgba(255,255,255,.12),0_2px_0_#000] dark:bg-[#232327] dark:shadow-[inset_0_1px_0_rgba(255,255,255,.08),0_2px_0_#000]", box, className)}>
      <span
        aria-hidden="true"
        className={cx(
          "absolute bg-[#C6FF3A] [mask:url(/kletia-logo.png)_center/contain_no-repeat] [-webkit-mask:url(/kletia-logo.png)_center/contain_no-repeat] transition-transform duration-240 ease-kl-snap group-hover:rotate-90 group-focus-visible:rotate-90 motion-reduce:transition-none motion-reduce:group-hover:rotate-0 motion-reduce:group-focus-visible:rotate-0",
          inset,
        )}
      />
    </span>
  );
}
