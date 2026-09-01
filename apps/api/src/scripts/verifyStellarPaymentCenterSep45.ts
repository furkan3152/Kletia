import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Address,
  Keypair,
  Networks,
  StrKey,
  authorizeEntry,
  nativeToScVal,
  xdr,
} from "stellar-sdk-16";

import type { AnchorDiscovery } from "../networks/stellar/lastMile.js";
import { STELLAR_TESTNET } from "../networks/stellar/config.js";
import {
  verifySep45SimulationFootprint,
  verifySignedSep45Challenge,
  verifyUnsignedSep45Challenge,
} from "../networks/stellar/payment-center/sep45Challenge.js";
import {
  buildSep38FirmQuoteRequest,
  validateSep24InteractiveResponse,
  validateSep24TransactionResponse,
  validateSep38FirmQuoteResponse,
} from "../networks/stellar/payment-center/sep38Sep24.js";
import { toPaymentCenterSessionView } from "../networks/stellar/payment-center/types.js";
import type { PaymentCenterSessionRecord } from "../networks/stellar/payment-center/types.js";

function encodeEntries(entries: xdr.SorobanAuthorizationEntry[]): string {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(entries.length, 0);
  return Buffer.concat([length, ...entries.map((entry) => entry.toXDR())]).toString(
    "base64",
  );
}

function invocation(input: {
  webAuthContractId: string;
  passkeyAccount: string;
  serverAccount: string;
}) {
  const fields = nativeToScVal({
    account: input.passkeyAccount,
    home_domain: "example.com",
    nonce: "7eb8a90d-6618-473b-8633-7de94b83f367",
    web_auth_domain: "auth.example.com",
    web_auth_domain_account: input.serverAccount,
  });
  return new xdr.SorobanAuthorizedInvocation({
    function:
      xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(input.webAuthContractId).toScAddress(),
          functionName: "web_auth_verify",
          args: [fields],
        }),
      ),
    subInvocations: [],
  });
}

function unsignedEntry(input: {
  address: string;
  nonce: string;
  invocation: xdr.SorobanAuthorizedInvocation;
}) {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(input.address).toScAddress(),
        nonce: xdr.Int64.fromString(input.nonce),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: input.invocation,
  });
}

async function rejection(
  action: () => unknown | Promise<unknown>,
  expectedCode: string,
) {
  await assert.rejects(Promise.resolve().then(action), (error: unknown) => {
    return (
      error instanceof Error &&
      "code" in error &&
      (error as { code: unknown }).code === expectedCode
    );
  });
}

function nonceLedgerKey(address: string, nonce: string): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(address).toScAddress(),
      durability: xdr.ContractDataDurability.temporary(),
      key: xdr.ScVal.scvLedgerKeyNonce(
        new xdr.ScNonceKey({ nonce: xdr.Int64.fromString(nonce) }),
      ),
    }),
  );
}

