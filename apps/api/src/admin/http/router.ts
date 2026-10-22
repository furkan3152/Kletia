/**
 * /api/admin: the wallet-gated operator API behind the /admin panel.
 *
 * Security contract (design §A, §H): admin enabled by an allowlist (EVM
 * and/or Solana), exact admin origins, mandatory X-Kletia-Admin header,
 * SameSite=Strict HttpOnly session cookie, single-use nonces, a step-up
 * confirmation signed by the session's wallet for every state-changing
 * route except logout (a stolen cookie alone can only read), an audit row for every
 * mutation and login attempt, JSON bodies only, no-store responses. The API
 * reads chains and calls Render; it never holds a key, signs or sends.
 */
import {
  ADMIN_CONTRACTS,
  ADMIN_DEPLOY_TARGETS,
  ADMIN_EVM_NETWORKS,
  ADMIN_NETWORK_CONSTANTS,
  ADMIN_PINNED_DEPLOYMENTS,
  ADMIN_SCHEMA_VERSION,
  type AdminEvmNetwork,
  type AdminNetworkProfile,
} from "@kletia/core";
import express, { type Request, type RequestHandler, type Response, type Router } from "express";
import { getAddress, isAddress, type Address } from "viem";
import { z } from "zod";
import { randomHex } from "../../platform/http/secrets.js";
import { audit, issueNonce, sessionView, verifyConfirmation, verifyLogin, type ConfirmAction } from "../auth/service.js";
import { payloadSha256, routePayloadSha256 } from "../auth/messages.js";
import { isAdminNetwork, profileDefaults, resolveRecordKey } from "../catalog.js";
import { getArtifact } from "../contract-artifacts/index.js";
import { defaultAdminDeps, type AdminDeps, type AdminSessionContext } from "../deps.js";
import { envView } from "../envReadiness.js";
import { buildExport } from "../export.js";
import { feesView, isTestnet, rescan } from "../fees.js";
import { servicesView, triggerDeploy } from "../render.js";
import { addSignature, cancelProposal, createProposal, markExecuted, refreshStale } from "../safe.js";
import { contractState } from "../state.js";
import { verifyAction } from "../verify/action.js";
import { rpc } from "../verify/chain.js";
import { recordDeployment, reverifyDeployment } from "../verify/deployment.js";
import { clearSessionCookie, setSessionCookie } from "./cookies.js";
import { AdminHttpError, adminErrorHandler, invalidRequest } from "./errors.js";
import { loadAdminSession, requireAdminRequest, requireAdminSession, sessionOf } from "./guard.js";
import { createAdminLimiters } from "./limits.js";

type AsyncHandler = (req: Request, res: Response) => Promise<void>;

function handle(task: AsyncHandler): RequestHandler {
  return (req, res, next) => {
    task(req, res).catch(next);
  };
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw invalidRequest("The request is not valid.", result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })));
  }
  return result.data;
}

const hash32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/u, "must be a 32-byte 0x hex hash");
const network = z.enum(ADMIN_EVM_NETWORKS as unknown as [AdminEvmNetwork, ...AdminEvmNetwork[]]);
const addressOrNull = z.string().nullable().refine((value) => value === null || isAddress(value, { strict: false }), "must be an EVM address or null");
const confirmation = z.object({ message: z.string().max(2000), signature: z.string().max(4000) }).strict();

const nonceBody = z.object({
  walletKind: z.enum(["evm", "solana"]).optional(),
  address: z.string().max(100),
  chainId: z.number().int().positive().optional(),
  purpose: z.enum(["login", "confirm"]).optional(),
  action: z.string().max(64).optional(),
  network: z.string().max(32).optional(),
  payloadSha256: z.string().max(64).optional(),
}).strict();
const verifyBody = z.object({ message: z.string().min(1).max(2000), signature: z.string().min(1).max(4000) }).strict();
const recordBody = z.object({
  targetId: z.string().max(80),
  txHash: hash32,
  constructorArgs: z.record(z.string().max(300)),
  notes: z.string().max(500).optional(),
  import: z.boolean().optional(),
}).strict();
const statusBody = z.object({ status: z.enum(["archived", "superseded"]), notes: z.string().max(500).optional(), confirmation }).strict();
const profileBody = z.object({
  owner: addressOrNull, guardian: addressOrNull, treasury: addressOrNull, eoaOwnerAcknowledged: z.boolean(), confirmation,
}).strict();
const actionBody = z.object({
  network, txHash: hash32, contract: z.string().refine((value) => isAddress(value, { strict: false }), "must be an address"),
  actionId: z.string().max(64).nullable(),
}).strict();
const proposalBody = z.object({
  network, safe: z.string().max(42), to: z.string().max(42), value: z.string().max(80), data: z.string().max(20_000),
  description: z.string().min(1).max(300), actionId: z.string().max(64).nullable().optional(),
}).strict();
const signatureBody = z.object({ signature: z.string().max(200) }).strict();
const executedBody = z.object({ txHash: hash32 }).strict();
const rescanBody = z.object({ key: z.string().max(120) }).strict();
const deployBody = z.object({ clearCache: z.boolean().optional() }).strict();

