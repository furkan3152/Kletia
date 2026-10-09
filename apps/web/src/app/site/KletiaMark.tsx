import { cx, INK_BORDER_THIN } from "./ui/styles";

/**
 * The Kletia logo tile. The PNG is white-on-transparent, inverted for light
 * mode. Inside a `group` link the mark turns a quarter on hover and focus.
 */
export function KletiaMark({ size = "md", className }: { size?: "sm" | "md" | "lg"; className?: string }) {
  const box = size === "lg" ? "h-14 w-14" : size === "sm" ? "h-9 w-9" : "h-11 w-11";
  const img = size === "lg" ? "h-10 w-10" : size === "sm" ? "h-6 w-6" : "h-7 w-7";
  return (
    <span
      className={cx(
        "flex shrink-0 items-center justify-center bg-white shadow-[3px_3px_0_#1A1A1A] dark:bg-[#0B1220] dark:shadow-[3px_3px_0_#475569]",
        INK_BORDER_THIN,
        "border-[3px]",
        box,
        className,
      )}
    >
      <img
        src="/kletia-logo.png"
        alt=""
        width="32"
        height="32"
        className={cx(
          img,
          "object-contain invert transition-transform duration-240 ease-kl-snap group-hover:rotate-90 group-focus-visible:rotate-90 dark:invert-0 motion-reduce:transition-none motion-reduce:group-hover:rotate-0 motion-reduce:group-focus-visible:rotate-0",
        )}
      />
    </span>
  );
}
