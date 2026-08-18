export enum ErrorCategory {
  RATE_LIMIT = "RATE_LIMIT",
  SLIPPAGE = "SLIPPAGE",
  ALLOWANCE = "ALLOWANCE",
  WHITELIST = "WHITELIST",
  INSUFFICIENT_FUNDS = "INSUFFICIENT_FUNDS",
  UNKNOWN_REVERT = "UNKNOWN_REVERT",
  NETWORK = "NETWORK",
  INVALID_ADDRESS = "INVALID_ADDRESS",
}

export interface AnalyzedError {
  category: ErrorCategory;
  reason: string;
  aiHint: string;
}

export class KletiaErrorTracker {
  static analyzeError(error: any, action?: string): AnalyzedError {
    const errorMsg = (error.message || error.toString()).toLowerCase();

    if (errorMsg.includes("over rate limit") || errorMsg.includes("429")) {
      return {
        category: ErrorCategory.RATE_LIMIT,
        reason: "RPC Node Rate Limit exceeded.",
        aiHint:
          "Tell the user that the transaction hit a temporary RPC limit and suggest they try again in 5-10 seconds or perform a different transaction.",
      };
    }

    if (
      errorMsg.includes("invalid_address") ||
      errorMsg.includes("invalid address") ||
      errorMsg.includes("checksum")
    ) {
      return {
        category: ErrorCategory.INVALID_ADDRESS,
        reason: "Invalid wallet or contract address.",
        aiHint:
          "Tell the user that the wallet or contract address is invalid. If the address belongs to the user, ask them to make sure their wallet is connected.",
      };
    }

    if (
      errorMsg.includes("insufficient output amount") ||
      errorMsg.includes("too little received") ||
      errorMsg.includes("slippage")
    ) {
      return {
        category: ErrorCategory.SLIPPAGE,
        reason:
          "Slippage might be set too low or the pool lacks sufficient liquidity.",
        aiHint:
          "Ask the user: 'The transaction was reverted due to slippage. Price volatility is high. Should we increase the slippage tolerance and try again?'",
      };
    }

    if (
      errorMsg.includes("transfer amount exceeds allowance") ||
      errorMsg.includes("insufficient allowance")
    ) {
      return {
        category: ErrorCategory.ALLOWANCE,
        reason:
          "Insufficient allowance granted to the Kletia Smart Contract for this token.",
        aiHint:
          "Tell the user they need to provide an Approve (Allowance) for the KletiaSmartRouter contract for this token. The system usually does this automatically, but manual intervention might be required.",
      };
    }

    if (
      errorMsg.includes("target protocol is not whitelisted") ||
      errorMsg.includes("not whitelisted")
    ) {
      return {
        category: ErrorCategory.WHITELIST,
        reason:
          "The target protocol is not whitelisted on the KletiaSmartRouter.",
        aiHint:
          "Tell the user: 'It seems the protocol for this transaction is not approved in the Kletia contract. We hit the security firewall. You must approve this protocol using the contract's setApprovedTarget function.'",
      };
    }

    if (
      errorMsg.includes("insufficient funds") ||
      errorMsg.includes("transfer amount exceeds balance")
    ) {
      return {
        category: ErrorCategory.INSUFFICIENT_FUNDS,
        reason:
          "The user does not have enough balance in their wallet to perform the transaction or pay for Gas fees.",
        aiHint:
          "Tell the user their wallet balance is insufficient for this transaction. Mention that you have added a button to the chat so they can instantly fund their Vault using a Credit Card or Apple Pay, and append EXACTLY this hidden tag to the end of your message: [SHOW_ONRAMP]",
      };
    }

    if (
      errorMsg.includes("timeout") ||
      errorMsg.includes("network error") ||
      errorMsg.includes("econnrefused")
    ) {
      return {
        category: ErrorCategory.NETWORK,
        reason: "Network connection error or timeout.",
        aiHint:
          "Tell the user there is a temporary connection issue on the Base network and the transaction timed out.",
      };
    }

    let aiHint =
      "Tell the user that the transaction was reverted by the blockchain due to an error. The liquidity pool might be depleted or parameters might be incorrect.";
    if (
      action === "borrow" ||
      action === "lend" ||
      action === "repay" ||
      action === "withdraw"
    ) {
      aiHint =
        "Tell the user that the transaction was rejected by the blockchain. This is usually caused by insufficient collateral in the wallet or exceeding the borrow limit. Ask them to check their collateral.";
    }

    return {
      category: ErrorCategory.UNKNOWN_REVERT,
      reason: `An unknown smart contract error occurred: ${error.shortMessage || errorMsg.substring(0, 150)}`,
      aiHint,
    };
  }
}
