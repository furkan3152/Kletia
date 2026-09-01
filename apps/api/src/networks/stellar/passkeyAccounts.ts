import { createHash } from "node:crypto";

import { rpc, xdr } from "@stellar/stellar-sdk";

import { STELLAR_MVP_ENABLED, STELLAR_TESTNET } from "./config.js";
import { observeLiveExecutable } from "./policyRegistryReadiness.js";

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RELAY_BODY_BYTES = 256 * 1_024;
const MAX_AUTH_ENTRIES = 8;
const MAX_BASE64_XDR_LENGTH = 220_000;
const DEFAULT_RELAYER_UPSTREAM =
  "https://smart-account-relayer-proxy.sdf-ecosystem.workers.dev";

export const STELLAR_PASSKEY_ACCOUNT_RELEASE = Object.freeze({
  network: "stellar_testnet" as const,
  networkPassphrase: STELLAR_TESTNET.networkPassphrase,
  accountWasmHash:
    "1b5f4534a76322da2ad7c745f6900857a6802b0ca79850c35a03561df997785a",
  webauthnVerifierAddress:
    "CC7EKIHQP3TN4CARQDND6CEOY2UXLWWC2X5GHTD5NLAT7BG5GPZIOM3F",
  webauthnVerifierWasmHash:
    "e63a030d0f1a1481e36059a4837c433083b33e704c1f9625b7314795b6d72b76",
  nativeTokenContract:
    "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  usdcTokenContract: STELLAR_TESTNET.usdc.sac,
  sdk: Object.freeze({
    package: "smart-account-kit",
    version: "0.6.2",
    repository: "https://github.com/stellar/smart-account-kit",
    deploymentManifest:
      "https://github.com/stellar/smart-account-kit/blob/main/docs/deployments-protocol-27-2026-07-09.md",
    upstreamContractCommit:
      "1e513890ecf79833c9d6e7ef38a9358001c0b111",
  }),
});

type RelayBody =
  | Readonly<{ xdr: string }>
  | Readonly<{ func: string; auth: readonly string[] }>;

function isBase64Xdr(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_BASE64_XDR_LENGTH &&
    value.length % 4 === 0 &&
    /^[A-Za-z\d+/]+={0,2}$/u.test(value)
  );
}

export function parseStellarPasskeyRelayBody(input: unknown): RelayBody {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw Object.assign(new Error("A Smart Account Kit relay payload is required."), {
      code: "STELLAR_PASSKEY_RELAY_BODY_INVALID",
      statusCode: 400,
    });
  }
  const body = input as Record<string, unknown>;
  const keys = Object.keys(body).sort();
  if (keys.length === 1 && keys[0] === "xdr" && isBase64Xdr(body.xdr)) {
    return Object.freeze({ xdr: body.xdr });
  }
  if (
    keys.length === 2 &&
    keys[0] === "auth" &&
    keys[1] === "func" &&
    isBase64Xdr(body.func) &&
    Array.isArray(body.auth) &&
    body.auth.length > 0 &&
    body.auth.length <= MAX_AUTH_ENTRIES &&
    body.auth.every(isBase64Xdr)
  ) {
    return Object.freeze({
      func: body.func,
      auth: Object.freeze([...body.auth]),
    });
  }
  throw Object.assign(
    new Error("Only the bounded Smart Account Kit xdr or func/auth relay shape is accepted."),
    { code: "STELLAR_PASSKEY_RELAY_BODY_INVALID", statusCode: 400 },
  );
}

function passkeyAccountsEnabled(): boolean {
  return (
    STELLAR_MVP_ENABLED &&
    process.env.STELLAR_PASSKEY_ACCOUNTS_ENABLED?.trim() === "true"
  );
}

function relayerUpstreamUrl(): URL {
  const candidate =
    process.env.STELLAR_PASSKEY_RELAYER_UPSTREAM_URL?.trim() ||
    DEFAULT_RELAYER_UPSTREAM;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("The configured Stellar passkey relayer URL is invalid.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    throw new Error("The Stellar passkey relayer must be a clean HTTPS origin.");
  }
  return parsed;
}

async function observeAccountWasm() {
  const server = new rpc.Server(STELLAR_TESTNET.rpcUrl, { timeout: REQUEST_TIMEOUT_MS });
  const expectedHash = STELLAR_PASSKEY_ACCOUNT_RELEASE.accountWasmHash;
  const key = xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({
      hash: new xdr.Hash(Buffer.from(expectedHash, "hex")),
    }),
  );
  const response = await server.getLedgerEntries(key);
  const entry = response.entries?.[0];
  if (!entry || entry.key.type !== "contractCode" || entry.val.type !== "contractCode") {
    return { ready: false as const, observedSha256: null, latestLedger: response.latestLedger };
  }
  const observedSha256 = createHash("sha256")
    .update(entry.val.value.code)
    .digest("hex");
  return {
    ready: observedSha256 === expectedHash,
    observedSha256,
    latestLedger: response.latestLedger,
  };
}

async function observeRelayer(upstream: URL) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(upstream, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok || Buffer.byteLength(text, "utf8") > 16_384) {
      return { ready: false as const, status: response.status, network: null };
    }
    const body = JSON.parse(text) as { status?: unknown; network?: unknown };
    return {
      ready: body.status === "ok" && body.network === "testnet",
      status: response.status,
      network: typeof body.network === "string" ? body.network : null,
    };
  } catch {
    return { ready: false as const, status: null, network: null };
  } finally {
    clearTimeout(timer);
  }
}

