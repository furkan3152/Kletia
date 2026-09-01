import type {
  WorkflowPlanV2,
  WorkflowRouteCandidateV2,
} from "../../cross-chain/v2/types";
import type {
  ApprovedCommitmentDisclosure,
  EgressGuardReport,
} from "./egressGuard";

export type PrivacyMeasurementStatus =
  | "measured"
  | "partial"
  | "violated"
  | "inactive";

export interface DerivedPrivacyBudgetView {
  readonly schemaVersion: "kletia_ui_privacy_budget_view_v1";
  readonly status: PrivacyMeasurementStatus;
  readonly selectedRoute: WorkflowRouteCandidateV2["kind"];
  readonly declaredRawWeight: number;
  readonly declaredNetPenalty: number;
  readonly userDefinedCap: null;
  readonly preset: WorkflowPlanV2["privacy"]["privacyBudget"]["preset"];
  readonly enforcement: "fail_closed";
  readonly compatible: boolean;
  readonly ruleCount: number;
  readonly publicFields: readonly string[];
  readonly observers: readonly string[];
  readonly guardedFields: readonly string[];
  readonly unguardableFields: readonly string[];
  readonly inspectedOperations: number;
  readonly blockedViolations: number;
  readonly approvedOpeningCount: number;
  readonly limitations: readonly string[];
}

export interface DerivedDisclosureDiffView {
  readonly schemaVersion: "kletia_ui_disclosure_diff_view_v1";
  readonly selectedRoute: WorkflowRouteCandidateV2["kind"];
  readonly comparedRoute: WorkflowRouteCandidateV2["kind"] | null;
  readonly rawWeightDelta: number | null;
  readonly netPenaltyDelta: number | null;
  readonly addedPairs: readonly string[];
  readonly avoidedPairs: readonly string[];
  readonly approvedOpenings: readonly ApprovedCommitmentDisclosure[];
  readonly irreversibleDisclosureCount: number;
  readonly entries: WorkflowPlanV2["privacy"]["disclosureDiff"]["entries"];
  readonly limitations: readonly string[];
}

function selectedCandidate(plan: WorkflowPlanV2): WorkflowRouteCandidateV2 {
  const selected = plan.routeCandidates.find(
    (candidate) => candidate.kind === plan.selectedRoute,
  );
  if (!selected) {
    throw new Error("The selected route has no disclosure profile.");
  }
  return selected;
}

function pairKey(pair: { field: string; observer: string }): string {
  return `${pair.field} → ${pair.observer}`;
}

export function derivePrivacyBudgetView(
  plan: WorkflowPlanV2,
  report: EgressGuardReport,
): DerivedPrivacyBudgetView {
  const selected = selectedCandidate(plan);
  const status: PrivacyMeasurementStatus = report.violations.length > 0
    ? "violated"
    : report.coverage === "complete"
      ? "measured"
      : report.coverage === "partial_low_entropy"
        ? "partial"
        : "inactive";
  return {
    schemaVersion: "kletia_ui_privacy_budget_view_v1",
    status,
    selectedRoute: selected.kind,
    declaredRawWeight: selected.disclosureProfile.rawWeight,
    declaredNetPenalty: selected.disclosureProfile.netPenalty,
    userDefinedCap: null,
    preset: plan.privacy.privacyBudget.preset,
    enforcement: plan.privacy.privacyBudget.enforcement,
    compatible: plan.privacy.disclosureDiff.compatible,
    ruleCount: plan.privacy.privacyBudget.rules.length,
    publicFields: [
      ...new Set(selected.disclosureProfile.pairs.map((pair) => pair.field)),
    ].sort(),
    observers: [
      ...new Set(selected.disclosureProfile.pairs.map((pair) => pair.observer)),
    ].sort(),
    guardedFields: report.guardedFields,
    unguardableFields: report.unguardableFields,
    inspectedOperations: report.inspectedOperations,
    blockedViolations: report.violations.length,
    approvedOpeningCount: report.approvedDisclosures.length,
    limitations: [
      "The signed Privacy Budget is an observer allowlist, not a numeric information-entropy cap or an anonymity proof.",
      "Route weights are reviewed policy values, not measured information entropy.",
      ...plan.privacy.privacyBudget.limitations,
      ...report.limitations,
    ],
  };
}

export function deriveDisclosureDiffView(
  plan: WorkflowPlanV2,
  report: EgressGuardReport,
): DerivedDisclosureDiffView {
  const selected = selectedCandidate(plan);
  const compared = plan.routeCandidates.find(
    (candidate) => candidate.kind !== selected.kind,
  ) ?? null;
  const selectedPairs = new Set(
    selected.disclosureProfile.pairs.map(pairKey),
  );
  const comparedPairs = new Set(
    compared?.disclosureProfile.pairs.map(pairKey) ?? [],
  );
  return {
    schemaVersion: "kletia_ui_disclosure_diff_view_v1",
    selectedRoute: selected.kind,
    comparedRoute: compared?.kind ?? null,
    rawWeightDelta: compared
      ? selected.disclosureProfile.rawWeight - compared.disclosureProfile.rawWeight
      : null,
    netPenaltyDelta: compared
      ? Number(
          (
            selected.disclosureProfile.netPenalty -
            compared.disclosureProfile.netPenalty
          ).toFixed(4),
        )
      : null,
    addedPairs: [...selectedPairs].filter((pair) => !comparedPairs.has(pair)).sort(),
    avoidedPairs: [...comparedPairs].filter((pair) => !selectedPairs.has(pair)).sort(),
    approvedOpenings: report.approvedDisclosures,
    irreversibleDisclosureCount:
      plan.privacy.disclosureDiff.finalKnowledge.filter(
        (entry) => entry.irreversible,
      ).length +
      report.approvedDisclosures.filter((entry) => entry.irreversible).length,
    entries: plan.privacy.disclosureDiff.entries,
    limitations: [
      ...plan.privacy.disclosureDiff.limitations,
      "A route diff describes declared observers. It does not prove that unrelated observers cannot correlate public amounts or timing.",
      "A public-checkpoint opening is irreversible once the request leaves the browser, even if the network response is lost.",
    ],
  };
}
