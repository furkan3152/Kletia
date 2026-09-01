import type {
  DevicePolicyProofEnvelopeV4,
  PolicyChallengeV4,
  SelectedPolicyWitnessV4,
} from "./types";

type WorkerResponse =
  | { readonly id: string; readonly success: true; readonly policyProof: DevicePolicyProofEnvelopeV4 }
  | { readonly id: string; readonly success: "progress"; readonly stage: string }
  | { readonly id: string; readonly success: false; readonly message: string };

export function generateDevicePolicyProofV4(input: {
  readonly challenge: PolicyChallengeV4;
  readonly amountAtomic: string;
  readonly witness: SelectedPolicyWitnessV4;
}, onProgress?: (stage: string) => void): Promise<DevicePolicyProofEnvelopeV4> {
  const worker = new Worker(new URL("./policyProof.worker.ts", import.meta.url), { type: "module" });
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      worker.terminate();
      reject(new Error("Device Policy V2 proof generation timed out."));
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
      reject(new Error(event.message || "The isolated Policy V2 worker failed."));
    });
    worker.postMessage({ id, ...input });
  });
}

