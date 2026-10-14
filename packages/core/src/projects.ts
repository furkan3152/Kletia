/**
 * Projects, publishable keys and flows (integrator design §4.8, phase 2):
 * the `kletia.project/v1` settings shape, what the API returns for a project
 * and what a publishable key reveals to a browser. Types and constants only;
 * the validators and routes land with the integrator API packages.
 */
import type { NetworkKey } from "./chains.js";
import type { SessionAmountBounds } from "./contracts.js";
import type { IntentActionSpec, IntentConstraints, SourceNetwork } from "./intent.js";
import type { KletiaAppearance } from "./appearance.js";

export const PROJECT_SCHEMA = "kletia.project/v1";

/** Publishable keys: `kl_pub_` + 32 base62 (a third key kind beside `kl_dev_` and `kl_agt_`). */
export const PUBLISHABLE_KEY_PREFIX = "kl_pub_";
export const PUBLISHABLE_KEY_PATTERN = /^kl_pub_[0-9A-Za-z]{32}$/u;

/** Request header the `/embed` frame sends with the bridge-proven host origin. */
export const HOST_ORIGIN_HEADER = "Kletia-Host-Origin";

/** Where a project proves its website: `{ "projects": ["prj_…"] }`. */
export const PROJECT_DOMAIN_FILE = "/.well-known/kletia.json";

/** Stored flow ids. */
export const PROJECT_FLOW_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;

export const PROJECT_ACTIONS = Object.freeze(["swap", "bridge", "transfer", "stake", "deposit", "withdraw"] as const);
export type ProjectAction = (typeof PROJECT_ACTIONS)[number];

export type ProjectLane = "production" | "testnet";

export const PROJECT_LIMITS = Object.freeze({
  allowedOrigins: 20,
  examples: 6,
  exampleLength: 120,
  flows: 20,
  flowLabel: 80,
  activePublishableKeys: 5,
  /** Requests per minute per publishable key (the public per-IP limit counts too). */
  publishableRatePerMinute: 120,
  /** A session minted from a flow. */
  flowSessionTtlSeconds: 600,
  flowSessionMaxIntents: 1,
  /** Domain proof file read by the guarded fetcher. */
  domainFileBytes: 16_384,
  logoBytes: 65_536,
  logoMinPx: 32,
  logoMaxPx: 512,
  /** Width / height between 1:1 and 4:1. */
  logoMaxAspect: 4,
});

/** Logo content types (PNG and WebP only: no SVG, no GIF, no animation). */
export const PROJECT_LOGO_TYPES = Object.freeze(["image/png", "image/webp"] as const);
export type ProjectLogoType = (typeof PROJECT_LOGO_TYPES)[number];

export interface ProjectDefaults {
  readonly lane?: ProjectLane;
  readonly networks?: readonly NetworkKey[];
  /** Where the money starts by default: a network or "auto" (console departure). */
  readonly sourceNetwork?: SourceNetwork;
  readonly actions?: readonly ProjectAction[];
  /** At most 6 examples of at most 120 characters. */
  readonly examples?: readonly string[];
  readonly appearance?: KletiaAppearance;
}

/** A stored session template: structured actions only, validated like POST /v1/sessions. */
export interface ProjectFlow {
  /** ^[a-z][a-z0-9-]{0,31}$ */
  readonly id: string;
  /** At most 80 characters. */
  readonly label: string;
  readonly actions: readonly IntentActionSpec[];
  readonly amount?: SessionAmountBounds;
  readonly constraints?: IntentConstraints;
}

export interface ProjectSettingsInput {
  readonly schema: typeof PROJECT_SCHEMA;
  /** Same name rules as integrator.name; website is an https origin. */
  readonly brand?: { readonly name: string; readonly website?: string };
  /** At most 20: https origins, http://localhost:<port> for development. */
  readonly allowedOrigins?: readonly string[];
  readonly defaults?: ProjectDefaults;
  /** At most 20 stored session templates. */
  readonly flows?: readonly ProjectFlow[];
}

export interface ProjectDomain {
  readonly host: string | null;
  readonly verified: boolean;
  readonly checkedAt: string | null;
  /** The JSON to publish at PROJECT_DOMAIN_FILE. */
  readonly file: string;
}

export interface ProjectView {
  readonly id: string;
  readonly version: number;
  /** sha256 of the canonical settings (the If-Match value). */
  readonly hash: string;
  readonly settings: Omit<ProjectSettingsInput, "flows"> & {
    readonly flows?: readonly (ProjectFlow & { readonly ownerKeyId: string })[];
  };
  readonly domain: ProjectDomain;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

/** What a publishable key reveals (GET /v1/publishable/profile). */
export interface ProjectProfile {
  readonly projectId: string;
  readonly brand: { readonly name: string; readonly host: string | null; readonly verified: boolean } | null;
  readonly allowedOrigins: readonly string[];
  readonly lane: ProjectLane;
  readonly defaults: Omit<ProjectDefaults, "lane">;
  readonly flows: readonly { readonly id: string; readonly label: string; readonly networks: readonly NetworkKey[] }[];
}
