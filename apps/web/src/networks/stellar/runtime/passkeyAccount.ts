import {
  Account,
  Asset,
  MuxedAccount,
  rpc,
  StrKey,
  xdr,
} from "@stellar/stellar-sdk";
import type { SmartAccountKit } from "smart-account-kit";
import {
  Address as Address16,
  Operation as Operation16,
  contract as contract16,
  nativeToScVal as nativeToScVal16,
  rpc as rpc16,
  xdr as xdr16,
} from "stellar-sdk-16";
import { Buffer } from "buffer";

import { BACKEND_URL } from "../../../shared/config/runtime";

export type StellarPasskeyReadiness = {
  ready: boolean;
  enabled: boolean;
  status: string;
  reason: string;
  release: {
    network: "stellar_testnet";
    networkPassphrase: string;
    accountWasmHash: string;
    webauthnVerifierAddress: string;
    nativeTokenContract: string;
    usdcTokenContract: string;
    sdk: { version: string };
  };
  browser: {
    relayPath: string;
    requiresSecureContext: true;
    extensionRequired: false;
    seedPhraseRequired: false;
  };
  capability: {
    classicSdexAndTrustlineSigning: false;
    muxedAnchorTransfer: "sep24_id_memo_custom_invocation";
    productionReady: false;
    auditedIntegration: false;
  };
};

export type StellarPasskeySession = Readonly<{
  contractId: string;
  balanceXlm: string | null;
  balanceUsdc: string | null;
}>;

type PasskeyReadinessEnvelope = {
  success?: boolean;
  message?: string;
  passkeyAccounts?: StellarPasskeyReadiness;
};

let activeKit:
  | { identity: string; kit: SmartAccountKit; readiness: StellarPasskeyReadiness }
  | undefined;

function browserSupportError(): string | null {
  if (
    window.location.hostname === "127.0.0.1" ||
    window.location.hostname === "::1" ||
    window.location.hostname === "[::1]"
  ) {
    return "Passkeys reject a raw loopback IP as a relying-party domain. Open this Kletia build on localhost instead.";
  }
  if (!window.isSecureContext) {
    return "Passkeys require HTTPS or a browser-trusted localhost origin.";
  }
  if (!("PublicKeyCredential" in window) || !navigator.credentials) {
    return "This browser does not expose WebAuthn passkeys.";
  }
  if (!("indexedDB" in window)) {
    return "This browser does not provide the IndexedDB storage required for account recovery metadata.";
  }
  return null;
}

export function readStellarPasskeyBrowserSupport() {
  const reason = browserSupportError();
  return { supported: reason === null, reason } as const;
}

async function readBody(response: Response): Promise<PasskeyReadinessEnvelope> {
  const body = (await response.json().catch(() => null)) as PasskeyReadinessEnvelope | null;
  if (!response.ok || !body?.passkeyAccounts) {
    throw new Error(
      body?.message ||
        "The Stellar Testnet passkey-account capability is not ready on this Kletia deployment.",
    );
  }
  return body;
}

export async function readStellarPasskeyReadiness(): Promise<StellarPasskeyReadiness> {
  const body = await readBody(
    await fetch(`${BACKEND_URL}/api/stellar/passkey/readiness`, {
      headers: { "X-Kletia-Chain-Ref": "stellar:testnet" },
    }),
  );
  if (!body.passkeyAccounts?.ready) {
    throw new Error(body.passkeyAccounts?.reason || "Passkey accounts are unavailable.");
  }
  return body.passkeyAccounts;
}

