/**
 * Tab-scoped record of the intent a surface is executing, so a reload can
 * resume it. Wallet-free and tiny: marketing routes read it to decide whether
 * to load the execution panel at all.
 *
 * Besides the intent id it keeps what the wallet already produced for each
 * step. A resume submits stored references instead of asking the wallet to
 * sign again, and refuses to re-sign silently when a signature was requested
 * but its outcome is unknown.
 */
import {
  readSessionStorage,
  removeSessionStorage,
  writeSessionStorage,
} from "../state/safeStorage";

/**
 * Studio's resume key, also used by the console chat's "Plan here" card so an
 * intent started there can be resumed from Studio after a reload.
 */
export const STUDIO_INTENT_SESSION_KEY = "kletia-studio-intent";
/** Console Solana "Ask" tab (resumed inside the tab). */
export const SOLANA_ASK_INTENT_SESSION_KEY = "kletia-solana-ask-intent";

/** Older records are ignored: intents expire long before this. */
const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;
const INTENT_ID = /^[A-Za-z0-9_.:-]{1,200}$/u;
const STEP_ID = /^[A-Za-z0-9_.:-]{1,120}$/u;
const REFERENCE = /^[A-Za-z0-9]{16,128}$/u;

/** What the wallet did for a step: asked to sign, or declined (nothing was sent). */
export type StepSigningMark = "requested" | "rejected";

export interface IntentSession {
  readonly intentId: string;
  readonly savedAt: number;
  /** Signing attempts per step id whose outcome matters for a resume. */
  readonly signing: Readonly<Record<string, StepSigningMark>>;
  /** Hashes / signatures the wallet returned per step id, in order. */
  readonly references: Readonly<Record<string, readonly string[]>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitize(value: unknown): IntentSession | null {
  if (!isRecord(value) || value.v !== 1) return null;
  const { intentId, savedAt } = value;
  if (typeof intentId !== "string" || !INTENT_ID.test(intentId)) return null;
  if (typeof savedAt !== "number" || !Number.isFinite(savedAt)) return null;
  if (Date.now() - savedAt > MAX_SESSION_AGE_MS) return null;
  const signing: Record<string, StepSigningMark> = {};
  if (isRecord(value.signing)) {
    for (const [stepId, mark] of Object.entries(value.signing).slice(0, 32)) {
      if (STEP_ID.test(stepId) && (mark === "requested" || mark === "rejected")) signing[stepId] = mark;
    }
  }
  const references: Record<string, string[]> = {};
  if (isRecord(value.references)) {
    for (const [stepId, list] of Object.entries(value.references).slice(0, 32)) {
      if (!STEP_ID.test(stepId) || !Array.isArray(list)) continue;
      const clean = list.filter((item): item is string => typeof item === "string" && REFERENCE.test(item)).slice(0, 8);
      if (clean.length > 0) references[stepId] = clean;
    }
  }
  return { intentId, savedAt, signing, references };
}

export function readIntentSession(key: string = STUDIO_INTENT_SESSION_KEY): IntentSession | null {
  const raw = readSessionStorage(key);
  if (!raw) return null;
  try {
    return sanitize(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writeIntentSession(key: string, session: IntentSession): void {
  writeSessionStorage(key, JSON.stringify({ v: 1, ...session, savedAt: Date.now() }));
}

export function clearIntentSession(key: string = STUDIO_INTENT_SESSION_KEY): void {
  removeSessionStorage(key);
}

/** Read-modify-write for the record of `intentId` (a record for another intent is replaced). */
export function updateIntentSession(
  key: string,
  intentId: string,
  mutate: (session: IntentSession) => IntentSession,
): void {
  const current = readIntentSession(key);
  const base: IntentSession =
    current && current.intentId === intentId
      ? current
      : { intentId, savedAt: Date.now(), signing: {}, references: {} };
  writeIntentSession(key, mutate(base));
}

export function markStepSigning(key: string, intentId: string, stepId: string, mark: StepSigningMark): void {
  updateIntentSession(key, intentId, (session) => ({
    ...session,
    signing: { ...session.signing, [stepId]: mark },
  }));
}

export function appendStepReference(key: string, intentId: string, stepId: string, reference: string): void {
  if (!REFERENCE.test(reference)) return;
  updateIntentSession(key, intentId, (session) => ({
    ...session,
    references: { ...session.references, [stepId]: [...(session.references[stepId] ?? []), reference] },
  }));
}

/** Forget what was recorded for steps that the API has already accepted. */
export function forgetSteps(key: string, intentId: string, stepIds: readonly string[]): void {
  if (stepIds.length === 0) return;
  const current = readIntentSession(key);
  if (!current || current.intentId !== intentId) return;
  const drop = new Set(stepIds);
  const keep = <T,>(record: Readonly<Record<string, T>>) =>
    Object.fromEntries(Object.entries(record).filter(([stepId]) => !drop.has(stepId)));
  const signing = keep(current.signing);
  const references = keep(current.references);
  if (
    Object.keys(signing).length === Object.keys(current.signing).length &&
    Object.keys(references).length === Object.keys(current.references).length
  ) {
    return;
  }
  writeIntentSession(key, { ...current, signing, references });
}
