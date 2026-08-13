import {
  encodeAbiParameters,
  getAddress,
  isAddress,
  keccak256,
  parseAbiParameters,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

import { basePublicClient } from "../../../config/networks.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const BASE_MAINNET_CHAIN_ID = 8_453 as const;
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/u;
const RUNTIME_CODE_PATTERN = /^0x(?:[0-9a-fA-F]{2})+$/u;

export const BASE_X402_ATTESTATION_REGISTRY_ENV =
  "KLETIA_X402_ATTESTATION_REGISTRY_ADDRESS";
export const BASE_X402_ATTESTATION_OWNER_ENV =
  "KLETIA_X402_ATTESTATION_OWNER_ADDRESS";
export const LEGACY_BASE_X402_ATTESTATION_OWNER_ENV =
  "KLETIA_V2_TIMELOCK_ADDRESS";
export const BASE_X402_ATTESTATION_GUARDIAN_ENV = "KLETIA_V2_GUARDIAN_SAFE";

// These are public, immutable deployment identities, not secrets. Keeping the
// verified production tuple in code prevents manually-created Render services
// from silently disabling read-only attestation checks when an optional env
// mirror is omitted. Every request still verifies chain id, runtime codehash,
// owner, guardian, schema and horizon against live Base state.
export const BASE_X402_ATTESTATION_REGISTRY_ADDRESS =
  "0xE69DE5A5E92F4a52b15C651C1C1fc0fE36143889" as Address;
export const BASE_X402_ATTESTATION_OWNER_ADDRESS =
  "0x84f19Fdfd8C50C6349BFe86Cd90BE131387ab47D" as Address;
export const BASE_X402_ATTESTATION_GUARDIAN_ADDRESS =
  "0xCae3520A4348BEB2b74Ef52E8be2dE06f57fC0Bc" as Address;

export const BASE_X402_ATTESTATION_REGISTRY_RUNTIME_CODEHASH =
  "0xc186d25e78cd9fa8752a79aa7fbe33337201b6c36b7c49aace6b470583750041" as Hex;
export const BASE_X402_ATTESTATION_SCHEMA =
  "0xc08d7e9af65b0762f5eb1cd75a237d8df6265ba799b636186d37f6339c55cb4e" as Hex;
export const BASE_X402_ATTESTATION_MAX_HORIZON_SECONDS = 15_552_000n;

const REGISTRY_ABI = [
  {
    inputs: [],
    name: "owner",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "guardian",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "ATTESTATION_SCHEMA",
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "MAX_ATTESTATION_HORIZON",
    outputs: [{ name: "", type: "uint48" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        components: [
          { name: "serviceId", type: "bytes32" },
          { name: "manifestDigest", type: "bytes32" },
          { name: "publisher", type: "address" },
          { name: "payTo", type: "address" },
          { name: "publisherDataHash", type: "bytes32" },
        ],
        name: "claim",
        type: "tuple",
      },
    ],
    name: "attestationKey",
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "key", type: "bytes32" },
      { name: "attester", type: "address" },
    ],
    name: "getAttestation",
    outputs: [
      {
        components: [
          { name: "issuedAt", type: "uint48" },
          { name: "expiresAt", type: "uint48" },
          { name: "revokedAt", type: "uint48" },
          { name: "authorizationEpoch", type: "uint64" },
          { name: "kind", type: "uint8" },
        ],
        name: "record",
        type: "tuple",
      },
      { name: "status", type: "uint8" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "curator", type: "address" }],
    name: "isCurator",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "curator", type: "address" }],
    name: "curatorAuthorizationEpoch",
    outputs: [{ name: "", type: "uint64" }],
    stateMutability: "view",
    type: "function",
  },
] as const satisfies Abi;

const CLAIM_ENCODING = parseAbiParameters(
  "bytes32 schema, bytes32 serviceId, bytes32 manifestDigest, address publisher, address payTo, bytes32 publisherDataHash",
);

type Environment = Readonly<Record<string, string | undefined>>;

export type BaseX402AttestationPublicClient = Pick<
  PublicClient,
  "getBlockNumber" | "getChainId" | "getCode" | "readContract"
>;

export class BaseX402AttestationRegistryError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, statusCode: number, message: string) {
    super(message);
    this.name = "BaseX402AttestationRegistryError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface BaseX402AttestationClaim {
  readonly serviceId: Hex;
  readonly manifestDigest: Hex;
  readonly publisher: Address;
  readonly payTo: Address;
  readonly publisherDataHash: Hex;
}