async function getKit(readiness: StellarPasskeyReadiness): Promise<SmartAccountKit> {
  const support = readStellarPasskeyBrowserSupport();
  if (!support.supported) throw new Error(support.reason || "Passkeys are unavailable.");
  const identity = [
    readiness.release.networkPassphrase,
    readiness.release.accountWasmHash,
    readiness.release.webauthnVerifierAddress,
    readiness.release.sdk.version,
  ].join(":");
  if (activeKit?.identity === identity) return activeKit.kit;

  const { IndexedDBStorage, SmartAccountKit } = await import("smart-account-kit");
  const kit = new SmartAccountKit({
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: readiness.release.networkPassphrase,
    accountWasmHash: readiness.release.accountWasmHash,
    acceptedWasmHashes: [readiness.release.accountWasmHash],
    webauthnVerifierAddress: readiness.release.webauthnVerifierAddress,
    relayerUrl: new URL(readiness.browser.relayPath, BACKEND_URL).toString(),
    rpName: "Kletia",
    storage: new IndexedDBStorage("kletia-stellar-passkey-v1"),
  });
  activeKit = { identity, kit, readiness };
  return kit;
}

async function readSacBalance(
  readiness: StellarPasskeyReadiness,
  contractId: string,
  asset: Asset,
): Promise<string | null> {
  if (!StrKey.isValidContract(contractId)) return null;
  try {
    const server = new rpc.Server("https://soroban-testnet.stellar.org", {
      timeout: 10_000,
    });
    const result = await server.getSACBalance(
      contractId,
      asset,
      readiness.release.networkPassphrase,
    );
    if (!result.balanceEntry) return "0.0000000";
    const atomic = BigInt(result.balanceEntry.amount.toString());
    const whole = atomic / 10_000_000n;
    const fraction = (atomic % 10_000_000n).toString().padStart(7, "0");
    return `${whole}.${fraction}`;
  } catch {
    return null;
  }
}

