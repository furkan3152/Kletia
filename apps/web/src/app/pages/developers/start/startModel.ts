/**
 * "Start here" on the Overview (integrator design 4.4, portal design
 * 4.4.1): get a key (sandbox first), pick a surface, run the first call, ship
 * the files. Pure: the node tests load it directly.
 *
 * Key rules: the key lives only in the portal's in-memory store. Snippets
 * and files never contain it; they read $KLETIA_API_KEY or
 * process.env.KLETIA_API_KEY. The only text that holds the key is the .env
 * line built by `envLine`, which the "Copy .env line" action puts on the
 * clipboard and nothing renders.
 */
import type { CodeLanguage } from "../../../site/ui/highlight.tsx";

export type KeyLaneChoice = "sandbox" | "live";
export type StartSurface = "embed" | "react" | "node" | "rest";

export const START_SURFACES: readonly { readonly id: StartSurface; readonly label: string; readonly minutes: number; readonly blurb: string }[] = [
  { id: "embed", label: "Embed", minutes: 3, blurb: "One script tag on any page, no build step." },
  { id: "react", label: "React widget", minutes: 5, blurb: "A drop-in panel for React apps; wallets stay yours." },
  { id: "node", label: "Node SDK", minutes: 5, blurb: "Plan on your server with the typed client." },
  { id: "rest", label: "REST", minutes: 2, blurb: "Plain HTTP from any language." },
];

/** The two lanes a new key can take, as Station one offers them (sandbox first). */
export const LANE_CHOICES: readonly { readonly value: KeyLaneChoice; readonly title: string; readonly detail: string }[] = [
  {
    value: "sandbox",
    title: "Sandbox",
    detail: "Test networks only (Arbitrum Sepolia, Arc Testnet, Solana Devnet): sends, swaps, bridges, stakes and your own contracts there, with test tokens.",
  },
  { value: "live", title: "Live", detail: "Every network. Dry runs move no money; stored intents still need the user's wallet." },
];

/** Same rule as the API (1-64 printable characters); the form only checks the common shape. */
export const KEY_NAME_PATTERN = /^[\w .:-]{1,64}$/u;

export function keyNameError(name: string): string | null {
  return KEY_NAME_PATTERN.test(name.trim()) ? null : "Use 1-64 letters, numbers, spaces, dots, colons, dashes or underscores.";
}

/** The request that issues a key: sandbox keys are kept on the testnet lane by their rule book. */
export function issueKeyBody(name: string, lane: KeyLaneChoice): { readonly name: string; readonly sandbox?: true } {
  return lane === "sandbox" ? { name: name.trim(), sandbox: true } : { name: name.trim() };
}

/** What a pasted text is, checked locally before it is used. */
export function classifyPastedKey(text: string): "empty" | "developer" | "agent" | "publishable" | "malformed" {
  const value = text.trim();
  if (!value) return "empty";
  if (/^kl_dev_[0-9A-Za-z]{32}$/u.test(value)) return "developer";
  if (/^kl_agt_[0-9A-Za-z]{32}$/u.test(value)) return "agent";
  if (/^kl_pub_[0-9A-Za-z]{32}$/u.test(value)) return "publishable";
  return "malformed";
}

/** The one string that holds the key: built only when "Copy .env line" is pressed, never rendered. */
export function envLine(key: string): string {
  return `KLETIA_API_KEY=${key.trim()}`;
}

/** The .env file as shown: a placeholder and how to fill it, never the key. */
export const ENV_FILE = `# Paste the line "Copy .env line" copies. Keep this file on your server, never in browser code.
KLETIA_API_KEY=`;

/** The first call: a dry-run plan of a fixed sentence for a demo account (nothing is stored, read for funds or signed). */
export const FIRST_CALL_TEXT = "swap 1 SOL to USDC";

export interface FirstCallPlan {
  readonly method: "POST";
  readonly url: string;
  /** Request headers; `authorization` only on the key tier. */
  readonly headers: readonly (readonly [string, string])[];
  readonly body: string;
  /** The key tier, or the public tier (no key, or a sandbox key whose rule book refuses mainnet dry runs). */
  readonly tier: "key" | "public";
  /** Shown next to Run: "with your key", "public tier". */
  readonly label: string;
}

