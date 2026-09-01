import React from "react";
import { Send } from "lucide-react";
import type { NetworkMode } from "../../config/networks";

interface ChatInputProps {
  input: string;
  setInput: (val: string) => void;
  handleSend: () => void;
  networkMode: NetworkMode | "stellar";
  inputRef?: React.Ref<HTMLTextAreaElement>;
}

export const ChatInput: React.FC<ChatInputProps> = ({
  input,
  setInput,
  handleSend,
  networkMode,
  inputRef,
}) => {
  const presentation = {
    base: {
      placeholder: "Base Mainnet: E.g., buy ETH with 10 USDC or show my portfolio",
      focus: "focus:border-[#0052FF] focus:shadow-[3px_3px_0_#0052FF] focus-visible:outline-[#0052FF]",
      notice: "Base Mainnet uses real assets. Verify the recipient, amount, and gas cost before signing.",
    },
    arc: {
      placeholder: "Arc Testnet: E.g., stake 10 USDC or show my Arc portfolio",
      focus: "focus:border-[#8B5CF6] focus:shadow-[3px_3px_0_#8B5CF6] focus-visible:outline-[#8B5CF6]",
      notice: "You are using Arc Testnet: native USDC is used for both value and gas. Verify the recipient and amount before signing.",
    },
    arbitrum: {
      placeholder: "Arbitrum One: E.g., swap 10 USDC to WETH or compare Aave rates",
      focus: "focus:border-[#28A0F0] focus:shadow-[3px_3px_0_#28A0F0] focus-visible:outline-[#28A0F0]",
      notice: "Arbitrum One is a mainnet Public Beta. Quotes expire; verify the route, recipient, amount, and ETH gas before signing.",
    },
    stellar: {
      placeholder: "Stellar Testnet: E.g., swap 5 XLM to USDC or show my balances",
      focus: "focus:border-[#8B5CF6] focus:shadow-[3px_3px_0_#8B5CF6] focus-visible:outline-[#8B5CF6]",
      notice: "Stellar-native and reviewed multichain goals stay in chat. Every public transaction still requires its exact network wallet.",
    },
  }[networkMode];

  return (
    <div className="z-20 w-full bg-transparent px-2.5 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-2 sm:px-4 md:px-6 md:pb-8 md:pt-4">
      <div className="relative mx-auto flex max-w-4xl items-end">
        <label htmlFor="kletia-intent-input" className="sr-only">
          Describe your intent
        </label>
        <textarea
          id="kletia-intent-input"
          ref={inputRef}
          rows={1}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              handleSend();
            }
          }}
          enterKeyHint="send"
          autoComplete="off"
          placeholder={presentation.placeholder}
          className={`max-h-32 min-h-14 w-full resize-none overflow-y-auto border-[3px] border-[#1A1A1A] bg-white px-3 py-3 pr-16 text-base font-black leading-6 text-[#1A1A1A] shadow-[3px_3px_0_#1A1A1A] outline-none transition-[background-color,box-shadow,border-color] duration-100 [field-sizing:content] placeholder:text-sm placeholder:font-bold placeholder:text-gray-600 focus:bg-[#FAFAFA] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 dark:border-[#4B5563] dark:bg-[#1A2841] dark:text-white dark:shadow-[3px_3px_0_#475569] dark:placeholder:text-slate-300 dark:focus:bg-[#131E32] md:min-h-16 md:px-5 md:py-4 md:pr-20 md:text-lg md:shadow-[4px_4px_0_#1A1A1A] dark:md:shadow-[4px_4px_0_#475569] ${presentation.focus}`}
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={!input.trim()}
          aria-label="Send intent"
          className="absolute bottom-1.5 right-1.5 flex h-11 w-11 items-center justify-center border-[3px] border-[#1A1A1A] bg-white text-[#1A1A1A] shadow-[2px_2px_0_#1A1A1A] transition-[transform,box-shadow,background-color] duration-100 hover:bg-gray-100 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#0052FF] active:translate-y-0.5 active:shadow-none disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-gray-500 disabled:shadow-none dark:border-[#4B5563] dark:bg-[#131E32] dark:text-white dark:shadow-[2px_2px_0_#475569] dark:hover:bg-[#1A2841] dark:disabled:bg-slate-800 dark:disabled:text-slate-400 md:bottom-2.5 md:right-3 md:h-12 md:w-12"
        >
          <Send
            className="h-5 w-5 md:h-6 md:w-6"
            strokeWidth={4}
            aria-hidden="true"
          />
        </button>
      </div>
      <p className="mx-auto mt-2 max-w-3xl px-2 text-center text-[11px] font-bold leading-4 text-gray-600 dark:text-slate-300 md:mt-3 md:text-xs">
        {presentation.notice}
      </p>
    </div>
  );
};
