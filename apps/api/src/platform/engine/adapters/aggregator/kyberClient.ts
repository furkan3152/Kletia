/**
 * KyberSwap aggregator API client (https://docs.kyberswap.com, keyless):
 * `GET /{chain}/api/v1/routes` for the route summary and
 * `POST /{chain}/api/v1/route/build` for the router call. The API is
 * untrusted and only supplies numbers and calldata: every field the adapter
 * uses is validated here, and the adapter decodes the calldata itself
 * (`kyberCalldata.ts`) before anything reaches a wallet.
 *
 * KYBERSWAP_API_URL overrides the endpoint (tests); KYBERSWAP_CLIENT_ID is
 * sent as `x-client-id` (default "kletia").
 */
import { isBaseUnitAmount, isEvmAddress, type NetworkKey } from "@kletia/core";
import { PlatformError } from "../../../errors.js";
import { fetchProviderJson } from "../../http.js";
import { isRecord } from "../../util.js";

function readUrl(name: string, fallback: string): string {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute URL.`);
  }
  if (parsed.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && parsed.protocol === "http:")) {
    throw new Error(`${name} must use HTTPS in production.`);
  }
  return raw.replace(/\/+$/u, "");
}

export const KYBERSWAP_API_URL = readUrl("KYBERSWAP_API_URL", "https://aggregator-api.kyberswap.com");
const PROVIDER = "KyberSwap";

/** KyberSwap's chain slugs for the networks Kletia serves. */
const CHAIN_SLUG: Readonly<Partial<Record<NetworkKey, string>>> = Object.freeze({
  ethereum: "ethereum",
  base: "base",
  arbitrum: "arbitrum",
  optimism: "optimism",
  polygon: "polygon",
});

export function kyberChain(network: NetworkKey): string | null {
  return CHAIN_SLUG[network] ?? null;
}

function invalid(detail: string): PlatformError {
  return new PlatformError("PROVIDER_TRANSACTION_INVALID", `KyberSwap returned a route Kletia refuses (${detail}).`, 502);
}

function headers(): Record<string, string> {
  return { "x-client-id": process.env.KYBERSWAP_CLIENT_ID?.trim() || "kletia" };
}

export interface KyberRouteRequest {
  readonly network: NetworkKey;
  /** Token addresses as KyberSwap names them (native: 0xEeee...). */
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountIn: string;
}

export interface KyberRoute {
  /** The opaque summary the build call needs back unchanged. */
  readonly routeSummary: Record<string, unknown>;
  readonly amountOut: string;
  readonly routerAddress: string;
}

export interface KyberBuild {
  readonly amountIn: string;
  readonly amountOut: string;
  readonly routerAddress: string;
  readonly data: string;
  readonly gas: string | null;
}

/** `GET /{chain}/api/v1/routes`: the best route for an exact input. */
export async function fetchKyberRoute(request: KyberRouteRequest): Promise<KyberRoute> {
  const chain = kyberChain(request.network);
  if (!chain) throw new PlatformError("NETWORK_UNSUPPORTED", "KyberSwap does not serve this network here.", 422);
  const query = new URLSearchParams({ tokenIn: request.tokenIn, tokenOut: request.tokenOut, amountIn: request.amountIn, gasInclude: "true" });
  const body = await fetchProviderJson(`${KYBERSWAP_API_URL}/${chain}/api/v1/routes?${query.toString()}`, { provider: PROVIDER, headers: headers() });
  const data = isRecord(body) && isRecord(body.data) ? body.data : null;
  const summary = data && isRecord(data.routeSummary) ? data.routeSummary : null;
  if (!summary) throw new PlatformError("ROUTE_UNAVAILABLE", "KyberSwap has no route for this swap right now.", 422);
  if (typeof summary.tokenIn !== "string" || summary.tokenIn.toLowerCase() !== request.tokenIn.toLowerCase()) throw invalid("tokenIn");
  if (typeof summary.tokenOut !== "string" || summary.tokenOut.toLowerCase() !== request.tokenOut.toLowerCase()) throw invalid("tokenOut");
  if (summary.amountIn !== request.amountIn) throw invalid("amountIn");
  if (!isBaseUnitAmount(summary.amountOut) || summary.amountOut === "0") throw invalid("amountOut");
  if (typeof data?.routerAddress !== "string" || !isEvmAddress(data.routerAddress)) throw invalid("routerAddress");
  return { routeSummary: summary, amountOut: summary.amountOut, routerAddress: data.routerAddress };
}

/** `POST /{chain}/api/v1/route/build`: the router call for `route`, paying `recipient`. */
export async function buildKyberRoute(
  network: NetworkKey,
  route: KyberRoute,
  sender: string,
  recipient: string,
  slippageBps: number,
): Promise<KyberBuild> {
  const chain = kyberChain(network);
  if (!chain) throw new PlatformError("NETWORK_UNSUPPORTED", "KyberSwap does not serve this network here.", 422);
  const body = await fetchProviderJson(`${KYBERSWAP_API_URL}/${chain}/api/v1/route/build`, {
    provider: PROVIDER,
    method: "POST",
    headers: headers(),
    body: { routeSummary: route.routeSummary, sender, recipient, slippageTolerance: slippageBps, enableGasEstimation: false, source: headers()["x-client-id"] },
  });
  const data = isRecord(body) && isRecord(body.data) ? body.data : null;
  if (!data) throw invalid("no build data");
  if (!isBaseUnitAmount(data.amountIn) || !isBaseUnitAmount(data.amountOut) || data.amountOut === "0") throw invalid("amounts");
  if (typeof data.routerAddress !== "string" || !isEvmAddress(data.routerAddress)) throw invalid("routerAddress");
  if (typeof data.data !== "string" || !/^0x(?:[0-9a-fA-F]{2}){4,}$/u.test(data.data) || data.data.length > 60_000) throw invalid("data");
  const gas = typeof data.gas === "string" && /^\d{1,12}$/u.test(data.gas) ? data.gas : null;
  return { amountIn: data.amountIn, amountOut: data.amountOut, routerAddress: data.routerAddress, data: data.data, gas };
}
