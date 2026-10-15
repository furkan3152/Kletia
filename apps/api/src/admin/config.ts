/**
 * Admin panel configuration: the two wallet allowlists, the admin origins
 * and whether the panel is on at all. Fails closed:
 *
 * - KLETIA_ADMIN_ADDRESSES (EVM, comma separated) and
 *   KLETIA_ADMIN_SOLANA_ADDRESSES (Solana base58, comma separated). Either
 *   list alone enables the admin panel; both unset or empty disables it.
 * - Any invalid entry in either list disables the admin panel entirely.
 * - No address is hard-coded here: the Kletia owner's wallets are committed
 *   values in render.yaml, never a code fallback.
 * - In production without KLETIA_DATABASE_URL the panel is off: sessions and
 *   the audit log must survive restarts.
 */
import { getBase58Encoder } from "@solana/kit";
import { getAddress, isAddress } from "viem";
import { allowedOrigins } from "../shared/http/cors.js";

export type AdminDisabledReason = "no_allowlist" | "invalid_allowlist" | "store_missing";

export interface AdminConfig {
  readonly enabled: boolean;
  readonly disabledReason: AdminDisabledReason | null;
  /** Lower-cased EVM addresses. */
  readonly evmAddresses: ReadonlySet<string>;
  /** Base58 Solana addresses (case-sensitive). */
  readonly solanaAddresses: ReadonlySet<string>;
  /** Exact origins allowed to use the admin API (same-site with the API). */
  readonly origins: readonly string[];
  readonly production: boolean;
}

/** Registrable domain of the hosted site and API (`api.kletiaai.xyz`). */
export const ADMIN_SITE_DOMAIN = "kletiaai.xyz";

const PRODUCTION_DEFAULT_ORIGINS = ["https://kletiaai.xyz", "https://www.kletiaai.xyz"];
const DEVELOPMENT_DEFAULT_ORIGINS = ["http://localhost:5174", "http://127.0.0.1:5174", "http://localhost:5173", "http://127.0.0.1:5173"];

function splitList(value: string | undefined): string[] {
  return (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
}

/** A checksummed EVM address, or null. Mixed-case input must carry a valid EIP-55 checksum. */
export function parseEvmAddress(value: unknown): string | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/u.test(value)) return null;
  if (!isAddress(value, { strict: true })) return null;
  return getAddress(value);
}

/** A base58 Solana address that decodes to 32 bytes, or null. */
export function parseSolanaAddress(value: unknown): string | null {
  if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/u.test(value)) return null;
  try {
    return getBase58Encoder().encode(value).length === 32 ? value : null;
  } catch {
    return null;
  }
}

function isSameSiteOrigin(origin: string, production: boolean): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin !== origin) return false;
  if (url.protocol === "https:" && (url.hostname === ADMIN_SITE_DOMAIN || url.hostname.endsWith(`.${ADMIN_SITE_DOMAIN}`))) return true;
  return !production && url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

export function parseAdminOrigins(env: NodeJS.ProcessEnv, production: boolean, corsOrigins: readonly string[] = allowedOrigins): string[] {
  const configured = splitList(env.KLETIA_ADMIN_ORIGINS);
  const requested = configured.length > 0
    ? configured
    : [...PRODUCTION_DEFAULT_ORIGINS, ...(production ? [] : DEVELOPMENT_DEFAULT_ORIGINS)];
  const accepted: string[] = [];
  for (const origin of requested) {
    if (!corsOrigins.includes(origin) || !isSameSiteOrigin(origin, production)) {
      if (configured.length > 0) console.warn(`[admin] KLETIA_ADMIN_ORIGINS entry ${origin} is not an allowed same-site origin; ignored.`);
      continue;
    }
    if (!accepted.includes(origin)) accepted.push(origin);
  }
  return accepted;
}

export function parseAdminConfig(env: NodeJS.ProcessEnv = process.env, corsOrigins: readonly string[] = allowedOrigins): AdminConfig {
  const production = env.NODE_ENV === "production";
  const origins = parseAdminOrigins(env, production, corsOrigins);
  const evmEntries = splitList(env.KLETIA_ADMIN_ADDRESSES);
  const solanaEntries = splitList(env.KLETIA_ADMIN_SOLANA_ADDRESSES);
  const evmAddresses = new Set<string>();
  const solanaAddresses = new Set<string>();
  let invalid = false;
  for (const entry of evmEntries) {
    const address = parseEvmAddress(entry);
    if (address) evmAddresses.add(address.toLowerCase());
    else invalid = true;
  }
  for (const entry of solanaEntries) {
    const address = parseSolanaAddress(entry);
    if (address) solanaAddresses.add(address);
    else invalid = true;
  }
  const off = (disabledReason: AdminDisabledReason): AdminConfig => ({
    enabled: false, disabledReason, evmAddresses: new Set(), solanaAddresses: new Set(), origins, production,
  });
  if (invalid) {
    console.error("[admin] KLETIA_ADMIN_ADDRESSES or KLETIA_ADMIN_SOLANA_ADDRESSES has an invalid entry; admin is disabled.");
    return off("invalid_allowlist");
  }
  if (evmAddresses.size === 0 && solanaAddresses.size === 0) return off("no_allowlist");
  if (production && !env.KLETIA_DATABASE_URL?.trim()) {
    console.error("[admin] KLETIA_DATABASE_URL is not set; the admin panel is disabled in production.");
    return { ...off("store_missing"), evmAddresses, solanaAddresses };
  }
  return { enabled: true, disabledReason: null, evmAddresses, solanaAddresses, origins, production };
}

let current: AdminConfig | null = null;

/** The process configuration, parsed once on first use. */
export function adminConfig(): AdminConfig {
  current ??= parseAdminConfig();
  return current;
}

/** Checksummed EVM allowlist entries. */
export function evmAllowlist(config: AdminConfig): string[] {
  return [...config.evmAddresses].map((address) => getAddress(address));
}
