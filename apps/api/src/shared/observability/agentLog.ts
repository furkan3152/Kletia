import { NETWORKS, type NetworkId } from "../config/networks.js";

/**
 * One line of the legacy engines' progress log. The wallet is never written:
 * not in full, not shortened (a 6 + 4 character prefix and suffix is enough
 * to find most addresses on a block explorer). The request id and a fixed
 * message are enough to follow a request.
 *
 * `_userAddress` stays in the signature so the engines' call sites keep
 * their shape; it is deliberately unused.
 */
export function emitAgentLog(
  _userAddress: string,
  msgId: string,
  log: string,
  network: NetworkId = "base",
) {
  const chainId = NETWORKS[network].chainId;
  console.log(`[AGENT LOG][${network}:${chainId}] [${msgId}]: ${log}`);
}
