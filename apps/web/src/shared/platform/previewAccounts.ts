/**
 * Demo CAIP-10 accounts used by read-only previews (dry-run planning never
 * moves funds). Read from the core registry (`PREVIEW_ACCOUNT_IDS`), so the
 * web app, the API and clarify agree on which accounts are never read, never
 * offered as funded and never signed for. Their addresses come from a public
 * label, so nobody holds their keys, and neither is the recipient of a grammar
 * or protocol example.
 *
 * Dependency-free apart from @kletia/core so marketing routes can import it
 * without the signing rules in `intentBinding.ts`, which refuse these
 * accounts.
 */
import { PREVIEW_ACCOUNT_IDS, formatAccountId, parseAccountId, type AccountId } from "@kletia/core";

function previewAccountFor(namespace: "eip155" | "solana"): AccountId {
  const account = PREVIEW_ACCOUNT_IDS.find((id) => parseAccountId(id)?.chain.namespace === namespace);
  // The registry lists one per virtual machine; a missing one is a build-time defect, never a runtime fallback.
  if (!account) throw new Error(`@kletia/core has no ${namespace} preview account.`);
  return account;
}

export const PREVIEW_ACCOUNTS = Object.freeze({
  evm: previewAccountFor("eip155"),
  solana: previewAccountFor("solana"),
} as const);

/** Both preview accounts, homed on a lane: production (Base, Solana) or the test yard (Arc, Solana Devnet). */
export function previewAccountsForLane(lane: "production" | "testnet"): readonly AccountId[] {
  if (lane === "production") return [PREVIEW_ACCOUNTS.evm, PREVIEW_ACCOUNTS.solana];
  const evm = parseAccountId(PREVIEW_ACCOUNTS.evm)!;
  const solana = parseAccountId(PREVIEW_ACCOUNTS.solana)!;
  return [formatAccountId("arc", evm.address), formatAccountId("solana-devnet", solana.address)];
}