async function main() {
  const passkeyAccount = StrKey.encodeContract(Buffer.alloc(32, 1));
  const webAuthContractId = StrKey.encodeContract(Buffer.alloc(32, 2));
  const serverKeypair = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3));
  const discovery: AnchorDiscovery = {
    domain: "example.com",
    networkPassphrase: Networks.TESTNET,
    transferServerSep24: "https://api.example.com/sep24",
    transferServerSep6: null,
    directPaymentServer: null,
    anchorQuoteServer: "https://api.example.com/sep38",
    kycServer: null,
    webAuthEndpoint: null,
    webAuthForContractsEndpoint: "https://auth.example.com/sep45/auth",
    webAuthContractId,
    signingKey: serverKeypair.publicKey(),
    sep45Advertised: true,
  };
  const root = invocation({
    webAuthContractId,
    passkeyAccount,
    serverAccount: serverKeypair.publicKey(),
  });
  const clientEntry = unsignedEntry({
    address: passkeyAccount,
    nonce: "1001",
    invocation: root,
  });
  const serverUnsigned = unsignedEntry({
    address: serverKeypair.publicKey(),
    nonce: "1002",
    invocation: root,
  });
  const serverEntry = await authorizeEntry(
    serverUnsigned,
    serverKeypair,
    9_999_999,
    Networks.TESTNET,
  );

  // SEP-45 explicitly does not guarantee entry order. Server-first must pass.
  const challenge = verifyUnsignedSep45Challenge({
    authorizationEntries: encodeEntries([serverEntry, clientEntry]),
    networkPassphrase: Networks.TESTNET,
    passkeyAccount,
    discovery,
  });
  assert.equal(challenge.clientEntryIndex, 1);
  assert.equal(challenge.serverEntryIndex, 0);
  assert.equal(challenge.signingKey, serverKeypair.publicKey());

  await rejection(
    () =>
      verifyUnsignedSep45Challenge({
        authorizationEntries: challenge.authorizationEntries,
        networkPassphrase: Networks.PUBLIC,
        passkeyAccount,
        discovery,
      }),
    "SEP45_CONFIGURATION_INVALID",
  );

  const missingServerSignature = xdr.SorobanAuthorizationEntry.fromXDR(
    serverEntry.toXDR(),
  );
  missingServerSignature
    .credentials()
    .address()
    .signature(xdr.ScVal.scvVoid());
  await rejection(
    () =>
      verifyUnsignedSep45Challenge({
        authorizationEntries: encodeEntries([
          missingServerSignature,
          clientEntry,
        ]),
        networkPassphrase: Networks.TESTNET,
        passkeyAccount,
        discovery,
      }),
    "SEP45_SERVER_SIGNATURE_INVALID",
  );

  await rejection(
    () =>
      verifySignedSep45Challenge({
        unsignedChallenge: challenge,
        signedAuthorizationEntries: challenge.authorizationEntries,
      }),
    "SEP45_SIGNED_CHALLENGE_INVALID",
  );

  const signedClient = xdr.SorobanAuthorizationEntry.fromXDR(
    clientEntry.toXDR(),
  );
  signedClient.credentials().address().signatureExpirationLedger(9_999_999);
  signedClient.credentials().address().signature(xdr.ScVal.scvVec([]));
  const structurallySigned = encodeEntries([serverEntry, signedClient]);
  assert.equal(
    verifySignedSep45Challenge({
      unsignedChallenge: challenge,
      signedAuthorizationEntries: structurallySigned,
    }),
    structurallySigned,
  );

  verifySep45SimulationFootprint({
    readWrite: [
      nonceLedgerKey(passkeyAccount, "1001"),
      nonceLedgerKey(serverKeypair.publicKey(), "1002"),
    ],
    passkeyAccount,
    signingKey: serverKeypair.publicKey(),
    webAuthContractId,
  });
  await rejection(
    () =>
      verifySep45SimulationFootprint({
        readWrite: [
          nonceLedgerKey(passkeyAccount, "1001"),
          nonceLedgerKey(webAuthContractId, "9999"),
        ],
        passkeyAccount,
        signingKey: serverKeypair.publicKey(),
        webAuthContractId,
      }),
    "SEP45_SIMULATION_SIDE_EFFECT",
  );

  const temporaryDirectory = mkdtempSync(join(tmpdir(), "kletia-payment-center-"));
  process.env.STELLAR_PAYMENT_CENTER_SQLITE_PATH = join(
    temporaryDirectory,
    "sessions.sqlite",
  );
  const store = await import("../networks/stellar/payment-center/store.js");
  const now = Date.now();
  const record: PaymentCenterSessionRecord = {
    schemaVersion: "kletia_stellar_payment_session_v1",
    sessionId: randomUUID(),
    state: "created",
    version: 1,
    passkeyAccount,
    provider: "example.com",
    quoteRequest: {
      sourceNetwork: "stellar_testnet",
      amountMode: "send_exact",
      amount: "10",
      destinationCountry: "TR",
      destinationCurrency: "TRY",
      deliveryMethod: "BANK",
      passkeyAccount,
    },
    indicativeQuote: {
      provider: "example.com",
      sourceNetwork: "stellar_testnet",
      sourceAsset: "USDC",
      destinationCountry: "TR",
      destinationCurrency: "TRY",
      deliveryMethod: "BANK",
      sellAmount: "10",
      buyAmount: "400",
      totalPrice: "40",
      price: "40",
      fee: null,
      quoteType: "indicative",
      observedAt: new Date(now).toISOString(),
      sep24: true,
      sep31PartnerAdvertised: false,
      sep38: true,
      settlementMode: "sep24_hosted_withdrawal",
      sep12Advertised: true,
      sep45Advertised: true,
      providerRole: "reviewed_anchor",
      realWorldSettlement: true,
      passkeyIdentityBound: false,
      executionReady: false,
      blockedReason: "Authentication required.",
      mockData: false,
    },
    challenge: null,
    anchorAccessTokenCiphertext: null,
    anchorAccessTokenExpiresAt: null,
    firmQuote: null,
    sep24Transaction: null,
    submittedTransfer: null,
    lastErrorCode: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + 60_000,
  };
  await store.createPaymentCenterSession(record);
  assert.deepEqual(await store.readPaymentCenterSession(record.sessionId), record);
  assert.deepEqual(await store.readPaymentCenterStoreReadiness(), {
    ready: true,
    durable: true,
    backend: "sqlite",
  });
  const token = store.sealPaymentCenterSessionToken(record);
  assert.equal(store.openPaymentCenterSessionToken(token).sessionId, record.sessionId);
  await rejection(
    () => store.openPaymentCenterSessionToken(`${token.slice(0, -1)}A`),
    "PAYMENT_CENTER_SESSION_TOKEN_INVALID",
  );
  const encrypted = store.encryptAnchorAccessToken("header.payload.signature");
  assert.equal(
    store.decryptAnchorAccessToken(encrypted),
    "header.payload.signature",
  );
  const quoteRequest = buildSep38FirmQuoteRequest(record);
  assert.deepEqual(quoteRequest, {
    sell_asset: `stellar:USDC:${STELLAR_TESTNET.usdc.issuer}`,
    buy_asset: "iso4217:TRY",
    country_code: "TR",
    buy_delivery_method: "BANK",
    context: "sep24",
    sell_amount: "10",
  });
  const firmQuote = validateSep38FirmQuoteResponse({
    session: record,
    now,
    value: {
      id: "firm-quote-1",
      expires_at: new Date(now + 300_000).toISOString(),
      total_price: "0.025",
      price: "0.024",
      sell_asset: `stellar:USDC:${STELLAR_TESTNET.usdc.issuer}`,
      sell_amount: "10",
      buy_asset: "iso4217:TRY",
      buy_amount: "400",
      buy_delivery_method: "BANK",
      fee: { total: "0.4", asset: "iso4217:TRY" },
    },
  });
  assert.equal(firmQuote.quoteType, "firm");
  assert.equal(firmQuote.sellAmount, "10");
  await rejection(
    () =>
      validateSep38FirmQuoteResponse({
        session: record,
        now,
        value: {
          id: "firm-quote-evil",
          expires_at: new Date(now + 300_000).toISOString(),
          total_price: "0.025",
          price: "0.024",
          sell_asset: "stellar:USDC:GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
          sell_amount: "10",
          buy_asset: "iso4217:TRY",
          buy_amount: "400",
        },
      }),
    "SEP38_FIRM_QUOTE_IDENTITY_MISMATCH",
  );
  await rejection(
    () =>
      validateSep38FirmQuoteResponse({
        session: record,
        now,
        value: {
          id: "firm-quote-bad-math",
          expires_at: new Date(now + 300_000).toISOString(),
          total_price: "0.05",
          price: "0.024",
          sell_asset: `stellar:USDC:${STELLAR_TESTNET.usdc.issuer}`,
          sell_amount: "10",
          buy_asset: "iso4217:TRY",
          buy_amount: "400",
        },
      }),
    "SEP38_FIRM_QUOTE_FORMULA_INVALID",
  );
  process.env.STELLAR_ANCHOR_ALLOWLIST = "https://example.com";
  process.env.STELLAR_ANCHOR_ENDPOINT_HOST_ALLOWLIST = "https://secure.example.com";
  const hosted = validateSep24InteractiveResponse({
    value: {
      type: "interactive_customer_info_needed",
      id: "withdrawal-1",
      url: "https://secure.example.com/withdraw?token=one-time-secret",
    },
    now,
    interactiveUrlCiphertext: store.encryptSep24InteractiveUrl,
  });
  assert.equal(hosted.snapshot.responseType, "interactive_customer_info_needed");
  assert.equal(
    store.decryptSep24InteractiveUrl(hosted.snapshot.interactiveUrlCiphertext),
    hosted.interactiveUrl,
  );
  const withdrawalReadyRecord: PaymentCenterSessionRecord = {
    ...record,
    state: "sep24_session_ready",
    firmQuote,
    sep24Transaction: hosted.snapshot,
  };
  const pendingWithdrawal = validateSep24TransactionResponse({
    session: withdrawalReadyRecord,
    now,
    value: {
      transaction: {
        id: "withdrawal-1",
        kind: "withdrawal",
        status: "pending_user_transfer_start",
        quote_id: "firm-quote-1",
        amount_in: "10.0000000",
        amount_in_asset: `stellar:USDC:${STELLAR_TESTNET.usdc.issuer}`,
        withdraw_anchor_account: serverKeypair.publicKey(),
        withdraw_memo: "186384",
        withdraw_memo_type: "id",
        user_action_required_by: new Date(now + 120_000).toISOString(),
      },
    },
  });
  assert.equal(pendingWithdrawal.status, "pending_user_transfer_start");
  assert.equal(pendingWithdrawal.transferInstruction?.memo?.value, "186384");
  assert.equal(
    StrKey.isValidMed25519PublicKey(
      pendingWithdrawal.transferInstruction?.destination || "",
    ),
    true,
  );
  const changedAmount = validateSep24TransactionResponse({
    session: withdrawalReadyRecord,
    now,
    value: {
      transaction: {
        id: "withdrawal-1",
        kind: "withdrawal",
        status: "pending_user_transfer_start",
        quote_id: "firm-quote-1",
        amount_in: "11",
        amount_in_asset: `stellar:USDC:${STELLAR_TESTNET.usdc.issuer}`,
        withdraw_anchor_account: serverKeypair.publicKey(),
      },
    },
  });
  assert.equal(changedAmount.transferInstruction, null);
  assert.match(changedAmount.transferBlockedReason || "", /firm quote/u);
  const unsupportedMemo = validateSep24TransactionResponse({
    session: withdrawalReadyRecord,
    now,
    value: {
      transaction: {
        id: "withdrawal-1",
        kind: "withdrawal",
        status: "pending_user_transfer_start",
        quote_id: "firm-quote-1",
        amount_in: "10",
        amount_in_asset: `stellar:USDC:${STELLAR_TESTNET.usdc.issuer}`,
        withdraw_anchor_account: serverKeypair.publicKey(),
        withdraw_memo: "bank-reference",
        withdraw_memo_type: "text",
      },
    },
  });
  assert.equal(unsupportedMemo.transferInstruction, null);
  assert.match(unsupportedMemo.transferBlockedReason || "", /ID memo/u);
  await rejection(
    () =>
      validateSep24TransactionResponse({
        session: withdrawalReadyRecord,
        now,
        value: {
          transaction: {
            id: "withdrawal-1",
            kind: "withdrawal",
            status: "pending_anchor",
            quote_id: "another-quote",
          },
        },
      }),
    "SEP24_TRANSACTION_IDENTITY_MISMATCH",
  );
  await rejection(
    () =>
      validateSep24TransactionResponse({
        session: withdrawalReadyRecord,
        now,
        value: {
          transaction: {
            id: "withdrawal-1",
            kind: "withdrawal",
            status: "completed",
            quote_id: "firm-quote-1",
          },
        },
      }),
    "SEP24_TRANSACTION_EVIDENCE_MISSING",
  );
  await rejection(
    () =>
      validateSep24InteractiveResponse({
        value: {
          type: "interactive_customer_info_needed",
          id: "withdrawal-evil",
          url: "https://unreviewed.example.net/withdraw?token=secret",
        },
        interactiveUrlCiphertext: store.encryptSep24InteractiveUrl,
      }),
    "STELLAR_ANCHOR_INTERACTIVE_URL_NOT_ALLOWED",
  );
  const sensitiveRecord: PaymentCenterSessionRecord = {
    ...record,
    anchorAccessTokenCiphertext: encrypted,
    anchorAccessTokenExpiresAt: now + 60_000,
    firmQuote,
    sep24Transaction: hosted.snapshot,
  };
  const publicView = toPaymentCenterSessionView(sensitiveRecord);
  assert.equal("anchorAccessTokenCiphertext" in publicView, false);
  assert.equal(
    JSON.stringify(publicView).includes("one-time-secret"),
    false,
  );
  assert.equal(
    "interactiveUrlCiphertext" in (publicView.sep24Transaction || {}),
    false,
  );
  const transitioned = await store.transitionPaymentCenterSession(
    record.sessionId,
    ["created"],
    (current) => ({
      ...current,
      state: "challenge_requesting",
      version: current.version + 1,
      updatedAt: current.updatedAt + 1,
    }),
  );
  assert.equal(transitioned.state, "challenge_requesting");
  await rejection(
    () =>
      store.transitionPaymentCenterSession(
        record.sessionId,
        ["created"],
        (current) => ({
          ...current,
          version: current.version + 1,
          updatedAt: current.updatedAt + 1,
        }),
      ),
    "PAYMENT_CENTER_STATE_CONFLICT",
  );
  rmSync(temporaryDirectory, { recursive: true, force: true });

  console.log(
    JSON.stringify(
      {
        success: true,
        sep45: {
          exactNetwork: true,
          unorderedEntriesAccepted: true,
          serverSignatureVerified: true,
          signedMutationBoundary: true,
          nonceOnlyFootprint: true,
        },
    persistence: {
          durableSqlite: true,
          readinessStoreProbe: true,
          integrityHash: true,
          sealedSessionToken: true,
          encryptedAnchorJwt: true,
      optimisticStateTransition: true,
      sensitiveFieldsExcludedFromView: true,
    },
    payoutPreparation: {
      sep38FirmQuoteBound: true,
      quoteFormulaVerified: true,
      sep24HostedUrlAllowlisted: true,
      hostedUrlEncryptedAtRest: true,
      sep24StatusIdentityBound: true,
      muxedIdMemoBound: true,
      duplicateTransferPreventedByState: true,
    },
      },
      null,
      2,
    ),
  );
}

void main();
