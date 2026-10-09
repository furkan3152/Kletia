/**
 * Intent states a rubber stamp can print, and how each state is said in
 * words. Tickets repeat the state in text, so the stamp itself can stay
 * decorative. Dependency-free so `node --test` can load it directly.
 */

export const STAMP_STATES = ["planned", "signed", "settled", "held", "failed"] as const;

export type StampState = (typeof STAMP_STATES)[number];

/** Short accessible name for a stamp (used when a stamp is labelled). */
export const STAMP_LABELS: Readonly<Record<StampState, string>> = {
  planned: "Planned, nothing signed",
  signed: "Signed in the wallet",
  settled: "Settled, evidence seen on-chain",
  held: "Held, recover by transaction hash",
  failed: "Failed, not settled",
};

/** One sentence per state, printed (visually hidden) on tickets next to the stamp. */
export const STAMP_SENTENCES: Readonly<Record<StampState, string>> = {
  planned: "Planned. Nothing has been signed.",
  signed: "Signed in the user's wallet. Waiting for on-chain evidence.",
  settled: "Settled. Every leg was seen on-chain.",
  held: "Held. The outcome is unknown and will be recovered by transaction hash.",
  failed: "Failed. The route stopped before every leg settled.",
};
