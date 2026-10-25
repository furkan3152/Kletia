/**
 * Launch Factory V2 evidence checks and envelope.
 */
import { decodeFunctionData, getAddress, type Address, type Hex } from "viem";
import {
  resolveBaseTokenDeploymentConfig,
  ZERO_ADDRESS,
  type LaunchFactoryV2TokenDeploymentConfig,
} from "../../../networks/base/config/launchFactoryV2Environment.js";
import {
  deriveLaunchFactoryV2UserSalt,
  KLETIA_LAUNCH_FACTORY_V2_EXECUTION_MODE,
  KLETIA_LAUNCH_FACTORY_V2_POLICY_VERSION,
  type LaunchFactoryV2Evidence,
} from "../../../networks/base/creator/launchFactoryV2.js";
import {
  KLETIA_LAUNCH_FACTORY_V2_ABI,
} from "../../../networks/base/creator/launchFactoryV2Abi.js";
import {
  IntentResponseError,
  type ResultLike,
  type UnknownRecord,
} from "./types.js";
import {
  BYTES32_PATTERN,
  DECIMAL_PATTERN,
  LAUNCH_V2_EVIDENCE_KEYS,
} from "./constants.js";
import {
  checkedAddress,
  checkedCalldata,
  checkedPolicyTargets,
  checkedQuoteExpiry,
  decimalValue,
  hasOnlyKeys,
  isRecord,
  sameAddress,
  sameHex,
} from "./checks.js";

export function launchV2ResponseError(): never {
  throw new IntentResponseError(
    "INVALID_BASE_LAUNCH_FACTORY_V2_RESPONSE",
    "Base Launch Factory V2 response could not be securely matched with active deployment evidence and calldata.",
  );
}

function checkedLaunchAddress(value: unknown): Address {
  if (typeof value !== "string") return launchV2ResponseError();
  try {
    const address = getAddress(value);
    if (sameAddress(address, ZERO_ADDRESS)) {
      return launchV2ResponseError();
    }
    return address;
  } catch {
    return launchV2ResponseError();
  }
}

function checkedLaunchAddressAllowZero(value: unknown): Address {
  if (typeof value !== "string") return launchV2ResponseError();
  try {
    return getAddress(value);
  } catch {
    return launchV2ResponseError();
  }
}

function checkedLaunchBytes32(value: unknown): Hex {
  if (typeof value !== "string" || !BYTES32_PATTERN.test(value)) {
    return launchV2ResponseError();
  }
  return value.toLowerCase() as Hex;
}

function checkedLaunchDecimal(
  value: unknown,
  allowZero = true,
): { readonly encoded: string; readonly value: bigint } {
  if (typeof value !== "string" || !DECIMAL_PATTERN.test(value)) {
    return launchV2ResponseError();
  }
  const parsed = BigInt(value);
  if (!allowZero && parsed === 0n) return launchV2ResponseError();
  return { encoded: value, value: parsed };
}

export function resolveActiveLaunchV2Config(): LaunchFactoryV2TokenDeploymentConfig {
  try {
    const config = resolveBaseTokenDeploymentConfig(process.env);
    if (config.mode !== "launch_v2" || config.chainId !== 8453) {
      return launchV2ResponseError();
    }
    return config;
  } catch {
    return launchV2ResponseError();
  }
}

