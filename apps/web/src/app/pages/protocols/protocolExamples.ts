/**
 * Example intents per protocol, for "Try a {action} intent" links into Studio.
 *
 * Every prompt is copied verbatim from the API grammar's examples
 * (`GRAMMAR_EXAMPLES` in apps/api/src/platform/engine/grammar.ts) or the
 * site's `INTENT_EXAMPLES`, so it is known to compile. The link names the
 * action, never the protocol: the planner picks the venue, and the UI must
 * not promise which one it will use.
 */

export interface ProtocolExample {
  /** Verb shown in the link: "Try a swap intent". */
  readonly action: string;
  readonly prompt: string;
}

const SWAP_SOL: ProtocolExample = { action: "swap", prompt: "swap 1 SOL to USDC" };
const SWAP_BASE: ProtocolExample = { action: "swap", prompt: "swap 0.01 ETH for USDC on base" };
const BRIDGE_TO_SOLANA: ProtocolExample = { action: "bridge", prompt: "bridge 25 USDC from base to solana" };
const BRIDGE_TO_ARBITRUM: ProtocolExample = { action: "bridge", prompt: "bridge 100 USDC from solana to arbitrum" };
const EVM_TRANSFER: ProtocolExample = {
  action: "transfer",
  prompt: "send 0.001 ETH to 0x000000000000000000000000000000000000dEaD on arbitrum",
};

const EXAMPLES: Readonly<Record<string, ProtocolExample>> = Object.freeze({
  jupiter: SWAP_SOL,
  relay: BRIDGE_TO_SOLANA,
  jito: { action: "stake", prompt: "buy JitoSOL with 2 SOL" },
  marinade: { action: "stake", prompt: "stake 1.5 SOL with marinade" },
  sanctum: { action: "swap", prompt: "buy JupSOL with 1 SOL" },
  "aave-v3": { action: "deposit", prompt: "bridge 20 USDC from solana to base and deposit it into aave" },
  "compound-v3": { action: "withdraw", prompt: "withdraw all USDC from compound on arbitrum" },
  morpho: { action: "deposit", prompt: "deposit 100 USDC into morpho on base" },
  "jupiter-lend": { action: "deposit", prompt: "deposit 10 USDC into jupiter lend" },
  "kletia-router-v2": SWAP_BASE,
  "uniswap-v3": SWAP_BASE,
  "spl-token": { action: "transfer", prompt: "send 5 USDC to 9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" },
  "erc20-transfer": EVM_TRANSFER,
  "system-transfer": EVM_TRANSFER,
  "cctp-v2": BRIDGE_TO_ARBITRUM,
  across: BRIDGE_TO_ARBITRUM,
  lifi: { action: "bridge", prompt: "bridge 25 USDC from base to solana via lifi" },
});

export function protocolExample(id: string): ProtocolExample | null {
  return Object.prototype.hasOwnProperty.call(EXAMPLES, id) ? EXAMPLES[id]! : null;
}

/** Studio deep link; Studio plans `?q=` on arrival. */
export function studioHref(prompt: string): string {
  return `/studio?q=${encodeURIComponent(prompt)}`;
}
