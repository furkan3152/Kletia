/**
 * Projects, publishable keys and flows (integrator design 4.8, phase 2).
 *
 * - Settings (`kletia.project/v1`), one row per project (`prj_…`): brand,
 *   allowed origins, defaults and at most 20 stored flows. GET
 *   /v1/projects/current (any key of the project); PATCH with
 *   `If-Match: "<hash>"` (a project key with its current secret) merge-patches
 *   them (`null` removes), validates the result (400 PROJECT_SETTINGS_INVALID
 *   with issues) and refuses a stale hash (409 PROJECT_CONFLICT). A new or
 *   changed flow is dry-run like a session template, owned by the saving key,
 *   which becomes the flow's contract authority (`ownerKeyId`).
 * - Domain proof: POST /v1/projects/current/domain/verify fetches
 *   `https://<brand.website>/.well-known/kletia.json` through the guarded
 *   fetcher (16 KB, no redirects, public hosts only) and checks that it lists
 *   the project; the contract watcher re-checks verified domains daily.
 * - Publishable keys: POST /v1/projects/current/publishable-keys issues a
 *   `kl_pub_` key (shown once, at most 5 active) under the calling project
 *   key with a rule book derived from the project defaults.
 * - The publishable guard (router, after authentication and the tier
 *   limiter): a publishable key may call only the routes marked
 *   `publishable` (403 PUBLISHABLE_KEY_FORBIDDEN otherwise); every request
 *   also counts against the public per-IP limit and must come from an
 *   allowed origin: `Origin` in `allowedOrigins`, or a Kletia first-party
 *   `Origin` with `Kletia-Host-Origin` in `allowedOrigins` (the `/embed`
 *   frame), else 403 PUBLISHABLE_ORIGIN_FORBIDDEN.
 * - GET /v1/publishable/profile: what the key reveals (`ProjectProfile`).
 * - POST /v1/sessions with a publishable key: `{ flow, hostOrigin }` only; a
 *   single-use 600 s session from the stored flow (404 FLOW_UNKNOWN).
 * - Logo: PUT / DELETE /v1/projects/current/logo (PNG or WebP, header
 *   checks in projects/logo.ts); GET /v1/projects/{projectId}/logo/{sha256}.{ext}
 *   serves it with fixed headers, only while the domain is verified.
 * - Publishable keys never reach registered contracts on their own: the
 *   installed contract directory refuses them (text intents get
 *   CONTRACT_UNKNOWN); flow sessions resolve against the flow's saver.
 *
 * Storage: memory, or Postgres `kletia_projects` and `kletia_project_logos`.
 */
import type { RequestHandler, Response } from "express";
import {
  canonicalJson,
  CONTRACT_ACTION_KINDS,
  domainFileListsProject,
  flowNetworks,
  mergeProjectPatch,
  normalizeProjectOrigin,
  normalizeWebOrigin,
  PROJECT_DOMAIN_FILE,
  PROJECT_FLOW_ID_PATTERN,
  PROJECT_LIMITS,
  PROJECT_SCHEMA,
  projectDomainFile,
  projectSettingsHash,
  validatePolicy,
  type IntentActionKind,
  type NetworkKey,
  type PolicyDocument,
  type ProjectFlow,
  type ProjectLogoType,
  type ProjectLogoView,
  type ProjectProfile,
  type ProjectView,
  type SessionView,
} from "@kletia/core";
import { configureContractDirectory, contractDirectory, type ContractDirectory } from "../index.js";
import { PlatformError, isPlatformError, type PlatformIssue } from "../errors.js";
import { allowedOrigins as firstPartyOrigins } from "../../shared/http/cors.js";
import { guardedJsonRequest } from "./actionTransport.js";
import { apiKeyStore, keyKindOf } from "./auth.js";
import { authOf, HttpError, invalidRequest, isRecord, sendError, type AuthContext } from "./context.js";
import { dbQuery, dbTransaction, platformDatabaseUrl } from "./db.js";
import { issueProjectPublishableKey, publishableForbidden } from "./keys.js";
import { takePublishableAddress } from "./limits.js";
import { agentForbidden } from "./policies/agentGuard.js";
import { projectScope } from "./policies/store.js";
import { checkLogo, logoExtension, logoInvalid } from "./projects/logo.js";
import { createTemplateSession, prepareSessionTemplate, type SessionIntegrator } from "./sessions.js";
import { kletiaWebOrigin } from "./webOrigin.js";

/* ================================================================= model */

type StoredSettings = ProjectView["settings"];
type StoredFlow = NonNullable<StoredSettings["flows"]>[number];

export interface StoredLogo {
  readonly sha256: string;
  readonly contentType: ProjectLogoType;
  readonly width: number;
  readonly height: number;
}

