import { Buffer } from "buffer";
import {
  Address,
  Keypair,
  StrKey,
  buildAuthorizationEntryPreimage,
  hash,
  scValToNative,
  xdr,
} from "stellar-sdk-16";

import {
  signStellarPasskeySep45Entry,
  type StellarPasskeyReadiness,
} from "./passkeyAccount";

export type StellarSep45Challenge = {
  authorizationEntries: string;
  clientEntryIndex: number;
  networkPassphrase: string;
  webAuthContractId: string;
  signingKey: string;
  homeDomain: string;
  webAuthDomain: string;
  expiresAt: number;
};

function fail(message: string): never {
  throw new Error(message);
}

function decodeEntries(value: string): xdr.SorobanAuthorizationEntry[] {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 96_000 ||
    Buffer.from(value, "base64").toString("base64") !== value
  ) {
    fail("The anchor authentication challenge failed its browser boundary.");
  }
  try {
    return xdr.SorobanAuthorizationEntries.fromXDR(value, "base64");
  } catch {
    return fail("The anchor authentication challenge is not valid Stellar XDR.");
  }
}

function credentials(entry: xdr.SorobanAuthorizationEntry) {
  if (entry.credentials().switch().name !== "sorobanCredentialsAddress") {
    fail("This anchor challenge uses an unsupported authorization form.");
  }
  return entry.credentials().address();
}

function invocation(input: {
  entry: xdr.SorobanAuthorizationEntry;
  webAuthContractId: string;
}): { argumentXdr: Buffer; fields: Record<string, unknown> } {
  const root = input.entry.rootInvocation();
  if (
    root.subInvocations().length !== 0 ||
    root.function().switch().name !== "sorobanAuthorizedFunctionTypeContractFn"
  ) {
    fail("The anchor challenge contains an unexpected nested action.");
  }
  const contractFunction = root.function().contractFn();
  const args = contractFunction.args();
  if (
    Address.fromScAddress(contractFunction.contractAddress()).toString() !==
      input.webAuthContractId ||
    contractFunction.functionName().toString() !== "web_auth_verify" ||
    args.length !== 1
  ) {
    fail("The anchor challenge is not the reviewed web authentication call.");
  }
  const fields = scValToNative(args[0]);
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    fail("The anchor challenge contains invalid identity fields.");
  }
  return {
    argumentXdr: args[0].toXDR(),
    fields: fields as Record<string, unknown>,
  };
}

function verifyFields(input: {
  fields: Record<string, unknown>;
  passkeyAccount: string;
  challenge: StellarSep45Challenge;
}): void {
  const expectedKeys = [
    "account",
    "home_domain",
    "nonce",
    "web_auth_domain",
    "web_auth_domain_account",
  ].sort();
  if (
    Object.keys(input.fields).sort().join("|") !== expectedKeys.join("|") ||
    input.fields.account !== input.passkeyAccount ||
    input.fields.home_domain !== input.challenge.homeDomain ||
    input.fields.web_auth_domain !== input.challenge.webAuthDomain ||
    input.fields.web_auth_domain_account !== input.challenge.signingKey ||
    typeof input.fields.nonce !== "string" ||
    input.fields.nonce.length < 16 ||
    input.fields.nonce.length > 128
  ) {
    fail("The anchor challenge identity does not match this payment session.");
  }
}

function verifyServerEntry(input: {
  entry: xdr.SorobanAuthorizationEntry;
  signingKey: string;
  networkPassphrase: string;
}): void {
  const entryCredentials = credentials(input.entry);
  const nativeSignature = scValToNative(entryCredentials.signature());
  if (
    !Array.isArray(nativeSignature) ||
    nativeSignature.length !== 1 ||
    !nativeSignature[0] ||
    typeof nativeSignature[0] !== "object"
  ) {
    fail("The anchor challenge is missing its server signature.");
  }
  const signature = nativeSignature[0] as Record<string, unknown>;
  const publicKey = signature.public_key;
  const signatureBytes = signature.signature;
  const expectedPublicKey = Buffer.from(
    StrKey.decodeEd25519PublicKey(input.signingKey),
  );
  const expiration = entryCredentials.signatureExpirationLedger();
  if (
    !Buffer.isBuffer(publicKey) ||
    !Buffer.isBuffer(signatureBytes) ||
    publicKey.length !== 32 ||
    signatureBytes.length !== 64 ||
    !publicKey.equals(expectedPublicKey) ||
    expiration <= 0
  ) {
    fail("The anchor challenge server signature is invalid.");
  }
  const payload = hash(
    buildAuthorizationEntryPreimage(
      input.entry,
      expiration,
      input.networkPassphrase,
    ).toXDR(),
  );
  if (!Keypair.fromPublicKey(input.signingKey).verify(payload, signatureBytes)) {
    fail("The anchor challenge server signature could not be verified.");
  }
}

