/**
 * Embed builder model (integrator design 4.4, portal 4.4.9): the builder's
 * state, its validation and the code it generates for the four outputs
 * (HTML element, npm `mountKletiaIntent`, React `KletiaIntentWidget`, plain
 * iframe). Pure: no React, no storage and no key store. The builder never
 * reads the portal's in-memory key, and no output can carry a secret key
 * (`kl_dev_…`, `kl_agt_…`): fields that hold one are refused and every output
 * is checked again before it is shown (`guardSecrets`).
 *
 * The script tag's integrity comes only from this deployment's
 * `/sdk/embed/manifest.json`; without it the HTML output is a notice, not
 * code. Snippets use the deployment's own origins, so they are right on a
 * self-hosted or local Kletia too.
 */
import {
  appearanceToParams,
  CHAINS,
  PUBLISHABLE_KEY_PATTERN,
  resolveAppearance,
  type AppearanceWarning,
  type KletiaAppearance,
  type NetworkKey,
} from "@kletia/core";

export const DEFAULT_WEB_ORIGIN = "https://kletiaai.xyz";
export const DEFAULT_API_ORIGIN = "https://api.kletiaai.xyz";

export type BuilderMode = "text" | "flow" | "session" | "intent";
export type BuilderOutput = "html" | "npm" | "react" | "iframe";
export type BuilderColor = "accent" | "ink" | "surface" | "line";
export const BUILDER_COLORS: readonly BuilderColor[] = ["accent", "ink", "surface", "line"];
export const BUILDER_ACTIONS = ["swap", "bridge", "transfer", "stake", "deposit", "withdraw"] as const;
export type BuilderAction = (typeof BUILDER_ACTIONS)[number];

export interface BuilderState {
  readonly mode: BuilderMode;
  readonly text: string;
  /** Comma separated, like the element's attribute. */
  readonly examples: string;
  readonly sessionId: string;
  readonly intentId: string;
  readonly publishableKey: string;
  readonly flow: string;
  readonly networks: readonly NetworkKey[];
  /** "" (not set), "auto" or one of `networks`. */
  readonly sourceNetwork: string;
  readonly actions: readonly BuilderAction[];
  readonly theme: "auto" | "light" | "dark";
  /** Light palette, "#RRGGBB" or "" (stock). */
  readonly colors: Readonly<Record<BuilderColor, string>>;
  readonly radius: number;
  readonly border: 1 | 2 | 3;
  readonly shadow: "hard" | "soft" | "none";
  readonly font: "inter" | "system" | "serif" | "mono" | "rounded";
  readonly density: "comfortable" | "compact";
  readonly header: "kletia" | "none";
  readonly transparent: boolean;
  readonly height: number;
  readonly maxHeight: number;
  readonly reference: string;
}

/** The stock widget: the generated element then carries no appearance attribute at all. */
export const DEFAULT_BUILDER_STATE: BuilderState = Object.freeze({
  mode: "text",
  text: "swap 1 SOL to USDC",
  examples: "",
  sessionId: "",
  intentId: "",
  publishableKey: "",
  flow: "",
  networks: [],
  sourceNetwork: "",
  actions: [],
  theme: "auto",
  colors: Object.freeze({ accent: "", ink: "", surface: "", line: "" }),
  radius: 0,
  border: 3,
  shadow: "hard",
  font: "inter",
  density: "comfortable",
  header: "kletia",
  transparent: false,
  height: 720,
  maxHeight: 1600,
  reference: "",
});

export interface BuilderPreset {
  readonly id: "kletia" | "soft" | "night" | "mono";
  readonly label: string;
  readonly apply: Partial<BuilderState>;
}

