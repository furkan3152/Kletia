/**
 * Action aliases and amount rules shared by every parser path.
 */
import type { NetworkId } from "../../config/networks.js";
import { normalizeAssetReference } from "../../assets/catalog.js";

export function normalizeAssetMention(
  inputToken: string | undefined,
): string | undefined {
  if (!inputToken) return undefined;
  const normalized = normalizeAssetReference(inputToken);
  return /^\d+$/u.test(normalized) ? undefined : normalized;
}

const ARC_ACTION_ALIASES: Record<string, string> = {
  arc_swap: "swap",
  arc_stake: "stake",
  arc_unstake: "unstake",
  arc_claim_rewards: "claim_rewards",
  arc_claim_unstaked: "claim_unstaked",
  arc_vault_deposit: "vault_deposit",
  arc_vault_withdraw: "vault_withdraw",
  arc_vault_legacy_withdraw: "vault_legacy_withdraw",
  arc_lending_deposit: "lending_deposit",
  arc_lending_withdraw: "lending_withdraw",
  arc_lending_borrow: "lending_borrow",
  arc_lending_repay: "lending_repay",
  arc_memo_send: "memo_send",
  arc_add_liquidity: "add_liquidity",
  arc_remove_liquidity: "remove_liquidity",
  arc_stable_swap: "stable_swap",
  arc_appkit_send: "appkit_send",
  arc_appkit_bridge: "appkit_bridge",
  arc_official_memo_send: "official_memo_send",
  arc_atomic_payout: "atomic_payout",
};

export const REQUIRED_AMOUNT_ACTIONS: Record<NetworkId, ReadonlySet<string>> = {
  base: new Set([
    "swap",
    "add_liquidity",
    "remove_liquidity",
    "stake",
    "liquid_stake",
    "liquid_unstake",
    "borrow",
    "lend",
    "repay",
    "withdraw",
    "bridge",
    "deploy_token",
  ]),
  arc: new Set([
    "swap",
    "stake",
    "unstake",
    "vault_deposit",
    "lending_deposit",
    "lending_withdraw",
    "lending_borrow",
    "lending_repay",
    "memo_send",
    "add_liquidity",
    "remove_liquidity",
    "stable_swap",
    "appkit_send",
    "appkit_bridge",
    "official_memo_send",
  ]),
  arbitrum: new Set([
    "transfer",
    "swap",
    "lend",
    "withdraw",
    "borrow",
    "repay",
    "bridge",
  ]),
};

export function hasSafeExplicitAmount(amount: unknown): boolean {
  const normalized = String(amount ?? "").trim();
  if (normalized.toUpperCase() === "MAX") return true;
  if (!/^(?:\d+\.?\d*|\.\d+)$/.test(normalized)) return false;
  return /[1-9]/.test(normalized);
}

export function arcActionSupportsMax(action: string, tokenIn: unknown): boolean {
  if (action === "swap") {
    return (
      String(tokenIn || "")
        .trim()
        .toUpperCase() === "KLET"
    );
  }
  return new Set(["unstake", "remove_liquidity", "lending_withdraw"]).has(
    action,
  );
}

export function normalizeParsedAction(action: unknown, network: NetworkId): string {
  const normalized = String(action || "unknown")
    .trim()
    .toLowerCase();
  return network === "arc"
    ? ARC_ACTION_ALIASES[normalized] || normalized
    : normalized;
}
