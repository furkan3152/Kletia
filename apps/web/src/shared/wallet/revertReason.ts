/**
 * Readable text for a reverted transaction or call. Wallets and nodes report
 * reverts as raw data ("Execution reverted with reason: custom error
 * 0x5dac504d: 0000…"); the user sees what it means, never the hex. Known
 * custom errors are named by their 4-byte selector (keccak-256 of the
 * signature, checked with viem's toFunctionSelector); an unknown one says the
 * contract refused without the raw data. Pure (node --test loads it).
 */

/** Selector → what it means for the person (the contract's own error name in brackets). */
const KNOWN_ERRORS: Readonly<Record<string, string>> = Object.freeze({
  // GMX Synthetics Errors.sol
  "0x5dac504d": "The execution fee sent is below what GMX asks for right now (InsufficientExecutionFee). Get a new quote: network fees moved.",
  "0x3a78cd7e": "The ETH sent does not cover GMX's execution fee (InsufficientWntAmountForExecutionFee). Get a new quote and keep some ETH for fees.",
  // OpenZeppelin ERC-20 (v5) IERC20Errors
  "0xe450d38c": "The wallet does not hold enough of the token for this transaction (ERC20InsufficientBalance).",
  "0xfb8f41b2": "The contract may not spend this much of the token yet: the approval is too small (ERC20InsufficientAllowance).",
  // Uniswap Permit2
  "0xf96fb071": "The Permit2 allowance is too small for this amount (InsufficientAllowance).",
  "0xd81b2f2e": "The Permit2 allowance expired (AllowanceExpired). Approve again.",
  // Uniswap Universal Router (V3 swaps)
  "0x39d35496": "The price moved: the swap would return less than the minimum you accepted (V3TooLittleReceived). Get a new quote.",
  "0x739dbe52": "The price moved: the swap would cost more than the maximum you accepted (V3TooMuchRequested). Get a new quote.",
});

/** Solidity panic codes (Panic(uint256)). */
const PANICS: Readonly<Record<number, string>> = Object.freeze({
  0x01: "an internal check failed",
  0x11: "an amount overflowed or went below zero",
  0x12: "a division by zero",
  0x32: "an index out of range",
});

const CUSTOM_ERROR = /custom error (0x[0-9a-fA-F]{8})/u;
const REASON_STRING = /reverted with (?:the following )?reason(?: string)?:?\s*['"]?([^'"\n]{1,200}?)['"]?(?:\n|$|\s*Contract Call:|\s*Request Arguments:)/u;
const PANIC = /panic(?: code)? (0x[0-9a-fA-F]+)/iu;
const RAW_DATA = /0x[0-9a-fA-F]{64,}|\b[0-9a-fA-F]{64,}\b/u;

/** True when the message is a revert a wallet or node reported. */
export function isRevertMessage(message: string): boolean {
  return /revert|custom error|panic code/iu.test(message);
}

/**
 * The person's reading of a revert message, or the message unchanged when
 * it is not one. Never returns raw hex data.
 */
export function readableRevert(message: string): string {
  if (!isRevertMessage(message)) return message;
  const custom = CUSTOM_ERROR.exec(message)?.[1]?.toLowerCase();
  if (custom) {
    const known = KNOWN_ERRORS[custom];
    return known ? `The contract refused this transaction: ${known}` : `The contract refused this transaction (its error ${custom} is not one Kletia can name).`;
  }
  const panic = PANIC.exec(message)?.[1];
  if (panic) {
    const what = PANICS[Number.parseInt(panic, 16)] ?? "an internal check failed";
    return `The contract refused this transaction: ${what}.`;
  }
  const reason = REASON_STRING.exec(message)?.[1]?.trim();
  if (reason && !RAW_DATA.test(reason) && !/^custom error/iu.test(reason)) {
    return `The contract refused this transaction: “${reason.replace(/[.]$/u, "")}”.`;
  }
  return "The contract refused this transaction.";
}
