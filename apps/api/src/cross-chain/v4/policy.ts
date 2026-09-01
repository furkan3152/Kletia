import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { CHAINS_V3 } from "../v3/chains.js";
import type { AddressRef, EnvironmentLane } from "../v3/types.js";
import { canonicalJsonV4, sha256V4 } from "./canonical.js";
import type { PolicyProfileCoreV1, PolicyProfileV1 } from "./types.js";

const HASH_PATTERN = /^0x[a-f\d]{64}$/iu;
const POLICY_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{7,63}$/u;
const PROTOCOL_PATTERN = /^[a-z0-9][a-z0-9-]{1,79}$/u;
// A fully qualified Stellar asset includes network, code, 56-byte issuer and
// 56-byte SAC identifiers. That valid identity is longer than 128 characters;
// keep a bounded 192-character ceiling without truncating either address.
const ASSET_PATTERN = /^[a-z0-9][a-z0-9:_-]{1,191}$/iu;
const BN254_SCALAR_FIELD_MODULUS = BigInt(
  "0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001",
);

function controlled(code: string, message: string, statusCode = 409): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

function decodeSignature(value: unknown): Buffer {
  const encoded = String(value ?? "").trim();
  let signature: Buffer;
  try {
    signature = /^0x[a-f\d]{128}$/iu.test(encoded)
      ? Buffer.from(encoded.slice(2), "hex")
      : Buffer.from(encoded, "base64");
  } catch {
    throw controlled("POLICY_SIGNATURE_INVALID", "The Stellar policy signature is malformed.");
  }
  if (signature.length !== 64) {
    throw controlled("POLICY_SIGNATURE_INVALID", "The Stellar policy signature must contain 64 bytes.");
  }
  return signature;
}

function uniqueStrings(
  value: unknown,
  name: string,
  pattern: RegExp,
  maximum: number,
): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    throw controlled("POLICY_CONSTRAINT_INVALID", `${name} must contain between one and ${maximum} entries.`);
  }
  const entries = value.map((entry) => String(entry ?? "").trim().toLowerCase());
  if (entries.some((entry) => !pattern.test(entry)) || new Set(entries).size !== entries.length) {
    throw controlled("POLICY_CONSTRAINT_INVALID", `${name} contains an invalid or duplicate entry.`);
  }
  return Object.freeze(entries);
}

function canonicalSets(
  value: unknown,
  name: string,
  pattern: RegExp,
  maximumSets: number,
  maximumEntries: number,
): readonly (readonly string[])[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximumSets) {
    throw controlled("POLICY_CONSTRAINT_INVALID", `${name} must contain between one and ${maximumSets} sets.`);
  }
  const sets = value.map((entry) => {
    const values = uniqueStrings(entry, name, pattern, maximumEntries);
    return Object.freeze([...values].sort());
  });
  const identities = sets.map((entry) => entry.join("\u001f"));
  if (new Set(identities).size !== identities.length) {
    throw controlled("POLICY_CONSTRAINT_INVALID", `${name} contains duplicate canonical sets.`);
  }
  return Object.freeze(sets.sort((left, right) => left.join("\u001f").localeCompare(right.join("\u001f"))));
}

function scalar(value: unknown, field: string): `0x${string}` {
  const encoded = String(value ?? "").trim().toLowerCase();
  if (!HASH_PATTERN.test(encoded)) {
    throw controlled("POLICY_SCALAR_INVALID", `${field} must be an exact 32-byte BN254 scalar.`);
  }
  const parsed = BigInt(encoded);
  if (parsed <= 0n || parsed >= BN254_SCALAR_FIELD_MODULUS) {
    throw controlled("POLICY_SCALAR_INVALID", `${field} is outside the canonical BN254 scalar field.`);
  }
  return encoded as `0x${string}`;
}

