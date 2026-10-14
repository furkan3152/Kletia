/**
 * Query parameters and document mode for the embeddable `/embed` page.
 * Dependency-free so the entry can apply the theme before the first paint.
 *
 * Accepted parameters (everything else is ignored):
 * - `theme=light|dark|auto` (default `auto`)
 * - `text=<default intent>` (max 500 characters)
 * - `examples=<comma separated>` (max 6, 120 characters each)
 * - `bg=transparent` (no page background, for hosts that draw their own)
 * - appearance tokens (`accent`, `surface`, `radius`, …), read with
 *   `appearanceFromParams` of `@kletia/core` by the page
 * - `networks`, `actions` and `source` (the widget's scope), read with
 *   `readEmbedScope` against the network registry the page passes in
 *
 * The host bridge parameters (`bridge`, `origin`, `ref`) are read by
 * `readBridgeParams` in `embedBridge.ts`, outside the entry bundle.
 *
 * Integrator-created work arrives in the URL fragment, which browsers never
 * send to servers (access logs, referrers): `#intent=int_…` opens an intent
 * the integrator's backend created with its key, `#session=cs_…` runs a
 * session (`readEmbedFragment`). Only those two exact shapes are accepted.
 *
 * A project's publishable key (`#key=kl_pub_…`, optionally `&flow=<id>`)
 * also arrives in the fragment (`readEmbedKey`): it is browser-safe by design
 * (public tier plus the project's stored flows, on the origins the project
 * allows). A secret API key is never read from the URL, so one cannot leak
 * through referrers, logs or browser history. Everything a URL can set is
 * cosmetic: the brand comes only from the verified project profile
 * (`profileView`), never from parameters.
 */

export type EmbedTheme = "light" | "dark" | "auto";

export interface EmbedParams {
  readonly theme: EmbedTheme;
  readonly text: string;
  /** `null` when the host did not pass examples (the widget defaults apply). */
  readonly examples: readonly string[] | null;
  readonly transparent: boolean;
}

/** Integrator-created work named in the fragment. */
export type EmbedTarget = { readonly kind: "intent"; readonly id: string } | { readonly kind: "session"; readonly id: string };

const INTENT_FRAGMENT_ID = /^int_[0-9a-f]{32}$/u;
const SESSION_FRAGMENT_ID = /^cs_[0-9a-f]{32}$/u;

/**
 * Reads `#intent=int_…` or `#session=cs_…` (the intent wins when both are
 * present, as `@kletia/embed` does). Anything else, including extra
 * characters around an id, is ignored: the frame then plans from text.
 */
export function readEmbedFragment(hash: string): EmbedTarget | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw || raw.length > 200) return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return null;
  }
  const intent = params.getAll("intent");
  if (intent.length === 1 && INTENT_FRAGMENT_ID.test(intent[0] ?? "")) return { kind: "intent", id: intent[0] as string };
  const session = params.getAll("session");
  if (session.length === 1 && SESSION_FRAGMENT_ID.test(session[0] ?? "")) return { kind: "session", id: session[0] as string };
  return null;
}

/** A publishable key and the stored flow to run with it, from `#key=kl_pub_…&flow=…`. */
export interface EmbedKeyTarget {
  readonly key: string;
  readonly flow: string | null;
}

const PUBLISHABLE_KEY = /^kl_pub_[0-9A-Za-z]{32}$/u;
const FLOW_ID = /^[a-z][a-z0-9-]{0,31}$/u;

/**
 * Reads `#key=kl_pub_…` and an optional `&flow=<id>` (both exactly once and
 * of their exact shapes). Nothing else is accepted: a secret key, a key of
 * another shape or a malformed flow gives `null` (a bad flow drops the whole
 * target, so the frame never runs text mode for a host that asked for a flow).
 */
export function readEmbedKey(hash: string): EmbedKeyTarget | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw || raw.length > 200) return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return null;
  }
  const keys = params.getAll("key");
  if (keys.length !== 1 || !PUBLISHABLE_KEY.test(keys[0] ?? "")) return null;
  const flows = params.getAll("flow");
  if (flows.length > 1 || (flows.length === 1 && !FLOW_ID.test(flows[0] ?? ""))) return null;
  return { key: keys[0] as string, flow: flows[0] ?? null };
}