async function session(
  readiness: StellarPasskeyReadiness,
  contractId: string,
): Promise<StellarPasskeySession> {
  if (!StrKey.isValidContract(contractId)) {
    throw new Error("The passkey did not resolve to a valid Stellar contract account.");
  }
  return Object.freeze({
    contractId,
    balanceXlm: await readSacBalance(readiness, contractId, Asset.native()),
    balanceUsdc: await readSacBalance(
      readiness,
      contractId,
      new Asset(
        "USDC",
        "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      ),
    ),
  });
}

export async function restoreStellarPasskeyAccount(
  readiness: StellarPasskeyReadiness,
): Promise<StellarPasskeySession | null> {
  const result = await (await getKit(readiness)).connectWallet();
  return result ? session(readiness, result.contractId) : null;
}

export async function createStellarPasskeyAccount(
  readiness: StellarPasskeyReadiness,
  label: string,
): Promise<{ session: StellarPasskeySession; transactionHash: string }> {
  const kit = await getKit(readiness);
  const result = await kit.createWallet("Kletia", label.trim() || "Kletia user", {
    autoSubmit: true,
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
  });
  if (!result.submitResult?.success) {
    throw new Error(
      result.submitResult?.error.message ||
        "The passkey was created, but its Stellar Testnet account was not deployed. Retry recovery from this browser.",
    );
  }
  return {
    session: await session(readiness, result.contractId),
    transactionHash: result.submitResult.hash,
  };
}

export async function connectStellarPasskeyAccount(
  readiness: StellarPasskeyReadiness,
): Promise<StellarPasskeySession> {
  const result = await (await getKit(readiness)).connectWallet({ prompt: true });
  if (!result) throw new Error("No Kletia passkey account was selected.");
  return session(readiness, result.contractId);
}

export async function disconnectStellarPasskeyAccount(): Promise<void> {
  if (!activeKit) return;
  await activeKit.kit.disconnect();
}

export async function refreshStellarPasskeyAccount(
  readiness: StellarPasskeyReadiness,
  contractId: string,
): Promise<StellarPasskeySession> {
  return session(readiness, contractId);
}

function signerUsesActivePasskey(
  signer: { tag: string; values: readonly unknown[] },
  credentialId: string,
  verifierAddress: string,
): boolean {
  if (
    signer.tag !== "External" ||
    signer.values[0] !== verifierAddress ||
    !(signer.values[1] instanceof Uint8Array)
  ) {
    return false;
  }
  return Buffer.from(signer.values[1]).equals(
    Buffer.from(credentialId, "base64url"),
  );
}

export async function signStellarPasskeySep45Entry(input: {
  readiness: StellarPasskeyReadiness;
  passkeyAccount: string;
  webAuthContractId: string;
  authorizationEntry: string;
}): Promise<string> {
  const kit = await getKit(input.readiness);
  if (
    !kit.isConnected ||
    kit.contractId !== input.passkeyAccount ||
    !kit.credentialId
  ) {
    throw new Error(
      "Connect the same Stellar passkey account that started this payment session.",
    );
  }
  const { createCallContractContext, createDefaultContext } = await import(
    "smart-account-kit"
  );
  const [specificRules, defaultRules] = await Promise.all([
    kit.rules.getAll(createCallContractContext(input.webAuthContractId)),
    kit.rules.getAll(createDefaultContext()),
  ]);
  const matching = (rules: typeof specificRules) =>
    rules.filter((rule) =>
      rule.signers.some((signer) =>
        signerUsesActivePasskey(
          signer,
          kit.credentialId as string,
          input.readiness.release.webauthnVerifierAddress,
        ),
      ),
    );
  const specificMatches = matching(specificRules);
  const candidates =
    specificMatches.length > 0 ? specificMatches : matching(defaultRules);
  if (candidates.length !== 1) {
    throw new Error(
      candidates.length === 0
        ? "This passkey is not authorized by a reviewed account rule for anchor authentication."
        : "More than one account rule could authorize this anchor request; Kletia will not choose silently.",
    );
  }
  const entry = xdr.SorobanAuthorizationEntry.fromXDR(
    input.authorizationEntry,
    "base64",
  );
  const signed = await kit.signAuthEntry(
    entry,
    { contextRuleIds: [candidates[0].id] },
  );
  return signed.toXDR("base64");
}

export async function fundStellarPasskeyAccount(
  readiness: StellarPasskeyReadiness,
): Promise<{ session: StellarPasskeySession; transactionHash: string; amount: number | null }> {
  const kit = await getKit(readiness);
  const result = await kit.fundWallet(readiness.release.nativeTokenContract, {
    forceMethod: "relayer",
  });
  if (!result.success) throw new Error(result.error.message || "Testnet funding failed.");
  const connected = await kit.connectWallet();
  if (!connected) throw new Error("The funded passkey account session was lost.");
  return {
    session: await session(readiness, connected.contractId),
    transactionHash: result.hash,
    amount: typeof result.amount === "number" ? result.amount : null,
  };
}

export async function transferAssetFromStellarPasskeyAccount(
  readiness: StellarPasskeyReadiness,
  symbol: "XLM" | "USDC",
  recipient: string,
  amount: number,
): Promise<{ session: StellarPasskeySession; transactionHash: string }> {
  if (
    !StrKey.isValidEd25519PublicKey(recipient) &&
    !StrKey.isValidContract(recipient)
  ) {
    throw new Error("Enter a valid Stellar G... or C... recipient.");
  }
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) {
    throw new Error(`Enter a positive ${symbol} amount within the Testnet limit.`);
  }
  const kit = await getKit(readiness);
  const result = await kit.transfer(
    symbol === "XLM"
      ? readiness.release.nativeTokenContract
      : readiness.release.usdcTokenContract,
    recipient,
    amount,
    { forceMethod: "relayer" },
  );
  if (!result.success) throw new Error(result.error.message || "The passkey transfer failed.");
  const connected = await kit.connectWallet();
  if (!connected) throw new Error("The passkey account session was lost after transfer.");
  return {
    session: await session(readiness, connected.contractId),
    transactionHash: result.hash,
  };
}

export type StellarSep24PasskeyTransferInstruction = Readonly<{
  assetCode: "USDC";
  assetContract: string;
  amount: string;
  anchorAccount: string;
  destination: string;
  memo: null | { type: "id"; value: string };
  quoteId: string;
}>;

