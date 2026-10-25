/**
 * Example intents per protocol, for "Try a {action}" links into Studio.
 *
 * Every prompt is copied verbatim from the API grammar's examples
 * (`GRAMMAR_EXAMPLES` in apps/api/src/platform/engine/grammar/examples.ts), so it is
 * known to compile; a test reads that file and fails when a prompt here is
 * not one of them. Where the grammar names the venue ("via raydium", "with
 * lido", "into yearn") the planner uses it; otherwise the link names the
 * action only and the planner picks the venue, so the UI never promises one.
 */

export interface ProtocolExample {
  /** Verb shown in the link: "Try a swap". */
  readonly action: string;
  readonly prompt: string;
}

const SWAP_SOL: ProtocolExample = { action: "swap", prompt: "swap 1 SOL to USDC" };
const SWAP_BASE: ProtocolExample = { action: "swap", prompt: "swap 0.01 ETH for USDC on base" };
const BRIDGE_TO_SOLANA: ProtocolExample = { action: "bridge", prompt: "bridge 25 USDC from base to solana" };
const BRIDGE_EVM: ProtocolExample = { action: "bridge", prompt: "bridge 100 USDC from ethereum to base" };
const EVM_TRANSFER: ProtocolExample = {
  action: "transfer",
  prompt: "send 0.001 ETH to 0x000000000000000000000000000000000000dEaD on arbitrum",
};

const EXAMPLES: Readonly<Record<string, ProtocolExample>> = Object.freeze({
  jupiter: SWAP_SOL,
  raydium: { action: "swap", prompt: "swap 1 SOL to USDC via raydium" },
  orca: { action: "swap", prompt: "swap 10 USDC to SOL on solana via orca" },
  meteora: { action: "swap", prompt: "swap 1 SOL to USDC via meteora" },
  relay: BRIDGE_TO_SOLANA,
  jito: { action: "stake", prompt: "buy JitoSOL with 2 SOL" },
  marinade: { action: "stake", prompt: "stake 1.5 SOL with marinade" },
  sanctum: { action: "swap", prompt: "buy JitoSOL with 2 SOL" },
  lido: { action: "stake", prompt: "stake 1 ETH with lido" },
  "aave-v3": { action: "withdraw", prompt: "withdraw 50 USDC from aave on base" },
  "compound-v3": { action: "withdraw", prompt: "withdraw all USDC from compound on arbitrum" },
  morpho: { action: "deposit", prompt: "deposit 100 USDC into morpho on base" },
  sparklend: { action: "deposit", prompt: "deposit 100 USDC into sparklend on ethereum" },
  "spark-savings": { action: "deposit", prompt: "deposit 100 USDC into spark savings on base" },
  "yearn-v3": { action: "deposit", prompt: "deposit 100 USDC into yearn on ethereum" },
  "jupiter-lend": { action: "deposit", prompt: "deposit 10 USDC into jupiter lend" },
  "uniswap-v3": { action: "swap", prompt: "swap 100 USDC to ETH on ethereum" },
  aerodrome: SWAP_BASE,
  "kletia-router-v2": SWAP_BASE,
  "spl-token": { action: "transfer", prompt: "send 5 USDC to 9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" },
  "erc20-transfer": EVM_TRANSFER,
  "system-transfer": EVM_TRANSFER,
  ens: { action: "transfer", prompt: "send 5 USDC to vitalik.eth on optimism" },
  across: { action: "bridge", prompt: "bridge 100 USDC from base to arbitrum via across" },
  "cctp-v2": BRIDGE_EVM,
  lifi: { action: "bridge", prompt: "bridge 25 USDC from base to solana via lifi" },
});

export function protocolExample(id: string): ProtocolExample | null {
  return Object.prototype.hasOwnProperty.call(EXAMPLES, id) ? EXAMPLES[id]! : null;
}

/** Studio deep link; Studio plans `?q=` on arrival. */
export function studioHref(prompt: string): string {
  return `/studio?q=${encodeURIComponent(prompt)}`;
}
