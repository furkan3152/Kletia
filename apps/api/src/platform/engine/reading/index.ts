/**
 * Model-assisted reading (design A.7): the reading layer behind seam S2.
 *
 * Order for each unread clause: (consent, checked by the HTTP layer before a
 * hook exists) -> pre-filter and masking -> per-scope cache -> breaker and
 * limits -> one call per family (primary and cross-check; the hedge starts
 * only when a call fails outright) under a 3.5 s per-call cap and a 4.0 s
 * stage deadline -> strict parse -> every gate -> unanimous agreement over
 * the canonical Goal. Any failure, timeout, disagreement or outage is no
 * proposal: the deterministic refusal stands.
 *
 * Switch `KLETIA_MODEL_READING=off|eval|on` (default off). Models and their
 * parameter profiles come only from env (`KLETIA_READING_MODELS`,
 * `KLETIA_READING_PROFILES`); the layer refuses to turn on unless at least two
 * models of distinct vendors are configured, each with a pinned provider, and
 * OPENROUTER_API_KEY is set. Logs carry codes only, never the clause.
 */
import { createHash } from "node:crypto";
import type { Goal } from "@kletia/core";
import type { Question, ReadingHook, UnreadClause } from "../clarify/types.js";
import { lex, normalizeClause } from "../goal/lexer.js";
import { canonicalGoal, gateReading } from "./gates.js";
import { maskClause, type MaskedClause } from "./mask.js";
import { openRouterProvider } from "./openrouter.js";
import { ANSWER_VARIANTS, answerUser, READING_VARIANTS, readingUser, type PromptVariant } from "./prompt.js";
import { noopProvider, ReadingTransportError, type ReadingProfile, type ReadingProvider } from "./provider.js";
import { ANSWER_JSON_SCHEMA, parseAnswer, parseReading, READING_JSON_SCHEMA, READING_SCHEMA_VERSION } from "./schema.js";
import { EGRESS_WORDS } from "./egressWords.js";

export type ReadingSwitch = "off" | "eval" | "on";

export const READING_LIMITS = Object.freeze({
  callTimeoutMs: 3_500,
  stageDeadlineMs: 4_000,
  perSessionHour: 20,
  perProjectDay: 200,
  cacheEntries: 200,
  cacheTtlMs: 60 * 60 * 1_000,
  breakerWindowMs: 5 * 60 * 1_000,
  breakerErrorRate: 0.2,
  breakerMinCalls: 10,
  breakerOpenMs: 10 * 60 * 1_000,
});

/** Hash of everything a recording depends on besides the model, provider, variant and text. */
export const READING_CATALOG_HASH = `sha256:${createHash("sha256")
  .update(JSON.stringify([READING_SCHEMA_VERSION, READING_JSON_SCHEMA, ANSWER_JSON_SCHEMA, READING_VARIANTS, ANSWER_VARIANTS, [...EGRESS_WORDS]]))
  .digest("hex")}`;

/* ------------------------------------------------------------ config */

export interface ReadingConfig {
  readonly switch: ReadingSwitch;
  /** Primary, cross-check and optional hedge. */
  readonly profiles: readonly ReadingProfile[];
  /** Why the layer stays off, as a code (never a secret). */
  readonly offReason?: string;
}

function vendorOf(model: string): string {
  return model.split("/")[0] ?? "";
}

/** Distinct vendors (B5): the text before "/" differs for every configured model. */
export function distinctVendors(profiles: readonly ReadingProfile[]): boolean {
  const vendors = profiles.map((profile) => vendorOf(profile.model));
  return vendors.every((vendor) => vendor.length > 0) && new Set(vendors).size === vendors.length;
}

