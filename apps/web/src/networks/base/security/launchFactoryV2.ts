import {
  decodeFunctionData,
  encodeAbiParameters,
  getAddress,
  isAddress,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import {
  BASE_LAUNCH_FACTORY_V2_ABI,
  BASE_LAUNCH_FACTORY_V2_ADDRESS,
  BASE_LAUNCH_FACTORY_V2_FEE_CAP,
  BASE_LAUNCH_FACTORY_V2_MAX_SUPPLY,
  BASE_LAUNCH_FACTORY_V2_RUNTIME_CODEHASH,
  BASE_LAUNCH_OWNER_AUTHORITY_ADDRESS,
  BASE_LAUNCH_OWNER_AUTHORITY_KIND,
  BASE_LAUNCH_TREASURY_SAFE_ADDRESS,
} from "../config/launchFactoryV2";
import type {
  BaseLaunchFactoryV2Evidence,
  IntentResponse,
} from "../../../shared/types";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const USER_SALT_DOMAIN = keccak256(
  stringToHex("KLETIA_LAUNCH_FACTORY_V2_USER_SALT_V1"),
);
const EVIDENCE_KEYS = [
  "policyVersion",
  "factory",
  "userSalt",
  "saltSource",
  "launchId",
  "name",
  "symbol",
  "totalSupply",
  "recipient",
  "maxDeploymentFee",
  "deploymentFee",
  "value",
  "predictedAddress",
  "observedAtBlock",
  "factoryCodehash",
  "ownerAuthority",
  "ownerAuthorityKind",
  "treasurySafe",
  "pendingTreasury",
  "factoryFeeCap",
  "simulationStatus",
  "supplyPolicy",
  "saltPolicy",
] as const satisfies readonly (keyof BaseLaunchFactoryV2Evidence)[];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isUnsignedInteger = (value: unknown): value is string =>
  typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value);

const isBytes32 = (value: unknown): value is Hex =>
  typeof value === "string" && /^0x[\da-fA-F]{64}$/.test(value);

const isEvmAddress = (value: unknown): value is Address =>
  typeof value === "string" && isAddress(value);

const sameAddress = (left: unknown, right: unknown): boolean =>
  typeof left === "string" &&
  typeof right === "string" &&
  isAddress(left) &&
  isAddress(right) &&
  getAddress(left) === getAddress(right);

const exactEvidenceKeys = (value: Record<string, unknown>): boolean => {
  const keys = Object.keys(value).sort();
  const expected = [...EVIDENCE_KEYS].sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
};

const exactEvidenceMatch = (
  left: BaseLaunchFactoryV2Evidence,
  right: BaseLaunchFactoryV2Evidence,
): boolean => EVIDENCE_KEYS.every((key) => left[key] === right[key]);

const validMetadata = (
  value: unknown,
  maximumBytes: number,
  allowInternalAsciiSpace: boolean,
): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.trim() === value &&
  value.normalize("NFC") === value &&
  !/\p{C}/u.test(value) &&
  new TextEncoder().encode(value).length <= maximumBytes &&
  (allowInternalAsciiSpace || !/\s/u.test(value)) &&
  !/\p{Z}/u.test(value.replace(/ /gu, ""));

