/** Neo-brutalist class recipes shared by the Solana workspace panels. */
export const ui = {
  card: "border-[3px] border-[#1A1A1A] bg-white p-4 text-[#1A1A1A] shadow-[4px_4px_0_#1A1A1A] dark:border-[#4B5563] dark:bg-[#131E32] dark:text-white dark:shadow-[4px_4px_0_#475569] sm:p-5",
  subtleCard:
    "border-[3px] border-[#1A1A1A] bg-[#F5F5F0] p-3 dark:border-[#4B5563] dark:bg-[#0F172A]",
  label:
    "text-[10px] font-black uppercase tracking-[0.16em] text-gray-600 dark:text-slate-300",
  input:
    "min-h-12 w-full border-[3px] border-[#1A1A1A] bg-white px-3 py-2 text-base font-black text-[#1A1A1A] shadow-[3px_3px_0_#1A1A1A] outline-none placeholder:text-sm placeholder:font-bold placeholder:text-gray-500 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#9945FF] aria-[invalid=true]:border-[#EF4444] dark:border-[#4B5563] dark:bg-[#1A2841] dark:text-white dark:shadow-[3px_3px_0_#475569] dark:placeholder:text-slate-400",
  primaryButton:
    "inline-flex min-h-12 items-center justify-center gap-2 border-[3px] border-[#1A1A1A] bg-[#9945FF] px-4 py-3 text-sm font-black uppercase tracking-wider text-white shadow-[4px_4px_0_#1A1A1A] transition-[transform,box-shadow,background-color] duration-100 ease-out hover:-translate-y-0.5 hover:bg-[#7C2FE0] hover:shadow-[5px_5px_0_#1A1A1A] focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#14F195] active:translate-y-0.5 active:shadow-none disabled:cursor-not-allowed disabled:bg-gray-400 disabled:shadow-none dark:border-[#4B5563] dark:shadow-[4px_4px_0_#475569] dark:disabled:bg-slate-600",
  accentButton:
    "inline-flex min-h-12 items-center justify-center gap-2 border-[3px] border-[#1A1A1A] bg-[#14F195] px-4 py-3 text-sm font-black uppercase tracking-wider text-[#1A1A1A] shadow-[4px_4px_0_#1A1A1A] transition-[transform,box-shadow] duration-100 ease-out hover:-translate-y-0.5 hover:shadow-[5px_5px_0_#1A1A1A] focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#9945FF] active:translate-y-0.5 active:shadow-none disabled:cursor-not-allowed disabled:bg-gray-300 disabled:shadow-none dark:border-[#4B5563] dark:shadow-[4px_4px_0_#475569]",
  ghostButton:
    "inline-flex min-h-11 items-center justify-center gap-2 border-[3px] border-[#1A1A1A] bg-white px-3 py-2 text-xs font-black uppercase tracking-wider text-[#1A1A1A] shadow-[3px_3px_0_#1A1A1A] transition-[transform,box-shadow,background-color] duration-100 ease-out hover:-translate-y-0.5 hover:bg-[#F3E8FF] hover:shadow-[4px_4px_0_#1A1A1A] focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#9945FF] active:translate-y-0.5 active:shadow-none disabled:cursor-not-allowed disabled:opacity-50 dark:border-[#4B5563] dark:bg-[#1A2841] dark:text-white dark:shadow-[3px_3px_0_#475569] dark:hover:bg-[#243652]",
  chip: (active: boolean) =>
    `inline-flex min-h-11 items-center justify-center border-[3px] border-[#1A1A1A] px-3 py-2 text-xs font-black uppercase tracking-wider transition-[transform,box-shadow,background-color] duration-100 ease-out focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#9945FF] active:translate-y-0.5 dark:border-[#4B5563] ${
      active
        ? "bg-[#1A1A1A] text-[#14F195] shadow-none dark:bg-[#14F195] dark:text-[#1A1A1A]"
        : "bg-white text-[#1A1A1A] shadow-[3px_3px_0_#1A1A1A] hover:-translate-y-0.5 dark:bg-[#1A2841] dark:text-white dark:shadow-[3px_3px_0_#475569]"
    }`,
  errorBox:
    "border-[3px] border-[#1A1A1A] bg-[#FEE2E2] p-3 text-sm font-bold text-[#7F1D1D] dark:border-red-500 dark:bg-red-950/40 dark:text-red-200",
  warningBox:
    "border-[3px] border-[#1A1A1A] bg-[#FFD60A] p-3 text-sm font-bold text-[#1A1A1A] dark:border-[#4B5563]",
} as const;
