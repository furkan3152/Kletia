/**
 * Explorer links for intent steps. Wallet-free and store-free so read-only
 * views (Studio, the widget host, the console) can share it.
 */
import { CHAINS, explorerTxUrl, type IntentStep, type NetworkKey, type StepEvidence } from "@kletia/core";

const REFERENCE = /^[A-Za-z0-9]{16,128}$/u;

export function isStepReference(value: unknown): value is string {
  return typeof value === "string" && REFERENCE.test(value);
}

export function httpsUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Evidence observed on the step's own network (the user's transaction), newest first. */
export function sourceEvidence(step: IntentStep): StepEvidence | undefined {
  return [...step.evidence]
    .reverse()
    .find((item) => item.network === step.network && (item.reference || item.url));
}

export interface StepLink {
  readonly label: string;
  readonly url: string;
  readonly network: NetworkKey;
}

/** Explorer links for a step: evidence URLs first, then submitted references. */
export function stepExplorerLinks(step: IntentStep): StepLink[] {
  const links: StepLink[] = [];
  const seen = new Set<string>();
  const push = (network: NetworkKey, url: string | undefined, label?: string) => {
    const safe = httpsUrl(url);
    if (!safe || seen.has(safe)) return;
    seen.add(safe);
    links.push({ network, url: safe, label: label ?? `View on ${CHAINS[network]?.explorer.name ?? "explorer"}` });
  };
  for (const evidence of step.evidence) {
    if (!CHAINS[evidence.network]) continue;
    const url =
      evidence.url ??
      (isStepReference(evidence.reference) ? explorerTxUrl(evidence.network, evidence.reference) : undefined);
    push(
      evidence.network,
      url,
      evidence.network !== step.network
        ? `Settlement on ${CHAINS[evidence.network].explorer.name}`
        : undefined,
    );
  }
  for (const reference of step.references ?? []) {
    if (isStepReference(reference)) push(step.network, explorerTxUrl(step.network, reference));
  }
  return links;
}

