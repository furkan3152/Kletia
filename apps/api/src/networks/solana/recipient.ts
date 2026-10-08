/**
 * Recipient checks for Solana transfers and bridges. Token transfers credit
 * the recipient's associated token account, so a pasted token account, mint or
 * program vault address would receive funds into an account no wallet signs for.
 */
import { address } from "@solana/kit";
import { isSolanaAddress } from "@kletia/core";
import { SOLANA_PROGRAMS, type SolanaNetworkKey } from "./config.js";
import { SolanaProviderError } from "./http.js";
import { rpcAbortSignal, solanaRpc } from "./rpc.js";

/**
 * Refuses a recipient that is not a wallet: an existing account owned by the
 * Token or Token-2022 program (a token account or mint), or by any program
 * other than the System program while holding data. Accounts that do not exist
 * yet (fresh wallets, PDA wallets such as multisig vaults) are allowed. A read
 * that fails is never treated as a pass.
 */
export async function assertSolanaWalletRecipient(network: SolanaNetworkKey, recipient: string): Promise<void> {
  if (!isSolanaAddress(recipient)) {
    throw new SolanaProviderError("Recipient must be a Solana address.", "SOLANA_ADDRESS_INVALID", 400);
  }
  let account;
  try {
    // One byte of data is enough to tell an empty account from one holding state.
    const info = await solanaRpc(network)
      .getAccountInfo(address(recipient), { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: 1 } })
      .send({ abortSignal: rpcAbortSignal() });
    account = info.value;
  } catch {
    throw new SolanaProviderError(
      "The recipient account could not be checked. Try again shortly.",
      "SOLANA_RPC_UNAVAILABLE",
      503,
    );
  }
  if (!account) return;
  const owner = String(account.owner);
  if (owner === SOLANA_PROGRAMS.token || owner === SOLANA_PROGRAMS.token2022) {
    throw new SolanaProviderError(
      "Recipient is a token account or mint, not a wallet address. Use the recipient's wallet address.",
      "SOLANA_RECIPIENT_NOT_WALLET",
      422,
    );
  }
  if (owner === SOLANA_PROGRAMS.system) return;
  // `space` is missing on older RPC nodes; the sliced data still shows whether the account holds any.
  const space: unknown = (account as { space?: unknown }).space;
  const data: unknown = account.data;
  const hasData =
    (typeof space === "bigint" ? space > 0n : typeof space === "number" && space > 0) ||
    (Array.isArray(data) && typeof data[0] === "string" && data[0].length > 0);
  if (hasData) {
    throw new SolanaProviderError(
      "Recipient is an account owned by a program, not a wallet address. Use the recipient's wallet address.",
      "SOLANA_RECIPIENT_NOT_WALLET",
      422,
    );
  }
}