export interface BaseX402AttestationDeploymentStatus {
  readonly status: "available";
  readonly available: true;
  readonly network: "base";
  readonly chainId: 8_453;
  readonly registry: {
    readonly address: Address;
    readonly runtimeCodehash: Hex;
    readonly owner: Address;
    readonly guardian: Address;
    readonly schema: Hex;
    readonly maxAttestationHorizonSeconds: string;
    readonly observedAtBlock: string;
  };
  readonly semantics: {
    readonly canonicalDiscovery: "Coinbase CDP Bazaar";
    readonly registryRole: "supplemental_claim_attestation";
    readonly claimProofRequired: true;
    readonly affectsPaymentAuthorization: false;
    readonly writeActionsExposed: false;
  };
}

export interface BaseX402AttestationVerification {
  readonly status: "verified_read_only";
  readonly network: "base";
  readonly chainId: 8_453;
  readonly registry: Address;
  readonly observedAtBlock: string;
  readonly attestationKey: Hex;
  readonly attester: Address;
  readonly claim: BaseX402AttestationClaim;
  readonly attestation: {
    readonly kind: "none" | "publisher" | "curator";
    readonly state:
      | "none"
      | "active"
      | "expired"
      | "revoked"
      | "attester_disabled"
      | "stale_authorization";
    readonly active: boolean;
    readonly issuedAt: string;
    readonly expiresAt: string;
    readonly revokedAt: string;
    readonly authorizationEpoch: string;
  };
  readonly semantics: BaseX402AttestationDeploymentStatus["semantics"];
}

type RegistryConfig = {
  readonly registry: Address;
  readonly expectedOwner: Address;
  readonly expectedGuardian: Address;
};

type VerifiedDeployment = {
  readonly config: RegistryConfig;
  readonly blockNumber: bigint;
  readonly status: BaseX402AttestationDeploymentStatus;
};

function unavailable(code = "X402_ATTESTATION_REGISTRY_UNAVAILABLE"): never {
  throw new BaseX402AttestationRegistryError(
    code,
    503,
    "Kletia supplemental x402 attestation registry is unavailable.",
  );
}

function invalidProof(): never {
  throw new BaseX402AttestationRegistryError(
    "X402_ATTESTATION_PROOF_INVALID",
    400,
    "The x402 attestation claim proof is incomplete or invalid.",
  );
}

function checkedAddress(value: unknown, error: () => never): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    return error();
  }
  try {
    const address = getAddress(value);
    if (address.toLowerCase() === ZERO_ADDRESS) return error();
    return address;
  } catch {
    return error();
  }
}

function checkedBytes32(value: unknown): Hex {
  if (
    typeof value !== "string" ||
    !BYTES32_PATTERN.test(value) ||
    /^0x0{64}$/iu.test(value)
  ) {
    return invalidProof();
  }
  return value.toLowerCase() as Hex;
}

function checkedUnsigned(value: unknown): bigint {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  return unavailable();
}

