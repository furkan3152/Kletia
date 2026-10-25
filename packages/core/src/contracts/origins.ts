/**
 * Plain-text and web-origin checks and the domain file readers.
 */
import type { NetworkKey } from "../chains.js";
import {
  ASSETS,
  findAssetBySymbol,
  getAsset,
  type AssetDescriptor,
} from "../assets.js";

/* ============================================================ helpers (shared) */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// eslint-disable-next-line no-control-regex
export const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

export function isPlainText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value === value.trim() && value.length <= max && !CONTROL_CHARS.test(value);
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u;
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".test", ".invalid"];

function isPublicHostName(host: string): boolean {
  if (!host || host.startsWith("[") || IPV4.test(host) || !host.includes(".")) return false;
  if (host === "localhost" || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(host);
}

/**
 * Normalises a web origin (`https://Acme.example/` → `https://acme.example`).
 * HTTPS with a public DNS name (no credentials, path, query or fragment);
 * `allowPort` admits 443 and 1024-65535; `allowLocalhost` admits
 * `http://localhost[:port]` and `http://127.0.0.1[:port]` for development.
 * Returns null when refused. Static only: DNS resolution is checked by the API.
 */
export function normalizeWebOrigin(value: unknown, options: { readonly allowPort?: boolean; readonly allowLocalhost?: boolean } = {}): string | null {
  if (typeof value !== "string" || value.length > 256 || CONTROL_CHARS.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return null;
  if (value.includes("?") || value.includes("#") || value.includes("@")) return null;
  if (url.protocol === "http:" && options.allowLocalhost && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) {
    return url.origin;
  }
  if (url.protocol !== "https:" || !isPublicHostName(url.hostname)) return null;
  if (url.port) {
    const port = Number(url.port);
    if (!options.allowPort || !(port === 443 || (port >= 1024 && port <= 65_535))) return null;
  }
  return url.origin;
}

/** True when a `/.well-known/kletia.json` body lists `contractId`. */
export function domainFileListsContract(body: unknown, contractId: string): boolean {
  return isRecord(body) && Array.isArray(body.contracts) && body.contracts.some((entry) => entry === contractId);
}

/** True when a `/.well-known/kletia.json` body lists the project (`"projects": ["prj_…"]`). */
export function domainFileListsProject(body: unknown, projectId: string): boolean {
  return isRecord(body) && Array.isArray(body.projects) && body.projects.some((entry) => entry === projectId);
}

/**
 * True when a `/.well-known/kletia.json` body authorizes an intent link:
 * `"links": ["lk_…"]` lists it, or `"keys": ["key_…"]` lists its owner key
 * (every link of that key; key ids are public and stable across rotations).
 */
export function domainFileListsLink(body: unknown, linkId: string, keyId: string): boolean {
  if (!isRecord(body)) return false;
  const lists = (field: unknown, value: string) => Array.isArray(field) && field.some((entry) => entry === value);
  return lists(body.links, linkId) || lists(body.keys, keyId);
}

/** Resolves a registry asset for a definition: `native`, a symbol on `network`, or a CAIP-19 id on `network`. */
export function resolveContractAsset(network: NetworkKey, token: string): AssetDescriptor | null {
  if (typeof token !== "string" || !token.trim()) return null;
  if (token === "native") return ASSETS.find((asset) => asset.network === network && asset.address === null) ?? null;
  if (token.includes("/")) {
    const asset = getAsset(token);
    return asset && asset.network === network ? asset : null;
  }
  return findAssetBySymbol(network, token);
}
