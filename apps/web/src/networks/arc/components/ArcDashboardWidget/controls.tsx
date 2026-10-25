/**
 * Form controls of the Arc dashboard widget.
 */
import React from "react";

export const InputLabel = ({ children }: { children: React.ReactNode }) => (
  <label className="block text-xs font-black uppercase tracking-wider text-[#121212] dark:text-white mb-2">
    {children}
  </label>
);

export const InputField = (props: React.InputHTMLAttributes<HTMLInputElement>) => (
  <input
    {...props}
    className={`w-full p-3 bg-[#FBFAF6] dark:bg-[#121212] border-[3px] border-[#121212] dark:border-[#4A4A52] shadow-[3px_3px_0_#121212] dark:shadow-[3px_3px_0_#2A2A30] focus:outline-none focus:-translate-y-0.5 focus:shadow-[5px_5px_0_#121212] dark:focus:shadow-[5px_5px_0_#8B5CF6] transition-all font-bold text-[#121212] dark:text-white disabled:opacity-50 disabled:cursor-not-allowed ${props.className || ""}`}
  />
);

export const ActionButton = ({
  onClick,
  disabled,
  children,
  colorClass,
  className = "",
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  colorClass?: string;
  className?: string;
}) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className={`w-full py-3 px-4 font-black uppercase tracking-widest text-white transition-all duration-200 border-[3px] border-[#121212] dark:border-[#4A4A52] shadow-[4px_4px_0_#121212] dark:shadow-[4px_4px_0_#2A2A30] ${disabled ? "bg-gray-400 dark:bg-slate-600 opacity-80 cursor-not-allowed shadow-[1px_1px_0_#121212] translate-y-0.5" : `${colorClass || "bg-[#2F5BFF]"} hover:-translate-y-1 hover:shadow-[6px_6px_0_#121212] dark:hover:shadow-[6px_6px_0_#2A2A30] active:translate-y-0 active:shadow-[1px_1px_0_#121212]`} ${className}`}
  >
    {children}
  </button>
);
