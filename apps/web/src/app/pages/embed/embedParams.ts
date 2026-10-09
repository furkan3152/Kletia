/**
 * Query parameters and document mode for the embeddable `/embed` page.
 * Dependency-free so the entry can apply the theme before the first paint.
 *
 * Accepted parameters (everything else is ignored):
 * - `theme=light|dark|auto` (default `auto`)
 * - `text=<default intent>` (max 500 characters)
 * - `examples=<comma separated>` (max 6, 120 characters each)
 * - `bg=transparent` (no page background, for hosts that draw their own)
 *
 * The host bridge parameters (`bridge`, `origin`, `ref`) are read by
 * `readBridgeParams` in `embedBridge.ts`, outside the entry bundle.
 *
 * An API key is never read from the URL: the embed always calls the public
 * tier, so a key cannot leak through referrers, logs or browser history.
 */

export type EmbedTheme = "light" | "dark" | "auto";

export interface EmbedParams {
  readonly theme: EmbedTheme;
  readonly text: string;
  /** `null` when the host did not pass examples (the widget defaults apply). */
  readonly examples: readonly string[] | null;
  readonly transparent: boolean;
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

if (
  typeof window !== "undefined" &&
  window.parent !== window &&
  /^\/embed\/?$/u.test(window.location.pathname) &&
  new URLSearchParams(window.location.search).get("bridge") === "1"
) {
  window.addEventListener("message", keepEarlyConnect);
}

/** Hands the connect messages kept so far to the bridge, once, and stops keeping them. */
export function takeEarlyConnects(): MessageEvent[] {
  if (typeof window !== "undefined") window.removeEventListener("message", keepEarlyConnect);
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