export const EMBED_MAX_TEXT = 500;
export const EMBED_MAX_EXAMPLES = 6;
export const EMBED_MAX_EXAMPLE_LENGTH = 120;

const EMBED_CLASS = "kletia-embed";
const TRANSPARENT_CLASS = "kletia-embed-transparent";

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]+/gu;

function clean(value: string, max: number): string {
  return value.replace(CONTROL_CHARACTERS, " ").replace(/\s{2,}/gu, " ").trim().slice(0, max);
}

export function readEmbedParams(search: string): EmbedParams {
  let query: URLSearchParams;
  try {
    query = new URLSearchParams(search);
  } catch {
    query = new URLSearchParams();
  }
  const rawTheme = query.get("theme");
  const theme: EmbedTheme = rawTheme === "light" || rawTheme === "dark" ? rawTheme : "auto";
  const text = clean(query.get("text") ?? "", EMBED_MAX_TEXT);
  const rawExamples = query.get("examples");
  let examples: string[] | null = null;
  if (rawExamples !== null) {
    const seen = new Set<string>();
    examples = [];
    for (const part of rawExamples.split(",")) {
      const example = clean(part, EMBED_MAX_EXAMPLE_LENGTH);
      if (!example || seen.has(example.toLowerCase())) continue;
      seen.add(example.toLowerCase());
      examples.push(example);
      if (examples.length >= EMBED_MAX_EXAMPLES) break;
    }
    if (examples.length === 0) examples = null;
  }
  return { theme, text, examples, transparent: query.get("bg") === "transparent" };
}

/*
 * Hosts often send the bridge's connect message on the frame's `load` event,
 * which can fire before the lazily loaded embed page starts its bridge. On
 * `/embed?bridge=1` inside a frame, this entry module keeps such messages
 * (at most 8) for the bridge to judge with its usual rules; nothing is
 * answered here. See `embedBridge.ts`.
 */
const MAX_EARLY_CONNECTS = 8;
const earlyConnects: MessageEvent[] = [];

function keepEarlyConnect(event: MessageEvent): void {
  const data: unknown = event.data;
  if (
    typeof data === "object" &&
    data !== null &&
    (data as { kletia?: unknown }).kletia === "connect" &&
    earlyConnects.length < MAX_EARLY_CONNECTS
  ) {
    earlyConnects.push(event);
  }
}

function isFramedBridgeEmbed(): boolean {
  try {
    return (
      window.parent !== window &&
      /^\/embed\/?$/u.test(window.location.pathname) &&
      new URLSearchParams(window.location.search).get("bridge") === "1"
    );
  } catch {
    return false;
  }
}

const canListen = typeof window !== "undefined" && typeof window.addEventListener === "function";
if (canListen && isFramedBridgeEmbed()) window.addEventListener("message", keepEarlyConnect);

/** Hands the connect messages kept so far to the bridge, once, and stops keeping them. */
export function takeEarlyConnects(): MessageEvent[] {
  if (canListen) window.removeEventListener("message", keepEarlyConnect);
  return earlyConnects.splice(0);
}

