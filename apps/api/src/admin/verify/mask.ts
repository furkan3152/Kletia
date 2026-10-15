/** Runtime code comparison that ignores immutable values (constructor-dependent bytes). */
import { keccak256, type Hex } from "viem";

export function maskImmutables(runtime: Hex, ranges: readonly { readonly start: number; readonly length: number }[]): Hex {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/u.test(runtime)) throw new Error("Runtime bytecode must be 0x-prefixed hex.");
  const bytes = Buffer.from(runtime.slice(2), "hex");
  for (const { start, length } of ranges) {
    if (start < 0 || length <= 0 || start + length > bytes.length) {
      // Code shorter than the artifact: cannot match; return a value no artifact hash equals.
      return "0x" as Hex;
    }
    bytes.fill(0, start, start + length);
  }
  return `0x${bytes.toString("hex")}` as Hex;
}

export function maskedRuntimeHash(runtime: Hex, ranges: readonly { readonly start: number; readonly length: number }[]): Hex {
  return keccak256(maskImmutables(runtime, ranges));
}
