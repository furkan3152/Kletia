/**
 * The reading provider interface (design A.7.8): one call sends one masked
 * clause (or one masked answer) to one model family and returns its text.
 * Four implementations: `noopProvider` (the default: never answers),
 * `scriptedProvider` (tests), `replayProvider` (recordings, the CI default)
 * and `openRouterProvider` (live).
 */
export interface ReadingProfile {
  /** Model id as configured in KLETIA_READING_MODELS (never hardcoded). */
  readonly model: string;
  /** The serving provider this profile pins (`provider.only`, no fallbacks). */
  readonly provider: string;
  readonly temperature?: number;
  readonly seed?: number;
}

export interface ReadingCall {
  readonly purpose: "reading" | "answer";
  /** 0 primary, 1 cross-check, 2 hedge. */
  readonly family: number;
  readonly profile: ReadingProfile;
  /** Prompt variant id (part of every recording key). */
  readonly variant: string;
  readonly system: string;
  readonly user: string;
  readonly schema: object;
  readonly signal: AbortSignal;
}

export interface ReadingAnswer {
  readonly text: string;
  /** The provider that served the call, when the transport reports it. */
  readonly servedProvider?: string;
}

export interface ReadingProvider {
  readonly kind: "noop" | "scripted" | "replay" | "openrouter";
  call(call: ReadingCall): Promise<ReadingAnswer>;
}

/** A transport failure the breaker counts; `status` is the HTTP status when there was one. */
export class ReadingTransportError extends Error {
  constructor(readonly code: string, readonly status?: number) {
    super(code);
  }
}

export const noopProvider: ReadingProvider = Object.freeze({
  kind: "noop" as const,
  call(): Promise<ReadingAnswer> {
    return Promise.reject(new ReadingTransportError("noop"));
  },
});