export function deriveBaseLaunchFactoryV2UserSalt(
  evidence: Pick<
    BaseLaunchFactoryV2Evidence,
    "saltSource" | "launchId" | "name" | "symbol" | "totalSupply" | "recipient"
  >,
): Hex | undefined {
  try {
    if (evidence.saltSource === "explicit_launch_id") {
      if (
        typeof evidence.launchId !== "string" ||
        evidence.launchId.trim() !== evidence.launchId ||
        evidence.launchId.normalize("NFC") !== evidence.launchId ||
        /\p{C}/u.test(evidence.launchId) ||
        new TextEncoder().encode(evidence.launchId).length < 1 ||
        new TextEncoder().encode(evidence.launchId).length > 128
      ) {
        return undefined;
      }
      return keccak256(
        encodeAbiParameters(
          [{ type: "bytes32" }, { type: "uint8" }, { type: "string" }],
          [USER_SALT_DOMAIN, 1, evidence.launchId],
        ),
      );
    }
    if (
      evidence.saltSource !== "canonical_parameters" ||
      evidence.launchId !== null ||
      !isUnsignedInteger(evidence.totalSupply) ||
      !isAddress(evidence.recipient)
    ) {
      return undefined;
    }
    return keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" },
          { type: "uint8" },
          { type: "string" },
          { type: "string" },
          { type: "uint256" },
          { type: "address" },
        ],
        [
          USER_SALT_DOMAIN,
          0,
          evidence.name,
          evidence.symbol,
          BigInt(evidence.totalSupply),
          getAddress(evidence.recipient),
        ],
      ),
    );
  } catch {
    return undefined;
  }
}

export function isBaseLaunchFactoryV2Evidence(
  value: unknown,
): value is BaseLaunchFactoryV2Evidence {
  if (!isRecord(value) || !exactEvidenceKeys(value)) return false;
  if (
    value.policyVersion !== "kletia_launch_factory_v2_v1" ||
    !sameAddress(value.factory, BASE_LAUNCH_FACTORY_V2_ADDRESS) ||
    !isBytes32(value.userSalt) ||
    !validMetadata(value.name, 64, true) ||
    !validMetadata(value.symbol, 16, false) ||
    !isUnsignedInteger(value.totalSupply) ||
    !isEvmAddress(value.recipient) ||
    !isUnsignedInteger(value.maxDeploymentFee) ||
    !isUnsignedInteger(value.deploymentFee) ||
    !isUnsignedInteger(value.value) ||
    !isEvmAddress(value.predictedAddress) ||
    !isUnsignedInteger(value.observedAtBlock) ||
    BigInt(value.observedAtBlock) <= 0n ||
    !isBytes32(value.factoryCodehash) ||
    value.factoryCodehash.toLowerCase() !==
      BASE_LAUNCH_FACTORY_V2_RUNTIME_CODEHASH.toLowerCase() ||
    !sameAddress(
      value.ownerAuthority,
      BASE_LAUNCH_OWNER_AUTHORITY_ADDRESS,
    ) ||
    value.ownerAuthorityKind !== BASE_LAUNCH_OWNER_AUTHORITY_KIND ||
    !sameAddress(value.treasurySafe, BASE_LAUNCH_TREASURY_SAFE_ADDRESS) ||
    !sameAddress(value.pendingTreasury, ZERO_ADDRESS) ||
    value.factoryFeeCap !== BASE_LAUNCH_FACTORY_V2_FEE_CAP.toString() ||
    value.simulationStatus !== "passed" ||
    value.supplyPolicy !== "fixed_full_supply_to_recipient" ||
    value.saltPolicy !== "creator_scoped_create2"
  ) {
    return false;
  }

  try {
    const totalSupply = BigInt(value.totalSupply);
    const maxDeploymentFee = BigInt(value.maxDeploymentFee);
    const deploymentFee = BigInt(value.deploymentFee);
    if (
      totalSupply <= 0n ||
      totalSupply > BASE_LAUNCH_FACTORY_V2_MAX_SUPPLY ||
      maxDeploymentFee !== deploymentFee ||
      deploymentFee > maxDeploymentFee ||
      maxDeploymentFee > BASE_LAUNCH_FACTORY_V2_FEE_CAP ||
      value.value !== value.deploymentFee ||
      sameAddress(value.predictedAddress, ZERO_ADDRESS) ||
      sameAddress(value.predictedAddress, BASE_LAUNCH_FACTORY_V2_ADDRESS)
    ) {
      return false;
    }
  } catch {
    return false;
  }

  const evidence = value as BaseLaunchFactoryV2Evidence;
  const derivedSalt = deriveBaseLaunchFactoryV2UserSalt(evidence);
  return (
    derivedSalt !== undefined &&
    derivedSalt.toLowerCase() === evidence.userSalt.toLowerCase()
  );
}

