import { getAddress } from "viem";
import { NETWORKS, type NetworkId } from "../config/networks.js";

export function emitAgentLog(
  userAddress: string,
  msgId: string,
  log: string,
  network: NetworkId = "base",
) {
  const chainId = NETWORKS[network].chainId;
  const normalizedUser = getAddress(userAddress);
  console.log(
    `[AGENT LOG][${network}:${chainId}] ` +
      `${normalizedUser.slice(0, 6)}…${normalizedUser.slice(-4)} ` +
      `[${msgId}]: ${log}`,
  );
}

export function agentLogRoom(network: NetworkId, userAddress: string) {
  return `agent:${network}:${getAddress(userAddress).toLowerCase()}`;
}
