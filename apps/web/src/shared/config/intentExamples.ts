import type { Address } from "viem";

export const ACTIVE_WALLET_ADDRESS = "{{ACTIVE_WALLET_ADDRESS}}";
const EDITABLE_RECIPIENT_SLOT = "{{RECIPIENT_ADDRESS}}";

export function requiresActiveWalletAddress(prompt: string): boolean {
  return prompt.includes(ACTIVE_WALLET_ADDRESS);
}

export function materializeIntentExample(
  prompt: string,
  address?: Address,
): string {
  if (!requiresActiveWalletAddress(prompt)) return prompt;
  return prompt
    .split(ACTIVE_WALLET_ADDRESS)
    .join(address ?? EDITABLE_RECIPIENT_SLOT);
}