/** JSON only for bodies; no-store; request id. */
const baseHeaders: RequestHandler = (req, res, next) => {
  const incoming = req.headers["x-request-id"];
  const requestId = typeof incoming === "string" && /^[A-Za-z0-9._-]{8,80}$/u.test(incoming) ? incoming : `adm_${randomHex(12)}`;
  res.setHeader("X-Request-Id", requestId);
  res.setHeader("Cache-Control", "no-store");
  if (["POST", "PUT", "PATCH"].includes(req.method)) {
    const length = Number(req.headers["content-length"] ?? "0");
    const hasBody = length > 0 || req.headers["transfer-encoding"] !== undefined;
    if (hasBody && !req.is("application/json")) {
      return next(new AdminHttpError(415, "ADMIN_UNSUPPORTED_MEDIA_TYPE", "Send JSON (Content-Type: application/json)."));
    }
  }
  next();
};

/** Marks a route handler as the step-up gate (checked by the route-coverage test). */
export const STEP_UP_ACTION = Symbol("kletia.admin.stepUpAction");

export function createAdminRouter(overrides: Partial<AdminDeps> = {}): Router {
  const deps: AdminDeps = { ...defaultAdminDeps(), ...overrides };
  const limits = createAdminLimiters();
  const router = express.Router();
  const production = () => deps.config().production;

  router.use(baseHeaders);
  router.use(express.json({ limit: "64kb" }));
  router.use(requireAdminRequest(deps));
  router.use(loadAdminSession(deps));

  /**
   * Step-up confirmation; a refused confirmation (e.g. a stolen cookie trying
   * to change defaults without the wallet) is audited as denied.
   */
  const confirmOrAudit = async (
    req: Request, res: Response, session: AdminSessionContext, auditAction: string,
    expected: Parameters<typeof verifyConfirmation>[3], signed: unknown, target: Record<string, string>,
  ): Promise<void> => {
    try {
      await verifyConfirmation(deps, session, req.adminOrigin as string, expected, signed);
    } catch (error) {
      if (error instanceof AdminHttpError && error.code === "ADMIN_CONFIRMATION_REQUIRED") {
        await audit(deps, req, res, { address: session.actor, action: auditAction, outcome: "denied", target: { ...target, reason: "confirmation" } });
      }
      throw error;
    }
  };

  /**
   * Route-bound step-up for a state-changing route: the body's `confirmation`
   * must be a fresh (5 min, single use) confirm nonce for `action`, signed by
   * the session's own wallet over the hash of the method, path and the rest
   * of the body. The handler then sees the body without `confirmation`.
   */
  const stepUp = (action: ConfirmAction): RequestHandler => {
    const handler: RequestHandler = (req, res, next) => {
      const run = async () => {
        const session = sessionOf(req);
        const raw: unknown = req.body ?? {};
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw invalidRequest("The request body must be a JSON object.");
        const { confirmation: signed, ...rest } = raw as Record<string, unknown>;
        const network = typeof rest.network === "string" && isAdminNetwork(rest.network) ? rest.network : null;
        const expected = { action, network, payloadSha256: routePayloadSha256(req.method, req.path, rest) };
        await confirmOrAudit(req, res, session, action, expected, signed, { route: `${req.method} ${req.path}`.slice(0, 200) });
        req.body = rest;
      };
      run().then(() => next(), next);
    };
    return Object.assign(handler, { [STEP_UP_ACTION]: action });
  };

  let lastPrune = 0;
  router.use((_req, _res, next) => {
    const now = deps.now().getTime();
    if (now - lastPrune > 60 * 60 * 1000) {
      lastPrune = now;
      deps.store().pruneNonces(deps.now()).catch(() => undefined);
    }
    next();
  });

  /* ---------------- Auth ---------------- */

  router.post("/auth/nonce", limits.nonce, handle(async (req, res) => {
    const body = parse(nonceBody, req.body);
    res.json(await issueNonce(deps, req.adminOrigin as string, body, req.adminSession ?? null));
  }));

  router.post("/auth/verify", limits.verify, handle(async (req, res) => {
    const body = parse(verifyBody, req.body);
    const { sessionId, record } = await verifyLogin(deps, req, res, req.adminOrigin as string, body.message, body.signature);
    setSessionCookie(res, sessionId, production());
    res.json({ session: sessionView(deps.config(), record) });
  }));

  router.get("/auth/session", (req, res, next) => {
    if (!req.adminSession) {
      clearSessionCookie(res, production());
      return next(new AdminHttpError(401, "ADMIN_SESSION_REQUIRED", "Sign in with the admin wallet."));
    }
    res.json({ session: req.adminSession.view });
  });

  // Everything below needs a session.
  router.use(requireAdminSession(deps));
  router.use((req, res, next) => (req.method === "GET" ? limits.read(req, res, next) : next()));
  router.use((req, res, next) => (req.method !== "GET" && !/^\/services\/[^/]+\/deploy$/u.test(req.path) ? limits.write(req, res, next) : next()));

  router.post("/auth/logout", handle(async (req, res) => {
    const session = sessionOf(req);
    await audit(deps, req, res, { address: session.actor, action: "auth.logout", outcome: "ok" });
    await deps.store().deleteSession(session.idHash);
    clearSessionCookie(res, production());
    res.status(204).end();
  }));

  router.post("/auth/logout-all", handle(async (req, res) => {
    const session = sessionOf(req);
    await audit(deps, req, res, { address: session.actor, action: "auth.logout_all", outcome: "ok" });
    await deps.store().deleteSessionsOf(session.record.walletKind, session.record.address);
    clearSessionCookie(res, production());
    res.status(204).end();
  }));

  /* ---------------- Catalog, overview ---------------- */

  router.get("/catalog", (_req, res) => {
    res.json({
      schemaVersion: ADMIN_SCHEMA_VERSION, contracts: ADMIN_CONTRACTS, targets: ADMIN_DEPLOY_TARGETS,
      pinned: ADMIN_PINNED_DEPLOYMENTS, constants: ADMIN_NETWORK_CONSTANTS,
    });
  });

  router.get("/overview", handle(async (_req, res) => {
    const store = deps.store();
    const records = await store.listDeployments({});
    const proposals = await store.listProposals({});
    const networks = ADMIN_EVM_NETWORKS.map((network) => {
      const verified = records.filter((record) => record.network === network && record.status === "verified").length;
      const failed = records.filter((record) => record.network === network && record.status === "verification_failed").length;
      const foreign = records.filter((record) => record.network === network && record.status === "foreign").length;
      const warnings: string[] = [];
      if (failed > 0) warnings.push(`${failed} deployment record(s) failed verification.`);
      if (foreign > 0) warnings.push(`${foreign} deployment record(s) are foreign: not controlled by an admin wallet, never exported or used as a dependency.`);
      if (verified > 0 && network !== "base") warnings.push("New deployments are prepared only until the lead pins them in a release.");
      return {
        network,
        pinned: ADMIN_PINNED_DEPLOYMENTS.filter((entry) => entry.network === network).length,
        verified,
        deployable: ADMIN_DEPLOY_TARGETS.filter((target) => target.network === network && (target.status === "deployable" || target.status === "pinned")).length,
        warnings,
      };
    });
    res.json({
      networks,
      safeQueue: proposals.filter((proposal) => proposal.status === "collecting" || proposal.status === "ready").length,
      servicesConfigured: Boolean(deps.env.RENDER_API_KEY?.trim()),
    });
  }));

  router.get("/artifacts/:project/:name", (req, res, next) => {
    const artifactId = `${req.params.project}/${req.params.name}`;
    const artifact = /^(base|arc)\/[A-Za-z0-9]{1,80}$/u.test(artifactId) ? getArtifact(artifactId) : null;
    if (!artifact) return next(new AdminHttpError(404, "ADMIN_ARTIFACT_NOT_FOUND", `No artifact ${artifactId}.`));
    res.json({ artifact: { artifactId, ...artifact } });
  });

  /* ---------------- Deployments ---------------- */

  router.get("/deployments", handle(async (req, res) => {
    const networkFilter = typeof req.query.network === "string" ? req.query.network : undefined;
    const statusFilter = typeof req.query.status === "string" ? req.query.status : undefined;
    if (networkFilter !== undefined && !isAdminNetwork(networkFilter)) throw invalidRequest("network must be an EVM network key.");
    const statuses = ["pending", "verified", "foreign", "verification_failed", "superseded", "archived"] as const;
    if (statusFilter !== undefined && !(statuses as readonly string[]).includes(statusFilter)) throw invalidRequest("status is not valid.");
    const records = await deps.store().listDeployments({
      ...(networkFilter ? { network: networkFilter as AdminEvmNetwork } : {}),
      ...(statusFilter ? { status: statusFilter as (typeof statuses)[number] } : {}),
    });
    res.json({ records, pinned: ADMIN_PINNED_DEPLOYMENTS.filter((entry) => !networkFilter || entry.network === networkFilter) });
  }));

  router.get("/deployments/export", handle(async (req, res) => {
    const session = sessionOf(req);
    const now = deps.now();
    const payload = buildExport(await deps.store().listDeployments({ status: "verified" }), session.actor, now, deps.env.RENDER_GIT_COMMIT?.trim() || null);
    await audit(deps, req, res, { address: session.actor, action: "export.download", outcome: "ok" });
    res.setHeader("Content-Disposition", `attachment; filename="kletia-deployments-${now.toISOString().slice(0, 10)}.json"`);
    res.json(payload);
  }));

  router.post("/deployments", stepUp("deployment.record"), handle(async (req, res) => {
    const session = sessionOf(req);
    const body = parse(recordBody, req.body);
    try {
      const { record, created } = await recordDeployment(deps, session, body);
      if (created) {
        await audit(deps, req, res, {
          address: session.actor, action: "deployment.record", outcome: record.status === "verified" ? "ok" : "error",
          target: { id: record.id, targetId: record.targetId, network: record.network, address: record.address, txHash: record.txHash, status: record.status },
        });
      }
      res.status(created ? 201 : 200).json({ record });
    } catch (error) {
      if (error instanceof AdminHttpError && error.code !== "ADMIN_STORE_UNAVAILABLE") {
        await audit(deps, req, res, { address: session.actor, action: "deployment.record", outcome: "denied", target: { targetId: body.targetId, txHash: body.txHash, code: error.code } });
      }
      throw error;
    }
  }));

  router.post("/deployments/:id/reverify", stepUp("deployment.reverify"), handle(async (req, res) => {
    const session = sessionOf(req);
    const record = await deps.store().getDeployment(String(req.params.id));
    if (!record) throw new AdminHttpError(404, "ADMIN_NOT_FOUND", "No such deployment record.");
    const updated = await reverifyDeployment(deps, record);
    await audit(deps, req, res, { address: session.actor, action: "deployment.reverify", outcome: updated.status === "verified" ? "ok" : "error", target: { id: record.id, status: updated.status } });
    await deps.store().updateDeployment(updated);
    res.json({ record: updated });
  }));

  router.patch("/deployments/:id", handle(async (req, res) => {
    const session = sessionOf(req);
    const body = parse(statusBody, req.body);
    const record = await deps.store().getDeployment(String(req.params.id));
    if (!record) throw new AdminHttpError(404, "ADMIN_NOT_FOUND", "No such deployment record.");
    const { confirmation: signed, ...payload } = body;
    await confirmOrAudit(req, res, session, "deployment.status", { action: "deployment.status", network: record.network, payloadSha256: payloadSha256({ id: record.id, ...payload }) }, signed, { id: record.id });
    const updated = { ...record, status: body.status, notes: body.notes ?? record.notes, updatedAt: deps.now().toISOString() };
    await audit(deps, req, res, { address: session.actor, action: "deployment.status", outcome: "ok", target: { id: record.id, status: body.status } });
    await deps.store().updateDeployment(updated);
    res.json({ record: updated });
  }));

  /* ---------------- Network profiles ---------------- */

  router.get("/network-profiles", handle(async (_req, res) => {
    const stored = new Map((await deps.store().listProfiles()).map((profile) => [profile.network, profile]));
    res.json({ profiles: ADMIN_EVM_NETWORKS.map((network) => stored.get(network) ?? profileDefaults(network)) });
  }));

  router.put("/network-profiles/:network", handle(async (req, res) => {
    const session = sessionOf(req);
    const target = String(req.params.network);
    if (!isAdminNetwork(target)) throw new AdminHttpError(404, "ADMIN_NOT_FOUND", "Unknown network.");
    const body = parse(profileBody, req.body);
    const { confirmation: signed, ...payload } = body;
    await confirmOrAudit(req, res, session, "network_profile.update", { action: "network-profile.update", network: target, payloadSha256: payloadSha256(payload) }, signed, { network: target });
    const checksum = (value: string | null) => (value === null ? null : getAddress(value));
    const owner = checksum(body.owner);
    if (owner && !isTestnet(target) && !body.eoaOwnerAcknowledged) {
      const client = deps.client(target);
      const code = await rpc(target, () => client.getCode({ address: owner as Address }));
      if (!code || code === "0x") {
        throw new AdminHttpError(422, "ADMIN_INVALID_REQUEST", `The owner has no code on ${target}. Acknowledge an EOA owner to continue.`, { eoaOwner: true });
      }
    }
    const profile: AdminNetworkProfile = {
      network: target, owner, guardian: checksum(body.guardian), treasury: checksum(body.treasury),
      eoaOwnerAcknowledged: body.eoaOwnerAcknowledged, updatedBy: session.actor, updatedAt: deps.now().toISOString(),
    };
    await audit(deps, req, res, { address: session.actor, action: "network_profile.update", outcome: "ok", target: { network: target } });
    await deps.store().putProfile(profile);
    res.json({ profile });
  }));

  /* ---------------- Contract state and actions ---------------- */

  router.get("/contracts/:recordKey/state", handle(async (req, res) => {
    const known = await resolveRecordKey(deps.store(), String(req.params.recordKey));
    if (!known) throw new AdminHttpError(404, "ADMIN_NOT_FOUND", "Not a pinned or recorded Kletia contract.");
    res.json(await contractState(deps, sessionOf(req), known));
  }));

  router.post("/actions/verify", stepUp("action.verify"), handle(async (req, res) => {
    const session = sessionOf(req);
    const body = parse(actionBody, req.body);
    const verified = await verifyAction(deps, session, { ...body, contract: getAddress(body.contract) });
    const auditId = await audit(deps, req, res, {
      address: session.actor, action: "action.verify", outcome: "ok",
      target: { network: body.network, contract: getAddress(body.contract), txHash: body.txHash.toLowerCase(), fn: verified.decoded.fn, args: JSON.stringify(verified.decoded.args).slice(0, 1000) },
    });
    res.json({ decoded: verified.decoded, block: verified.block, auditId });
  }));

  /* ---------------- Safe proposals ---------------- */

  router.get("/safe-proposals", handle(async (req, res) => {
    const networkFilter = typeof req.query.network === "string" ? req.query.network : undefined;
    if (networkFilter !== undefined && !isAdminNetwork(networkFilter)) throw invalidRequest("network must be an EVM network key.");
    const statusFilter = typeof req.query.status === "string" ? req.query.status : undefined;
    const statuses = ["collecting", "ready", "executed", "stale", "cancelled"] as const;
    if (statusFilter !== undefined && !(statuses as readonly string[]).includes(statusFilter)) throw invalidRequest("status is not valid.");
    const proposals = await refreshStale(deps, await deps.store().listProposals({ ...(networkFilter ? { network: networkFilter as AdminEvmNetwork } : {}) }));
    res.json({ proposals: proposals.filter((proposal) => !statusFilter || proposal.status === statusFilter) });
  }));

  router.post("/safe-proposals", stepUp("safe.propose"), handle(async (req, res) => {
    const session = sessionOf(req);
    const body = parse(proposalBody, req.body);
    const proposal = await createProposal(deps, session, body);
    await audit(deps, req, res, { address: session.actor, action: "safe.propose", outcome: "ok", target: { id: proposal.id, network: proposal.network, safe: proposal.safe, nonce: proposal.nonce, safeTxHash: proposal.safeTxHash } });
    res.status(201).json({ proposal });
  }));

  const loadProposal = async (id: string) => {
    const proposal = /^sfp_[0-9a-f]{24}$/u.test(id) ? await deps.store().getProposal(id) : null;
    if (!proposal) throw new AdminHttpError(404, "ADMIN_NOT_FOUND", "No such Safe proposal.");
    return proposal;
  };

  router.post("/safe-proposals/:id/signatures", stepUp("safe.sign"), handle(async (req, res) => {
    const session = sessionOf(req);
    const body = parse(signatureBody, req.body);
    const proposal = await addSignature(deps, await loadProposal(String(req.params.id)), body.signature);
    const signer = proposal.signatures[proposal.signatures.length - 1]?.signer ?? "";
    await audit(deps, req, res, { address: session.actor, action: "safe.sign", outcome: "ok", target: { id: proposal.id, signer, status: proposal.status } });
    res.json({ proposal });
  }));

  router.post("/safe-proposals/:id/executed", stepUp("safe.executed"), handle(async (req, res) => {
    const session = sessionOf(req);
    const body = parse(executedBody, req.body);
    const proposal = await markExecuted(deps, await loadProposal(String(req.params.id)), body.txHash);
    await audit(deps, req, res, { address: session.actor, action: "safe.executed", outcome: "ok", target: { id: proposal.id, txHash: body.txHash.toLowerCase() } });
    res.json({ proposal });
  }));

  router.post("/safe-proposals/:id/cancel", stepUp("safe.cancel"), handle(async (req, res) => {
    const session = sessionOf(req);
    const proposal = await cancelProposal(deps, await loadProposal(String(req.params.id)));
    await audit(deps, req, res, { address: session.actor, action: "safe.cancel", outcome: "ok", target: { id: proposal.id } });
    res.json({ proposal });
  }));

  /* ---------------- Fees ---------------- */

  router.get("/fees", handle(async (req, res) => {
    res.json(await feesView(deps, sessionOf(req)));
  }));

  router.post("/fees/rescan", stepUp("fees.rescan"), limits.rescan, handle(async (req, res) => {
    const session = sessionOf(req);
    const body = parse(rescanBody, req.body);
    const scannedThroughBlock = await rescan(deps, body.key);
    await audit(deps, req, res, { address: session.actor, action: "fees.rescan", outcome: "ok", target: { key: body.key, scannedThroughBlock } });
    res.status(202).json({ scannedThroughBlock });
  }));

  /* ---------------- Services and environment ---------------- */

  router.get("/services", handle(async (_req, res) => {
    res.json(await servicesView(deps));
  }));

  // The service is checked before the limiters: an unknown name must not spend the global redeploy budget.
  // The step-up runs before the redeploy limiter: a stolen cookie must not spend it either.
  const knownService: RequestHandler = (req, _res, next) =>
    (req.params.service === "api" || req.params.service === "site" ? next() : next(new AdminHttpError(404, "ADMIN_NOT_FOUND", "service must be api or site.")));
  router.post("/services/:service/deploy", knownService, limits.write, stepUp("render.deploy"), limits.renderDeploy, handle(async (req, res) => {
    const session = sessionOf(req);
    const service = String(req.params.service) as "api" | "site";
    const body = parse(deployBody, req.body);
    try {
      const deploy = await triggerDeploy(deps, service, body.clearCache === true);
      await audit(deps, req, res, { address: session.actor, action: "render.deploy", outcome: "ok", target: { service, deployId: deploy.id } });
      res.status(202).json({ deploy });
    } catch (error) {
      if (error instanceof AdminHttpError && error.code !== "ADMIN_STORE_UNAVAILABLE") {
        await audit(deps, req, res, { address: session.actor, action: "render.deploy", outcome: "error", target: { service, code: error.code } });
      }
      throw error;
    }
  }));

  router.get("/env", (_req, res) => {
    res.json(envView(deps.env, deps.config().origins, deps.store().kind));
  });

  router.get("/audit", handle(async (req, res) => {
    const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : 50;
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 50;
    const beforeRaw = typeof req.query.before === "string" ? new Date(req.query.before) : null;
    if (beforeRaw && Number.isNaN(beforeRaw.getTime())) throw invalidRequest("before must be an ISO timestamp.");
    const entries = await deps.store().listAudit(limit, beforeRaw);
    res.json({ entries, next: entries.length === limit ? (entries[entries.length - 1]?.at ?? null) : null });
  }));

  router.use((_req, _res, next) => next(new AdminHttpError(404, "ADMIN_NOT_FOUND", "No such admin route.")));
  router.use(adminErrorHandler);
  return router;
}