export async function transferSep24WithdrawalFromStellarPasskeyAccount(
  readiness: StellarPasskeyReadiness,
  passkeySession: StellarPasskeySession,
  instruction: StellarSep24PasskeyTransferInstruction,
): Promise<{ session: StellarPasskeySession; transactionHash: string }> {
  if (
    instruction.assetCode !== "USDC" ||
    instruction.assetContract !== readiness.release.usdcTokenContract
  ) {
    throw new Error("The SEP-24 payment instruction changed the reviewed USDC asset.");
  }
  if (!StrKey.isValidEd25519PublicKey(instruction.anchorAccount)) {
    throw new Error("The SEP-24 anchor account is invalid.");
  }
  if (!/^\d{1,10}(?:\.\d{1,7})?$/u.test(instruction.amount)) {
    throw new Error("The SEP-24 USDC amount is outside Stellar precision.");
  }
  const numericAmount = Number(instruction.amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0 || numericAmount > 10_000_000) {
    throw new Error("The SEP-24 USDC amount is outside Kletia's Testnet limit.");
  }
  let expectedDestination = instruction.anchorAccount;
  if (instruction.memo) {
    if (!/^\d{1,20}$/u.test(instruction.memo.value)) {
      throw new Error("The SEP-24 ID memo is invalid.");
    }
    expectedDestination = new MuxedAccount(
      new Account(instruction.anchorAccount, "0"),
      instruction.memo.value,
    ).accountId();
  }
  if (instruction.destination !== expectedDestination) {
    throw new Error("The SEP-24 muxed destination does not match its anchor memo.");
  }
  const kit = await getKit(readiness);
  const connected = await kit.connectWallet();
  if (!connected || connected.contractId !== passkeySession.contractId) {
    throw new Error("The connected passkey account changed before payout approval.");
  }
  const [whole, fraction = ""] = instruction.amount.split(".");
  const amountAtomic =
    BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, "0") || "0");
  const rpcServer = new rpc16.Server("https://soroban-testnet.stellar.org");
  const transferInvocation = xdr16.HostFunction.hostFunctionTypeInvokeContract(
    new xdr16.InvokeContractArgs({
      contractAddress: Address16.fromString(
        readiness.release.usdcTokenContract,
      ).toScAddress(),
      functionName: "transfer",
      args: [
        Address16.fromString(passkeySession.contractId).toScVal(),
        Address16.fromString(instruction.destination).toScVal(),
        nativeToScVal16(amountAtomic, { type: "i128" }),
      ],
    }),
  );
  const assembled = await contract16.AssembledTransaction.buildWithOp(
    Operation16.invokeHostFunction({ func: transferInvocation, auth: [] }),
    {
      contractId: readiness.release.usdcTokenContract,
      networkPassphrase: readiness.release.networkPassphrase,
      rpcUrl: rpcServer.serverURL.toString(),
      server: rpcServer,
      timeoutInSeconds: 300,
      method: "transfer",
      parseResultXdr: (value) => value,
    },
  );
  const result = await kit.signAndSubmit(
    assembled as unknown as Parameters<SmartAccountKit["signAndSubmit"]>[0],
    { forceMethod: "relayer" },
  );
  if (!result.success) {
    throw new Error(result.error.message || "The SEP-24 passkey transfer failed.");
  }
  const after = await kit.connectWallet();
  if (!after || after.contractId !== passkeySession.contractId) {
    throw new Error("The passkey account session changed after the payout transfer.");
  }
  return {
    session: await session(readiness, after.contractId),
    transactionHash: result.hash,
  };
}

export async function transferXlmFromStellarPasskeyAccount(
  readiness: StellarPasskeyReadiness,
  recipient: string,
  amount: number,
): Promise<{ session: StellarPasskeySession; transactionHash: string }> {
  return transferAssetFromStellarPasskeyAccount(
    readiness,
    "XLM",
    recipient,
    amount,
  );
}
