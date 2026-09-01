import { createHash } from "node:crypto";
import {
  Address,
  Keypair,
  StrKey,
  buildAuthorizationEntryPreimage,
  hash,
  scValToNative,
  xdr,
} from "stellar-sdk-16";

import { STELLAR_TESTNET } from "../config.js";
import type { AnchorDiscovery } from "../lastMile.js";
import type { Sep45ChallengeSnapshot } from "./types.js";

const MAX_CHALLENGE_BODY_BYTES = 128 * 1024;
const DEFAULT_CHALLENGE_TIMEOUT_MS = 8_000;

function controlled(
  code: string,
  message: string,
  statusCode = 502,
  cause?: unknown,
): Error {
  return Object.assign(new Error(message, { cause }), { code, statusCode });
}

function canonicalAuthorizationEntries(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 96_000) {
    throw controlled(
      "SEP45_CHALLENGE_INVALID",
      "Anchor SEP-45 authorization entries are missing or too large.",
    );
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64");
  } catch (error) {
    throw controlled(
      "SEP45_CHALLENGE_INVALID",
      "Anchor SEP-45 authorization entries are not valid base64.",
      502,
      error,
    );
  }
  if (
    decoded.length === 0 ||
    decoded.length > 64 * 1024 ||
    decoded.toString("base64") !== value
  ) {
    throw controlled(
      "SEP45_CHALLENGE_INVALID",
      "Anchor SEP-45 authorization entries failed canonical base64 validation.",
    );
  }
  return value;
}

function decodeEntries(value: string): xdr.SorobanAuthorizationEntry[] {
  try {
    return xdr.SorobanAuthorizationEntries.fromXDR(value, "base64");
  } catch (error) {
    throw controlled(
      "SEP45_CHALLENGE_INVALID",
      "Anchor SEP-45 authorization entries are invalid XDR.",
      502,
      error,
    );
  }
}

export function verifySep45SimulationFootprint(input: {
  readWrite: xdr.LedgerKey[];
  passkeyAccount: string;
  signingKey: string;
  webAuthContractId: string;
}): void {
  const foundNonceAddresses = new Set<string>();
  let foundContractInstance = false;
  for (const key of input.readWrite) {
    if (key.switch().name !== "contractData") {
      throw controlled(
        "SEP45_SIMULATION_SIDE_EFFECT",
        "SEP-45 simulation requested an unexpected ledger write.",
        409,
      );
    }
    const contractData = key.contractData();
    const address = Address.fromScAddress(contractData.contract()).toString();
    const keyType = contractData.key().switch().name;
    if (
      keyType === "scvLedgerKeyNonce" &&
      (address === input.passkeyAccount || address === input.signingKey)
    ) {
      if (foundNonceAddresses.has(address)) {
        throw controlled(
          "SEP45_SIMULATION_SIDE_EFFECT",
          "SEP-45 simulation contained a duplicate nonce write.",
          409,
        );
      }
      foundNonceAddresses.add(address);
      continue;
    }
    if (
      keyType === "scvLedgerKeyContractInstance" &&
      address === input.webAuthContractId &&
      !foundContractInstance
    ) {
      foundContractInstance = true;
      continue;
    }
    throw controlled(
      "SEP45_SIMULATION_SIDE_EFFECT",
      "SEP-45 simulation footprint exceeded the reviewed nonce-only boundary.",
      409,
    );
  }
  if (
    foundNonceAddresses.size !== 2 ||
    !foundNonceAddresses.has(input.passkeyAccount) ||
    !foundNonceAddresses.has(input.signingKey)
  ) {
    throw controlled(
      "SEP45_SIMULATION_FOOTPRINT_INVALID",
      "SEP-45 simulation did not bind both client and anchor nonce entries.",
      409,
    );
  }
}

function addressCredentials(entry: xdr.SorobanAuthorizationEntry) {
  const credentials = entry.credentials();
  if (credentials.switch().name !== "sorobanCredentialsAddress") {
    throw controlled(
      "SEP45_CREDENTIALS_UNSUPPORTED",
      "Kletia currently accepts only the reviewed SEP-45 address credential form.",
    );
  }
  return credentials.address();
}

