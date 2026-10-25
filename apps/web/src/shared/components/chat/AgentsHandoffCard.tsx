import { ArrowUpRight, Bot } from "lucide-react";

/**
 * Shown when the intent engine classifies a request as an autonomous agent
 * action. The console executes one wallet-approved intent at a time; agents
 * run through the Agents integration (x402, MCP context and the v1 API).
 */
export function AgentsHandoffCard() {
  return (
    <div className="mt-5 flex w-full flex-col gap-3 border-[3px] border-[#121212] bg-[#E1E8FF] p-4 text-[#121212] shadow-[3px_3px_0_#121212] dark:border-[#4A4A52] dark:bg-[#19191C] dark:text-white dark:shadow-[3px_3px_0_#2A2A30] sm:w-80 md:w-[450px] md:shadow-[4px_4px_0_#121212] dark:md:shadow-[4px_4px_0_#2A2A30]">
      <p className="flex items-center gap-2 border-b-[3px] border-[#121212] pb-2 text-xs font-black uppercase tracking-widest dark:border-[#4A4A52] md:text-sm">
        <Bot className="h-4 w-4 text-[#1A36B0] md:h-5 md:w-5" aria-hidden="true" />
        Run this with Kletia Agents
      </p>
      <p className="text-sm font-bold leading-relaxed">
        This request asks Kletia to act on your behalf over time. Agents run through the Agents
        integration: they plan with the v1 intents API, read context over MCP and pay for data
        with x402, while every value-moving step still needs a wallet signature.
      </p>
      <a
        href="/developers#agents"
        className="inline-flex min-h-11 items-center justify-center gap-2 border-[3px] border-[#121212] bg-[#2F5BFF] px-3 py-2 text-xs font-black uppercase tracking-wider text-white shadow-[3px_3px_0_#121212] transition-[transform,box-shadow] duration-100 ease-out hover:-translate-y-0.5 hover:shadow-[4px_4px_0_#121212] focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#FFD700] active:translate-y-0.5 active:shadow-none dark:border-[#4A4A52]"
      >
        Set up an agent
        <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
      </a>
    </div>
  );
}
