/**
 * Compact action surfaces rendered inside the shared Kletia chat message.
 * Network-specific widgets should reuse these classes so the network changes
 * the content and wallet boundary, not the conversation's visual grammar.
 */
export const intentActionSectionClass =
  "mt-4 w-full border-t-[3px] border-[#1A1A1A] pt-4 text-[#1A1A1A] dark:border-[#4B5563] dark:text-white";

export const intentActionButtonClass =
  "inline-flex min-h-11 items-center justify-center gap-2 border-[3px] border-[#1A1A1A] bg-white px-3 py-2 text-xs font-black uppercase shadow-[3px_3px_0_#1A1A1A] transition-[transform,box-shadow,background-color] duration-100 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#0052FF] enabled:hover:-translate-y-0.5 enabled:hover:bg-[#FFF36D] enabled:hover:shadow-[4px_4px_0_#1A1A1A] enabled:active:translate-y-0.5 enabled:active:shadow-none disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-gray-500 disabled:shadow-none dark:border-[#4B5563] dark:bg-[#1A2841] dark:shadow-[3px_3px_0_#475569] dark:enabled:hover:bg-[#233554] dark:disabled:bg-slate-800 dark:disabled:text-slate-400";

export const intentPrimaryButtonClass = `${intentActionButtonClass} bg-[#0052FF] text-white enabled:hover:bg-[#003FC7] dark:bg-[#2563EB] dark:enabled:hover:bg-[#1D4ED8]`;

export const intentPositiveButtonClass = `${intentActionButtonClass} bg-[#B9F6D2] text-[#1A1A1A] enabled:hover:bg-[#83E7AD] dark:bg-[#256F4A] dark:text-white dark:enabled:hover:bg-[#1E5B3D]`;

export const intentActionInputClass =
  "min-h-11 w-full border-[3px] border-[#1A1A1A] bg-white px-3 py-2 font-black text-[#1A1A1A] shadow-[2px_2px_0_#1A1A1A] outline-none transition-[box-shadow,border-color] focus:border-[#0052FF] focus:shadow-[3px_3px_0_#0052FF] focus-visible:outline-none dark:border-[#4B5563] dark:bg-[#0F172A] dark:text-white dark:shadow-[2px_2px_0_#475569]";