function exactInvocation(
  entry: xdr.SorobanAuthorizationEntry,
  expectedContractId: string,
): { argumentXdr: Buffer; fields: Record<string, unknown> } {
  const invocation = entry.rootInvocation();
  if (
    invocation.subInvocations().length !== 0 ||
    invocation.function().switch().name !==
      "sorobanAuthorizedFunctionTypeContractFn"
  ) {
    throw controlled(
      "SEP45_INVOCATION_INVALID",
      "SEP-45 challenge must contain one direct web_auth_verify invocation without subinvocations.",
    );
  }
  const contractFunction = invocation.function().contractFn();
  const contractId = Address.fromScAddress(
    contractFunction.contractAddress(),
  ).toString();
  const args = contractFunction.args();
  if (
    contractId !== expectedContractId ||
    contractFunction.functionName().toString() !== "web_auth_verify" ||
    args.length !== 1
  ) {
    throw controlled(
      "SEP45_INVOCATION_INVALID",
      "SEP-45 challenge is not bound to the reviewed web authentication contract and function.",
    );
  }
  const native = scValToNative(args[0]);
  if (!native || typeof native !== "object" || Array.isArray(native)) {
    throw controlled(
      "SEP45_ARGUMENTS_INVALID",
      "SEP-45 challenge arguments are invalid.",
    );
  }
  return {
    argumentXdr: args[0].toXDR(),
    fields: native as Record<string, unknown>,
  };
}

function exactChallengeFields(input: {
  fields: Record<string, unknown>;
  passkeyAccount: string;
  discovery: AnchorDiscovery;
}): string {
  const expectedKeys = [
    "account",
    "home_domain",
    "nonce",
    "web_auth_domain",
    "web_auth_domain_account",
  ];
  const keys = Object.keys(input.fields).sort();
  if (keys.join("|") !== [...expectedKeys].sort().join("|")) {
    throw controlled(
      "SEP45_ARGUMENTS_UNSUPPORTED",
      "SEP-45 client-domain extensions are not accepted until Kletia has a reviewed domain signer.",
    );
  }
  if (
    input.fields.account !== input.passkeyAccount ||
    input.fields.home_domain !== input.discovery.domain ||
    input.fields.web_auth_domain !==
      new URL(input.discovery.webAuthForContractsEndpoint || "https://invalid.invalid")
        .hostname ||
    input.fields.web_auth_domain_account !== input.discovery.signingKey
  ) {
    throw controlled(
      "SEP45_IDENTITY_MISMATCH",
      "SEP-45 challenge identity does not match the selected passkey account and anchor.",
    );
  }
  const nonce = input.fields.nonce;
  if (typeof nonce !== "string" || nonce.length < 16 || nonce.length > 128) {
    throw controlled(
      "SEP45_NONCE_INVALID",
      "SEP-45 challenge nonce is invalid.",
    );
  }
  return nonce;
}

function verifyServerSignature(input: {
  entry: xdr.SorobanAuthorizationEntry;
  credentials: ReturnType<typeof addressCredentials>;
  signingKey: string;
  networkPassphrase: string;
}): void {
  const signatureValue = scValToNative(input.credentials.signature());
  if (
    !Array.isArray(signatureValue) ||
    signatureValue.length !== 1 ||
    !signatureValue[0] ||
    typeof signatureValue[0] !== "object"
  ) {
    throw controlled(
      "SEP45_SERVER_SIGNATURE_INVALID",
      "SEP-45 server authorization has an invalid signature envelope.",
    );
  }
  const signature = signatureValue[0] as Record<string, unknown>;
  const publicKey = signature.public_key;
  const signatureBytes = signature.signature;
  const expectedPublicKey = Buffer.from(
    StrKey.decodeEd25519PublicKey(input.signingKey),
  );
  if (
    !Buffer.isBuffer(publicKey) ||
    !Buffer.isBuffer(signatureBytes) ||
    publicKey.length !== 32 ||
    signatureBytes.length !== 64 ||
    !publicKey.equals(expectedPublicKey)
  ) {
    throw controlled(
      "SEP45_SERVER_SIGNATURE_INVALID",
      "SEP-45 server signature does not match the anchor signing key.",
    );
  }
  const expiration = input.credentials.signatureExpirationLedger();
  if (!Number.isSafeInteger(expiration) || expiration <= 0) {
    throw controlled(
      "SEP45_SERVER_SIGNATURE_INVALID",
      "SEP-45 server authorization has an invalid expiration ledger.",
    );
  }
  const payload = hash(
    buildAuthorizationEntryPreimage(
      input.entry,
      expiration,
      input.networkPassphrase,
    ).toXDR(),
  );
  if (
    !Keypair.fromPublicKey(input.signingKey).verify(payload, signatureBytes)
  ) {
    throw controlled(
      "SEP45_SERVER_SIGNATURE_INVALID",
      "SEP-45 server signature verification failed.",
    );
  }
}