/** Reads the switch, models and profiles from env; falls back to off with a code when anything is missing. */
export function readingConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ReadingConfig {
  const raw = env.KLETIA_MODEL_READING?.trim().toLowerCase();
  const wanted: ReadingSwitch = raw === "on" || raw === "eval" ? raw : "off";
  if (wanted === "off") return { switch: "off", profiles: [] };
  const off = (offReason: string): ReadingConfig => ({ switch: "off", profiles: [], offReason });
  if (!env.OPENROUTER_API_KEY?.trim()) return off("key_missing");
  const models = (env.KLETIA_READING_MODELS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  if (models.length < 2 || models.length > 3) return off("models_count");
  let table: Record<string, unknown>;
  try {
    table = JSON.parse(env.KLETIA_READING_PROFILES ?? "{}") as Record<string, unknown>;
  } catch {
    return off("profiles_invalid");
  }
  const profiles: ReadingProfile[] = [];
  for (const model of models) {
    const entry = table[model] as { provider?: unknown; temperature?: unknown; seed?: unknown } | undefined;
    if (!entry || typeof entry.provider !== "string" || entry.provider.length === 0) return off("provider_unpinned");
    profiles.push({
      model,
      provider: entry.provider,
      ...(typeof entry.temperature === "number" ? { temperature: entry.temperature } : {}),
      ...(Number.isInteger(entry.seed) ? { seed: entry.seed as number } : {}),
    });
  }
  if (!distinctVendors(profiles)) return off("vendors_not_distinct");
  return { switch: wanted, profiles };
}

/* ------------------------------------------------------------ breaker, limits, cache */

export class Breaker {
  private events: { at: number; failed: boolean }[] = [];
  private openUntil = 0;
  constructor(private readonly now: () => number) {}
  open(): boolean {
    return this.now() < this.openUntil;
  }
  record(failed: boolean, status?: number): void {
    const at = this.now();
    if (status === 402 || status === 403) {
      this.openUntil = at + READING_LIMITS.breakerOpenMs;
      return;
    }
    this.events = this.events.filter((event) => at - event.at <= READING_LIMITS.breakerWindowMs);
    this.events.push({ at, failed });
    const failures = this.events.filter((event) => event.failed).length;
    if (this.events.length >= READING_LIMITS.breakerMinCalls && failures / this.events.length > READING_LIMITS.breakerErrorRate) {
      this.openUntil = at + READING_LIMITS.breakerOpenMs;
      this.events = [];
    }
  }
}

export class Limiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly now: () => number) {}
  take(key: string, limit: number, windowMs: number): boolean {
    const at = this.now();
    const list = (this.hits.get(key) ?? []).filter((time) => at - time < windowMs);
    if (list.length >= limit) {
      this.hits.set(key, list);
      return false;
    }
    list.push(at);
    this.hits.set(key, list);
    if (this.hits.size > 10_000) this.hits.delete(this.hits.keys().next().value as string);
    return true;
  }
}

/** Per scope only (B8): the key starts with the session or thread, so nothing is shared across people. */
class ReadingCache {
  private readonly entries = new Map<string, { at: number; goal: Goal | null }>();
  constructor(private readonly now: () => number) {}
  get(key: string): { goal: Goal | null } | undefined {
    const found = this.entries.get(key);
    if (!found) return undefined;
    if (this.now() - found.at > READING_LIMITS.cacheTtlMs) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, found);
    return { goal: found.goal };
  }
  set(key: string, goal: Goal | null): void {
    this.entries.set(key, { at: this.now(), goal });
    while (this.entries.size > READING_LIMITS.cacheEntries) this.entries.delete(this.entries.keys().next().value as string);
  }
}

/* ------------------------------------------------------------ metrics (codes only) */

export interface ReadingMetrics {
  calls: number;
  failures: number;
  proposals: number;
  rejected: Record<string, number>;
  cacheHits: number;
}

function emptyMetrics(): ReadingMetrics {
  return { calls: 0, failures: 0, proposals: 0, rejected: {}, cacheHits: 0 };
}

/* ------------------------------------------------------------ the layer */

export interface ReadingLayerOptions {
  readonly config: ReadingConfig;
  readonly provider: ReadingProvider;
  readonly now?: () => number;
  /** Rate limits per scope and project (the eval lifts them; production keeps READING_LIMITS). */
  readonly limits?: { readonly perSessionHour: number; readonly perProjectDay: number };
  /** Code-only log sink (default: console.warn with a "[reading]" prefix). */
  readonly log?: (code: string, detail?: Record<string, string | number>) => void;
}

export interface HookScope {
  /** Wallet session or thread: the cache and the hourly limit are per scope. */
  readonly scope: string;
  /** API key or project id for the daily limit. */
  readonly project?: string;
}

export class ReadingLayer {
  readonly metrics: ReadingMetrics = emptyMetrics();
  private readonly now: () => number;
  private readonly breaker: Breaker;
  private readonly limiter: Limiter;
  private readonly cache: ReadingCache;
  private readonly log: (code: string, detail?: Record<string, string | number>) => void;

  constructor(private readonly options: ReadingLayerOptions) {
    this.now = options.now ?? Date.now;
    this.breaker = new Breaker(this.now);
    this.limiter = new Limiter(this.now);
    this.cache = new ReadingCache(this.now);
    this.log = options.log ?? ((code, detail) => console.warn(`[reading] ${code}`, detail ?? {}));
  }

  get switch(): ReadingSwitch {
    return this.options.config.switch;
  }

  /** Families that took part in an agreed reading (for `interpretation.modelReading.families`). */
  get families(): number {
    return Math.min(2, this.options.config.profiles.length);
  }

  private reject(code: string): null {
    this.metrics.rejected[code] = (this.metrics.rejected[code] ?? 0) + 1;
    this.log(`reject:${code}`);
    return null;
  }