export interface FirstCallInput {
  readonly apiOrigin: string;
  readonly account: string;
  /** The key in memory ("" when none). */
  readonly key: string;
  /** The key's lane from GET /v1/keys or its issuance; null when unknown. */
  readonly lane: "testnet" | "production" | "any" | null;
}

/**
 * What Run sends. A sandbox key stays out of the request: its rule book
 * refuses production networks, so the mainnet dry run goes on the public
 * tier and the label says so.
 */
export function firstCallPlan({ apiOrigin, account, key, lane }: FirstCallInput): FirstCallPlan {
  const kind = classifyPastedKey(key);
  const usable = kind === "developer" || kind === "agent";
  const tier = usable && lane !== "testnet" ? "key" : "public";
  const headers: [string, string][] = [
    ["accept", "application/json"],
    ["content-type", "application/json"],
  ];
  if (tier === "key") headers.push(["authorization", `Bearer ${key.trim()}`]);
  return {
    method: "POST",
    url: `${apiOrigin}/v1/intents?dryRun=true`,
    headers,
    body: JSON.stringify({ text: FIRST_CALL_TEXT, accounts: [account] }),
    tier,
    label: tier === "key" ? "with your key" : lane === "testnet" ? "public tier (sandbox keys stay on testnets)" : "public tier",
  };
}

/** The curl shown for the first call: the key is always $KLETIA_API_KEY. */
export function firstCallCurl(apiOrigin: string, account: string, tier: "key" | "public"): string {
  const lines = [
    `curl -X POST "${apiOrigin}/v1/intents?dryRun=true" \\`,
    `  -H "content-type: application/json" \\`,
    ...(tier === "key" ? [`  -H "authorization: Bearer $KLETIA_API_KEY" \\`] : []),
    `  -d '{"text":"${FIRST_CALL_TEXT}","accounts":["${account}"]}'`,
  ];
  return lines.join("\n");
}

export interface RunSummary {
  readonly ok: boolean;
  /** "200 · 287 ms · 1 step · Swap 1 SOL for USDC · ≈105.7 USDC". */
  readonly line: string;
  readonly requestId: string | null;
}

interface StepLike {
  readonly title?: unknown;
  readonly expectedOutput?: { readonly formatted?: unknown; readonly symbol?: unknown } | null;
}

/** One line for the result of Run, from the status, the time and the intent graph (or the error code). */
export function summarizeRun(input: { readonly status: number; readonly latencyMs: number; readonly body: unknown; readonly requestId?: string | null }): RunSummary {
  const head = `${input.status} · ${Math.round(input.latencyMs)} ms`;
  const requestId = input.requestId ?? null;
  const body = input.body && typeof input.body === "object" ? (input.body as Record<string, unknown>) : null;
  if (input.status < 200 || input.status >= 300) {
    const error = body?.error && typeof body.error === "object" ? (body.error as Record<string, unknown>) : null;
    const code = typeof error?.code === "string" ? error.code : null;
    return { ok: false, line: code ? `${head} · ${code}` : head, requestId };
  }
  // POST /v1/intents answers { intent, preview?, journey? }; a bare graph is read the same way.
  const graph = body?.intent && typeof body.intent === "object" ? (body.intent as Record<string, unknown>) : body;
  const steps = Array.isArray(graph?.steps) ? (graph!.steps as StepLike[]) : [];
  const parts = [head, `${steps.length} ${steps.length === 1 ? "step" : "steps"}`];
  const first = steps[0];
  if (first && typeof first.title === "string") parts.push(first.title);
  const last = steps[steps.length - 1];
  const output = last?.expectedOutput;
  if (output && typeof output.formatted === "string" && typeof output.symbol === "string") parts.push(`≈${output.formatted} ${output.symbol}`);
  return { ok: true, line: parts.join(" · "), requestId };
}