export type BaseLaunchFactoryV2BindingExpectation = {
  requestId: string;
  userAddress: Address;
  nowMs?: number;
};

export function isBaseLaunchFactoryV2ResponseBinding(
  response: IntentResponse,
  expected: BaseLaunchFactoryV2BindingExpectation,
): boolean {
  const evidence = response.launchFactoryV2Evidence;
  const routes = response.allRoutes;
  if (
    response.status !== "success" ||
    response.network !== "base" ||
    response.chainId !== 8_453 ||
    response.requestId !== expected.requestId ||
    response.action !== "deploy_token" ||
    response.actionType !== "deploy_token" ||
    response.executionMode !== "kletia_launch_factory_v2" ||
    response.simulationStatus !== "passed" ||
    response.winner !== "Kletia Launch Factory V2" ||
    !sameAddress(response.userAddress, expected.userAddress) ||
    !isBaseLaunchFactoryV2Evidence(evidence) ||
    !Array.isArray(routes) ||
    routes.length !== 1
  ) {
    return false;
  }

  const route = routes[0];
  const routeEvidence = route.launchFactoryV2Evidence;
  if (
    route.network !== "base" ||
    route.chainId !== 8_453 ||
    route.requestId !== expected.requestId ||
    route.action !== "deploy_token" ||
    route.executionMode !== "kletia_launch_factory_v2" ||
    route.simulationStatus !== "passed" ||
    !sameAddress(route.userAddress, expected.userAddress) ||
    !sameAddress(evidence.recipient, expected.userAddress) ||
    !isBaseLaunchFactoryV2Evidence(routeEvidence) ||
    !exactEvidenceMatch(evidence, routeEvidence) ||
    !sameAddress(response.targetContract, BASE_LAUNCH_FACTORY_V2_ADDRESS) ||
    !sameAddress(route.router, BASE_LAUNCH_FACTORY_V2_ADDRESS) ||
    !sameAddress(response.predictedTokenAddress, evidence.predictedAddress) ||
    response.value !== evidence.value ||
    response.amountInWei !== evidence.value ||
    route.value !== evidence.value ||
    !Array.isArray(response.approvals) ||
    response.approvals.length !== 0 ||
    !Array.isArray(route.approvals) ||
    route.approvals.length !== 0 ||
    route.approvalPolicy !== "explicit" ||
    !Array.isArray(route.policyTargets) ||
    route.policyTargets.length !== 1 ||
    !sameAddress(route.policyTargets[0], BASE_LAUNCH_FACTORY_V2_ADDRESS) ||
    typeof response.calldata !== "string" ||
    response.calldata.toLowerCase() !== route.calldata.toLowerCase() ||
    String(response.quoteExpiresAt) !== String(route.quoteExpiresAt)
  ) {
    return false;
  }

  const expiresAt = Number(response.quoteExpiresAt);
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= (expected.nowMs ?? Date.now())
  ) {
    return false;
  }

  try {
    const decoded = decodeFunctionData({
      abi: BASE_LAUNCH_FACTORY_V2_ABI,
      data: route.calldata as Hex,
    });
    if (decoded.functionName !== "deployToken" || !decoded.args) {
      return false;
    }
    const [userSalt, name, symbol, totalSupply, recipient, maxDeploymentFee] =
      decoded.args;
    return (
      userSalt.toLowerCase() === evidence.userSalt.toLowerCase() &&
      name === evidence.name &&
      symbol === evidence.symbol &&
      totalSupply.toString() === evidence.totalSupply &&
      sameAddress(recipient, evidence.recipient) &&
      maxDeploymentFee.toString() === evidence.maxDeploymentFee
    );
  } catch {
    return false;
  }
}
