/**
 * Off-chain checks and settings for contract registrations (BYOC):
 *
 * - Source verification on Sourcify v2 (EVM): `exact_match` / `match` /
 *   `unverified` (404) / `unknown` (timeout or failure), plus Sourcify's
 *   `proxyResolution`, recorded as a cross-check of the on-chain proxy pins.
 * - Program verification on OtterSec (`verify.osec.io/status/<program>`).
 * - Domain verification: `https://<website>/.well-known/kletia.json` lists the
 *   registration id (fetched through the SSRF-guarded client).
 * - Optional address risk screening with Webacy when WEBACY_API_KEY is set.
 * - Deployment settings: kill switch, deny lists, activation delay, caps.
 *
 * Every provider call is best effort with a 5 s timeout: a failure is
 * recorded as `unknown`, never as verified. The engine functions the HTTP
 * layer calls (pins, Solana program pins, action metadata, contract tests)
 * are reached through `contractEngine()`, which tests replace.
 */
import { WebacyClient, Chain } from "@webacy-xyz/sdk";
import {
  CHAINS,
  CONTRACT_LIMITS,
  type ContractAbiItem,
  type ContractTestRequest,
  type ContractTestResult,
  type EvmContractPins,
  type NetworkKey,
  type ProgramVerification,
  type RiskScreening,
  type SolanaActionMetadata,
  type SolanaProgramPin,
  type SourceVerification,
} from "@kletia/core";
import {
  compareEvmPins,
  fetchSolanaActionMetadata,
  inspectEvmContract,
  readSolanaProgramPins,
  simulationCapability,
  testContractAction,
  type ActionTransport,
  type RegisteredContract,
} from "../index.js";
import { domainListsContract } from "./actionTransport.js";

const PROVIDER_TIMEOUT_MS = 5_000;
const MAX_PROVIDER_BYTES = 2_000_000;
export const SOURCIFY_API = "https://sourcify.dev/server/v2/contract";
export const OTTERSEC_API = "https://verify.osec.io/status";

/* ------------------------------------------------------------- settings */

function envNumber(name: string, fallback: number, min = 0): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

/** Kill switch: KLETIA_CONTRACTS_ENABLED=false disables registration, plan and prepare of call/action steps. */
export function contractsEnabled(): boolean {
  const raw = process.env.KLETIA_CONTRACTS_ENABLED?.trim().toLowerCase();
  return !(raw === "false" || raw === "0" || raw === "off" || raw === "no");
}

/** Seconds a mainnet registration or security-relevant revision waits before it activates (testnets: 0). */
export function activationDelaySeconds(network: NetworkKey): number {
  if (CHAINS[network].environment !== "mainnet") return 0;
  return Math.floor(envNumber("KLETIA_CONTRACT_ACTIVATION_DELAY_SECONDS", CONTRACT_LIMITS.defaultActivationDelaySeconds));
}

/** Per-key 24 h notional cap (USD) for custom contract steps, counted at prepare. */
export function keyDailyMaxUsd(): number {
  return envNumber("KLETIA_CONTRACT_KEY_DAILY_MAX_USD", CONTRACT_LIMITS.defaultKeyDailyMaxUsd);
}

function listEnv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Configured deny entries as `network:address` (KLETIA_CONTRACT_DENYLIST, and
 * KLETIA_SOLANA_PROGRAM_DENYLIST whose bare program ids apply to every Solana
 * network), on top of the built-in list in `deniedTargetReason`.
 */
export function configuredDenylist(): string[] {
  const entries = listEnv("KLETIA_CONTRACT_DENYLIST");
  for (const entry of listEnv("KLETIA_SOLANA_PROGRAM_DENYLIST")) {
    if (entry.includes(":")) entries.push(entry);
    else entries.push(`solana:${entry}`, `solana-devnet:${entry}`);
  }
  return entries;
}

/* ------------------------------------------------------------- providers */