  /**
   * Runs the families for one masked input. Each started call must answer and
   * pass `accept`; the hedge (family 2) starts only when a call fails
   * outright, never for slowness. Returns the accepted values, or null.
   */
  private async families_<T>(purpose: "reading" | "answer", variants: readonly PromptVariant[], user: string, schema: object, accept: (text: string) => T | null): Promise<T[] | null> {
    const profiles = this.options.config.profiles;
    if (profiles.length < 2) return null;
    const deadline = AbortSignal.timeout(READING_LIMITS.stageDeadlineMs);
    const run = async (family: number): Promise<T | "failed" | "invalid"> => {
      const profile = profiles[family] as ReadingProfile;
      const signal = AbortSignal.any([deadline, AbortSignal.timeout(READING_LIMITS.callTimeoutMs)]);
      this.metrics.calls += 1;
      const started = this.now();
      try {
        const answer = await Promise.race([
          this.options.provider.call({ purpose, family, profile, variant: (variants[family] as PromptVariant).id, system: (variants[family] as PromptVariant).system, user, schema, signal }),
          new Promise<never>((_, reject) => {
            signal.addEventListener("abort", () => reject(new ReadingTransportError("timeout")), { once: true });
          }),
        ]);
        this.breaker.record(false);
        if (answer.servedProvider && answer.servedProvider.toLowerCase() !== profile.provider.toLowerCase()) {
          this.log("served_provider_changed", { family });
          return "invalid";
        }
        const value = accept(answer.text);
        this.log("call", { family, ms: this.now() - started, ok: value === null ? 0 : 1 });
        return value === null ? "invalid" : value;
      } catch (error) {
        const transport = error instanceof ReadingTransportError ? error : null;
        this.metrics.failures += 1;
        // A timeout is slowness, not an outright failure: no hedge, and no proposal.
        if (transport?.code === "timeout" || deadline.aborted) {
          this.log("timeout", { family });
          return "failed";
        }
        this.breaker.record(true, transport?.status);
        this.log(`call_failed:${transport?.code ?? "error"}`, { family });
        return "invalid";
      }
    };
    const first = await Promise.all([run(0), run(1)]);
    const out: T[] = [];
    let hedged = false;
    for (const value of first) {
      if (value === "failed") return null;
      if (value === "invalid") {
        if (hedged || profiles.length < 3 || deadline.aborted) return null;
        hedged = true;
        const hedge = await run(2);
        if (hedge === "failed" || hedge === "invalid") return null;
        out.push(hedge);
        continue;
      }
      out.push(value);
    }
    return out.length === 2 ? out : null;
  }

  private allowed(scope: HookScope): boolean {
    if (this.switch === "off" || this.breaker.open()) return false;
    const limits = this.options.limits ?? READING_LIMITS;
    if (!this.limiter.take(`s:${scope.scope}`, limits.perSessionHour, 60 * 60 * 1_000)) return false;
    if (scope.project && !this.limiter.take(`p:${scope.project}`, limits.perProjectDay, 24 * 60 * 60 * 1_000)) return false;
    return true;
  }