export interface ProjectRecord {
  /** Raw project id (the project key's id); the API shows `prj_…`. */
  readonly projectId: string;
  readonly version: number;
  readonly settings: StoredSettings;
  readonly domain: { readonly host: string | null; readonly verified: boolean; readonly checkedAt: string | null };
  readonly logo: StoredLogo | null;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface ProjectStore {
  readonly kind: "memory" | "postgres";
  get(projectId: string): Promise<ProjectRecord | null>;
  /**
   * Writes settings when the stored version still is `expectedVersion` (0:
   * no row yet). False when another write won (409 PROJECT_CONFLICT).
   */
  put(record: ProjectRecord, expectedVersion: number): Promise<boolean>;
  /** Records a domain check; ignored when the host changed meanwhile. */
  setDomain(projectId: string, host: string, verified: boolean, checkedAt: string): Promise<void>;
  /** Projects with a website whose domain check is older than `before` (or never ran), oldest first. */
  dueForDomainCheck(before: string, limit: number): Promise<ProjectRecord[]>;
  /** Stores (or with null removes) the logo; the record's `logo` follows. */
  setLogo(projectId: string, logo: (StoredLogo & { readonly bytes: Buffer }) | null, at: string, by: string): Promise<void>;
  logoBytes(projectId: string, sha256: string): Promise<{ readonly contentType: ProjectLogoType; readonly bytes: Buffer } | null>;
}

function emptyRecord(projectId: string): ProjectRecord {
  return { projectId, version: 0, settings: { schema: PROJECT_SCHEMA }, domain: { host: null, verified: false, checkedAt: null }, logo: null, updatedAt: new Date(0).toISOString(), updatedBy: "" };
}

export class MemoryProjectStore implements ProjectStore {
  readonly kind = "memory" as const;
  private readonly records = new Map<string, ProjectRecord>();
  private readonly logos = new Map<string, { readonly sha256: string; readonly contentType: ProjectLogoType; readonly bytes: Buffer }>();

  async get(projectId: string): Promise<ProjectRecord | null> {
    return this.records.get(projectId) ?? null;
  }

  async put(record: ProjectRecord, expectedVersion: number): Promise<boolean> {
    const current = this.records.get(record.projectId);
    if ((current?.version ?? 0) !== expectedVersion) return false;
    this.records.set(record.projectId, { ...record, logo: current?.logo ?? null });
    return true;
  }

  async setDomain(projectId: string, host: string, verified: boolean, checkedAt: string): Promise<void> {
    const current = this.records.get(projectId);
    if (!current || current.domain.host !== host) return;
    this.records.set(projectId, { ...current, domain: { host, verified, checkedAt } });
  }

  async dueForDomainCheck(before: string, limit: number): Promise<ProjectRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.domain.host !== null && (record.domain.checkedAt === null || record.domain.checkedAt < before))
      .sort((a, b) => ((a.domain.checkedAt ?? "") < (b.domain.checkedAt ?? "") ? -1 : 1))
      .slice(0, limit);
  }

  async setLogo(projectId: string, logo: (StoredLogo & { readonly bytes: Buffer }) | null, at: string, by: string): Promise<void> {
    const current = this.records.get(projectId) ?? emptyRecord(projectId);
    if (logo) this.logos.set(projectId, { sha256: logo.sha256, contentType: logo.contentType, bytes: Buffer.from(logo.bytes) });
    else this.logos.delete(projectId);
    const meta: StoredLogo | null = logo ? { sha256: logo.sha256, contentType: logo.contentType, width: logo.width, height: logo.height } : null;
    this.records.set(projectId, { ...current, logo: meta, updatedAt: at, updatedBy: by });
  }

  async logoBytes(projectId: string, sha256: string): Promise<{ readonly contentType: ProjectLogoType; readonly bytes: Buffer } | null> {
    const logo = this.logos.get(projectId);
    return logo && logo.sha256 === sha256 ? { contentType: logo.contentType, bytes: logo.bytes } : null;
  }
}

const PROJECTS_SCHEMA = {
  name: "kletia_projects",
  ddl: `
CREATE TABLE IF NOT EXISTS kletia_projects (
  project_id text PRIMARY KEY,
  version integer NOT NULL,
  settings jsonb NOT NULL,
  domain_host text,
  domain_verified boolean NOT NULL DEFAULT false,
  domain_checked_at timestamptz,
  logo jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL
);
CREATE INDEX IF NOT EXISTS kletia_projects_domain_idx ON kletia_projects (domain_checked_at NULLS FIRST) WHERE domain_host IS NOT NULL;
CREATE TABLE IF NOT EXISTS kletia_project_logos (
  project_id text PRIMARY KEY,
  sha256 text NOT NULL,
  content_type text NOT NULL CHECK (content_type IN ('image/png', 'image/webp')),
  bytes bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);`,
} as const;

interface ProjectRow {
  project_id: string;
  version: number;
  settings: unknown;
  domain_host: string | null;
  domain_verified: boolean;
  domain_checked_at: Date | string | null;
  logo: unknown;
  updated_at: Date | string;
  updated_by: string;
}

const PROJECT_COLUMNS = "project_id, version, settings, domain_host, domain_verified, domain_checked_at, logo, updated_at, updated_by";