export const BUILDER_PRESETS: readonly BuilderPreset[] = [
  {
    id: "kletia",
    label: "Kletia",
    apply: { colors: DEFAULT_BUILDER_STATE.colors, radius: 0, border: 3, shadow: "hard", font: "inter", density: "comfortable", theme: "auto" },
  },
  {
    id: "soft",
    label: "Soft",
    apply: { colors: { accent: "#0F766E", ink: "#1F2937", surface: "#FFFDF8", line: "#6B7280" }, radius: 12, border: 1, shadow: "soft", font: "system", density: "comfortable", theme: "light" },
  },
  {
    id: "night",
    label: "Night",
    apply: { colors: { accent: "#7C3AED", ink: "#141414", surface: "#FFFFFF", line: "#3F3F46" }, radius: 8, border: 2, shadow: "none", font: "inter", density: "comfortable", theme: "dark" },
  },
  {
    id: "mono",
    label: "Mono",
    apply: { colors: { accent: "#141414", ink: "#141414", surface: "#F4F4F5", line: "#141414" }, radius: 0, border: 2, shadow: "none", font: "mono", density: "compact", theme: "light" },
  },
];

/** `/sdk/embed/manifest.json` as the builder needs it. */
export interface EmbedManifest {
  readonly version: string;
  readonly script: { readonly path: string; readonly integrity: string };
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const SRI = /^sha384-[A-Za-z0-9+/]{64}$/u;
const SCRIPT_PATH = /^\/sdk\/embed\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\/kletia-embed\.min\.js$/u;

/** Reads the manifest (`kletia.embed-manifest/v1`); `null` for anything that is not a usable one. */
export function parseEmbedManifest(input: unknown): EmbedManifest | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as { schema?: unknown; version?: unknown; files?: Record<string, { path?: unknown; integrity?: unknown }> };
  if (record.schema !== "kletia.embed-manifest/v1" || typeof record.version !== "string" || !SEMVER.test(record.version)) return null;
  const file = record.files?.["kletia-embed.min.js"];
  if (!file || typeof file.path !== "string" || typeof file.integrity !== "string") return null;
  const match = SCRIPT_PATH.exec(file.path);
  if (!match || match[1] !== record.version || !SRI.test(file.integrity)) return null;
  return { version: record.version, script: { path: file.path, integrity: file.integrity } };
}

/* ----------------------------------------------------------------- checks */

const INTENT_ID = /^int_[0-9a-f]{32}$/u;
const SESSION_ID = /^cs_[0-9a-f]{32}$/u;
const FLOW_ID = /^[a-z][a-z0-9-]{0,31}$/u;
const REFERENCE = /^[A-Za-z0-9_.:-]{1,80}$/u;
const HEX = /^#[0-9A-Fa-f]{6}$/u;
/** Secret key prefixes: never in generated code, whatever a field holds. */
const SECRET = /kl_(?:dev|agt)_/u;

export type BuilderField = "text" | "examples" | "sessionId" | "intentId" | "publishableKey" | "flow" | "reference" | BuilderColor | "networks";

/** Field errors: a field with an error is left out of the generated code. */
export function builderErrors(state: BuilderState): Partial<Record<BuilderField, string>> {
  const errors: Partial<Record<BuilderField, string>> = {};
  const secret = "This is a secret key. It never goes in a page: revoke it if it was published, and use a publishable key (kl_pub_…).";
  if (SECRET.test(state.text)) errors.text = secret;
  if (SECRET.test(state.examples)) errors.examples = secret;
  if (SECRET.test(state.reference)) errors.reference = secret;
  else if (state.reference && !REFERENCE.test(state.reference)) errors.reference = "Letters, digits and _ . : - only, at most 80.";
  if (state.mode === "session" && !SESSION_ID.test(state.sessionId.trim())) errors.sessionId = "A session id is cs_ followed by 32 hex characters, from your server.";
  if (state.mode === "intent" && !INTENT_ID.test(state.intentId.trim())) errors.intentId = "An intent id is int_ followed by 32 hex characters, from your server.";
  if (state.mode === "flow" || state.publishableKey.trim()) {
    const key = state.publishableKey.trim();
    if (SECRET.test(key)) errors.publishableKey = secret;
    else if (!PUBLISHABLE_KEY_PATTERN.test(key)) errors.publishableKey = "A publishable key is kl_pub_ followed by 32 letters and digits (Project settings).";
  }
  if (state.mode === "flow" && !FLOW_ID.test(state.flow.trim())) errors.flow = "A flow id: lower-case letters, digits and -, starting with a letter.";
  for (const color of BUILDER_COLORS) {
    const value = state.colors[color];
    if (value && !HEX.test(value)) errors[color] = "Six hex digits, for example #0F766E.";
  }
  const lanes = new Set(state.networks.map((network) => CHAINS[network]?.environment));
  if (lanes.size > 1) errors.networks = "Production and testnet networks never share one intent.";
  return errors;
}