function parseOwner(value: unknown, lane: EnvironmentLane): AddressRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw controlled("POLICY_OWNER_INVALID", "A Stellar policy owner is required.");
  }
  const input = value as Record<string, unknown>;
  const network = lane === "testnet" ? "testnet" : "public";
  const address = String(input.address ?? "").trim();
  if (input.family !== "stellar" || input.network !== network || !StrKey.isValidEd25519PublicKey(address)) {
    throw controlled(
      "POLICY_OWNER_INVALID",
      `The policy owner must be a Stellar ${network === "testnet" ? "Testnet" : "Mainnet"} G-account.`,
    );
  }
  return { family: "stellar", network, address };
}

function parseCore(value: unknown, now: number): PolicyProfileCoreV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw controlled("POLICY_PROFILE_INVALID", "A canonical policy profile core is required.");
  }
  const input = value as Record<string, unknown>;
  const lane = input.lane === "production" || input.lane === "testnet" ? input.lane : null;
  if (!lane) throw controlled("POLICY_LANE_INVALID", "Policy lane must be production or testnet.");
  const allowedChains = uniqueStrings(input.allowedChains, "allowedChains", /^[a-z][a-z0-9_]{2,39}$/u, 8);
  for (const chainKey of allowedChains) {
    const chain = CHAINS_V3[chainKey as keyof typeof CHAINS_V3];
    if (!chain || chain.lane !== lane) {
      throw controlled("POLICY_CHAIN_INVALID", `Policy chain ${chainKey} does not belong to the ${lane} lane.`);
    }
  }
  const risk = input.risk && typeof input.risk === "object" && !Array.isArray(input.risk)
    ? input.risk as Record<string, unknown>
    : {};
  const tolerance = risk.tolerance;
  const healthFactor = risk.minimumHealthFactor;
  const slippage = Number(risk.maximumSlippageBps);
  if (
    (tolerance !== "conservative" && tolerance !== "balanced" && tolerance !== "aggressive") ||
    (healthFactor !== "1.5" && healthFactor !== "1.6" && healthFactor !== "1.8" && healthFactor !== "2.0") ||
    !Number.isInteger(slippage) || slippage < 1 || slippage > 500
  ) {
    throw controlled("POLICY_RISK_INVALID", "The policy risk envelope is invalid.");
  }
  const validFrom = Number(input.validFrom);
  const expiresAt = Number(input.expiresAt);
  const executionExpiresAtLedger = Number(input.executionExpiresAtLedger);
  if (
    !Number.isSafeInteger(validFrom) ||
    !Number.isSafeInteger(expiresAt) ||
    validFrom > now + 5 * 60_000 ||
    expiresAt <= now ||
    expiresAt - validFrom > 30 * 24 * 60 * 60_000
  ) {
    throw controlled("POLICY_EXPIRY_INVALID", "The policy validity window is expired, future-dated or longer than 30 days.");
  }
  if (
    !Number.isSafeInteger(executionExpiresAtLedger) ||
    executionExpiresAtLedger <= 0 ||
    executionExpiresAtLedger > 0xffff_ffff
  ) {
    throw controlled("POLICY_LEDGER_EXPIRY_INVALID", "The policy execution ledger expiry must be a positive uint32.");
  }
  if (
    input.schemaVersion !== "kletia_policy_profile_core_v1" ||
    !POLICY_ID_PATTERN.test(String(input.policyId ?? "")) ||
    !HASH_PATTERN.test(String(input.privacyBudgetCommitment ?? "")) ||
    !HASH_PATTERN.test(String(input.nonce ?? "")) ||
    input.policyCircuit !== "kletia_policy_v2" ||
    input.verifierVersion !== 2 ||
    input.publicInputCount !== 12 ||
    input.requireStellarControlPlane !== true ||
    input.perFinancialStepWalletApproval !== true ||
    input.solverMayCustodyUserFunds !== false
  ) {
    throw controlled("POLICY_PROFILE_INVALID", "The policy core is malformed or relaxes a mandatory safety invariant.");
  }
  return {
    schemaVersion: "kletia_policy_profile_core_v1",
    policyId: String(input.policyId),
    owner: parseOwner(input.owner, lane),
    lane,
    allowedChains: allowedChains as PolicyProfileCoreV1["allowedChains"],
    allowedProtocols: uniqueStrings(input.allowedProtocols, "allowedProtocols", PROTOCOL_PATTERN, 32),
    allowedAssets: uniqueStrings(input.allowedAssets, "allowedAssets", ASSET_PATTERN, 48),
    allowedRouteProtocolSets: canonicalSets(
      input.allowedRouteProtocolSets,
      "allowedRouteProtocolSets",
      PROTOCOL_PATTERN,
      32,
      12,
    ),
    allowedRouteAssetSets: canonicalSets(
      input.allowedRouteAssetSets,
      "allowedRouteAssetSets",
      ASSET_PATTERN,
      32,
      24,
    ),
    policyCircuit: "kletia_policy_v2",
    verifierVersion: 2,
    publicInputCount: 12,
    policyRoot: scalar(input.policyRoot, "policyRoot"),
    protocolRegistryRoot: scalar(input.protocolRegistryRoot, "protocolRegistryRoot"),
    assetRegistryRoot: scalar(input.assetRegistryRoot, "assetRegistryRoot"),
    recipientPolicyRoot: scalar(input.recipientPolicyRoot, "recipientPolicyRoot"),
    privacyBudgetCommitment: String(input.privacyBudgetCommitment).toLowerCase() as `0x${string}`,
    risk: {
      tolerance,
      minimumHealthFactor: healthFactor,
      maximumSlippageBps: slippage,
    },
    executionExpiresAtLedger,
    validFrom,
    expiresAt,
    nonce: String(input.nonce).toLowerCase() as `0x${string}`,
    requireStellarControlPlane: true,
    perFinancialStepWalletApproval: true,
    solverMayCustodyUserFunds: false,
  };
}

