export type DevicePolicyProofEnvelopeV3 = {
  readonly schemaVersion: "kletia_policy_proof_envelope_v1";
  readonly routeId: string;
  readonly workflowRoot: `0x${string}`;
  readonly policyRoot: `0x${string}`;
  readonly protocolRegistryRoot: `0x${string}`;
  readonly assetRegistryRoot: `0x${string}`;
  readonly recipientPolicyRoot: `0x${string}`;
  readonly executionExpiresAtLedger: number;
  readonly nullifier: `0x${string}`;
  readonly executionContextCommitment: `0x${string}`;
  readonly verifierVersion: 1;
  readonly proof: `0x${string}`;
};

type WorkerResponse =
  | { readonly id: string; readonly success: true; readonly policyProof: DevicePolicyProofEnvelopeV3 }
  | { readonly id: string; readonly success: "progress"; readonly stage: string }
  | { readonly id: string; readonly success: false; readonly message: string };

export async function readStellarTestnetLatestLedger(): Promise<number> {
  const response = await fetch("https://soroban-testnet.stellar.org", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "getLatestLedger" }),
  });
  const body = await response.json() as { result?: { sequence?: unknown }; error?: unknown };
  const sequence = Number(body.result?.sequence);
  if (!response.ok || body.error || !Number.isSafeInteger(sequence) || sequence <= 0) {
    throw new Error("The current Stellar Testnet ledger could not be observed for policy expiry.");
  }
  return sequence;
}

export function generateDevicePolicyProofV3(input: {
  readonly workflowRoot: `0x${string}`;
  readonly routeId: string;
  readonly solverRouteHash: `0x${string}`;
  readonly amountAtomic: string;
  readonly recipient: string;
  readonly executionExpiresAtLedger: number;
}, onProgress?: (stage: string) => void): Promise<DevicePolicyProofEnvelopeV3> {
  const worker = new Worker(new URL("./policyProof.worker.ts", import.meta.url), { type: "module" });
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      worker.terminate();
      reject(new Error("Device policy proof generation timed out."));
    }, 300_000);
    worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
      if (event.data.id !== id) return;
      if (event.data.success === "progress") {
        onProgress?.(event.data.stage);
        return;
      }
      window.clearTimeout(timeout);
      worker.terminate();
      if (event.data.success) resolve(event.data.policyProof);
      else reject(new Error(event.data.message));
    });
    worker.addEventListener("error", (event) => {
      window.clearTimeout(timeout);
      worker.terminate();
      reject(new Error(
        event.message
          ? `The isolated policy-proof worker failed: ${event.message}`
          : "The isolated policy-proof worker failed.",
      ));
    });
    worker.postMessage({ id, ...input });
  });
}