/** The appearance the state describes (only what differs from the stock widget). */
export function builderAppearance(state: BuilderState): KletiaAppearance {
  const light: Record<string, string> = {};
  for (const color of BUILDER_COLORS) if (HEX.test(state.colors[color])) light[color] = state.colors[color].toUpperCase();
  return {
    ...(Object.keys(light).length > 0 ? { light } : {}),
    ...(state.radius !== 0 ? { radius: Math.max(0, Math.min(16, Math.round(state.radius))) } : {}),
    ...(state.border !== 3 ? { border: state.border } : {}),
    ...(state.shadow !== "hard" ? { shadow: state.shadow } : {}),
    ...(state.font !== "inter" ? { font: state.font } : {}),
    ...(state.density !== "comfortable" ? { density: state.density } : {}),
    ...(state.header !== "kletia" ? { header: state.header } : {}),
  };
}

export interface ContrastNote {
  readonly color: BuilderColor | null;
  readonly message: string;
  /** One-click fix: the colour the widget will use instead. */
  readonly fix: string | null;
}

/**
 * Contrast and range warnings, from `resolveAppearance` (the code the frame
 * runs), for the scheme the preview shows (both when it follows the visitor).
 */
export function contrastNotes(state: BuilderState): ContrastNote[] {
  const appearance = builderAppearance(state);
  const schemes: ("light" | "dark")[] = state.theme === "auto" ? ["light", "dark"] : [state.theme];
  const notes: ContrastNote[] = [];
  const seen = new Set<string>();
  for (const scheme of schemes) {
    // The builder sets one palette: the frame uses it for both schemes.
    const resolved = resolveAppearance(scheme === "dark" && appearance.light ? { ...appearance, dark: appearance.light } : appearance, scheme);
    for (const warning of resolved.warnings as readonly AppearanceWarning[]) {
      const key = warning.path.split(".").pop() as string;
      const color = (BUILDER_COLORS as readonly string[]).includes(key) ? (key as BuilderColor) : null;
      const id = `${key}:${warning.message}`;
      if (seen.has(id)) continue;
      seen.add(id);
      notes.push({ color, message: warning.message, fix: color && warning.fallback && HEX.test(warning.fallback) ? warning.fallback.toUpperCase() : null });
    }
  }
  return notes;
}

/* ------------------------------------------------------------ the outputs */

