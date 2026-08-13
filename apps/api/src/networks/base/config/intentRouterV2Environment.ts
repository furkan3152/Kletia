import { getAddress, type Address } from "viem";
import {
  BaseIntentV2PlanError,
  resolveBaseSwapExecutionConfig,
  type BaseIntentV2DeploymentEvidence,
  type BaseSwapExecutionConfig,
} from "../intent/routerV2.js";

export const BASE_SWAP_EXECUTION_MODE_ENV = "BASE_SWAP_EXECUTION_MODE";
export const BASE_INTENT_V2_ROUTER_ENV = "KLETIA_INTENT_ROUTER_V2_ADDRESS";
export const BASE_INTENT_V2_EVIDENCE_ENV =
  "KLETIA_INTENT_ROUTER_V2_EVIDENCE_JSON";

type Environment = Readonly<Record<string, string | undefined>>;

function configError(): never {
  throw new BaseIntentV2PlanError("BASE_INTENT_V2_CONFIG_INVALID");
}

function decimalBigInt(value: unknown): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/u.test(value)) {
    configError();
  }
  return BigInt(value);
}

export function parseBaseIntentV2DeploymentEvidence(
  environment: Environment,
): BaseIntentV2DeploymentEvidence {
  const encoded = environment[BASE_INTENT_V2_EVIDENCE_ENV]?.trim();
  if (!encoded) configError();

  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    return configError();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    configError();
  }
  const record = parsed as Record<string, unknown>;
  return {
    ...record,
    observedAtBlock: decimalBigInt(record.observedAtBlock),
  } as unknown as BaseIntentV2DeploymentEvidence;
}

export function resolveConfiguredBaseSwapExecution(
  environment: Environment,
  deploymentEvidence?: BaseIntentV2DeploymentEvidence,
): BaseSwapExecutionConfig {
  const configuredMode =
    environment[BASE_SWAP_EXECUTION_MODE_ENV]?.trim() || "legacy_v1";
  const normalizedEnvironment = {
    ...environment,
    [BASE_SWAP_EXECUTION_MODE_ENV]: configuredMode,
  };
  const evidence =
    configuredMode === "intent_v2"
      ? deploymentEvidence || parseBaseIntentV2DeploymentEvidence(environment)
      : undefined;
  return resolveBaseSwapExecutionConfig(normalizedEnvironment, evidence);
}

export interface BaseIntentV2AddressManifest {
  readonly router: Address;
  readonly policyDependencies: readonly Address[];
}

export function configuredBaseIntentV2AddressManifest(
  environment: Environment,
): BaseIntentV2AddressManifest | null {
  if (environment[BASE_SWAP_EXECUTION_MODE_ENV]?.trim() !== "intent_v2") {
    return null;
  }
  try {
    const router = getAddress(environment[BASE_INTENT_V2_ROUTER_ENV]!.trim());
    const evidence = parseBaseIntentV2DeploymentEvidence(environment);
    if (getAddress(evidence.router) !== router) return null;
    const policyDependencies = [
      getAddress(evidence.wrappedNative),
      ...evidence.adapters.flatMap((adapter) => [
        getAddress(adapter.adapter),
        getAddress(adapter.target),
        getAddress(adapter.spender),
        getAddress(adapter.factory),
      ]),
    ];
    return {
      router,
      policyDependencies: [
        ...new Map(
          policyDependencies.map((address) => [address.toLowerCase(), address]),
        ).values(),
      ],
    };
  } catch {
    return null;
  }
}