function encodeEntries(entries: xdr.SorobanAuthorizationEntry[]): string {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(entries.length, 0);
  return Buffer.concat([length, ...entries.map((entry) => entry.toXDR())]).toString(
    "base64",
  );
}

export async function verifyAndSignStellarSep45Challenge(input: {
  readiness: StellarPasskeyReadiness;
  passkeyAccount: string;
  challenge: StellarSep45Challenge;
}): Promise<string> {
  const { challenge } = input;
  if (
    challenge.expiresAt <= Date.now() ||
    challenge.networkPassphrase !== input.readiness.release.networkPassphrase ||
    !StrKey.isValidContract(input.passkeyAccount) ||
    !StrKey.isValidContract(challenge.webAuthContractId) ||
    !StrKey.isValidEd25519PublicKey(challenge.signingKey)
  ) {
    fail("The anchor challenge is expired or bound to a different Stellar network.");
  }
  const entries = decodeEntries(challenge.authorizationEntries);
  if (entries.length !== 2) {
    fail("Kletia requires exactly one passkey and one anchor authorization.");
  }
  const indexed = entries.map((entry, index) => ({
    entry,
    index,
    credentials: credentials(entry),
  }));
  const clientMatches = indexed.filter(
    (candidate) =>
      Address.fromScAddress(candidate.credentials.address()).toString() ===
      input.passkeyAccount,
  );
  const serverMatches = indexed.filter(
    (candidate) =>
      Address.fromScAddress(candidate.credentials.address()).toString() ===
      challenge.signingKey,
  );
  if (
    clientMatches.length !== 1 ||
    serverMatches.length !== 1 ||
    clientMatches[0].index !== challenge.clientEntryIndex
  ) {
    fail("The anchor challenge does not contain the expected payment identities.");
  }
  const client = clientMatches[0];
  const server = serverMatches[0];
  if (
    client.credentials.signature().switch().name !== "scvVoid" ||
    client.credentials.signatureExpirationLedger() !== 0
  ) {
    fail("The passkey authorization was not unsigned when received.");
  }
  const clientInvocation = invocation({
    entry: client.entry,
    webAuthContractId: challenge.webAuthContractId,
  });
  const serverInvocation = invocation({
    entry: server.entry,
    webAuthContractId: challenge.webAuthContractId,
  });
  if (!clientInvocation.argumentXdr.equals(serverInvocation.argumentXdr)) {
    fail("The anchor and passkey authorizations contain different identity data.");
  }
  verifyFields({
    fields: clientInvocation.fields,
    passkeyAccount: input.passkeyAccount,
    challenge,
  });
  verifyFields({
    fields: serverInvocation.fields,
    passkeyAccount: input.passkeyAccount,
    challenge,
  });
  verifyServerEntry({
    entry: server.entry,
    signingKey: challenge.signingKey,
    networkPassphrase: challenge.networkPassphrase,
  });

  const signedEntryBase64 = await signStellarPasskeySep45Entry({
    readiness: input.readiness,
    passkeyAccount: input.passkeyAccount,
    webAuthContractId: challenge.webAuthContractId,
    authorizationEntry: client.entry.toXDR("base64"),
  });
  const signedEntry = xdr.SorobanAuthorizationEntry.fromXDR(
    signedEntryBase64,
    "base64",
  );
  const signedCredentials = credentials(signedEntry);
  if (
    !signedEntry.rootInvocation().toXDR().equals(client.entry.rootInvocation().toXDR()) ||
    !signedCredentials.address().toXDR().equals(client.credentials.address().toXDR()) ||
    !signedCredentials.nonce().toXDR().equals(client.credentials.nonce().toXDR()) ||
    signedCredentials.signature().switch().name === "scvVoid" ||
    signedCredentials.signatureExpirationLedger() <= 0
  ) {
    fail("The passkey signer changed fields outside its authorization signature.");
  }
  const signedEntries = [...entries];
  signedEntries[client.index] = signedEntry;
  return encodeEntries(signedEntries);
}
