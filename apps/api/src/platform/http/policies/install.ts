/**
 * Installs the Rule Book gate into the engine (policy design PF3a): the
 * engine's reference gate (`createRuleBookGate`) over this layer's ports:
 * the key chain source, the exposure ledger, the approval store and the
 * hash-chained decision log (memory, or Postgres when KLETIA_DATABASE_URL is
 * set). Approval links point at `<web origin>/approve#apr_…` (the id stays
 * in the fragment).
 *
 * Kill switch: KLETIA_POLICIES_ENABLED=false installs nothing (the engine's
 * no-op gate: rule books are stored but not enforced). A gate an embedder or
 * a test installed first is never replaced.
 *
 * Background (long-running hosts): the amendment promoter (every 30 s), the
 * Solana exposure reaper (every minute) and hourly pruning of decisions
 * (retention), decided approvals (30 days) and exposures (8 days).
 */
import { configurePolicyGate, createRuleBookGate, policyGateActive, type RuleBookGate } from "../../index.js";
import { kletiaWebOrigin } from "../webOrigin.js";
import { announcePromotions } from "./announce.js";
import { approvalStore } from "./approvals.js";
import { keyChainSource } from "./chain.js";
import { decisionRetentionDays, decisionStore } from "./decisions.js";
import { spendLedger, startExposureReaper } from "./ledger.js";
import { policyStore } from "./store.js";

let installed: RuleBookGate | null = null;

export function policiesEnabled(): boolean {
  return process.env.KLETIA_POLICIES_ENABLED?.trim().toLowerCase() !== "false";
}

/** Installs the gate once per process (idempotent); returns it, or null when disabled or another gate is installed. */
export function installPolicyGate(): RuleBookGate | null {
  if (installed) return installed;
  if (!policiesEnabled() || policyGateActive()) return null;
  installed = createRuleBookGate({
    chains: keyChainSource,
    ledger: spendLedger(),
    approvals: approvalStore(),
    decisions: decisionStore(),
    approvalUrl: (id) => `${kletiaWebOrigin()}/approve#${id}`,
  });
  configurePolicyGate(installed);
  return installed;
}

/** The installed gate (simulator, narrowing); null when rule books are not enforced here. */
export function ruleBookGate(): RuleBookGate | null {
  return installed;
}

/** Removes the installed gate (tests). */
export function uninstallPolicyGate(): void {
  if (installed) configurePolicyGate(null);
  installed = null;
}

const PROMOTE_INTERVAL_MS = 30_000;
const PRUNE_INTERVAL_MS = 60 * 60_000;
const APPROVAL_RETENTION_MS = 30 * 86_400_000;

/** Promoter, reaper and pruners; returns a stop function. */
export function startPolicyBackground(): () => void {
  const promoter = setInterval(() => {
    void policyStore()
      .promoteDue(Date.now(), 200)
      .then((promoted) => {
        if (promoted.length > 0) announcePromotions(promoted);
      })
      .catch((error: unknown) => console.warn("[platform] rule book promoter failed:", error instanceof Error ? error.message : error));
  }, PROMOTE_INTERVAL_MS);
  promoter.unref?.();
  const pruner = setInterval(() => {
    const now = Date.now();
    void decisionStore()
      .prune(new Date(now - decisionRetentionDays() * 86_400_000).toISOString())
      .catch((error: unknown) => console.warn("[platform] decision prune failed:", error instanceof Error ? error.message : error));
    void approvalStore()
      .prune(new Date(now - APPROVAL_RETENTION_MS).toISOString())
      .catch((error: unknown) => console.warn("[platform] approval prune failed:", error instanceof Error ? error.message : error));
  }, PRUNE_INTERVAL_MS);
  pruner.unref?.();
  const stopReaper = startExposureReaper();
  return () => {
    clearInterval(promoter);
    clearInterval(pruner);
    stopReaper();
  };
}