export function policyProfileSigningMessageV1(core: PolicyProfileCoreV1): string {
  if (core.owner.family !== "stellar") {
    throw controlled("POLICY_OWNER_INVALID", "A Stellar policy owner is required.");
  }
  return [
    "KLETIA_POLICY_PROFILE_V1",
    core.owner.network === "testnet" ? "stellar:testnet" : "stellar:public",
    sha256V4("KLETIA_POLICY_PROFILE_CORE_V1", core),
    canonicalJsonV4(core),
  ].join("\n");
}

export async function verifyPolicyProfileV1(value: unknown, now = Date.now()): Promise<PolicyProfileV1> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw controlled("POLICY_PROFILE_REQUIRED", "A user-signed PolicyProfileV1 is required before route selection.");
  }
  const input = value as Record<string, unknown>;
  const core = parseCore(input.core, now);
  const expectedHash = sha256V4("KLETIA_POLICY_PROFILE_CORE_V1", core);
  if (input.schemaVersion !== "kletia_policy_profile_v1" || String(input.profileHash ?? "").toLowerCase() !== expectedHash) {
    throw controlled("POLICY_PROFILE_HASH_MISMATCH", "The policy profile hash does not match its canonical core.");
  }
  const auth = input.authorization && typeof input.authorization === "object" && !Array.isArray(input.authorization)
    ? input.authorization as Record<string, unknown>
    : {};
  const signer = parseOwner(auth.signer, core.lane);
  if (auth.scheme !== "stellar_sep53" || signer.address !== core.owner.address) {
    throw controlled("POLICY_SIGNER_MISMATCH", "The Stellar policy signer did not match the policy owner.");
  }
  const verified = Keypair.fromPublicKey(signer.address).verifyMessage(
    policyProfileSigningMessageV1(core),
    decodeSignature(auth.signature),
  );
  if (!verified) throw controlled("POLICY_SIGNATURE_INVALID", "The Stellar SEP-53 policy signature could not be verified.");
  return {
    schemaVersion: "kletia_policy_profile_v1",
    core,
    profileHash: expectedHash,
    authorization: {
      scheme: "stellar_sep53",
      signer,
      signature: String(auth.signature),
      verifiedAt: new Date(now).toISOString(),
    },
  };
}
