export interface ReferenceSolverRoutePolicyInput {
  readonly id: string;
  readonly routeHash: string;
  readonly quoteEvidenceHash: string;
  readonly protocols: readonly string[];
}

const ALLOWED_ROUTE_IDS = new Set([
  "arc-arbitrum-direct-cctp",
  "arc-stellar-arbitrum-cctp",
]);

const ALLOWED_PROTOCOLS = new Set([
  "aave-v3-arbitrum-sepolia",
  "circle-cctp-v2",
  "stellar-intent-control-plane-v1",
  "stellar-policy-receipt-registry-v1",
]);

export function isReferenceSolverRouteEligible(
  route: ReferenceSolverRoutePolicyInput,
): boolean {
  return (
    ALLOWED_ROUTE_IDS.has(route.id) &&
    route.protocols.length > 0 &&
    route.protocols.every((protocol) => ALLOWED_PROTOCOLS.has(protocol)) &&
    /^0x[a-f\d]{64}$/iu.test(route.routeHash) &&
    /^0x[a-f\d]{64}$/iu.test(route.quoteEvidenceHash)
  );
}

export function referenceSolverNetworkCliArgs(input: {
  readonly rpcUrl: string;
  readonly networkPassphrase: string;
}): readonly string[] {
  const rpc = new URL(input.rpcUrl);
  if (rpc.protocol !== "https:" || !input.networkPassphrase.trim()) {
    throw new Error("The reference solver requires an exact HTTPS RPC and network passphrase.");
  }
  return [
    "--rpc-url",
    rpc.toString(),
    "--network-passphrase",
    input.networkPassphrase,
  ];
}