/** HTML attribute value: `&`, `"`, `<` and `>` escaped. */
export function escapeAttribute(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

/** A JavaScript string literal that is also safe inside an HTML script block. */
function js(value: string): string {
  return JSON.stringify(value).replace(/</gu, "\\u003c").replace(/>/gu, "\\u003e").replace(/&/gu, "\\u0026");
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F]+/gu;
const cleanText = (value: string, max: number) => value.replace(CONTROL, " ").replace(/\s{2,}/gu, " ").trim().slice(0, max);

function exampleList(state: BuilderState): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of state.examples.split(",")) {
    const example = cleanText(part, 120);
    if (!example || seen.has(example.toLowerCase())) continue;
    seen.add(example.toLowerCase());
    out.push(example);
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * The element's attributes for a state, in a fixed order, as [name, value]
 * pairs (unescaped). Fields with errors are left out.
 */
export function elementAttributes(state: BuilderState, options: { readonly origin?: string | null } = {}): [string, string][] {
  const errors = builderErrors(state);
  const out: [string, string][] = [];
  if (options.origin) out.push(["origin", options.origin]);
  if (state.mode === "text" || state.mode === "flow") {
    if (state.mode === "text") {
      const text = cleanText(state.text, 500);
      if (text && !errors.text) out.push(["text", text]);
      const examples = exampleList(state);
      if (examples.length > 0 && !errors.examples) out.push(["examples", examples.join(",")]);
    }
    if (!errors.publishableKey && state.publishableKey.trim()) out.push(["key", state.publishableKey.trim()]);
    if (state.mode === "flow" && !errors.flow && !errors.publishableKey) out.push(["flow", state.flow.trim()]);
  }
  if (state.mode === "session" && !errors.sessionId) out.push(["session", state.sessionId.trim()]);
  if (state.mode === "intent" && !errors.intentId) out.push(["intent", state.intentId.trim()]);
  if (state.networks.length > 0 && !errors.networks) out.push(["networks", state.networks.join(",")]);
  if (state.sourceNetwork === "auto" || (state.sourceNetwork && state.networks.includes(state.sourceNetwork as NetworkKey) && !errors.networks)) {
    out.push(["source-network", state.sourceNetwork]);
  }
  if (state.actions.length > 0) out.push(["actions", state.actions.join(",")]);
  if (state.theme !== "auto") out.push(["theme", state.theme]);
  out.push(...appearanceToParams(builderAppearance(state)));
  if (state.transparent) out.push(["bg", "transparent"]);
  out.push(["height", String(state.height)]);
  if (state.maxHeight !== 1600) out.push(["max-height", String(state.maxHeight)]);
  if (state.reference && !errors.reference) out.push(["reference", state.reference]);
  return out;
}

const camel = (name: string) => name.replace(/-(\w)/gu, (_, letter: string) => letter.toUpperCase());

export interface BuilderOrigins {
  /** This deployment's web origin (serves /embed and /sdk/embed). */
  readonly web: string;
  /** This deployment's API origin. */
  readonly api: string;
}

/**
 * Last line of defence: an output that would contain a secret key prefix is
 * replaced by a notice. Field checks already keep such values out.
 */
export function guardSecrets(code: string): string {
  return SECRET.test(code) ? "<!-- A secret key prefix (kl_dev_ / kl_agt_) was found in this snippet, so nothing is shown. Secret keys never go in a page. -->" : code;
}

const EVENTS_SCRIPT = `<script type="module">
  const widget = document.querySelector("kletia-intent");
  // Notifications only: your server verifies GET /v1/intents/{id} before it fulfils anything.
  widget.addEventListener("kletia:ready", (event) => console.log("ready", event.detail.height));
  widget.addEventListener("kletia:intent-created", (event) => console.log("intent", event.detail.intentId, event.detail.status));
  widget.addEventListener("kletia:question", (event) => console.log("asking", event.detail.count, event.detail.reasons));
  widget.addEventListener("kletia:completed", (event) => console.log("done", event.detail.status));
  widget.addEventListener("kletia:error", (event) => console.warn(event.detail.code, event.detail.message));
</script>`;

/** The HTML output: the script with this deployment's integrity, the element and an events listener. */
export function htmlSnippet(state: BuilderState, origins: BuilderOrigins, manifest: EmbedManifest | null): string {
  if (!manifest) {
    return `<!-- This deployment does not serve /sdk/embed/manifest.json, so the script tag cannot pin an integrity hash. -->
<!-- Use the npm or React output, or build the web app with the embed script (npm run build:web). -->`;
  }
  const attributes = elementAttributes(state);
  const lines = attributes.map(([name, value]) => `  ${name}="${escapeAttribute(value)}"`);
  const element = lines.length > 0 ? `<kletia-intent\n${lines.join("\n")}\n></kletia-intent>` : "<kletia-intent></kletia-intent>";
  const script = `<script
  src="${escapeAttribute(`${origins.web}${manifest.script.path}`)}"
  integrity="${escapeAttribute(manifest.script.integrity)}"
  crossorigin="anonymous"
></script>`;
  return guardSecrets(`<!-- Serve this page over http(s): a file:// page has no origin, so the widget cannot connect. -->
${script}

${element}

${EVENTS_SCRIPT}`);
}

/** The npm output: `mountKletiaIntent` with the same settings as options. */
export function npmSnippet(state: BuilderState, origins: BuilderOrigins): string {
  // The script tag defaults to the origin it came from; the npm package defaults to kletiaai.xyz.
  const attributes = elementAttributes(state, { origin: origins.web === DEFAULT_WEB_ORIGIN ? null : origins.web });
  const option = (name: string, value: string): string => {
    const key = name === "key" ? "publishableKey" : name === "bg" ? "bg" : camel(name);
    if (name === "height" || name === "max-height" || name === "radius" || name === "border") return `  ${key}: ${Number(value)},`;
    if (name === "examples" || name === "networks" || name === "actions") return `  ${key}: [${value.split(",").map(js).join(", ")}],`;
    return `  ${key}: ${js(value)},`;
  };
  return guardSecrets(`// npm install @kletia/embed
import { mountKletiaIntent } from "@kletia/embed";

mountKletiaIntent("#kletia-widget", {
${attributes.map(([name, value]) => option(name, value)).join("\n")}
  // Notifications only: your server verifies GET /v1/intents/{id} before it fulfils anything.
  onIntentCreated: (detail) => console.log("intent", detail.intentId, detail.status),
  onQuestion: (detail) => console.log("asking", detail.count, detail.reasons),
  onError: (detail) => console.warn(detail.code, detail.message),
});`);
}

function jsValue(value: unknown, indent: string): string {
  if (typeof value === "string") return js(value);
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map((item) => jsValue(item, indent)).join(", ")}]`;
  if (value && typeof value === "object") {
    const inner = `${indent}  `;
    const entries = Object.entries(value).map(([key, item]) => `${inner}${key}: ${jsValue(item, inner)},`);
    return `{\n${entries.join("\n")}\n${indent}}`;
  }
  return "undefined";
}

/** The React output: `KletiaIntentWidget` with the same settings as props. */
export function reactSnippet(state: BuilderState, origins: BuilderOrigins): string {
  const errors = builderErrors(state);
  const props: string[] = ["accounts={accounts}", "signers={signers}"];
  if (origins.api !== DEFAULT_API_ORIGIN) props.unshift(`clientOptions={{ baseUrl: ${js(origins.api)} }}`);
  const key = state.publishableKey.trim();
  // JSX string attributes have no escapes: every value is an expression.
  const prop = (name: string, value: unknown) => props.push(`${name}={${jsValue(value, "      ")}}`);
  if (key && !errors.publishableKey && (state.mode === "text" || state.mode === "flow")) prop("publishableKey", key);
  if (state.mode === "text") {
    const text = cleanText(state.text, 500);
    if (text && !errors.text) prop("defaultText", text);
    const examples = exampleList(state);
    if (examples.length > 0 && !errors.examples) prop("examples", examples);
  }
  if (state.mode === "session" && !errors.sessionId) prop("sessionId", state.sessionId.trim());
  if (state.mode === "intent" && !errors.intentId) prop("intentId", state.intentId.trim());
  if (state.networks.length > 0 && !errors.networks) prop("networks", state.networks);
  if (state.sourceNetwork === "auto" || (state.sourceNetwork && state.networks.includes(state.sourceNetwork as NetworkKey) && !errors.networks)) prop("sourceNetwork", state.sourceNetwork);
  if (state.actions.length > 0) prop("actions", state.actions);
  if (state.theme !== "auto") prop("theme", state.theme);
  const appearance = builderAppearance(state);
  if (Object.keys(appearance).length > 0) prop("appearance", appearance);
  if (state.reference && !errors.reference) prop("metadata", { hostRef: state.reference });
  const flowNote =
    state.mode === "flow"
      ? "\n// Stored flows run in the embed (<kletia-intent key flow>). In React, create the session on your server and pass sessionId."
      : "";
  return guardSecrets(`// npm install @kletia/widget @kletia/sdk @kletia/core react react-dom${flowNote}