function checkedLaunchV2Evidence(
  value: unknown,
  userAddress: Address,
  config: LaunchFactoryV2TokenDeploymentConfig,
): {
  readonly evidence: LaunchFactoryV2Evidence;
  readonly totalSupply: bigint;
  readonly value: bigint;
} {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, LAUNCH_V2_EVIDENCE_KEYS) ||
    value.policyVersion !== KLETIA_LAUNCH_FACTORY_V2_POLICY_VERSION ||
    value.simulationStatus !== "passed" ||
    value.supplyPolicy !== "fixed_full_supply_to_recipient" ||
    value.saltPolicy !== "creator_scoped_create2"
  ) {
    return launchV2ResponseError();
  }
  const factory = checkedLaunchAddress(value.factory);
  const recipient = checkedLaunchAddress(value.recipient);
  const predictedAddress = checkedLaunchAddress(value.predictedAddress);
  const ownerAuthority = checkedLaunchAddress(value.ownerAuthority);
  const ownerAuthorityKind =
    value.ownerAuthorityKind === "timelock" ||
    value.ownerAuthorityKind === "safe_2_of_2"
      ? value.ownerAuthorityKind
      : launchV2ResponseError();
  const treasurySafe = checkedLaunchAddress(value.treasurySafe);
  const pendingTreasury = checkedLaunchAddressAllowZero(value.pendingTreasury);
  const userSalt = checkedLaunchBytes32(value.userSalt);
  const factoryCodehash = checkedLaunchBytes32(value.factoryCodehash);
  const totalSupply = checkedLaunchDecimal(value.totalSupply, false);
  const maxDeploymentFee = checkedLaunchDecimal(value.maxDeploymentFee);
  const deploymentFee = checkedLaunchDecimal(value.deploymentFee);
  const nativeValue = checkedLaunchDecimal(value.value);
  const factoryFeeCap = checkedLaunchDecimal(value.factoryFeeCap, false);
  const observedAtBlock = checkedLaunchDecimal(value.observedAtBlock, false);
  const name =
    typeof value.name === "string" ? value.name : launchV2ResponseError();
  const symbol =
    typeof value.symbol === "string" ? value.symbol : launchV2ResponseError();
  const saltSource =
    value.saltSource === "explicit_launch_id" ||
    value.saltSource === "canonical_parameters"
      ? value.saltSource
      : launchV2ResponseError();
  const launchId =
    value.launchId === null || typeof value.launchId === "string"
      ? value.launchId
      : launchV2ResponseError();

  if (
    !sameAddress(factory, config.factory) ||
    !sameAddress(recipient, userAddress) ||
    !sameAddress(ownerAuthority, config.deployment.ownerAuthority) ||
    ownerAuthorityKind !== config.deployment.ownerAuthorityKind ||
    !sameAddress(treasurySafe, config.deployment.treasurySafe) ||
    !sameAddress(pendingTreasury, ZERO_ADDRESS) ||
    !sameHex(factoryCodehash, config.deployment.factoryCodehash) ||
    observedAtBlock.value < config.deployment.observedAtBlock ||
    factoryFeeCap.value !== config.deployment.factoryFeeCap ||
    totalSupply.value > config.deployment.maxTokenSupply ||
    maxDeploymentFee.value !== deploymentFee.value ||
    nativeValue.value !== deploymentFee.value ||
    deploymentFee.value > factoryFeeCap.value ||
    (saltSource === "explicit_launch_id") !== (launchId !== null)
  ) {
    return launchV2ResponseError();
  }

  let canonicalSalt: Hex;
  try {
    canonicalSalt = deriveLaunchFactoryV2UserSalt({
      ...(launchId === null ? {} : { launchId }),
      name,
      symbol,
      totalSupply: totalSupply.value,
      recipient,
    }).userSalt;
  } catch {
    return launchV2ResponseError();
  }
  if (!sameHex(canonicalSalt, userSalt)) {
    return launchV2ResponseError();
  }

  return {
    evidence: {
      policyVersion: KLETIA_LAUNCH_FACTORY_V2_POLICY_VERSION,
      factory,
      userSalt,
      saltSource,
      launchId,
      name,
      symbol,
      totalSupply: totalSupply.encoded,
      recipient,
      maxDeploymentFee: maxDeploymentFee.encoded,
      deploymentFee: deploymentFee.encoded,
      value: nativeValue.encoded,
      predictedAddress,
      observedAtBlock: observedAtBlock.encoded,
      factoryCodehash,
      ownerAuthority,
      ownerAuthorityKind,
      treasurySafe,
      pendingTreasury: ZERO_ADDRESS,
      factoryFeeCap: factoryFeeCap.encoded,
      simulationStatus: "passed",
      supplyPolicy: "fixed_full_supply_to_recipient",
      saltPolicy: "creator_scoped_create2",
    },
    totalSupply: totalSupply.value,
    value: nativeValue.value,
  };
}

