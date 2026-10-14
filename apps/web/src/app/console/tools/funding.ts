/**
 * How the desk helps a wallet get money onto a network (console design 6.1,
 * moved from the old console shell): the Coinbase onramp on Base, Circle's
 * faucet on Arc Testnet, and a bridge sentence everywhere else. Offered by
 * the Funding tools and by Holdings' "Fund".
 *
 * Nothing here signs or moves funds: the onramp only asks the Kletia API for
 * a Coinbase session token for the connected address and opens Coinbase's own
 * page; a bridge only puts a sentence in the composer. Pure apart from the
 * injected `fetch` (node --test loads it).
 */
import { isEvmAddress, type NetworkKey } from "@kletia/core";

/** Circle's public faucet for test USDC (Arc Testnet). */
export const ARC_FAUCET_URL = "https://faucet.circle.com";
/** Kletia's Coinbase Developer Platform app id (public; the session token is what authorizes). */
export const COINBASE_ONRAMP_APP_ID = "82ee9f72-74ba-4279-bf89-5f212261ce85";
const COINBASE_ONRAMP_ORIGIN = "https://pay.coinbase.com";
const BASE_CHAIN_ID = 8453;
/** Coinbase session tokens are opaque URL-safe strings; anything else is refused. */
const SESSION_TOKEN = /^[A-Za-z0-9._~-]{8,2048}$/u;

export type FundingOption =
  | { readonly kind: "onramp"; readonly network: "base" }
  | { readonly kind: "faucet"; readonly network: "arc"; readonly url: string }
  | { readonly kind: "bridge"; readonly network: NetworkKey };

/** The way to fund a network: onramp on Base, faucet on Arc, a bridge in elsewhere. */
export function fundingFor(network: NetworkKey): FundingOption {
  if (network === "base") return { kind: "onramp", network };
  if (network === "arc") return { kind: "faucet", network, url: ARC_FAUCET_URL };
  return { kind: "bridge", network };
}

/** Coinbase's buy page for one Base address and a session token, USDC preselected. */
export function coinbaseOnrampUrl(sessionToken: string, address: string): string {
  if (!SESSION_TOKEN.test(sessionToken)) throw new Error("The funding service returned an invalid session token.");
  if (!isEvmAddress(address)) throw new Error("The onramp needs an EVM address.");
  const params = new URLSearchParams({
    appId: COINBASE_ONRAMP_APP_ID,
    sessionToken,
    addresses: JSON.stringify({ [address]: ["base"] }),
    defaultAsset: "USDC",
  });
  return `${COINBASE_ONRAMP_ORIGIN}/buy/select-asset?${params.toString()}`;
}

export type OnrampResult = { readonly ok: true; readonly url: string } | { readonly ok: false; readonly reason: string };

const UNAVAILABLE = "The funding service is unavailable right now. Try again later.";

/**
 * Asks the Kletia API (`POST /api/onramp-token`, Base headers) for a Coinbase
 * session token and returns the page to open. Fails closed: any unexpected
 * answer is an error, never a half-built URL.
 */
export async function requestCoinbaseOnramp(
  address: string,
  { backendUrl, fetchImpl = fetch, signal }: { readonly backendUrl: string; readonly fetchImpl?: typeof fetch; readonly signal?: AbortSignal },
): Promise<OnrampResult> {
  if (!isEvmAddress(address)) return { ok: false, reason: "Connect an EVM wallet first: Coinbase funds that address on Base." };
  try {
    const response = await fetchImpl(`${backendUrl}/api/onramp-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Kletia-Network": "base", "X-Kletia-Chain-Id": String(BASE_CHAIN_ID) },
      body: JSON.stringify({ address }),
      signal,
    });
    const data: unknown = await response.json().catch(() => null);
    const token = data && typeof data === "object" ? (data as Record<string, unknown>).token : undefined;
    const status = data && typeof data === "object" ? (data as Record<string, unknown>).status : undefined;
    if (!response.ok || status !== "success" || typeof token !== "string" || !SESSION_TOKEN.test(token)) {
      return { ok: false, reason: UNAVAILABLE };
    }
    return { ok: true, url: coinbaseOnrampUrl(token, address) };
  } catch {
    return { ok: false, reason: UNAVAILABLE };
  }
}