import { KletiaIntentWidget } from "@kletia/widget";

// accounts: your visitor's wallet accounts (CAIP-10); signers: their wallet signers.
// Without signers the widget plans and reviews, and never executes.
export function Checkout({ accounts, signers }) {
  return (
    <KletiaIntentWidget
${props.map((prop) => `      ${prop}`).join("\n")}
    />
  );
}`);
}

/**
 * Why the frame's sandbox pairs allow-scripts with allow-same-origin, which
 * browsers flag in the console ("can escape its sandboxing"). That escape is
 * only possible for a frame of the page's own origin, which is the case in
 * the portal's preview (it frames this site's /embed) and never on a partner
 * page, where /embed is another origin.
 */
export const SANDBOX_COMMENT =
  "allow-scripts with allow-same-origin lets the widget keep wallet state and call the API. Browsers may log a warning about the pair; it matters only for a frame of your own origin, and /embed is Kletia's.";

/** The note under the builder's preview about that console warning. */
export const PREVIEW_SANDBOX_NOTE =
  "Your browser console may warn that this preview's frame has both allow-scripts and allow-same-origin. Here the frame shows this site's own /embed, so the warning is expected; on your page /embed is another origin and the sandbox keeps it apart from your page.";

/**
 * What the preview says next to an error event, when there is something to
 * do about it: a publishable key works only from its project's allowed
 * origins, and the preview runs on this site's origin.
 */
export function previewErrorHint(code: string, webOrigin: string): string | null {
  if (code === "PUBLISHABLE_ORIGIN_FORBIDDEN") {
    return `This preview runs on ${webOrigin}, which this key's project does not allow. To preview with the key, add ${webOrigin} to the allowed origins in Project settings (your own site's origin goes there too), or clear the key to preview on the public tier.`;
  }
  return null;
}

/** The iframe output: the raw `/embed` URL (no bridge, so no events, sessions or publishable keys). */
export function iframeSnippet(state: BuilderState, origins: BuilderOrigins): string {
  if (state.mode !== "text" || state.publishableKey.trim()) {
    return `<!-- Sessions, intents and publishable keys need <kletia-intent>: a plain iframe has no bridge to prove your site, so the frame refuses them. -->`;
  }
  const query = new URLSearchParams();
  for (const [name, value] of elementAttributes(state)) {
    if (name === "height" || name === "max-height" || name === "reference") continue;
    query.set(name === "source-network" ? "source" : name, value);
  }
  const search = query.toString();
  const src = `${origins.web}/embed${search ? `?${search}` : ""}`;
  return guardSecrets(`<!-- A plain frame reports no events; use <kletia-intent> for kletia:* events and auto-resize. -->
