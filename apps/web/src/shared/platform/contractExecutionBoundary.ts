import type { KletiaClient, PrepareStepOptions } from "@kletia/sdk";

/**
 * Custom contracts belong to an integrator's project, rather than the
 * first-party Kletia signing surfaces. Keep this check independent of the
 * wallet runtime so every execution entry can apply it before a prompt.
 */
export const CUSTOM_CONTRACT_EXECUTION_CODE = "CUSTOM_CONTRACT_INTEGRATION_ONLY";
export const CUSTOM_CONTRACT_EXECUTION_MESSAGE =
  "Custom contracts can only be executed through the developer's own project integration. Kletia's main site does not sign custom contract calls. Open the integration that created this request.";

const CUSTOM_ACTIONS = new Set([
  "call", "action", "custom_call", "custom_action", "contract_call", "contract_action", "byoc",
]);
const CUSTOM_PROTOCOLS = new Set(["custom-call", "solana-actions"]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function actionName(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase().replace(/-/gu, "_") : "";
}

/** Core `call`/`action`, their protocol ids and legacy action names all count. */
export function isCustomContractExecution(value: unknown): boolean {
  const item = record(value);
  if (!item) return CUSTOM_ACTIONS.has(actionName(value));
  if ([item.kind, item.action, item.actionType].some((kind) => CUSTOM_ACTIONS.has(actionName(kind)))) return true;
  if (typeof item.protocol === "string" && CUSTOM_PROTOCOLS.has(item.protocol)) return true;
  // These are registration/call snapshots, never an audited protocol step.
  if (item.call !== undefined || item.contract !== undefined) return true;
  for (const key of ["steps", "actions"]) {
    if (Array.isArray(item[key]) && item[key].some(isCustomContractExecution)) return true;
  }
  return item.request !== undefined && isCustomContractExecution(item.request);
}

export class CustomContractExecutionError extends Error {
  readonly code = CUSTOM_CONTRACT_EXECUTION_CODE;

  constructor() {
    super(CUSTOM_CONTRACT_EXECUTION_MESSAGE);
    this.name = "CustomContractExecutionError";
  }
}

/** A prepared custom-contract review also blocks a graph whose labels changed. */
export function assertFirstPartyContractExecution(value: unknown, preparedReview?: unknown): void {
  if (isCustomContractExecution(value) || preparedReview !== undefined) throw new CustomContractExecutionError();
}

/**
 * The hosted frame may sign only the exact integrator-created intent it
 * opened, or the intent returned by its checked session. A URL query,
 * metadata flag or ordinary text plan never grants this exception.
 */
export function assertEmbedContractExecution(
  intent: unknown,
  integrationIntentId: string | null,
  preparedReview?: unknown,
): void {
  if (!isCustomContractExecution(intent) && preparedReview === undefined) return;
  const graph = record(intent);
  if (integrationIntentId && /^int_[0-9a-f]{32}$/u.test(integrationIntentId) && graph?.id === integrationIntentId) return;
  throw new CustomContractExecutionError();
}

/** A live integration scope, updated by the frame's committed navigation. */
export function createIntegrationIntentScope(initial: string | null): {
  get: () => string | null;
  set: (next: string | null) => void;
} {
  let intentId = initial;
  return { get: () => intentId, set: (next) => { intentId = next; } };
}

/** Check the fresh payload too, before the SDK can hand it to a wallet. */
export function withContractPreparationBoundary(
  client: KletiaClient,
  integrationIntentId?: () => string | null,
): KletiaClient {
  const guarded = Object.create(client) as KletiaClient;
  Object.defineProperty(guarded, "intents", {
    value: {
      ...client.intents,
      prepareStep: async (id: string, stepId: string, options?: PrepareStepOptions) => {
        const scopeAtRequest = integrationIntentId?.() ?? null;
        const prepared = await client.intents.prepareStep(id, stepId, options);
        if (integrationIntentId) {
          const scope = id === scopeAtRequest && scopeAtRequest === integrationIntentId() ? scopeAtRequest : null;
          assertEmbedContractExecution(prepared.intent, scope, prepared.payload.review);
        }
        else assertFirstPartyContractExecution(prepared.intent, prepared.payload.review);
        return prepared;
      },
    },
  });
  return guarded;
}
