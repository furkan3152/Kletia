/**
 * Class recipes shared by the Solana tool panels (desk Tools 04-07). They use
 * the site's Interchange tokens: ink borders, the semantic surface and text
 * colours, control borders with 3:1 contrast, the blue primary and the shared
 * focus ring. Solana's registry green stays on Solana marks (line bullets),
 * never on controls.
 */
const FOCUS = "focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-focus";
const PRESS =
  "transition-[transform,box-shadow,background-color] duration-100 ease-out hover:-translate-y-0.5 active:translate-y-0.5 active:shadow-none motion-reduce:transition-none motion-reduce:hover:translate-y-0";

export const ui = {
  card: "border-[3px] border-[#121212] bg-surface p-4 text-fg shadow-[4px_4px_0_#121212] dark:border-[#4A4A52] dark:shadow-[4px_4px_0_#2A2A30] sm:p-5",
  subtleCard: "border-[3px] border-[#121212] bg-surface-2 p-3 dark:border-[#4A4A52]",
  label: "text-label uppercase text-muted",
  input: `min-h-12 w-full border-[3px] border-control bg-surface px-3 py-2 text-base font-bold text-fg outline-none placeholder:text-sm placeholder:font-semibold placeholder:text-[var(--kl-placeholder)] aria-[invalid=true]:border-[#B91C1C] dark:aria-[invalid=true]:border-[#FCA5A5] ${FOCUS}`,
  primaryButton: `inline-flex min-h-12 items-center justify-center gap-2 border-[3px] border-control bg-[#2F5BFF] px-4 py-3 text-sm font-black uppercase tracking-wider text-white shadow-[4px_4px_0_#121212] hover:bg-[#2448E0] dark:shadow-[4px_4px_0_#2A2A30] disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none ${PRESS} ${FOCUS}`,
  accentButton: `inline-flex min-h-12 items-center justify-center gap-2 border-[3px] border-control bg-[#C6FF3A] px-4 py-3 text-sm font-black uppercase tracking-wider text-[#121212] shadow-[4px_4px_0_#121212] hover:bg-[#D4FF6A] dark:shadow-[4px_4px_0_#2A2A30] disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none ${PRESS} ${FOCUS}`,
  ghostButton: `inline-flex min-h-11 items-center justify-center gap-2 border-[3px] border-control bg-surface px-3 py-2 text-xs font-black uppercase tracking-wider text-fg shadow-[3px_3px_0_#121212] hover:bg-[#EEFBC8] dark:shadow-[3px_3px_0_#2A2A30] dark:hover:bg-[#2A2A2E] disabled:cursor-not-allowed disabled:opacity-50 ${PRESS} ${FOCUS}`,
  chip: (active: boolean) =>
    `inline-flex min-h-11 items-center justify-center border-[3px] border-control px-3 py-2 text-xs font-black uppercase tracking-wider transition-[transform,box-shadow,background-color] duration-100 ease-out active:translate-y-0.5 motion-reduce:transition-none ${FOCUS} ${
      active
        ? "bg-[#121212] text-white shadow-none dark:bg-[#F2F0EA] dark:text-[#0E0E10]"
        : "bg-surface text-fg shadow-[3px_3px_0_#121212] hover:-translate-y-0.5 dark:shadow-[3px_3px_0_#2A2A30] motion-reduce:hover:translate-y-0"
    }`,
  /** Inline text buttons ("Max 1.2"): the link colour of the site. */
  textButton: `text-xs font-black uppercase text-[#1A36B0] underline-offset-2 hover:underline disabled:opacity-50 dark:text-[#8FA6FF] ${FOCUS}`,
  /** Hints under a field. */
  hint: "text-xs font-semibold text-muted",
  errorBox:
    "border-[3px] border-[#121212] bg-[#FEE2E2] p-3 text-sm font-bold text-[#7F1D1D] dark:border-[#4A4A52] dark:bg-[#3A1414] dark:text-[#FECACA]",
  warningBox: "border-[3px] border-[#121212] bg-[#C6FF3A] p-3 text-sm font-bold text-[#121212] dark:border-[#4A4A52]",
} as const;
