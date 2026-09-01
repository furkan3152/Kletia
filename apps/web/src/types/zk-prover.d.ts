declare module "circomlibjs" {
  export function buildPoseidon(): Promise<{
    (inputs: readonly bigint[]): unknown;
    readonly F: {
      readonly p: bigint;
      toObject(value: unknown): bigint;
    };
  }>;
}

declare module "snarkjs" {
  export const groth16: {
    fullProve(
      input: Readonly<Record<string, unknown>>,
      wasmFile: string,
      zkeyFile: string,
    ): Promise<{
      proof: {
        readonly pi_a: readonly string[];
        readonly pi_b: readonly (readonly string[])[];
        readonly pi_c: readonly string[];
        readonly protocol: "groth16";
        readonly curve: "bn128";
      };
      publicSignals: readonly string[];
    }>;
  };
}