function isoOf(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function recordFromRow(row: ProjectRow): ProjectRecord {
  const logo = isRecord(row.logo) && typeof row.logo.sha256 === "string" ? (row.logo as unknown as StoredLogo) : null;
  return {
    projectId: row.project_id,
    version: row.version,
    settings: (isRecord(row.settings) ? row.settings : { schema: PROJECT_SCHEMA }) as unknown as StoredSettings,
    domain: { host: row.domain_host, verified: row.domain_verified === true, checkedAt: isoOf(row.domain_checked_at) },
    logo,
    updatedAt: isoOf(row.updated_at) ?? new Date(0).toISOString(),
    updatedBy: row.updated_by,
  };
}

export class PostgresProjectStore implements ProjectStore {
  readonly kind = "postgres" as const;

  async get(projectId: string): Promise<ProjectRecord | null> {
    const result = await dbQuery<ProjectRow>(PROJECTS_SCHEMA, `SELECT ${PROJECT_COLUMNS} FROM kletia_projects WHERE project_id = $1`, [projectId]);
    const row = result.rows[0];
    return row ? recordFromRow(row) : null;
  }

  async put(record: ProjectRecord, expectedVersion: number): Promise<boolean> {
    const values = [record.projectId, record.version, JSON.stringify(record.settings), record.domain.host, record.domain.verified, record.domain.checkedAt, record.updatedAt, record.updatedBy, expectedVersion];
    // One statement: inserted when no row exists and 0 was expected, updated only from the expected version.
    const result = await dbQuery(
      PROJECTS_SCHEMA,
      `INSERT INTO kletia_projects (project_id, version, settings, domain_host, domain_verified, domain_checked_at, updated_at, updated_by)
       SELECT $1, $2, $3::jsonb, $4, $5, $6, $7, $8 WHERE $9::integer = 0
       ON CONFLICT (project_id) DO UPDATE SET
         version = EXCLUDED.version, settings = EXCLUDED.settings, domain_host = EXCLUDED.domain_host,
         domain_verified = EXCLUDED.domain_verified, domain_checked_at = EXCLUDED.domain_checked_at,
         updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by
       WHERE kletia_projects.version = $9::integer`,
      values,
    );
    if (result.rowCount === 1) return true;
    if (expectedVersion === 0) return false;
    const updated = await dbQuery(
      PROJECTS_SCHEMA,
      `UPDATE kletia_projects SET version = $2, settings = $3::jsonb, domain_host = $4, domain_verified = $5, domain_checked_at = $6, updated_at = $7, updated_by = $8
       WHERE project_id = $1 AND version = $9::integer`,
      values,
    );
    return updated.rowCount === 1;
  }

  async setDomain(projectId: string, host: string, verified: boolean, checkedAt: string): Promise<void> {
    await dbQuery(
      PROJECTS_SCHEMA,
      "UPDATE kletia_projects SET domain_verified = $3, domain_checked_at = $4 WHERE project_id = $1 AND domain_host = $2",
      [projectId, host, verified, checkedAt],
    );
  }

  async dueForDomainCheck(before: string, limit: number): Promise<ProjectRecord[]> {
    const result = await dbQuery<ProjectRow>(
      PROJECTS_SCHEMA,
      `SELECT ${PROJECT_COLUMNS} FROM kletia_projects
       WHERE domain_host IS NOT NULL AND (domain_checked_at IS NULL OR domain_checked_at < $1)
       ORDER BY domain_checked_at ASC NULLS FIRST LIMIT $2`,
      [before, limit],
    );
    return result.rows.map(recordFromRow);
  }

  async setLogo(projectId: string, logo: (StoredLogo & { readonly bytes: Buffer }) | null, at: string, by: string): Promise<void> {
    await dbTransaction(PROJECTS_SCHEMA, async (client) => {
      await client.query(
        `INSERT INTO kletia_projects (project_id, version, settings, updated_at, updated_by) VALUES ($1, 0, $2::jsonb, $3, $4)
         ON CONFLICT (project_id) DO NOTHING`,
        [projectId, JSON.stringify({ schema: PROJECT_SCHEMA }), at, by],
      );
      if (logo) {
        await client.query(
          `INSERT INTO kletia_project_logos (project_id, sha256, content_type, bytes) VALUES ($1, $2, $3, $4)
           ON CONFLICT (project_id) DO UPDATE SET sha256 = EXCLUDED.sha256, content_type = EXCLUDED.content_type, bytes = EXCLUDED.bytes, created_at = now()`,
          [projectId, logo.sha256, logo.contentType, logo.bytes],
        );
      } else {
        await client.query("DELETE FROM kletia_project_logos WHERE project_id = $1", [projectId]);
      }
      const meta = logo ? { sha256: logo.sha256, contentType: logo.contentType, width: logo.width, height: logo.height } : null;
      await client.query("UPDATE kletia_projects SET logo = $2::jsonb, updated_at = $3, updated_by = $4 WHERE project_id = $1", [projectId, meta ? JSON.stringify(meta) : null, at, by]);
    });
  }

  async logoBytes(projectId: string, sha256: string): Promise<{ readonly contentType: ProjectLogoType; readonly bytes: Buffer } | null> {
    const result = await dbQuery<{ content_type: string; bytes: Buffer }>(
      PROJECTS_SCHEMA,
      "SELECT content_type, bytes FROM kletia_project_logos WHERE project_id = $1 AND sha256 = $2",
      [projectId, sha256],
    );
    const row = result.rows[0];
    if (!row || (row.content_type !== "image/png" && row.content_type !== "image/webp")) return null;
    return { contentType: row.content_type, bytes: row.bytes };
  }
}

let store: ProjectStore | null = null;

export function projectStore(): ProjectStore {
  store ??= platformDatabaseUrl() ? new PostgresProjectStore() : new MemoryProjectStore();
  return store;
}

/* ============================================================ test seams */

export interface ProjectChecks {
  /** True when `https://<website>/.well-known/kletia.json` lists `projectId`. */
  domain(website: string, projectId: string): Promise<boolean>;
}

async function domainListsProject(website: string, projectId: string): Promise<boolean> {
  // Default https port only (fail closed for a legacy website that carries a port).
  const origin = normalizeWebOrigin(website);
  if (!origin) return false;
  try {
    const response = await guardedJsonRequest(`${origin}${PROJECT_DOMAIN_FILE}`, { method: "GET", maxBytes: PROJECT_LIMITS.domainFileBytes, timeoutMs: 5_000 });
    return response.status === 200 && domainFileListsProject(response.json, projectId);
  } catch {
    return false;
  }
}

const DEFAULT_CHECKS: ProjectChecks = { domain: domainListsProject };
let checks: ProjectChecks = DEFAULT_CHECKS;

/** Replaces the domain check (tests, local stacks); null restores the guarded fetcher. */
export function configureProjectChecks(next: Partial<ProjectChecks> | null): void {
  checks = next ? { ...DEFAULT_CHECKS, ...next } : DEFAULT_CHECKS;
}

/* ================================================================ views */

/** Short-lived settings cache for the publishable guard (15 s, like verified keys; local writes refresh it). */
const SETTINGS_CACHE_MS = 15_000;
const settingsCache = new Map<string, { readonly record: ProjectRecord; readonly expiresAt: number }>();

async function cachedRecord(projectId: string): Promise<ProjectRecord> {
  const now = Date.now();
  const cached = settingsCache.get(projectId);
  if (cached && cached.expiresAt > now) return cached.record;
  const record = (await projectStore().get(projectId)) ?? emptyRecord(projectId);
  settingsCache.delete(projectId);
  settingsCache.set(projectId, { record, expiresAt: now + SETTINGS_CACHE_MS });
  while (settingsCache.size > 10_000) {
    const oldest = settingsCache.keys().next().value;
    if (oldest === undefined) break;
    settingsCache.delete(oldest);
  }
  return record;
}

function forgetCachedProject(projectId: string): void {
  settingsCache.delete(projectId);
}

/**
 * The domain record's key: `url.host`, so a non-default port stays part of it
 * (a proof on `acme.example:8443` never counts for `acme.example`).
 */
function hostOf(settings: StoredSettings): string | null {
  const website = settings.brand?.website;
  return website ? new URL(website).host : null;
}

function logoView(projectId: string, logo: StoredLogo | null): ProjectLogoView | null {
  if (!logo) return null;
  return {
    url: `/v1/projects/${projectScope(projectId)}/logo/${logo.sha256}.${logoExtension(logo.contentType)}`,
    sha256: logo.sha256,
    contentType: logo.contentType,
    width: logo.width,
    height: logo.height,
  };
}

export function projectView(record: ProjectRecord): ProjectView {
  const id = projectScope(record.projectId);
  return {
    id,
    version: record.version,
    hash: projectSettingsHash(record.settings),
    settings: record.settings,
    domain: { host: record.domain.host, verified: record.domain.verified, checkedAt: record.domain.checkedAt, file: projectDomainFile(id) },
    logo: logoView(record.projectId, record.logo),
    updatedAt: record.updatedAt,
    updatedBy: record.updatedBy,
  };
}

/** The lane a project runs on: its default lane, else `any` (both lanes; the name key lists use). */
function laneOf(settings: StoredSettings): ProjectProfile["lane"] {
  return settings.defaults?.lane ?? "any";
}

/**
 * `defaults.lane: "any"` (the name key lists and the profile use for both
 * lanes) is accepted in a patch and stored as no lane (merge patch null).
 */
function normalizeLanePatch(body: unknown): unknown {
  if (!isRecord(body) || !isRecord(body.defaults) || body.defaults.lane !== "any") return body;
  return { ...body, defaults: { ...body.defaults, lane: null } };
}

/** What a publishable key reveals (GET /v1/publishable/profile): never keys, flow contents or who saved them. */
export function projectProfile(record: ProjectRecord): ProjectProfile {
  const { settings } = record;
  const { lane: _lane, ...defaults } = settings.defaults ?? {};
  const verified = record.domain.verified && record.domain.host !== null && record.domain.host === hostOf(settings);
  return {
    projectId: projectScope(record.projectId),
    brand: settings.brand
      ? {
          name: settings.brand.name,
          host: hostOf(settings),
          verified,
          // The logo is part of the brand only once the domain proves it.
          ...(verified ? { logo: logoView(record.projectId, record.logo) } : {}),
        }
      : null,
    allowedOrigins: settings.allowedOrigins ?? [],
    lane: laneOf(settings),
    defaults,
    flows: (settings.flows ?? []).map((flow) => ({ id: flow.id, label: flow.label, networks: flowNetworks(flow) })),
  };
}

/* ============================================================== callers */

interface ProjectCaller {
  readonly keyId: string;
  readonly projectId: string;
}

function operatorRefusal(): PlatformError {
  return new PlatformError("KEY_NOT_MANAGEABLE", "Operator keys have no project; project settings belong to projects and their keys.", 409);
}

/** Any key of the project (agent keys read too). */
function projectReader(auth: AuthContext): ProjectCaller {
  if (auth.tier === "operator") throw operatorRefusal();
  if (auth.keyKind === "publishable") throw publishableForbidden("Publishable keys read GET /v1/publishable/profile, not the project settings.");
  if (!auth.keyId || !auth.projectId) throw new HttpError(401, "API_KEY_REQUIRED", "Project settings require an API key of the project.");
  return { keyId: auth.keyId, projectId: auth.projectId };
}

/** Writes: a project key of the project with its current secret. */
function projectWriter(auth: AuthContext): ProjectCaller {
  const caller = projectReader(auth);
  if (auth.keyKind === "agent") throw agentForbidden("Agent keys never change project settings. Use a project key.");
  if (auth.viaPreviousSecret) {
    throw new PlatformError("KEY_SECRET_ROTATED", "This secret was rotated and only authenticates until its grace window ends. Change project settings with the current secret.", 403);
  }
  return caller;
}

function settingsInvalid(issues: readonly PlatformIssue[], message = "The project settings are invalid; fix the fields listed in issues."): PlatformError {
  return new PlatformError("PROJECT_SETTINGS_INVALID", message, 400, issues.slice(0, 20));
}

function projectConflict(): PlatformError {
  return new PlatformError("PROJECT_CONFLICT", "The project changed since the version your If-Match names. Read it again (GET /v1/projects/current) and resend the change.", 409);
}

/** `If-Match: "<hash>"` (quotes and the `sha256:` prefix optional); null when absent. */
export function parseIfMatch(header: string | undefined): string | null {
  if (header === undefined) return null;
  const value = header.trim().replace(/^W\//u, "").replace(/^"(.*)"$/u, "$1");
  const match = /^(?:sha256:)?([0-9a-f]{64})$/u.exec(value);
  if (!match) throw invalidRequest("If-Match must be the project's hash from GET /v1/projects/current.", [{ path: "If-Match", message: "Invalid hash." }]);
  return `sha256:${match[1] as string}`;
}

/* ================================================================ routes */

/** GET /v1/projects/current. */
export async function getProject(auth: AuthContext): Promise<ProjectView> {
  const caller = projectReader(auth);
  return projectView((await projectStore().get(caller.projectId)) ?? emptyRecord(caller.projectId));
}

/** A flow without the server-set field, for comparing what the caller sent with what is stored. */
function flowContent(flow: ProjectFlow): string {
  const { id, label, actions, amount, constraints } = flow;
  return canonicalJson({ id, label, actions, amount, constraints });
}

/**
 * Dry-runs a new or changed flow like a session template, owned by the
 * saving key (whose registrations it calls); template errors become issues
 * at `flows[index]`.
 */
async function checkFlow(flow: ProjectFlow, index: number, saver: string): Promise<StoredFlow> {
  try {
    const prepared = await prepareSessionTemplate(flow, { ownerKeyId: saver, contractKeyId: saver }, Date.now());
    return { ...flow, actions: prepared.actions, ownerKeyId: saver };
  } catch (error) {
    if (isPlatformError(error) && error.status < 500) {
      const issues = (error.issues ?? []).map((issue) => ({ path: `flows[${index}]${issue.path ? `.${issue.path}` : ""}`, message: `${error.code}: ${issue.message}` }));
      throw settingsInvalid(issues.length > 0 ? issues : [{ path: `flows[${index}]`, message: `${error.code}: ${error.message}` }], `Flow ${flow.id} cannot run: ${error.message}`);
    }
    throw error;
  }
}

/** PATCH /v1/projects/current: merge patch under If-Match. */
export async function patchProject(auth: AuthContext, ifMatchHeader: string | undefined, body: unknown): Promise<ProjectView> {
  const caller = projectWriter(auth);
  const ifMatch = parseIfMatch(ifMatchHeader);
  if (ifMatch === null) {
    throw invalidRequest("Send If-Match with the project's hash (GET /v1/projects/current) so a concurrent change is never overwritten.", [{ path: "If-Match", message: "Required." }]);
  }
  const current = (await projectStore().get(caller.projectId)) ?? emptyRecord(caller.projectId);
  if (projectSettingsHash(current.settings) !== ifMatch) throw projectConflict();
  const merged = mergeProjectPatch(current.version === 0 ? null : current.settings, normalizeLanePatch(body));
  if (!merged.ok) throw settingsInvalid(merged.issues);
  const next = merged.value;
  // Flows: unchanged ones keep their saver; new or changed ones are dry-run and saved by the caller.
  const previous = new Map((current.settings.flows ?? []).map((flow) => [flow.id, flow]));
  const flows: StoredFlow[] = [];
  for (const [index, flow] of (next.flows ?? []).entries()) {
    const stored = previous.get(flow.id);
    flows.push(stored && flowContent(stored) === flowContent(flow) ? stored : await checkFlow(flow, index, caller.keyId));
  }
  const { flows: _sent, ...rest } = next;
  const settings: StoredSettings = { ...rest, ...(next.flows ? { flows } : {}) };
  const host = hostOf(settings);
  const now = new Date().toISOString();
  const record: ProjectRecord = {
    projectId: caller.projectId,
    version: current.version + 1,
    settings,
    // A new website starts unverified; the same host keeps its last check.
    domain: host !== null && host === current.domain.host ? current.domain : { host, verified: false, checkedAt: null },
    logo: current.logo,
    updatedAt: now,
    updatedBy: caller.keyId,
  };
  if (!(await projectStore().put(record, current.version))) throw projectConflict();
  forgetCachedProject(caller.projectId);
  return projectView(record);
}

/** Checks one project's domain file now and records the result. */
async function checkDomain(record: ProjectRecord): Promise<boolean | null> {
  const website = record.settings.brand?.website;
  const host = hostOf(record.settings);
  if (!website || !host) return null;
  const verified = await checks.domain(website, projectScope(record.projectId));
  await projectStore().setDomain(record.projectId, host, verified, new Date().toISOString());
  forgetCachedProject(record.projectId);
  return verified;
}

/** POST /v1/projects/current/domain/verify. */
export async function verifyProjectDomain(auth: AuthContext): Promise<ProjectView> {
  const caller = projectWriter(auth);
  const record = await projectStore().get(caller.projectId);
  if (!record?.settings.brand?.website) {
    throw settingsInvalid([{ path: "brand.website", message: "Required: the website whose /.well-known/kletia.json lists this project." }], "Set brand.website first (PATCH /v1/projects/current).");
  }
  await checkDomain(record);
  return projectView((await projectStore().get(caller.projectId)) ?? record);
}

/** Daily re-check of project domains (contract watcher). Returns how many were checked. Never throws. */
export async function recheckProjectDomains(intervalMs: number, limit: number): Promise<number> {
  let due: ProjectRecord[] = [];
  try {
    due = await projectStore().dueForDomainCheck(new Date(Date.now() - intervalMs).toISOString(), limit);
  } catch (error) {
    console.warn("[platform] project domain listing failed:", error instanceof Error ? error.message : error);
    return 0;
  }
  let checked = 0;
  for (const record of due) {
    try {
      if ((await checkDomain(record)) !== null) checked += 1;
    } catch (error) {
      console.warn(`[platform] project domain check of ${record.projectId} failed:`, error instanceof Error ? error.message : error);
    }
  }
  return checked;
}

/* -------------------------------------------------------- publishable keys */

const KIND_OF_ACTION: Readonly<Record<string, IntentActionKind>> = Object.freeze({
  swap: "swap",
  bridge: "bridge",
  transfer: "transfer",
  stake: "stake",
  deposit: "deposit",
  withdraw: "withdraw",
});

/**
 * The first rule book of a publishable key, derived from the project defaults
 * (integrator design 4.8): `kinds.allow` from `defaults.actions`,
 * `networks.allow` from `defaults.networks`, `networks.lanes` from
 * `defaults.lane`, `permissions.storeIntents`. The flows stored at issuance
 * are added (their kinds, networks and, for contract steps, their
 * registrations in `contracts.allow`), so the key can run them; later flows
 * need a rule book update (PUT /v1/keys/{id}/policy).
 */
export function publishableRuleBook(settings: StoredSettings): PolicyDocument {
  const defaults = settings.defaults ?? {};
  const flows = settings.flows ?? [];
  const flowKinds = flows.flatMap((flow) => flow.actions.map((action) => action.kind));
  const flowNetworkList = flows.flatMap((flow) => flowNetworks(flow));
  const contracts = new Map<string, Set<string>>();
  for (const flow of flows) {
    for (const action of flow.actions) {
      if (!CONTRACT_ACTION_KINDS.includes(action.kind) || !action.contract) continue;
      const entries = contracts.get(action.contract) ?? new Set<string>();
      if (action.entry) entries.add(action.entry);
      contracts.set(action.contract, entries);
    }
  }
  const kinds = defaults.actions ? [...new Set([...defaults.actions.map((action) => KIND_OF_ACTION[action] as IntentActionKind), ...flowKinds])] : null;
  const networks: NetworkKey[] | null = defaults.networks ? [...new Set([...defaults.networks, ...flowNetworkList])] : null;
  const document = {
    schema: "kletia.policy/v1",
    label: "Publishable key (project defaults)",
    ...(networks || defaults.lane ? { networks: { ...(networks ? { allow: networks } : {}), ...(defaults.lane ? { lanes: [defaults.lane] } : {}) } } : {}),
    ...(kinds ? { kinds: { allow: kinds } } : {}),
    ...(contracts.size > 0 ? { contracts: { allow: [...contracts].map(([id, entries]) => ({ id, ...(entries.size > 0 ? { entries: [...entries] } : {}) })) } } : {}),
    permissions: { storeIntents: true },
  };
  const result = validatePolicy(document, { defaults: "project" });
  if (!result.ok) {
    throw settingsInvalid(result.issues.map((issue) => ({ path: `defaults (rule book ${issue.path})`, message: issue.message })), "The project defaults do not make a valid rule book for a publishable key.");
  }
  return result.value;
}

/** `{ label }`: 1-80 printable characters. */
export function parsePublishableKeyRequest(body: unknown): { readonly label: string } {
  const label = isRecord(body) && typeof body.label === "string" ? body.label.trim() : "";
  if (!isRecord(body) || Object.keys(body).some((key) => key !== "label") || !label || label.length > 80 || /[\p{Cc}\p{Cf}]/u.test(label)) {
    throw invalidRequest("Body must be { \"label\": \"…\" } with 1-80 printable characters.", [{ path: "label", message: "Required, 1-80 printable characters." }]);
  }
  return { label };
}

/** POST /v1/projects/current/publishable-keys. */
export async function createPublishableKey(auth: AuthContext, body: unknown): Promise<Awaited<ReturnType<typeof issueProjectPublishableKey>>> {
  const caller = projectWriter(auth);
  const { label } = parsePublishableKeyRequest(body);
  const record = (await projectStore().get(caller.projectId)) ?? emptyRecord(caller.projectId);
  return issueProjectPublishableKey(auth, label, publishableRuleBook(record.settings));
}

/** GET /v1/publishable/profile (publishable keys; other keys of the project may read it too). */
export async function publishableProfile(auth: AuthContext): Promise<ProjectProfile> {
  if (auth.tier === "operator") throw operatorRefusal();
  if (!auth.keyId || !auth.projectId) throw new HttpError(401, "API_KEY_REQUIRED", "The profile is read with a publishable key (Authorization: Bearer kl_pub_…).");
  return projectProfile(await cachedRecord(auth.projectId));
}

/* ---------------------------------------------------------- flow sessions */

/** POST /v1/sessions with a publishable key: `{ flow, hostOrigin }` only. */
export async function createFlowSession(auth: AuthContext, body: unknown): Promise<SessionView> {
  if (auth.keyKind !== "publishable" || !auth.keyId || !auth.projectId) throw publishableForbidden("Flow sessions are started with a publishable key.");
  if (!isRecord(body) || Object.keys(body).some((key) => key !== "flow" && key !== "hostOrigin")) {
    throw publishableForbidden("A publishable key creates sessions only from a stored flow: send { flow, hostOrigin }.");
  }
  if (typeof body.flow !== "string" || !PROJECT_FLOW_ID_PATTERN.test(body.flow)) {
    throw invalidRequest("flow must be the id of a stored flow.", [{ path: "flow", message: `Must match ${PROJECT_FLOW_ID_PATTERN.source}.` }]);
  }
  const hostOrigin = normalizeProjectOrigin(body.hostOrigin);
  if (!hostOrigin) throw invalidRequest("hostOrigin must be the origin of the page hosting the widget.", [{ path: "hostOrigin", message: "Required origin." }]);
  // A fresh read: a flow removed a moment ago never starts again.
  const record = (await projectStore().get(auth.projectId)) ?? emptyRecord(auth.projectId);
  const settings = record.settings;
  const allowed = settings.allowedOrigins ?? [];
  if (!allowed.includes(hostOrigin)) throw originForbidden(hostOrigin);
  const flow = (settings.flows ?? []).find((candidate) => candidate.id === body.flow);
  if (!flow) throw new PlatformError("FLOW_UNKNOWN", `This project has no flow "${body.flow}". GET /v1/publishable/profile lists them.`, 404, [{ path: "flow", message: "Unknown flow." }]);
  const verified = record.domain.verified && record.domain.host !== null && record.domain.host === hostOf(settings);
  const integrator: SessionIntegrator = settings.brand && verified
    ? { name: settings.brand.name, ...(settings.brand.website ? { website: settings.brand.website } : {}), domainVerified: true }
    : { name: new URL(hostOrigin).hostname, domainVerified: false };
  return createTemplateSession({
    ownerKeyId: auth.keyId,
    contractAuthorityKeyId: flow.ownerKeyId,
    integrator,
    request: {
      actions: flow.actions,
      ...(flow.amount ? { amount: flow.amount } : {}),
      ...(flow.constraints ? { constraints: flow.constraints } : {}),
      allowedOrigins: allowed,
      expiresInSeconds: PROJECT_LIMITS.flowSessionTtlSeconds,
      maxIntents: PROJECT_LIMITS.flowSessionMaxIntents,
    },
  });
}

/* ------------------------------------------------------------------ logo */

/** PUT /v1/projects/current/logo (raw image/png or image/webp body). */
export async function putProjectLogo(auth: AuthContext, body: unknown, contentType: string | undefined): Promise<ProjectView> {
  const caller = projectWriter(auth);
  if (!Buffer.isBuffer(body)) throw logoInvalid("Send the logo bytes as the request body with Content-Type image/png or image/webp.");
  const logo = checkLogo(body, contentType);
  await projectStore().setLogo(caller.projectId, logo, new Date().toISOString(), caller.keyId);
  forgetCachedProject(caller.projectId);
  return projectView((await projectStore().get(caller.projectId)) ?? emptyRecord(caller.projectId));
}

/** DELETE /v1/projects/current/logo. */
export async function deleteProjectLogo(auth: AuthContext): Promise<void> {
  const caller = projectWriter(auth);
  await projectStore().setLogo(caller.projectId, null, new Date().toISOString(), caller.keyId);
  forgetCachedProject(caller.projectId);
}

const LOGO_FILE = /^([0-9a-f]{64})\.(png|webp)$/u;

/** GET /v1/projects/{projectId}/logo/{sha256}.{png|webp}: fixed headers, 404 unless the domain is verified. */
export async function serveProjectLogo(res: Response, projectParam: string, file: string): Promise<void> {
  const match = LOGO_FILE.exec(file);
  const notFound = () => new HttpError(404, "NOT_FOUND", "No logo here.");
  if (!match || !/^prj_[A-Za-z0-9_]{1,80}$/u.test(projectParam)) throw notFound();
  const projectId = projectParam.slice(4);
  const record = await projectStore().get(projectId);
  const verified = record !== null && record.domain.verified && record.domain.host !== null && record.domain.host === hostOf(record.settings);
  if (!record || !verified || !record.logo || record.logo.sha256 !== match[1] || logoExtension(record.logo.contentType) !== match[2]) throw notFound();
  const logo = await projectStore().logoBytes(projectId, record.logo.sha256);
  if (!logo) throw notFound();
  res.setHeader("Content-Type", logo.contentType);
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.status(200).end(logo.bytes);
}

/* ====================================================== publishable guard */

function originForbidden(origin: string | undefined): PlatformError {
  return new PlatformError(
    "PUBLISHABLE_ORIGIN_FORBIDDEN",
    origin ? `This publishable key is not set up for ${origin.slice(0, 100)}. Add the origin to allowedOrigins with PATCH /v1/projects/current.` : "Publishable keys work only from a browser page whose origin the project allows.",
    403,
  );
}

/** Kletia's own web origins (the /embed frame): the CORS allowlist and KLETIA_WEB_ORIGIN. */
function firstParty(origin: string): boolean {
  return firstPartyOrigins.includes(origin) || origin === kletiaWebOrigin();
}

/**
 * Whether a publishable request comes from a page the project allows:
 * `Origin` in `allowedOrigins`, or a Kletia first-party `Origin` (the
 * `/embed` frame) with `Kletia-Host-Origin` in `allowedOrigins`.
 */
export function publishableOriginAllowed(allowed: readonly string[], origin: string | undefined, hostOrigin: string | undefined): boolean {
  if (!origin) return false;
  if (allowed.includes(origin)) return true;
  return firstParty(origin) && hostOrigin !== undefined && allowed.includes(hostOrigin);
}

export interface PublishableRoute {
  readonly method: string;
  readonly path: string;
}

function routePattern(path: string): RegExp {
  const source = path
    .split("/")
    .map((segment) => (segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")))
    .join("/");
  return new RegExp(`^${source}/?$`, "iu");
}

/**
 * The router guard for publishable keys (mounted after the tier limiter and
 * the credential check): only `routes` (method + Express path) are allowed
 * (403 PUBLISHABLE_KEY_FORBIDDEN otherwise); each request also spends the
 * public per-IP budget and must pass the project's origin rule.
 */
export function createPublishableGuard(routes: readonly PublishableRoute[]): RequestHandler {
  const allowed = routes.map((route) => ({ method: route.method.toUpperCase(), pattern: routePattern(route.path) }));
  return (req, res, next) => {
    const auth = authOf(req);
    if (auth.keyKind !== "publishable") {
      next();
      return;
    }
    void (async () => {
      const method = req.method === "HEAD" ? "GET" : req.method.toUpperCase();
      if (!allowed.some((route) => route.method === method && route.pattern.test(req.path))) {
        throw publishableForbidden(`${req.method} /v1${req.path} is not available to publishable keys. Call it from your server with a secret key.`);
      }
      takePublishableAddress(req);
      const record = await cachedRecord(auth.projectId ?? "");
      const origin = req.get("origin");
      if (!publishableOriginAllowed(record.settings.allowedOrigins ?? [], origin, req.get("kletia-host-origin")?.trim())) throw originForbidden(origin);
    })().then(() => next(), (error: unknown) => sendError(req, res, error));
  };
}

/* ======================================== contract directory for browsers */

const KIND_CACHE_MAX = 20_000;
const kindCache = new Map<string, string>();

/** Whether a key is a publishable key (kinds never change; unknown keys are not). */
async function isPublishable(keyId: string): Promise<boolean> {
  let kind = kindCache.get(keyId);
  if (kind === undefined) {
    const record = await apiKeyStore().findById(keyId);
    if (!record) return false;
    kind = keyKindOf(record);
    kindCache.set(keyId, kind);
    while (kindCache.size > KIND_CACHE_MAX) {
      const oldest = kindCache.keys().next().value;
      if (oldest === undefined) break;
      kindCache.delete(oldest);
    }
  }
  return kind === "publishable";
}

const GUARDED = Symbol("kletia.publishableContractGuard");

/**
 * Wraps the installed contract directory so a publishable key never resolves,
 * lists or uses a registration by itself (its text and clarify intents get
 * CONTRACT_UNKNOWN; the planner and the prepare check of a flow session ask
 * for the flow's saver instead). Its daily notional is still recorded on it.
 * Idempotent; a directory installed later (tests) is wrapped by the next call.
 */
export function installPublishableContractGuard(): void {
  const inner = contractDirectory();
  if (!inner || (inner as ContractDirectory & { [GUARDED]?: true })[GUARDED]) return;
  const guarded: ContractDirectory & { [GUARDED]: true } = {
    [GUARDED]: true,
    resolve: async (ownerKeyId, reference, network) => ((await isPublishable(ownerKeyId)) ? null : inner.resolve(ownerKeyId, reference, network)),
    phrases: async (ownerKeyId) => ((await isPublishable(ownerKeyId)) ? [] : inner.phrases(ownerKeyId)),
    current: (id) => inner.current(id),
    usableBy: async (id, ownerKeyId) => !(await isPublishable(ownerKeyId)) && inner.usableBy(id, ownerKeyId),
    denied: (network, target) => inner.denied(network, target),
    reportAnomaly: (id, reason, detail) => inner.reportAnomaly(id, reason, detail),
    recordSpend: (ownerKeyId, usd) => inner.recordSpend(ownerKeyId, usd),
    get actionTransport() {
      return inner.actionTransport;
    },
  };
  configureContractDirectory(guarded);
}

/** Model-assisted reading for a project's keys (A.7.6): enabled only by the project setting. */
export async function projectReadingEnabled(projectId: string): Promise<boolean> {
  const record = await cachedRecord(projectId);
  return (record.settings as { modelReading?: unknown }).modelReading === "enabled";
}

/** Whether a browser origin is one of the project's allowed origins. */
export async function projectAllowsOrigin(projectId: string, origin: string | undefined): Promise<boolean> {
  if (!origin) return false;
  const record = await cachedRecord(projectId);
  return (record.settings.allowedOrigins ?? []).includes(origin);
}