export function verifyUnsignedSep45Challenge(input: {
  authorizationEntries: unknown;
  networkPassphrase: unknown;
  passkeyAccount: string;
  discovery: AnchorDiscovery;
}): Sep45ChallengeSnapshot {
  const { discovery } = input;
  if (
    !StrKey.isValidContract(input.passkeyAccount) ||
    !discovery.webAuthForContractsEndpoint ||
    !discovery.webAuthContractId ||
    !discovery.signingKey ||
    !StrKey.isValidContract(discovery.webAuthContractId) ||
    !StrKey.isValidEd25519PublicKey(discovery.signingKey) ||
    input.networkPassphrase !== STELLAR_TESTNET.networkPassphrase ||
    discovery.networkPassphrase !== STELLAR_TESTNET.networkPassphrase
  ) {
    throw controlled(
      "SEP45_CONFIGURATION_INVALID",
      "SEP-45 challenge is not bound to Kletia's reviewed Stellar Testnet configuration.",
    );
  }
  const authorizationEntries = canonicalAuthorizationEntries(
    input.authorizationEntries,
  );
  const entries = decodeEntries(authorizationEntries);
  if (entries.length !== 2) {
    throw controlled(
      "SEP45_CHALLENGE_UNSUPPORTED",
      "Kletia's SEP-45 MVP requires exactly one client and one anchor authorization entry.",
    );
  }
  const indexed = entries.map((entry, index) => ({
    entry,
    index,
    credentials: addressCredentials(entry),
  }));
  const clientMatches = indexed.filter(
    ({ credentials }) =>
      Address.fromScAddress(credentials.address()).toString() ===
      input.passkeyAccount,
  );
  const serverMatches = indexed.filter(
    ({ credentials }) =>
      Address.fromScAddress(credentials.address()).toString() ===
      discovery.signingKey,
  );
  if (clientMatches.length !== 1 || serverMatches.length !== 1) {
    throw controlled(
      "SEP45_CREDENTIALS_INVALID",
      "SEP-45 challenge must contain exactly one client and one anchor authorization.",
    );
  }
  const client = clientMatches[0];
  const server = serverMatches[0];
  const clientCredentials = client.credentials;
  const serverCredentials = server.credentials;
  if (
    clientCredentials.signature().switch().name !== "scvVoid" ||
    clientCredentials.signatureExpirationLedger() !== 0
  ) {
    throw controlled(
      "SEP45_CREDENTIALS_INVALID",
      "SEP-45 client authorization must be unsigned before passkey approval.",
    );
  }
  const clientInvocation = exactInvocation(
    client.entry,
    discovery.webAuthContractId,
  );
  const serverInvocation = exactInvocation(
    server.entry,
    discovery.webAuthContractId,
  );
  if (!clientInvocation.argumentXdr.equals(serverInvocation.argumentXdr)) {
    throw controlled(
      "SEP45_ARGUMENTS_MISMATCH",
      "SEP-45 client and anchor authorizations do not contain the same arguments.",
    );
  }
  const nonce = exactChallengeFields({
    fields: clientInvocation.fields,
    passkeyAccount: input.passkeyAccount,
    discovery,
  });
  exactChallengeFields({
    fields: serverInvocation.fields,
    passkeyAccount: input.passkeyAccount,
    discovery,
  });
  verifyServerSignature({
    entry: server.entry,
    credentials: serverCredentials,
    signingKey: discovery.signingKey,
    networkPassphrase: input.networkPassphrase as string,
  });
  const now = Date.now();
  return {
    authorizationEntries,
    clientEntryIndex: client.index,
    serverEntryIndex: server.index,
    networkPassphrase: input.networkPassphrase as string,
    webAuthEndpoint: discovery.webAuthForContractsEndpoint,
    webAuthContractId: discovery.webAuthContractId,
    signingKey: discovery.signingKey,
    homeDomain: discovery.domain,
    challengeSha256: createHash("sha256")
      .update(Buffer.from(authorizationEntries, "base64"))
      .digest("hex"),
    nonceSha256: createHash("sha256").update(nonce).digest("hex"),
    expiresAt: now + 10 * 60_000,
  };
}

