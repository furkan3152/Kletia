/**
 * Base Intent Router V2 field checks: addresses, hex, decimals, active
 * configuration, adapters, policy targets and the signed intent.
 */
import { getAddress, type Address, type Hex } from "viem";
import {
  resolveConfiguredBaseSwapExecution,
} from "../../../networks/base/config/intentRouterV2Environment.js";
import {
  NATIVE_TOKEN_SENTINEL,
  type BaseIntentV2AdapterEvidence,
  type BaseIntentV2DeploymentEvidence,
  type BaseIntentV2DeploymentSchemaVersion,
  type IntentV2ExecutionConfig,
} from "../../../networks/base/intent/routerV2.js";
import {
  type CheckedV2Intent,
  IntentResponseError,
  type RouteLike,
} from "./types.js";
import {
  BYTES32_PATTERN,
  DECIMAL_PATTERN,
  HEX_PATTERN,
  MAX_BASE_INTENT_V2_FEE_BPS,
  MAX_BASE_INTENT_V2_TTL_SECONDS,
  V2_CONFIG_EVIDENCE_KEYS,
  V2_INTENT_KEYS,
} from "./constants.js";
import { hasOnlyKeys, isRecord, sameAddress, sameHex } from "./checks.js";

export function v2ResponseError(): never {
  throw new IntentResponseError(
    "INVALID_BASE_INTENT_V2_RESPONSE",
    "Base Intent Router V2 response could not be securely matched with active deployment evidence.",
  );
}

export function checkedV2Address(value: unknown, allowNative = false): Address {
  if (typeof value !== "string") return v2ResponseError();
  try {
    const address = getAddress(value);
    if (!allowNative && sameAddress(address, NATIVE_TOKEN_SENTINEL)) {
      return v2ResponseError();
    }
    return address;
  } catch {
    return v2ResponseError();
  }
}

export function checkedV2Hex(value: unknown, bytes32 = false): Hex {
  if (
    typeof value !== "string" ||
    !(bytes32 ? BYTES32_PATTERN : HEX_PATTERN).test(value)
  ) {
    return v2ResponseError();
  }
  return value.toLowerCase() as Hex;
}

export function checkedV2Decimal(
  value: unknown,
  allowZero = true,
): { readonly encoded: string; readonly value: bigint } {
  if (typeof value !== "string" || !DECIMAL_PATTERN.test(value)) {
    return v2ResponseError();
  }
  const parsed = BigInt(value);
  if (!allowZero && parsed === 0n) return v2ResponseError();
  return { encoded: value, value: parsed };
}

export function resolveActiveV2Config(): IntentV2ExecutionConfig {
  try {
    const config = resolveConfiguredBaseSwapExecution(process.env);
    if (config.mode !== "intent_v2" || config.chainId !== 8453) {
      return v2ResponseError();
    }
    return config;
  } catch {
    return v2ResponseError();
  }
}

export function findBoundV2Adapter(
  route: RouteLike,
  deployment: BaseIntentV2DeploymentEvidence,
): {
  readonly adapter: BaseIntentV2AdapterEvidence;
  readonly adapterAddress: Address;
  readonly target: Address;
  readonly spender: Address;
  readonly factory: Address;
  readonly wrappedNative: Address;
} {
  const adapterKind =
    route.adapterKind === "uniswap_v2_compatible" ||
    route.adapterKind === "uniswap_v3_swaprouter02"
      ? route.adapterKind
      : v2ResponseError();
  const adapterAddress = checkedV2Address(route.adapter);
  const target = checkedV2Address(route.underlyingTarget);
  const spender = checkedV2Address(route.underlyingSpender);
  const factory = checkedV2Address(route.underlyingFactory);
  const wrappedNative = checkedV2Address(route.wrappedNative);
  if (!sameAddress(wrappedNative, deployment.wrappedNative)) {
    return v2ResponseError();
  }

  const adapter = deployment.adapters.find(
    (candidate) =>
      candidate.kind === adapterKind &&
      sameAddress(candidate.adapter, adapterAddress) &&
      sameAddress(candidate.target, target) &&
      sameAddress(candidate.spender, spender) &&
      sameAddress(candidate.factory, factory),
  );
  if (!adapter) return v2ResponseError();
  return {
    adapter,
    adapterAddress,
    target,
    spender,
    factory,
    wrappedNative,
  };
}

export function checkedV2PolicyTargets(
  value: unknown,
  identities: readonly Address[],
): readonly Address[] {
  if (!Array.isArray(value)) return v2ResponseError();
  const normalized = value.map((target) => checkedV2Address(target));
  const suppliedKeys = normalized.map((target) => target.toLowerCase());
  if (new Set(suppliedKeys).size !== suppliedKeys.length) {
    return v2ResponseError();
  }

  const expected = [
    ...new Map(
      identities.map((target) => [target.toLowerCase(), target]),
    ).values(),
  ];
  const expectedKeys = new Set(expected.map((target) => target.toLowerCase()));
  if (
    normalized.length !== expected.length ||
    suppliedKeys.some(
      (key, index) =>
        !expectedKeys.has(key) || key !== expected[index].toLowerCase(),
    )
  ) {
    return v2ResponseError();
  }
  return expected;
}

