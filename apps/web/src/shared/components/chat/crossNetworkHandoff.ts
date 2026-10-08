/** Marker stored on chat messages that handed a Solana / cross-network prompt to the platform planner. */
export const CROSS_NETWORK_HANDOFF_WIDGET = "cross_network_handoff";

export const CROSS_NETWORK_HANDOFF_MESSAGE =
  "This prompt involves Solana, which this chat's EVM engines cannot execute. Kletia's platform planner can: plan it in Intent Studio or right here.";

export interface CrossNetworkHandoffData {
  /** The prompt as typed. Kept in memory only (chat history persists a redacted copy). */
  readonly prompt: string;
}

export function readHandoffData(value: unknown): CrossNetworkHandoffData | null {
  if (!value || typeof value !== "object") return null;
  const prompt = (value as { prompt?: unknown }).prompt;
  return typeof prompt === "string" && prompt.trim() ? { prompt: prompt.slice(0, 500) } : null;
}

export function studioHrefFor(prompt: string): string {
  return `/studio?q=${encodeURIComponent(prompt.trim().slice(0, 500))}`;
}
