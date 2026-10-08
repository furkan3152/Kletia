/**
 * Demo CAIP-10 accounts used by read-only previews (dry-run planning never
 * moves funds). Dependency-free so marketing routes can import it without the
 * signing rules in `intentBinding.ts`, which refuse these accounts.
 */
export const PREVIEW_ACCOUNTS = Object.freeze({
  evm: "eip155:8453:0x000000000000000000000000000000000000dEaD",
  solana:
    "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
} as const);