function sameAddress(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function sameHex(left: Hex, right: Hex): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export function resolveBaseX402AttestationRegistryConfig(
  environment: Environment,
): RegistryConfig {
  const registryValue =
    environment[BASE_X402_ATTESTATION_REGISTRY_ENV]?.trim() ||
    BASE_X402_ATTESTATION_REGISTRY_ADDRESS;
  const ownerValue =
    environment[BASE_X402_ATTESTATION_OWNER_ENV]?.trim() ||
    environment[LEGACY_BASE_X402_ATTESTATION_OWNER_ENV]?.trim() ||
    BASE_X402_ATTESTATION_OWNER_ADDRESS;
  const guardianValue =
    environment[BASE_X402_ATTESTATION_GUARDIAN_ENV]?.trim() ||
    BASE_X402_ATTESTATION_GUARDIAN_ADDRESS;
  return {
    registry: checkedAddress(registryValue, unavailable),
    expectedOwner: checkedAddress(ownerValue, unavailable),
    expectedGuardian: checkedAddress(guardianValue, unavailable),
  };
}

async function verifyDeployment(
  client: BaseX402AttestationPublicClient,
  environment: Environment,
): Promise<VerifiedDeployment> {
  const config = resolveBaseX402AttestationRegistryConfig(environment);
  let chainId: number;
  let blockNumber: bigint;
  try {
    [chainId, blockNumber] = await Promise.all([
      client.getChainId(),
      client.getBlockNumber(),
    ]);
  } catch {
    return unavailable();
  }
  if (chainId !== BASE_MAINNET_CHAIN_ID || blockNumber <= 0n) {
    return unavailable("X402_ATTESTATION_REGISTRY_CHAIN_MISMATCH");
  }

  try {
    const [code, owner, guardian, schema, maxHorizon] = await Promise.all([
      client.getCode({ address: config.registry, blockNumber }),
      client.readContract({
        address: config.registry,
        abi: REGISTRY_ABI,
        functionName: "owner",
        blockNumber,
      }),
      client.readContract({
        address: config.registry,
        abi: REGISTRY_ABI,
        functionName: "guardian",
        blockNumber,
      }),
      client.readContract({
        address: config.registry,
        abi: REGISTRY_ABI,
        functionName: "ATTESTATION_SCHEMA",
        blockNumber,
      }),
      client.readContract({
        address: config.registry,
        abi: REGISTRY_ABI,
        functionName: "MAX_ATTESTATION_HORIZON",
        blockNumber,
      }),
    ]);
    if (!code || !RUNTIME_CODE_PATTERN.test(code)) return unavailable();
    const runtimeCodehash = keccak256(code);
    const observedOwner = checkedAddress(owner, unavailable);
    const observedGuardian = checkedAddress(guardian, unavailable);
    const observedSchema =
      typeof schema === "string" && BYTES32_PATTERN.test(schema)
        ? (schema.toLowerCase() as Hex)
        : unavailable();
    const observedHorizon = checkedUnsigned(maxHorizon);
    if (
      !sameHex(
        runtimeCodehash,
        BASE_X402_ATTESTATION_REGISTRY_RUNTIME_CODEHASH,
      ) ||
      !sameAddress(observedOwner, config.expectedOwner) ||
      !sameAddress(observedGuardian, config.expectedGuardian) ||
      !sameHex(observedSchema, BASE_X402_ATTESTATION_SCHEMA) ||
      observedHorizon !== BASE_X402_ATTESTATION_MAX_HORIZON_SECONDS
    ) {
      return unavailable("X402_ATTESTATION_REGISTRY_IDENTITY_MISMATCH");
    }

    const semantics = {
      canonicalDiscovery: "Coinbase CDP Bazaar",
      registryRole: "supplemental_claim_attestation",
      claimProofRequired: true,
      affectsPaymentAuthorization: false,
      writeActionsExposed: false,
    } as const;
    return {
      config,
      blockNumber,
      status: {
        status: "available",
        available: true,
        network: "base",
        chainId: BASE_MAINNET_CHAIN_ID,
        registry: {
          address: config.registry,
          runtimeCodehash,
          owner: observedOwner,
          guardian: observedGuardian,
          schema: observedSchema,
          maxAttestationHorizonSeconds: observedHorizon.toString(),
          observedAtBlock: blockNumber.toString(),
        },
        semantics,
      },
    };
  } catch (error) {
    if (error instanceof BaseX402AttestationRegistryError) throw error;
    return unavailable();
  }
}

export async function readBaseX402AttestationRegistryStatus(
  client: BaseX402AttestationPublicClient = basePublicClient,
  environment: Environment = process.env,
): Promise<BaseX402AttestationDeploymentStatus> {
  return (await verifyDeployment(client, environment)).status;
}

export function parseBaseX402AttestationClaim(
  value: unknown,
): BaseX402AttestationClaim {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalidProof();
  }
  const claim = value as Record<string, unknown>;
  const keys = Object.keys(claim).sort();
  const expectedKeys = [
    "manifestDigest",
    "payTo",
    "publisher",
    "publisherDataHash",
    "serviceId",
  ];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    return invalidProof();
  }
  return {
    serviceId: checkedBytes32(claim.serviceId),
    manifestDigest: checkedBytes32(claim.manifestDigest),
    publisher: checkedAddress(claim.publisher, invalidProof),
    payTo: checkedAddress(claim.payTo, invalidProof),
    publisherDataHash: checkedBytes32(claim.publisherDataHash),
  };
}

export function computeBaseX402AttestationKey(
  claim: BaseX402AttestationClaim,
): Hex {
  return keccak256(
    encodeAbiParameters(CLAIM_ENCODING, [
      BASE_X402_ATTESTATION_SCHEMA,
      claim.serviceId,
      claim.manifestDigest,
      claim.publisher,
      claim.payTo,
      claim.publisherDataHash,
    ]),
  );
}