export function systemPrefersDark(): boolean {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

export function resolveEmbedTheme(theme: EmbedTheme): "light" | "dark" {
  if (theme === "auto") return systemPrefersDark() ? "dark" : "light";
  return theme;
}

/**
 * Document mode for the embed: normal document scrolling, the resolved theme
 * and, with `bg=transparent`, no page background. A transparent frame keeps a
 * light colour scheme unless the host asked for `theme=dark`, so browsers do
 * not paint an opaque backdrop behind it on light host pages.
 */
export function applyEmbedDocumentMode(params: Pick<EmbedParams, "theme" | "transparent">): void {
  const root = document.documentElement;
  const resolved = resolveEmbedTheme(params.theme);
  root.classList.add(EMBED_CLASS);
  root.classList.toggle("dark", resolved === "dark");
  root.classList.toggle(TRANSPARENT_CLASS, params.transparent);
  root.style.colorScheme = params.transparent ? (params.theme === "dark" ? "dark" : "light") : resolved;
}

export function leaveEmbedDocumentMode(): void {
  const root = document.documentElement;
  root.classList.remove(EMBED_CLASS, TRANSPARENT_CLASS);
  root.style.colorScheme = "";
}

/** Calls `onChange` when the OS colour scheme changes. Returns an unsubscribe function. */
export function watchSystemTheme(onChange: () => void): () => void {
  let media: MediaQueryList;
  try {
    media = window.matchMedia("(prefers-color-scheme: dark)");
  } catch {
    return () => undefined;
  }
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

// ---------------------------------------------------------------------------
// Scope: networks, actions and the starting network
// ---------------------------------------------------------------------------

export type EmbedVm = "evm" | "svm";

/** What the scope parser needs of a network (`CHAINS` of `@kletia/core`, passed in to keep this module dependency-free). */
export interface EmbedChainInfo {
  readonly environment: string;
  readonly vm: EmbedVm;
}

export const EMBED_ACTIONS: readonly string[] = ["swap", "bridge", "transfer", "stake", "deposit", "withdraw"];
export const EMBED_MAX_NETWORKS = 9;

export interface EmbedScope {
  /** Network keys of one capital lane, or `null` (any network). */
  readonly networks: readonly string[] | null;
  /** Kinds of action, or `null` (any kind). */
  readonly actions: readonly string[] | null;
  /** `auto` or a network key inside `networks`, or `null`. */
  readonly source: string | null;
}

/**
 * Reads `networks`, `actions` and `source`. Networks must be registry keys
 * of one capital lane (the first valid key's; mainnet and testnet never mix);
 * `source` must be `auto` or a registry key of that lane and, when
 * `networks` is set, one of them. Anything else is dropped.
 */
export function readEmbedScope(search: string, chains: Readonly<Record<string, EmbedChainInfo>>): EmbedScope {
  let query: URLSearchParams;
  try {
    query = new URLSearchParams(search);
  } catch {
    query = new URLSearchParams();
  }
  const known = (key: string) => Object.prototype.hasOwnProperty.call(chains, key);
  const networks: string[] = [];
  for (const raw of (query.get("networks") ?? "").split(",")) {
    const key = raw.trim().toLowerCase();
    if (!known(key) || networks.includes(key)) continue;
    if (networks.length > 0 && chains[key]?.environment !== chains[networks[0] as string]?.environment) continue;
    networks.push(key);
    if (networks.length >= EMBED_MAX_NETWORKS) break;
  }
  const actions: string[] = [];
  for (const raw of (query.get("actions") ?? "").split(",")) {
    const action = raw.trim().toLowerCase();
    if (EMBED_ACTIONS.includes(action) && !actions.includes(action)) actions.push(action);
  }
  const rawSource = (query.get("source") ?? "").trim().toLowerCase();
  const source =
    rawSource === "auto"
      ? "auto"
      : known(rawSource) && (networks.length === 0 || networks.includes(rawSource))
        ? rawSource
        : null;
  return { networks: networks.length > 0 ? networks : null, actions: actions.length > 0 ? actions : null, source };
}

/**
 * The wallets the frame offers: the virtual machines of the scope's
 * networks, of a session's actions (`network`, `toNetwork`) and of an
 * integrator intent's steps. With none of them known (text mode without
 * `networks`), both.
 */
export function embedWalletVms(
  sources: { readonly networks?: readonly string[] | null; readonly session?: readonly string[] | null; readonly intent?: readonly string[] | null },
  chains: Readonly<Record<string, EmbedChainInfo>>,
): ReadonlySet<EmbedVm> {
  const keys = [...(sources.networks ?? []), ...(sources.session ?? []), ...(sources.intent ?? [])];
  const vms = new Set<EmbedVm>();
  for (const key of keys) {
    const vm = Object.prototype.hasOwnProperty.call(chains, key) ? chains[key]?.vm : undefined;
    if (vm) vms.add(vm);
  }
  return vms.size > 0 ? vms : new Set<EmbedVm>(["evm", "svm"]);
}

/** True when `/embed` is shown inside a frame; opened directly, the page explains what it is (S-21). */
export function isFramed(): boolean {
  try {
    return window.parent !== window;
  } catch {
    return true;
  }
}

/** Connect buttons of the wallet bar (the static bar before the runtime loads uses the same box). */
export const EMBED_PILL_CLASS =
  "flex min-h-11 min-w-0 items-center gap-2 border-[3px] border-[#1A1A1A] px-2.5 py-2 text-[11px] font-black uppercase tracking-wider shadow-[3px_3px_0_#1A1A1A] transition-[transform,box-shadow,background-color] duration-100 ease-out hover:-translate-y-0.5 hover:shadow-[4px_4px_0_#1A1A1A] focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 active:translate-y-0.5 active:shadow-none motion-reduce:transition-none dark:border-[#4B5563] dark:shadow-[3px_3px_0_#475569] sm:px-3 sm:text-xs";

// ---------------------------------------------------------------------------
// Phase 2: the project profile a publishable key reveals
// ---------------------------------------------------------------------------

/** The parts of `ProjectProfile` (`@kletia/core`) the frame reads; anything else in the response is ignored. */
export interface EmbedProfileInput {
  readonly projectId?: unknown;
  readonly brand?: unknown;
  readonly allowedOrigins?: unknown;
  readonly lane?: unknown;
  readonly defaults?: unknown;
  readonly flows?: unknown;
}

export interface EmbedBrand {
  readonly name: string;
  /** The verified website host, shown next to the name. */
  readonly host: string | null;
  /** Path of the logo on the API origin (`/v1/projects/<id>/logo/<sha256>.<png|webp>`), when the profile names one. */
  readonly logoPath: string | null;
}

export interface EmbedProfileDefaults {
  readonly networks: readonly string[] | null;
  readonly actions: readonly string[] | null;
  readonly sourceNetwork: string | null;
  readonly examples: readonly string[] | null;
  /** Unvalidated: the page runs it through `validateAppearance` before use. */
  readonly appearance: unknown;
}

export type EmbedProfileView =
  | { readonly ok: false; readonly code: "PUBLISHABLE_ORIGIN_FORBIDDEN"; readonly host: string }
  | { readonly ok: false; readonly code: "FLOW_UNKNOWN" }
  | { readonly ok: false; readonly code: "INVALID_RESPONSE" }
  | {
      readonly ok: true;
      readonly projectId: string;
      /** Only for a verified domain; never from URL parameters. */
      readonly brand: EmbedBrand | null;
      readonly testnet: boolean;
      readonly defaults: EmbedProfileDefaults;
      /** The stored flow to run, when the fragment named one (checked to exist). */
      readonly flow: string | null;
    };

const PROJECT_ID = /^prj_[A-Za-z0-9_-]{1,80}$/u;
const LOGO_PATH = /^\/v1\/projects\/(prj_[A-Za-z0-9_-]{1,80})\/logo\/[0-9a-f]{64}\.(?:png|webp)$/u;
const LOGO_SHA = /^[0-9a-f]{64}$/u;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);

function stringList(value: unknown, pattern: RegExp, max: number): string[] | null {
  if (!Array.isArray(value)) return null;
  const items = [...new Set(value.filter((item): item is string => typeof item === "string" && pattern.test(item)))].slice(0, max);
  return items.length > 0 ? items : null;
}

/** The logo path on the API origin, from `brand.logo` (`{ sha256, type }` or the path itself) of a verified brand. */
function logoPathOf(projectId: string, logo: unknown): string | null {
  if (typeof logo === "string") {
    const match = LOGO_PATH.exec(logo);
    return match && match[1] === projectId ? logo : null;
  }
  if (!isRecord(logo) || typeof logo.sha256 !== "string" || !LOGO_SHA.test(logo.sha256)) return null;
  const extension = logo.type === "image/png" ? "png" : logo.type === "image/webp" ? "webp" : null;
  return extension ? `/v1/projects/${projectId}/logo/${logo.sha256}.${extension}` : null;
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/**
 * What the frame does with a profile (integrator 4.8): refuse unless the
 * bridge-proven host origin is one the project allowed (exact origin match),
 * refuse a flow the project does not have, else the verified brand (only when
 * `brand.verified` is true), the lane and the defaults. Fails closed on a
 * malformed profile.
 */
export function profileView(input: unknown, hostOrigin: string, flow: string | null): EmbedProfileView {
  if (!isRecord(input) || typeof input.projectId !== "string" || !PROJECT_ID.test(input.projectId) || !Array.isArray(input.allowedOrigins)) {
    return { ok: false, code: "INVALID_RESPONSE" };
  }
  const profile = input as unknown as EmbedProfileInput & { readonly projectId: string; readonly allowedOrigins: readonly unknown[] };
  if (!profile.allowedOrigins.some((origin) => origin === hostOrigin)) return { ok: false, code: "PUBLISHABLE_ORIGIN_FORBIDDEN", host: hostOf(hostOrigin) };
  if (flow !== null) {
    const flows = Array.isArray(profile.flows) ? profile.flows : [];
    if (!flows.some((item) => isRecord(item) && item.id === flow)) return { ok: false, code: "FLOW_UNKNOWN" };
  }
  const brand = isRecord(profile.brand) && profile.brand.verified === true && typeof profile.brand.name === "string" && profile.brand.name.trim()
    ? {
        name: clean(profile.brand.name, 80),
        host: typeof profile.brand.host === "string" && /^[a-z0-9.-]{1,253}(?::\d{1,5})?$/u.test(profile.brand.host) ? profile.brand.host : null,
        logoPath: logoPathOf(profile.projectId, profile.brand.logo),
      }
    : null;
  const defaults = isRecord(profile.defaults) ? profile.defaults : {};
  const examples = Array.isArray(defaults.examples)
    ? defaults.examples.filter((item): item is string => typeof item === "string").map((item) => clean(item, EMBED_MAX_EXAMPLE_LENGTH)).filter(Boolean).slice(0, EMBED_MAX_EXAMPLES)
    : [];
  return {
    ok: true,
    projectId: profile.projectId,
    brand,
    testnet: profile.lane === "testnet",
    defaults: {
      networks: stringList(defaults.networks, /^[a-z0-9][a-z0-9-]{0,39}$/u, EMBED_MAX_NETWORKS),
      actions: stringList(defaults.actions, /^[a-z]+$/u, EMBED_ACTIONS.length)?.filter((action) => EMBED_ACTIONS.includes(action)) ?? null,
      sourceNetwork: typeof defaults.sourceNetwork === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/u.test(defaults.sourceNetwork) ? defaults.sourceNetwork : null,
      examples: examples.length > 0 ? examples : null,
      appearance: defaults.appearance,
    },
    flow,
  };
}

/**
 * The query string with the project's defaults under it: `networks`,
 * `actions`, `source` and `examples` the element did not set come from the
 * profile, so the usual parsers (`readEmbedScope`, `readEmbedParams`)
 * validate them like any parameter. Element attributes always win.
 */
export function searchWithDefaults(search: string, defaults: EmbedProfileDefaults): string {
  let query: URLSearchParams;
  try {
    query = new URLSearchParams(search);
  } catch {
    query = new URLSearchParams();
  }
  if (!query.has("networks") && defaults.networks) query.set("networks", defaults.networks.join(","));
  if (!query.has("actions") && defaults.actions && defaults.actions.length > 0) query.set("actions", defaults.actions.join(","));
  if (!query.has("source") && defaults.sourceNetwork) query.set("source", defaults.sourceNetwork);
  if (!query.has("examples") && defaults.examples) query.set("examples", defaults.examples.join(","));
  const text = query.toString();
  return text ? `?${text}` : "";
}

/**
 * The project's default appearance with the element's attributes over it:
 * each token the element set wins, colour palettes merge per colour.
 */
export function mergeAppearance<T extends object>(defaults: T | null | undefined, attributes: T): T {
  if (!defaults) return attributes;
  const merged: Record<string, unknown> = { ...(defaults as Readonly<Record<string, unknown>>) };
  for (const [name, value] of Object.entries(attributes as Readonly<Record<string, unknown>>)) {
    if (value === undefined) continue;
    const base = merged[name];
    merged[name] = (name === "light" || name === "dark") && isRecord(base) && isRecord(value) ? { ...base, ...value } : value;
  }
  return merged as T;
}