/** "Key issuance is limited to 5 per hour from one IP address; try again in 12 min." */
export function issueLimitMessage(retryAfterSeconds: number | null, now: number, since: number): string {
  if (retryAfterSeconds === null) return "Key issuance is limited to 5 per hour from one IP address; try again later.";
  const left = Math.max(0, retryAfterSeconds - Math.floor((now - since) / 1000));
  if (left === 0) return "Key issuance is limited to 5 per hour from one IP address; you can try again now.";
  const minutes = Math.ceil(left / 60);
  return `Key issuance is limited to 5 per hour from one IP address; try again in ${minutes} min.`;
}

export interface ShipFile {
  readonly id: string;
  readonly label: string;
  readonly filename: string;
  readonly language: CodeLanguage;
  readonly code: string;
}

export interface ShipInput {
  readonly surface: StartSurface;
  readonly apiOrigin: string;
  readonly webOrigin: string;
  readonly embedVersion: string;
  /** The script's `sha384-…` from this deployment's /sdk/embed/manifest.json; null while unknown or unavailable. */
  readonly embedIntegrity?: string | null;
  /** The @kletia/* package version the install lines name (SDK_VERSION). */
  readonly sdkVersion?: string;
  readonly account: string;
}

/**
 * False until the @kletia packages are on the npm registry: the install
 * lines then lead with the GitHub release tarballs and this site's SDK
 * build, and name npm as the later way.
 */
export const PACKAGES_ON_NPM = false;

/** The repository's GitHub releases (release-packages.yml attaches the `npm pack` tarballs there). */
export const RELEASES_URL = "https://github.com/furkan3152/Kletia/releases";

export type KletiaPackage = "core" | "sdk" | "widget" | "embed" | "cli";

/** `https://github.com/…/releases/download/packages-v0.1.0/kletia-sdk-0.1.0.tgz`. */
export function releaseTarballUrl(name: KletiaPackage, version: string): string {
  return `${RELEASES_URL}/download/packages-v${version}/kletia-${name}-${version}.tgz`;
}

const SRI = /^sha384-[A-Za-z0-9+/]{64}$/u;

/**
 * How to install `packages` (dependencies first: the SDK needs core) with
 * and without the npm registry. With `sdkFile`, it also shows the
 * single-file SDK build this site serves, checked against its manifest.
 */
export function installScript({ packages, version, webOrigin, sdkFile = false }: { readonly packages: readonly KletiaPackage[]; readonly version: string; readonly webOrigin: string; readonly sdkFile?: boolean }): string {
  const order: readonly KletiaPackage[] = ["core", "sdk", "widget", "embed", "cli"];
  // Every package but the embed depends on @kletia/core, so its tarball goes first.
  const wanted = order.filter((name) => packages.includes(name) || (name === "core" && packages.some((item) => item !== "embed")));
  const npm = `npm install ${packages.map((name) => `@kletia/${name}`).join(" ")}`;
  const tarballs = ["npm install \\", ...wanted.map((name, index) => `  ${releaseTarballUrl(name, version)}${index === wanted.length - 1 ? "" : " \\"}`)];
  const lines = PACKAGES_ON_NPM
    ? ["# From npm:", npm, "", `# Or from the GitHub release (${RELEASES_URL}):`, ...tarballs]
    : [
        "# The packages are not on the npm registry yet. Install them from the GitHub release",
        `# (${RELEASES_URL}); core comes first because the others depend on it:`,
        ...tarballs,
        "",
        "# Once they are on npm:",
        `# ${npm}`,
      ];
  if (sdkFile) {
    const file = `kletia-sdk-${version}.js`;
    lines.push(
      "",
      `# Or the SDK as one ES module file from ${webOrigin} (no install). Check it against the`,
      `# "integrity" of ${webOrigin}/sdk/manifest.json before you use it, then import "./${file}":`,
      `curl -fsSLO ${webOrigin}/sdk/${file}`,
      `echo "sha384-$(openssl dgst -sha384 -binary ${file} | openssl base64 -A)"`,
    );
  }
  return lines.join("\n");
}

