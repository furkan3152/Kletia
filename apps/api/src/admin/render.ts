/**
 * Render status and redeploy. Only three upstream calls exist,
 * all to https://api.render.com/v1 with the RENDER_API_KEY bearer:
 *   GET  /services/{id}
 *   GET  /services/{id}/deploys?limit=5
 *   POST /services/{id}/deploys   { clearCache }
 * No env-var, secret-file or service-update endpoint is ever called, and
 * upstream bodies are never forwarded on errors (only the status code).
 */
import type { AdminRenderDeploy, AdminRenderService, AdminRenderServiceKey, AdminServicesView } from "@kletia/core";
import type { AdminDeps } from "./deps.js";
import { AdminHttpError } from "./http/errors.js";

export const RENDER_API = "https://api.render.com/v1";
const RENDER_TIMEOUT_MS = 10_000;
const SERVICE_ID = /^srv-[a-z0-9]{20}$/u;
const DEFAULT_SERVICE_IDS: Readonly<Record<AdminRenderServiceKey, string>> = {
  api: "srv-d7ccgk1kh4rs73cir6c0",
  site: "srv-d7cd2mlckfvc7388hrmg",
};

export function renderServiceId(env: NodeJS.ProcessEnv, key: AdminRenderServiceKey): string | null {
  const configured = (key === "api" ? env.KLETIA_RENDER_API_SERVICE_ID : env.KLETIA_RENDER_SITE_SERVICE_ID)?.trim();
  const id = configured || DEFAULT_SERVICE_IDS[key];
  return SERVICE_ID.test(id) ? id : null;
}

function renderKey(env: NodeJS.ProcessEnv): string | null {
  return env.RENDER_API_KEY?.trim() || null;
}

async function renderCall(deps: AdminDeps, key: string, method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RENDER_TIMEOUT_MS);
  let response: Response;
  try {
    response = await deps.fetch(`${RENDER_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
      redirect: "error",
    });
  } catch {
    throw new AdminHttpError(502, "ADMIN_RENDER_FAILED", "Render did not answer.", { upstreamStatus: null });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new AdminHttpError(502, "ADMIN_RENDER_FAILED", `Render answered ${response.status}.`, { upstreamStatus: response.status });
  }
  try {
    return await response.json();
  } catch {
    throw new AdminHttpError(502, "ADMIN_RENDER_FAILED", "Render answered with an unreadable body.", { upstreamStatus: response.status });
  }
}

const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

export function toDeploy(raw: unknown): AdminRenderDeploy | null {
  if (typeof raw !== "object" || raw === null) return null;
  const deploy = ((raw as { deploy?: unknown }).deploy ?? raw) as Record<string, unknown>;
  const id = str(deploy.id);
  if (!id) return null;
  const commit = typeof deploy.commit === "object" && deploy.commit !== null ? deploy.commit as Record<string, unknown> : null;
  return {
    id,
    status: str(deploy.status) ?? "unknown",
    trigger: str(deploy.trigger),
    commit: commit && str(commit.id) ? { id: String(commit.id), message: (str(commit.message) ?? "").slice(0, 300) } : null,
    createdAt: str(deploy.createdAt) ?? "",
    finishedAt: str(deploy.finishedAt),
  };
}

async function serviceView(deps: AdminDeps, apiKey: string, key: AdminRenderServiceKey, serviceId: string): Promise<AdminRenderService> {
  const [service, deploys] = await Promise.all([
    renderCall(deps, apiKey, "GET", `/services/${serviceId}`),
    renderCall(deps, apiKey, "GET", `/services/${serviceId}/deploys?limit=5`),
  ]);
  const record = (typeof service === "object" && service !== null ? service : {}) as Record<string, unknown>;
  const details = (typeof record.serviceDetails === "object" && record.serviceDetails !== null ? record.serviceDetails : {}) as Record<string, unknown>;
  const suspended = record.suspended === "suspended" ? true : record.suspended === "not_suspended" ? false : null;
  return {
    key, serviceId, name: str(record.name), url: str(details.url), suspended,
    deploys: (Array.isArray(deploys) ? deploys : []).map(toDeploy).filter((entry): entry is AdminRenderDeploy => entry !== null),
  };
}

export async function servicesView(deps: AdminDeps): Promise<AdminServicesView> {
  const runningCommit = deps.env.RENDER_GIT_COMMIT?.trim() || null;
  const apiKey = renderKey(deps.env);
  if (!apiKey) return { configured: false, services: [], runningCommit };
  const services: AdminRenderService[] = [];
  for (const key of ["api", "site"] as const) {
    const serviceId = renderServiceId(deps.env, key);
    if (serviceId) services.push(await serviceView(deps, apiKey, key, serviceId));
  }
  return { configured: true, services, runningCommit };
}

export async function triggerDeploy(deps: AdminDeps, key: AdminRenderServiceKey, clearCache: boolean): Promise<AdminRenderDeploy> {
  const apiKey = renderKey(deps.env);
  if (!apiKey) throw new AdminHttpError(503, "ADMIN_RENDER_NOT_CONFIGURED", "Add RENDER_API_KEY on the Kletia API service to redeploy from the panel.");
  const serviceId = renderServiceId(deps.env, key);
  if (!serviceId) throw new AdminHttpError(503, "ADMIN_RENDER_NOT_CONFIGURED", `The ${key} service id is not valid.`);
  const deploy = toDeploy(await renderCall(deps, apiKey, "POST", `/services/${serviceId}/deploys`, { clearCache: clearCache ? "clear" : "do_not_clear" }));
  if (!deploy) throw new AdminHttpError(502, "ADMIN_RENDER_FAILED", "Render did not return a deploy.", { upstreamStatus: null });
  return deploy;
}