<!-- ${SANDBOX_COMMENT} -->
<iframe
  src="${escapeAttribute(src)}"
  title="Kletia intent widget"
  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
  allow="clipboard-write"
  referrerpolicy="strict-origin-when-cross-origin"
  style="display:block;width:100%;height:${state.height}px;border:0"
></iframe>`);
}

export function builderOutput(output: BuilderOutput, state: BuilderState, origins: BuilderOrigins, manifest: EmbedManifest | null): string {
  switch (output) {
    case "html":
      return htmlSnippet(state, origins, manifest);
    case "npm":
      return npmSnippet(state, origins);
    case "react":
      return reactSnippet(state, origins);
    case "iframe":
      return iframeSnippet(state, origins);
  }
}

/**
 * Options for the live preview (`mountKletiaIntent` options): this
 * deployment's `/embed`, framed by the portal itself, with the same settings.
 */
export function previewOptions(state: BuilderState, webOrigin: string): Record<string, string | number> {
  const options: Record<string, string | number> = { origin: webOrigin };
  for (const [name, value] of elementAttributes(state)) {
    if (name === "height" || name === "max-height" || name === "radius" || name === "border") options[camel(name)] = Number(value);
    else options[name === "key" ? "publishableKey" : camel(name)] = value;
  }
  return options;
}