export function checkedV2ConfigEvidence(
  value: unknown,
  deployment: BaseIntentV2DeploymentEvidence,
  adapter: BaseIntentV2AdapterEvidence,
): {
  readonly schemaVersion: BaseIntentV2DeploymentSchemaVersion;
  readonly adapterKind: "uniswap_v2_compatible" | "uniswap_v3_swaprouter02";
  readonly observedAtBlock: string;
  readonly routerCodehash: Hex;
  readonly wrappedNativeCodehash: Hex;
  readonly adapterConfigHash: Hex;
  readonly adapterConfigurationHash: Hex;
} {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, V2_CONFIG_EVIDENCE_KEYS) ||
    value.schemaVersion !== deployment.schemaVersion ||
    value.adapterKind !== adapter.kind
  ) {
    return v2ResponseError();
  }
  const observedAtBlock = checkedV2Decimal(value.observedAtBlock, false);
  const routerCodehash = checkedV2Hex(value.routerCodehash, true);
  const wrappedNativeCodehash = checkedV2Hex(value.wrappedNativeCodehash, true);
  const adapterConfigHash = checkedV2Hex(value.adapterConfigHash, true);
  const adapterConfigurationHash = checkedV2Hex(
    value.adapterConfigurationHash,
    true,
  );
  if (
    observedAtBlock.value < deployment.observedAtBlock ||
    !sameHex(routerCodehash, deployment.routerCodehash) ||
    !sameHex(wrappedNativeCodehash, deployment.wrappedNativeCodehash) ||
    !sameHex(adapterConfigHash, adapter.adapterConfigHash) ||
    !sameHex(adapterConfigurationHash, adapter.adapterConfigurationHash)
  ) {
    return v2ResponseError();
  }
  return {
    schemaVersion: deployment.schemaVersion,
    adapterKind: adapter.kind,
    observedAtBlock: observedAtBlock.encoded,
    routerCodehash,
    wrappedNativeCodehash,
    adapterConfigHash,
    adapterConfigurationHash,
  };
}

export function checkedV2Intent(
  value: unknown,
  userAddress: Address,
  adapter: BaseIntentV2AdapterEvidence,
): {
  readonly intent: CheckedV2Intent;
  readonly numeric: {
    readonly amountIn: bigint;
    readonly minAmountOut: bigint;
    readonly nonce: bigint;
    readonly issuedAt: bigint;
    readonly validAfter: bigint;
    readonly deadline: bigint;
  };
} {
  if (!isRecord(value) || !hasOnlyKeys(value, V2_INTENT_KEYS)) {
    return v2ResponseError();
  }
  const owner = checkedV2Address(value.owner);
  const tokenIn = checkedV2Address(value.tokenIn, true);
  const tokenOut = checkedV2Address(value.tokenOut, true);
  const recipient = checkedV2Address(value.recipient);
  const adapterAddress = checkedV2Address(value.adapter);
  const executor = checkedV2Address(value.executor);
  const adapterConfigHash = checkedV2Hex(value.adapterConfigHash, true);
  const adapterDataHash = checkedV2Hex(value.adapterDataHash, true);
  const amountIn = checkedV2Decimal(value.amountIn, false);
  const minAmountOut = checkedV2Decimal(value.minAmountOut, false);
  const nonce = checkedV2Decimal(value.nonce);
  const issuedAt = checkedV2Decimal(value.issuedAt, false);
  const validAfter = checkedV2Decimal(value.validAfter, false);
  const deadline = checkedV2Decimal(value.deadline, false);
  if (
    !sameAddress(owner, userAddress) ||
    !sameAddress(recipient, userAddress) ||
    !sameAddress(executor, userAddress) ||
    !sameAddress(adapterAddress, adapter.adapter) ||
    !sameHex(adapterConfigHash, adapter.adapterConfigHash) ||
    sameAddress(tokenIn, tokenOut) ||
    issuedAt.value > validAfter.value ||
    validAfter.value > deadline.value ||
    deadline.value - issuedAt.value > MAX_BASE_INTENT_V2_TTL_SECONDS ||
    typeof value.maxFeeBps !== "number" ||
    !Number.isInteger(value.maxFeeBps) ||
    value.maxFeeBps < 0 ||
    value.maxFeeBps > MAX_BASE_INTENT_V2_FEE_BPS
  ) {
    return v2ResponseError();
  }

  return {
    intent: {
      owner,
      tokenIn,
      tokenOut,
      amountIn: amountIn.encoded,
      minAmountOut: minAmountOut.encoded,
      recipient,
      adapter: adapterAddress,
      adapterConfigHash,
      adapterDataHash,
      nonce: nonce.encoded,
      issuedAt: issuedAt.encoded,
      validAfter: validAfter.encoded,
      deadline: deadline.encoded,
      executor,
      maxFeeBps: value.maxFeeBps,
    },
    numeric: {
      amountIn: amountIn.value,
      minAmountOut: minAmountOut.value,
      nonce: nonce.value,
      issuedAt: issuedAt.value,
      validAfter: validAfter.value,
      deadline: deadline.value,
    },
  };
}