/**
 * Complete files for the chosen surface, on this deployment's own origins.
 * There is no key parameter on purpose: nothing here can contain one.
 */
export function shipFiles({ surface, apiOrigin, webOrigin, embedVersion, embedIntegrity = null, sdkVersion = "0.1.0", account }: ShipInput): readonly ShipFile[] {
  const script = `${webOrigin}/sdk/embed/${embedVersion}/kletia-embed.min.js`;
  const pinned = embedIntegrity !== null && SRI.test(embedIntegrity);
  const scriptTag = pinned
    ? `<!-- The browser refuses the script if its bytes ever differ from this hash (${webOrigin}/sdk/embed/manifest.json). -->
<script src="${script}" integrity="${embedIntegrity}" crossorigin="anonymous"></script>`
    : `<!-- Add integrity="sha384-…" for ${embedVersion} from ${webOrigin}/sdk/embed/manifest.json -->
<script src="${script}" crossorigin="anonymous"></script>`;
  if (surface === "embed") {
    return [
      {
        id: "html",
        label: "index.html",
        filename: "index.html",
        language: "html",
        code: `<!doctype html>
<meta charset="utf-8" />
<title>Checkout</title>
<!-- Serve this page over http(s): a file:// page has no origin, so the widget cannot connect. -->
${scriptTag}

<kletia-intent text="${FIRST_CALL_TEXT}"${webOrigin === "https://kletiaai.xyz" ? "" : ` origin="${webOrigin}"`}></kletia-intent>

<script>
  document.querySelector("kletia-intent").addEventListener("kletia:intent-created", (event) => {
    // A notification only: your server checks GET /v1/intents/{id} before it fulfils anything.
    console.log(event.detail.intentId, event.detail.status);
  });
</script>`,
      },
    ];
  }
  if (surface === "react") {
    return [
      {
        id: "app",
        label: "App.tsx",
        filename: "src/App.tsx",
        language: "tsx",
        code: `// Install with install.sh (npm, or the GitHub release tarballs until the packages are on npm).
import { KletiaIntentWidget } from "@kletia/widget";

// The browser uses the public tier: never put a kl_dev_ key in browser code.
export function App() {
  return (
    <KletiaIntentWidget
      clientOptions={{ baseUrl: "${apiOrigin}" }}
      accounts={["${account}"]}
      defaultText="${FIRST_CALL_TEXT}"
      theme="auto"
    />
  );
}`,
      },
      { id: "install", label: "install.sh", filename: "install.sh", language: "bash", code: installScript({ packages: ["widget", "sdk"], version: sdkVersion, webOrigin }) },
    ];
  }
  if (surface === "node") {
    return [
      {
        id: "server",
        label: "plan.mjs",
        filename: "plan.mjs",
        language: "ts",
        code: `// Node 20.6 or later: install @kletia/sdk (install.sh), then node --env-file=.env plan.mjs
// With the single-file build instead, import from "./kletia-sdk-${sdkVersion}.js".
import { KletiaClient } from "@kletia/sdk";

const kletia = new KletiaClient({ baseUrl: "${apiOrigin}", apiKey: process.env.KLETIA_API_KEY });
const intent = await kletia.intents.create(
  { text: "${FIRST_CALL_TEXT}", accounts: ["${account}"] },
  { dryRun: true }, // plan and quote; nothing is stored or signed
);
console.log(intent.steps.map((step) => step.title));`,
      },
      { id: "env", label: ".env", filename: ".env", language: "bash", code: ENV_FILE },
      { id: "install", label: "install.sh", filename: "install.sh", language: "bash", code: installScript({ packages: ["sdk"], version: sdkVersion, webOrigin, sdkFile: true }) },
    ];
  }
  return [
    { id: "curl", label: "first-call.sh", filename: "first-call.sh", language: "bash", code: `# Reads KLETIA_API_KEY from .env next to this file: sh first-call.sh\nset -a; . ./.env; set +a\n\n${firstCallCurl(apiOrigin, account, "key")}` },
    { id: "env", label: ".env", filename: ".env", language: "bash", code: ENV_FILE },
  ];
}