export async function readStellarPasskeyAccountReadiness() {
  const base = {
    schemaVersion: "kletia_stellar_passkey_account_readiness_v1" as const,
    enabled: passkeyAccountsEnabled(),
    network: STELLAR_PASSKEY_ACCOUNT_RELEASE.network,
    release: STELLAR_PASSKEY_ACCOUNT_RELEASE,
    browser: {
      relayPath: "/api/stellar/passkey/relay",
      storage: "indexeddb" as const,
      requiresSecureContext: true as const,
      extensionRequired: false as const,
      seedPhraseRequired: false as const,
    },
    capability: {
      contractAccount: true as const,
      passkeyAuthentication: true as const,
      sponsoredTestnetSubmission: true as const,
      classicSdexAndTrustlineSigning: false as const,
      muxedAnchorTransfer: "sep24_id_memo_custom_invocation" as const,
      evmWalletControlsStellarFunds: false as const,
      productionReady: false as const,
      auditedIntegration: false as const,
    },
  };
  if (!base.enabled) {
    return Object.freeze({
      ...base,
      ready: false,
      status: "disabled" as const,
      reason: "The Testnet passkey-account capability is disabled by the operator.",
      observations: null,
    });
  }

  try {
    const upstream = relayerUpstreamUrl();
    const [accountWasm, verifier, nativeToken, usdcToken, relayer] = await Promise.all([
      observeAccountWasm(),
      observeLiveExecutable(STELLAR_PASSKEY_ACCOUNT_RELEASE.webauthnVerifierAddress),
      observeLiveExecutable(STELLAR_PASSKEY_ACCOUNT_RELEASE.nativeTokenContract),
      observeLiveExecutable(STELLAR_PASSKEY_ACCOUNT_RELEASE.usdcTokenContract),
      observeRelayer(upstream),
    ]);
    const ready = Boolean(
      accountWasm.ready &&
      verifier.networkPassphrase === STELLAR_TESTNET.networkPassphrase &&
      verifier.observedExecutable === "wasm" &&
      verifier.observedWasmSha256 ===
        STELLAR_PASSKEY_ACCOUNT_RELEASE.webauthnVerifierWasmHash &&
      nativeToken.networkPassphrase === STELLAR_TESTNET.networkPassphrase &&
      nativeToken.observedExecutable === "stellar_asset" &&
      usdcToken.networkPassphrase === STELLAR_TESTNET.networkPassphrase &&
      usdcToken.observedExecutable === "stellar_asset" &&
      relayer.ready,
    );
    return Object.freeze({
      ...base,
      ready,
      status: ready ? "ready" as const : "live_identity_mismatch" as const,
      reason: ready
        ? "The account WASM, WebAuthn verifier, XLM and Circle USDC SACs, and fee-sponsoring relayer match the pinned Testnet profile."
        : "At least one live passkey-account dependency differs from the pinned Testnet profile.",
      observations: {
        accountWasm,
        webauthnVerifier: verifier,
        nativeToken,
        usdcToken,
        relayer: {
          ready: relayer.ready,
          network: relayer.network,
          status: relayer.status,
          operator:
            upstream.origin === DEFAULT_RELAYER_UPSTREAM
              ? "stellar_smart_account_kit_reference"
              : "kletia_configured",
        },
      },
    });
  } catch {
    return Object.freeze({
      ...base,
      ready: false,
      status: "observation_failed" as const,
      reason: "The live passkey-account dependencies could not all be verified.",
      observations: null,
    });
  }
}

export async function relayStellarPasskeyTransaction(input: unknown) {
  const readiness = await readStellarPasskeyAccountReadiness();
  if (!readiness.ready) {
    throw Object.assign(new Error("The Stellar Testnet passkey relayer is not ready."), {
      code: "STELLAR_PASSKEY_RELAYER_UNAVAILABLE",
      statusCode: 503,
    });
  }
  const body = parseStellarPasskeyRelayBody(input);
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized, "utf8") > MAX_RELAY_BODY_BYTES) {
    throw Object.assign(new Error("The Stellar passkey relay payload is too large."), {
      code: "STELLAR_PASSKEY_RELAY_BODY_TOO_LARGE",
      statusCode: 413,
    });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6 * 60_000);
  try {
    const response = await fetch(relayerUpstreamUrl(), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Client-Name": "Kletia",
      },
      body: serialized,
      signal: controller.signal,
    });
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RELAY_BODY_BYTES) {
      throw Object.assign(new Error("The Stellar passkey relayer response was too large."), {
        code: "STELLAR_PASSKEY_RELAY_RESPONSE_TOO_LARGE",
        statusCode: 502,
      });
    }
    let responseBody: unknown = null;
    try {
      responseBody = JSON.parse(text) as unknown;
    } catch {
      responseBody = { success: false, error: "The upstream relayer returned invalid JSON." };
    }
    return { statusCode: response.status, body: responseBody };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw Object.assign(new Error("The Stellar passkey relayer timed out."), {
        code: "STELLAR_PASSKEY_RELAYER_TIMEOUT",
        statusCode: 504,
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