const KIND_NAMES = ["none", "publisher", "curator"] as const;
const STATUS_NAMES = [
  "none",
  "active",
  "expired",
  "revoked",
  "attester_disabled",
  "stale_authorization",
] as const;

function tupleField(value: unknown, name: string, index: number): unknown {
  if (Array.isArray(value)) return value[index];
  if (value && typeof value === "object") {
    return (value as Record<string, unknown>)[name];
  }
  return unavailable();
}

export async function verifyBaseX402AttestationClaim(
  input: unknown,
  client: BaseX402AttestationPublicClient = basePublicClient,
  environment: Environment = process.env,
): Promise<BaseX402AttestationVerification> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return invalidProof();
  }
  const proof = input as Record<string, unknown>;
  const keys = Object.keys(proof).sort();
  if (keys.length !== 2 || keys[0] !== "attester" || keys[1] !== "claim") {
    return invalidProof();
  }
  const claim = parseBaseX402AttestationClaim(proof.claim);
  const attester = checkedAddress(proof.attester, invalidProof);
  const deployment = await verifyDeployment(client, environment);
  const expectedKey = computeBaseX402AttestationKey(claim);

  try {
    const [onchainKey, attestationResult] = await Promise.all([
      client.readContract({
        address: deployment.config.registry,
        abi: REGISTRY_ABI,
        functionName: "attestationKey",
        args: [claim],
        blockNumber: deployment.blockNumber,
      }),
      client.readContract({
        address: deployment.config.registry,
        abi: REGISTRY_ABI,
        functionName: "getAttestation",
        args: [expectedKey, attester],
        blockNumber: deployment.blockNumber,
      }),
    ]);
    if (
      typeof onchainKey !== "string" ||
      !BYTES32_PATTERN.test(onchainKey) ||
      !sameHex(onchainKey as Hex, expectedKey) ||
      !Array.isArray(attestationResult) ||
      attestationResult.length !== 2
    ) {
      return unavailable();
    }

    const record = attestationResult[0];
    const kindValue = checkedUnsigned(tupleField(record, "kind", 4));
    const statusValue = checkedUnsigned(attestationResult[1]);
    if (
      kindValue >= BigInt(KIND_NAMES.length) ||
      statusValue >= BigInt(STATUS_NAMES.length)
    ) {
      return unavailable();
    }
    const kind = KIND_NAMES[Number(kindValue)];
    const state = STATUS_NAMES[Number(statusValue)];
    const issuedAt = checkedUnsigned(tupleField(record, "issuedAt", 0));
    const expiresAt = checkedUnsigned(tupleField(record, "expiresAt", 1));
    const revokedAt = checkedUnsigned(tupleField(record, "revokedAt", 2));
    const authorizationEpoch = checkedUnsigned(
      tupleField(record, "authorizationEpoch", 3),
    );

    let active = state === "active";
    if (
      active &&
      (kind === "none" ||
        issuedAt === 0n ||
        expiresAt <= issuedAt ||
        revokedAt !== 0n)
    ) {
      return unavailable();
    }
    if (active && kind === "publisher") {
      active =
        sameAddress(attester, claim.publisher) && authorizationEpoch === 0n;
      if (!active) return unavailable();
    }
    if (active && kind === "curator") {
      const [allowed, currentEpoch] = await Promise.all([
        client.readContract({
          address: deployment.config.registry,
          abi: REGISTRY_ABI,
          functionName: "isCurator",
          args: [attester],
          blockNumber: deployment.blockNumber,
        }),
        client.readContract({
          address: deployment.config.registry,
          abi: REGISTRY_ABI,
          functionName: "curatorAuthorizationEpoch",
          args: [attester],
          blockNumber: deployment.blockNumber,
        }),
      ]);
      if (
        allowed !== true ||
        checkedUnsigned(currentEpoch) !== authorizationEpoch
      ) {
        return unavailable();
      }
    }

    return {
      status: "verified_read_only",
      network: "base",
      chainId: BASE_MAINNET_CHAIN_ID,
      registry: deployment.config.registry,
      observedAtBlock: deployment.blockNumber.toString(),
      attestationKey: expectedKey,
      attester,
      claim,
      attestation: {
        kind,
        state,
        active,
        issuedAt: issuedAt.toString(),
        expiresAt: expiresAt.toString(),
        revokedAt: revokedAt.toString(),
        authorizationEpoch: authorizationEpoch.toString(),
      },
      semantics: deployment.status.semantics,
    };
  } catch (error) {
    if (error instanceof BaseX402AttestationRegistryError) throw error;
    return unavailable();
  }
}