async function fetchJson(url: string, init: RequestInit = {}): Promise<{ status: number; json: unknown } | null> {
  try {
    const response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_PROVIDER_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const text = await response.text();
    if (text.length > MAX_PROVIDER_BYTES) return null;
    let json: unknown = null;
    try {
      json = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      return { status: response.status, json: null };
    }
    return { status: response.status, json };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface SourcifyProxyResolution {
  readonly isProxy: boolean;
  readonly proxyType: string | null;
  /** Lower-case implementation addresses Sourcify reports. */
  readonly implementations: readonly string[];
}

export interface SourcifyResult {
  readonly verification: SourceVerification;
  readonly proxy: SourcifyProxyResolution | null;
  /** Only when requested with `withAbi` and the contract is verified. */
  readonly abi: readonly ContractAbiItem[] | null;
}

function sourcifyUrl(network: NetworkKey, address: string): string | null {
  const chainId = CHAINS[network].evmChainId;
  return chainId === undefined ? null : `${SOURCIFY_API}/${chainId}/${address}`;
}

async function sourcify(network: NetworkKey, address: string, withAbi = false): Promise<SourcifyResult> {
  const checkedAt = new Date().toISOString();
  const base = sourcifyUrl(network, address);
  if (!base) return { verification: { status: "unknown", provider: "sourcify", checkedAt }, proxy: null, abi: null };
  const reply = await fetchJson(`${base}?fields=${withAbi ? "abi,proxyResolution" : "proxyResolution"}`, { headers: { accept: "application/json" } });
  if (!reply || !isRecord(reply.json)) return { verification: { status: "unknown", provider: "sourcify", checkedAt, url: base }, proxy: null, abi: null };
  const body = reply.json;
  const match = body.match;
  const status: SourceVerification["status"] =
    reply.status === 200 && (match === "exact_match" || match === "match")
      ? match
      : reply.status === 404 && match === null
        ? "unverified"
        : "unknown";
  let proxy: SourcifyProxyResolution | null = null;
  if (isRecord(body.proxyResolution)) {
    const resolution = body.proxyResolution;
    const implementations = Array.isArray(resolution.implementations)
      ? resolution.implementations
          .map((entry) => (isRecord(entry) && typeof entry.address === "string" ? entry.address.toLowerCase() : null))
          .filter((entry): entry is string => entry !== null)
      : [];
    proxy = {
      isProxy: resolution.isProxy === true,
      proxyType: typeof resolution.proxyType === "string" ? resolution.proxyType : null,
      implementations,
    };
  }
  const abi = withAbi && Array.isArray(body.abi) ? (body.abi.filter(isRecord) as unknown as ContractAbiItem[]) : null;
  return {
    verification: { status, provider: "sourcify", checkedAt, url: base, ...(proxy ? { proxyType: proxy.proxyType } : {}) },
    proxy,
    abi,
  };
}

async function ottersec(program: string): Promise<ProgramVerification> {
  const checkedAt = new Date().toISOString();
  const reply = await fetchJson(`${OTTERSEC_API}/${encodeURIComponent(program)}`, { headers: { accept: "application/json" } });
  if (!reply || reply.status !== 200 || !isRecord(reply.json) || typeof reply.json.is_verified !== "boolean") {
    return { program, verified: null, provider: "ottersec", checkedAt };
  }
  const body = reply.json;
  const repository = typeof body.repo_url === "string" && /^https:\/\//u.test(body.repo_url) ? body.repo_url.slice(0, 300) : undefined;
  const commit = typeof body.commit === "string" && /^[0-9a-f]{7,64}$/u.test(body.commit) ? body.commit : undefined;
  return {
    program,
    verified: body.is_verified === true,
    provider: "ottersec",
    checkedAt,
    ...(body.is_verified === true && repository ? { repository } : {}),
    ...(body.is_verified === true && commit ? { commit } : {}),
  };
}

const WEBACY_CHAINS: Partial<Record<NetworkKey, Chain>> = {
  ethereum: Chain.ETH,
  base: Chain.BASE,
  arbitrum: Chain.ARB,
  optimism: Chain.OPT,
  polygon: Chain.POL,
  solana: Chain.SOL,
};

/** Webacy overall risk above this refuses registration (same threshold as the first-party address check). */
export const RISK_REFUSAL_SCORE = 50;

async function risk(network: NetworkKey, address: string): Promise<RiskScreening | null> {
  const apiKey = process.env.WEBACY_API_KEY?.trim();
  const chain = WEBACY_CHAINS[network];
  if (!apiKey || !chain) return null;
  const checkedAt = new Date().toISOString();
  try {
    const client = new WebacyClient({ apiKey, defaultChain: chain });
    let timer: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      client.threat.addresses.analyze(address, { chain }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), PROVIDER_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    const raw: unknown = (result as { overallRisk?: unknown }).overallRisk;
    const score = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : Number.NaN;
    if (!Number.isFinite(score) || score < 0 || score > 100) return { provider: "webacy", score: null, checkedAt };
    return { provider: "webacy", score, level: score > RISK_REFUSAL_SCORE ? "high" : "low", checkedAt };
  } catch {
    // Optional screening: an outage is recorded (score null), the registration's other controls still apply.
    return { provider: "webacy", score: null, checkedAt };
  }
}

/* ------------------------------------------------------------- injection */

/** What `inspectEvmContract` (engine) returns. */
export interface EvmInspection {
  readonly codeSize: number;
  readonly eip7702: boolean;
  readonly pins: EvmContractPins;
  /** Signals of a proxy pattern the engine cannot pin (e.g. an EIP-2535 diamond). */
  readonly proxyHints: readonly string[];
}

/** Engine functions the HTTP layer calls (design §8.2). */
export interface ContractEngine {
  inspectEvmContract(network: NetworkKey, address: string, extra?: readonly string[]): Promise<EvmInspection>;
  compareEvmPins(pinned: EvmContractPins, current: EvmContractPins): string | null;
  readSolanaProgramPins(network: NetworkKey, programs: readonly string[]): Promise<SolanaProgramPin[]>;
  fetchSolanaActionMetadata(transport: ActionTransport, href: string, network: NetworkKey): Promise<SolanaActionMetadata>;
  testContractAction(contract: RegisteredContract, request: ContractTestRequest): Promise<ContractTestResult>;
  simulationCapability(): Promise<Partial<Record<NetworkKey, "ok" | "unavailable">>>;
}

/** Off-chain providers. */
export interface ContractChecks {
  sourcify(network: NetworkKey, address: string, withAbi?: boolean): Promise<SourcifyResult>;
  ottersec(program: string): Promise<ProgramVerification>;
  /** True when the website's `/.well-known/kletia.json` lists the registration id. */
  domain(website: string | undefined, contractId: string): Promise<boolean>;
  risk(network: NetworkKey, address: string): Promise<RiskScreening | null>;
}

const ENGINE: ContractEngine = {
  inspectEvmContract: (network, address, extra) => inspectEvmContract(network as never, address, extra) as Promise<EvmInspection>,
  compareEvmPins: (pinned, current) => compareEvmPins(pinned, current),
  readSolanaProgramPins: (network, programs) => readSolanaProgramPins(network as never, programs),
  fetchSolanaActionMetadata: (transport, href, network) => fetchSolanaActionMetadata(transport, href, network as never),
  testContractAction: (contract, request) => testContractAction(contract, request),
  simulationCapability: () => simulationCapability(),
};

const CHECKS: ContractChecks = { sourcify, ottersec, domain: domainListsContract, risk };

let engine: ContractEngine = ENGINE;
let checks: ContractChecks = CHECKS;

/** The engine functions in use (tests substitute them with `configureContractEngine`). */
export function contractEngine(): ContractEngine {
  return engine;
}

export function contractChecks(): ContractChecks {
  return checks;
}

/** Replaces some engine functions and/or providers (tests, embedders); `null` restores the defaults. */
export function configureContractEngine(options: { readonly engine?: Partial<ContractEngine> | null; readonly checks?: Partial<ContractChecks> | null }): void {
  if (options.engine !== undefined) engine = options.engine === null ? ENGINE : { ...ENGINE, ...options.engine };
  if (options.checks !== undefined) checks = options.checks === null ? CHECKS : { ...CHECKS, ...options.checks };
}

/** Compares Solana program pins (same program list, same loader, program data, deploy slot, authority and data hash). */
export function compareSolanaPins(pinned: readonly SolanaProgramPin[], current: readonly SolanaProgramPin[]): string | null {
  for (const before of pinned) {
    const after = current.find((entry) => entry.program === before.program);
    if (!after) return `program ${before.program} could not be read`;
    for (const field of ["loader", "programData", "lastDeploySlot", "upgradeAuthority"] as const) {
      if ((before[field] ?? null) !== (after[field] ?? null)) return `program ${before.program} ${field} changed`;
    }
    if ((before.dataHash ?? null) !== (after.dataHash ?? null)) return `program ${before.program} data changed`;
  }
  return null;
}