  /** One unread clause: the agreed, gated Goal, or null. */
  async readClause(clause: UnreadClause, scope: HookScope): Promise<Goal | null> {
    const masked = maskClause(clause);
    if (!masked.ok) return this.reject(`prefilter:${masked.code}`);
    const cacheKey = [scope.scope, masked.masked.hash, READING_CATALOG_HASH, ...this.options.config.profiles.map((profile) => `${profile.model}@${profile.provider}`)].join("|");
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.metrics.cacheHits += 1;
      return cached.goal;
    }
    if (!this.allowed(scope)) return this.reject("unavailable");
    const goals = await this.families_("reading", READING_VARIANTS, readingUser(masked.masked.text), READING_JSON_SCHEMA, (text) => this.gated(text, masked.masked));
    const agreed = goals && goals.every((goal) => canonicalGoal(goal) === canonicalGoal(goals[0] as Goal)) ? (goals[0] as Goal) : null;
    if (goals && !agreed) this.reject("disagreement");
    // Only an outcome the families actually produced is cached (never an outage).
    if (goals) this.cache.set(cacheKey, agreed);
    if (agreed) this.metrics.proposals += 1;
    return agreed;
  }

  private gated(text: string, masked: MaskedClause): Goal | null {
    const reading = parseReading(text, masked.tokens.length);
    if (!reading) return this.reject("schema");
    const outcome = gateReading(reading, masked);
    if (!outcome.ok) return this.reject(`gate:${outcome.code}`);
    return outcome.goal;
  }

  /**
   * T3: an answer that fits no option, mapped to one option id of the open
   * question by both families; the evidence must name a word of that option's
   * label. Shown as "Did you mean", never applied.
   */
  async mapAnswer(question: Question, text: string, scope: HookScope): Promise<string | null> {
    const masked = maskClause({ index: 0, text, closedClass: { questionMark: false, hits: [], lookalikes: [] } });
    if (!masked.ok && masked.code !== "no_verb") return this.reject(`prefilter:${masked.code}`);
    const tokens = masked.ok ? masked.masked.tokens : maskAnswerTokens(text);
    if (!tokens || tokens.length === 0 || tokens.length > 12 || /[@?]|:\/\//u.test(text)) return this.reject("prefilter:answer");
    const maskedText = tokens.map((entry) => `${entry.i}:${entry.sent}`).join(" ");
    const options = question.options.filter((option) => option.value.target !== "cancel").map((option) => ({ id: option.id, label: maskLabel(option.label) }));
    if (options.length === 0) return null;
    if (!this.allowed(scope)) return this.reject("unavailable");
    const ids = options.map((option) => option.id);
    const picks = await this.families_("answer", ANSWER_VARIANTS, answerUser(maskedText, options), ANSWER_JSON_SCHEMA, (out) => {
      const parsed = parseAnswer(out, ids, tokens.length);
      if (!parsed || parsed.option === null || !parsed.evidence) return null;
      const label = (question.options.find((option) => option.id === parsed.option)?.label ?? "").toLowerCase();
      const words = tokens.slice(parsed.evidence[0], parsed.evidence[1]).map((entry) => entry.sent).filter((word) => !word.startsWith("<"));
      const grounded = words.length > 0 && words.every((word) => new RegExp(`(^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}($|[^a-z0-9])`, "u").test(label));
      return grounded ? parsed.option : null;
    });
    if (!picks || picks[0] !== picks[1]) return null;
    return picks[0] as string;
  }

  /** The hook the decision layer calls (seam S2) for one request scope. */
  hookFor(scope: HookScope): ReadingHook {
    return {
      readClauses: async (clauses) => {
        const out = new Map<number, readonly Goal[]>();
        for (const clause of clauses) {
          const goal = await this.readClause(clause, scope);
          // Every unread clause must be read, or none is used (no partial message).
          if (!goal) return new Map();
          out.set(clause.index, [goal]);
        }
        return out;
      },
      crossCheck: async (clause, reading) => {
        // T2: further readings of an order-only clause; never removes the confirm, never changes a value.
        const goal = await this.readClause(clause, scope);
        if (!goal || reading.some((given) => canonicalGoal(given) === canonicalGoal(goal))) return [];
        return [[goal]];
      },
      mapAnswer: (question, text) => this.mapAnswer(question, text, scope),
    };
  }
}

/** Answer tokens when the answer has no verb ("the base one"): the same masking, verbs not required. */
function maskAnswerTokens(text: string): { i: number; sent: string }[] | null {
  const tokens = lex(normalizeClause(text));
  const out: { i: number; sent: string }[] = [];
  let unknown = 0;
  for (const token of tokens) {
    if (token.t === "ADDRESS" || token.t === "NAME" || token.t === "AMOUNT" || token.t === "VAGUE") return null;
    const raw = ("raw" in token && typeof token.raw === "string" ? token.raw : token.t === "CONN" ? token.word : "").toLowerCase();
    const known = token.t !== "NOISE" || EGRESS_WORDS.has(raw);
    const sent = known && /^[a-z0-9][a-z0-9.' -]{0,31}$/u.test(raw) ? raw : `<word_${(unknown += 1)}>`;
    out.push({ i: out.length, sent });
  }
  return unknown > 3 ? null : out;
}

/** An option label with every word that is not Kletia vocabulary masked (labels may name recipients). */
function maskLabel(label: string): string {
  return label
    .split(/\s+/u)
    .map((word) => {
      const lower = word.toLowerCase().replace(/[^a-z0-9.]/gu, "");
      const kind = lex(lower)[0]?.t;
      return kind && kind !== "NOISE" && kind !== "ADDRESS" && kind !== "NAME" ? lower : EGRESS_WORDS.has(lower) ? lower : "<word>";
    })
    .join(" ")
    .slice(0, 80);
}

/* ------------------------------------------------------------ process singleton */

let layer: ReadingLayer | null = null;

/** The process's reading layer (env config, live provider when on). */
export function readingLayer(): ReadingLayer {
  if (layer) return layer;
  const config = readingConfigFromEnv();
  if (config.offReason) console.warn(`[reading] off:${config.offReason}`);
  const key = process.env.OPENROUTER_API_KEY?.trim();
  layer = new ReadingLayer({ config, provider: config.switch !== "off" && key ? openRouterProvider(key) : noopProvider });
  return layer;
}

/** Tests: install a layer (or null to rebuild from env). */
export function configureReadingLayer(next: ReadingLayer | null): void {
  layer = next;
}