export function verifySignedSep45Challenge(input: {
  unsignedChallenge: Sep45ChallengeSnapshot;
  signedAuthorizationEntries: unknown;
}): string {
  const signedAuthorizationEntries = canonicalAuthorizationEntries(
    input.signedAuthorizationEntries,
  );
  const unsignedEntries = decodeEntries(
    input.unsignedChallenge.authorizationEntries,
  );
  const signedEntries = decodeEntries(signedAuthorizationEntries);
  if (signedEntries.length !== 2 || unsignedEntries.length !== 2) {
    throw controlled(
      "SEP45_SIGNED_CHALLENGE_INVALID",
      "Signed SEP-45 challenge has an unexpected number of entries.",
      400,
    );
  }
  const clientIndex = input.unsignedChallenge.clientEntryIndex;
  const serverIndex = input.unsignedChallenge.serverEntryIndex;
  if (
    !Number.isInteger(clientIndex) ||
    !Number.isInteger(serverIndex) ||
    clientIndex === serverIndex ||
    !signedEntries[clientIndex] ||
    !signedEntries[serverIndex]
  ) {
    throw controlled(
      "SEP45_SIGNED_CHALLENGE_INVALID",
      "Stored SEP-45 entry positions are invalid.",
      409,
    );
  }
  const unchangedServer = signedEntries[serverIndex]
    .toXDR()
    .equals(unsignedEntries[serverIndex].toXDR());
  const unsignedClientCredentials = addressCredentials(
    unsignedEntries[clientIndex],
  );
  const signedClientCredentials = addressCredentials(signedEntries[clientIndex]);
  const immutableClientIdentity =
    signedEntries[clientIndex]
      .rootInvocation()
      .toXDR()
      .equals(unsignedEntries[clientIndex].rootInvocation().toXDR()) &&
    signedClientCredentials
      .address()
      .toXDR()
      .equals(unsignedClientCredentials.address().toXDR()) &&
    signedClientCredentials
      .nonce()
      .toXDR()
      .equals(unsignedClientCredentials.nonce().toXDR());
  if (
    !unchangedServer ||
    !immutableClientIdentity ||
    signedClientCredentials.signature().switch().name === "scvVoid" ||
    signedClientCredentials.signatureExpirationLedger() <= 0
  ) {
    throw controlled(
      "SEP45_SIGNED_CHALLENGE_INVALID",
      "Passkey signing changed SEP-45 challenge fields outside the client signature and expiration.",
      400,
    );
  }
  return signedAuthorizationEntries;
}

export async function fetchAndVerifySep45Challenge(input: {
  passkeyAccount: string;
  discovery: AnchorDiscovery;
}): Promise<Sep45ChallengeSnapshot> {
  const endpoint = input.discovery.webAuthForContractsEndpoint;
  if (!endpoint) {
    throw controlled(
      "SEP45_UNAVAILABLE",
      "The selected provider does not advertise SEP-45 contract-account authentication.",
      503,
    );
  }
  const url = new URL(endpoint);
  url.searchParams.set("account", input.passkeyAccount);
  url.searchParams.set("home_domain", input.discovery.domain);
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(
      Math.min(
        15_000,
        Math.max(
          2_000,
          Number(
            process.env.STELLAR_ANCHOR_TIMEOUT_MS ||
              DEFAULT_CHALLENGE_TIMEOUT_MS,
          ),
        ),
      ),
    ),
  });
  if (!response.ok) {
    throw controlled(
      "SEP45_ANCHOR_REJECTED",
      `Anchor rejected the SEP-45 challenge request with HTTP ${response.status}.`,
      response.status >= 500 ? 502 : 409,
    );
  }
  const declaredLength = Number(response.headers.get("content-length") || "0");
  if (declaredLength > MAX_CHALLENGE_BODY_BYTES) {
    throw controlled(
      "SEP45_RESPONSE_TOO_LARGE",
      "Anchor SEP-45 response exceeded Kletia's safety limit.",
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_CHALLENGE_BODY_BYTES) {
    throw controlled(
      "SEP45_RESPONSE_TOO_LARGE",
      "Anchor SEP-45 response exceeded Kletia's safety limit.",
    );
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch (error) {
    throw controlled(
      "SEP45_RESPONSE_INVALID",
      "Anchor returned invalid SEP-45 JSON.",
      502,
      error,
    );
  }
  const allowedKeys = new Set([
    "authorizationEntries",
    "authorization_entries",
    "networkPassphrase",
    "network_passphrase",
  ]);
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !allowedKeys.has(key))
  ) {
    throw controlled(
      "SEP45_RESPONSE_INVALID",
      "Anchor returned an unexpected SEP-45 response shape.",
    );
  }
  return verifyUnsignedSep45Challenge({
    authorizationEntries:
      body.authorizationEntries ?? body.authorization_entries,
    networkPassphrase: body.networkPassphrase ?? body.network_passphrase,
    passkeyAccount: input.passkeyAccount,
    discovery: input.discovery,
  });
}