function sameLaunchV2Evidence(
  left: LaunchFactoryV2Evidence,
  right: LaunchFactoryV2Evidence,
): boolean {
  return Object.keys(left).every((key) => {
    const field = key as keyof LaunchFactoryV2Evidence;
    const leftValue = left[field];
    const rightValue = right[field];
    return typeof leftValue === "string" && /^0x[0-9a-fA-F]+$/u.test(leftValue)
      ? typeof rightValue === "string" &&
          leftValue.toLowerCase() === rightValue.toLowerCase()
      : leftValue === rightValue;
  });
}

export function hasLaunchFactoryV2Marker(rawResult: ResultLike): boolean {
  return (
    rawResult.executionMode === KLETIA_LAUNCH_FACTORY_V2_EXECUTION_MODE ||
    rawResult.launchFactoryV2Evidence !== undefined ||
    (Array.isArray(rawResult.allRoutes) &&
      rawResult.allRoutes.some(
        (route) =>
          isRecord(route) &&
          (route.executionMode === KLETIA_LAUNCH_FACTORY_V2_EXECUTION_MODE ||
            route.launchFactoryV2Evidence !== undefined),
      ))
  );
}

export function createLaunchFactoryV2Envelope(
  rawResult: ResultLike,
  requestId: string,
  userAddress: Address,
  config: LaunchFactoryV2TokenDeploymentConfig,
  entityResolution?: UnknownRecord,
) {
  if (
    rawResult.executionMode !== KLETIA_LAUNCH_FACTORY_V2_EXECUTION_MODE ||
    rawResult.simulationStatus !== "passed" ||
    !Array.isArray(rawResult.approvals) ||
    rawResult.approvals.length !== 0 ||
    !Array.isArray(rawResult.allRoutes) ||
    rawResult.allRoutes.length !== 1 ||
    !isRecord(rawResult.allRoutes[0])
  ) {
    return launchV2ResponseError();
  }
  const route = rawResult.allRoutes[0];
  if (
    route.action !== "deploy_token" ||
    route.executionMode !== KLETIA_LAUNCH_FACTORY_V2_EXECUTION_MODE ||
    route.simulationStatus !== "passed" ||
    !Array.isArray(route.approvals) ||
    route.approvals.length !== 0
  ) {
    return launchV2ResponseError();
  }

  const topEvidence = checkedLaunchV2Evidence(
    rawResult.launchFactoryV2Evidence,
    userAddress,
    config,
  );
  const routeEvidence = checkedLaunchV2Evidence(
    route.launchFactoryV2Evidence,
    userAddress,
    config,
  );
  if (!sameLaunchV2Evidence(topEvidence.evidence, routeEvidence.evidence)) {
    return launchV2ResponseError();
  }

  const rawTarget = rawResult.targetContract || rawResult.target;
  const targetContract = checkedAddress(
    "base",
    String(rawTarget || ""),
    "deploy_token",
  );
  const routeTarget = checkedAddress(
    "base",
    String(route.router || route.targetContract || ""),
    "deploy_token",
  );
  const calldata = checkedCalldata(rawResult.calldata, "launchV2.calldata");
  const routeCalldata = checkedCalldata(
    route.calldata,
    "launchV2.route.calldata",
  );
  const value = checkedLaunchDecimal(
    decimalValue(rawResult.value ?? rawResult.amountInWei, "launchV2.value"),
  );
  const routeValue = checkedLaunchDecimal(
    decimalValue(route.value, "launchV2.route.value"),
  );
  const amountInWei = checkedLaunchDecimal(
    decimalValue(rawResult.amountInWei, "launchV2.amountInWei"),
  );
  if (
    !sameAddress(targetContract, config.factory) ||
    !sameAddress(routeTarget, config.factory) ||
    !sameHex(calldata, routeCalldata) ||
    value.value !== topEvidence.value ||
    routeValue.value !== topEvidence.value ||
    amountInWei.value !== topEvidence.value ||
    rawResult.predictedTokenAddress === undefined ||
    !sameAddress(
      checkedLaunchAddress(rawResult.predictedTokenAddress),
      topEvidence.evidence.predictedAddress,
    )
  ) {
    return launchV2ResponseError();
  }

  let decoded: ReturnType<typeof decodeFunctionData>;
  try {
    decoded = decodeFunctionData({
      abi: KLETIA_LAUNCH_FACTORY_V2_ABI,
      data: calldata,
    });
  } catch {
    return launchV2ResponseError();
  }
  if (
    decoded.functionName !== "deployToken" ||
    !decoded.args ||
    decoded.args.length !== 6
  ) {
    return launchV2ResponseError();
  }
  const [
    decodedSalt,
    decodedName,
    decodedSymbol,
    decodedTotalSupply,
    decodedRecipient,
    decodedMaxFee,
  ] = decoded.args;
  if (
    !sameHex(
      checkedLaunchBytes32(decodedSalt),
      topEvidence.evidence.userSalt,
    ) ||
    decodedName !== topEvidence.evidence.name ||
    decodedSymbol !== topEvidence.evidence.symbol ||
    decodedTotalSupply !== topEvidence.totalSupply ||
    !sameAddress(checkedLaunchAddress(decodedRecipient), userAddress) ||
    decodedMaxFee !== topEvidence.value
  ) {
    return launchV2ResponseError();
  }

  const policyTargets = checkedPolicyTargets(
    route.policyTargets,
    "base",
    "deploy_token",
  );
  if (
    policyTargets.length !== 1 ||
    !sameAddress(policyTargets[0], config.factory)
  ) {
    return launchV2ResponseError();
  }
  const quoteExpiresAt = checkedQuoteExpiry(
    rawResult.quoteExpiresAt,
    Date.now() + 2 * 60 * 1_000,
    "launchV2.quoteExpiresAt",
  );
  const routeQuoteExpiresAt = checkedQuoteExpiry(
    route.quoteExpiresAt,
    quoteExpiresAt,
    "launchV2.route.quoteExpiresAt",
  );
  if (
    routeQuoteExpiresAt !== quoteExpiresAt ||
    rawResult.winner !== "Kletia Launch Factory V2"
  ) {
    return launchV2ResponseError();
  }

  const canonicalRoute = {
    name: "Kletia Launch Factory V2",
    action: "deploy_token",
    router: config.factory,
    calldata,
    value: value.encoded,
    approvals: [] as const,
    approvalPolicy: "explicit" as const,
    executionMode: KLETIA_LAUNCH_FACTORY_V2_EXECUTION_MODE,
    simulationStatus: "passed" as const,
    launchFactoryV2Evidence: topEvidence.evidence,
    policyTargets: [config.factory],
    network: "base" as const,
    chainId: 8453 as const,
    requestId,
    userAddress,
    quoteExpiresAt,
  };

  return {
    ...rawResult,
    status: "success",
    action: "deploy_token",
    actionType: "deploy_token",
    executionMode: KLETIA_LAUNCH_FACTORY_V2_EXECUTION_MODE,
    winner: "Kletia Launch Factory V2",
    target: config.factory,
    targetContract: config.factory,
    calldata,
    value: value.encoded,
    amountInWei: value.encoded,
    isNativeIn: false,
    approvals: [] as const,
    allRoutes: [canonicalRoute],
    simulationStatus: "passed" as const,
    launchFactoryV2Evidence: topEvidence.evidence,
    predictedTokenAddress: topEvidence.evidence.predictedAddress,
    network: "base" as const,
    chainId: 8453 as const,
    requestId,
    userAddress,
    quoteExpiresAt,
    ...(entityResolution ? { entityResolution } : {}),
  };
}
