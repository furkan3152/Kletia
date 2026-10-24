/**
 * Assistant routes (docs/platform/assistant.md):
 *
 *   POST /v1/assistant/ask       one question about the caller's own wallets -> a grounded answer
 *   POST /v1/assistant/consent   a desk session's consent to the model steps (session token)
 *
 * Who may ask about which wallets:
 * - an API key names the wallets in the body; an agent key only accounts its
 *   rule book chain pins (`accounts.allow`, every pinned level), and the set
 *   is narrowed to them; publishable keys never;
 * - without a key, a desk wallet session (`Kletia-Account-Session` from the
 *   first-party origin) answers for its own wallet only.
 *
 * The model steps need the switch (`KLETIA_ASSISTANT=on`) plus consent:
 * server keys the project setting `modelReading: "enabled"` and
 * `model: "on"`; the desk `model: "on"` with a session consent token bound
 * to the signed-in wallet. Every ask spends the data budget like a portfolio
 * read (one unit per account).
 */
import type { Request, RequestHandler } from "express";
import { accountMatchesPattern, ACCOUNT_SESSION_HEADER, ASSISTANT_LIMITS, type AssistantAskRequest, type DataWalletSet } from "@kletia/core";
import { issueReadingConsentToken, verifyReadingConsentToken } from "../../shared/intent/semanticConsent.js";
import { ask, assistantModel, dataServicePort, type AskInput } from "../assistant/index.js";
import { parseWalletSet } from "../data/index.js";
import { assertNoSecret } from "../engine/secretScreen.js";
import { PlatformError } from "../errors.js";
import { accountSessionOf, requireAccountOrigin, requireAccountSession } from "./accounts/auth.js";
import { authOf, handle, invalidRequest, isRecord, type AuthContext } from "./context.js";
import { takeDataReads } from "./limits.js";
import { readKeyChain } from "./policies/chain.js";
import { projectReadingEnabled } from "./projects.js";
import { kletiaWebOrigin } from "./webOrigin.js";

function forbidden(message: string): PlatformError {
  return new PlatformError("ASSISTANT_ACCOUNT_FORBIDDEN", message, 403, [{ path: "wallets", message: "Not a wallet this caller may read." }]);
}

/** The request body, checked. Throws 400 INVALID_REQUEST. */
export function parseAskRequest(body: unknown): AssistantAskRequest {
  if (!isRecord(body)) throw invalidRequest("The request body must be an object.", [{ path: "", message: "Expected an object." }]);
  const issues: { path: string; message: string }[] = [];
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (question.length === 0 || question.length > ASSISTANT_LIMITS.questionChars) issues.push({ path: "question", message: `1 to ${ASSISTANT_LIMITS.questionChars} characters.` });
  const wallets = body.wallets;
  if (wallets !== undefined) {
    if (!isRecord(wallets)) issues.push({ path: "wallets", message: "Expected { evm?, solana?, lane? }." });
    else {
      for (const name of ["evm", "solana"] as const) {
        const list = wallets[name];
        if (list !== undefined && (!Array.isArray(list) || list.length > 2 || !list.every((entry) => typeof entry === "string" && entry.length <= 64 && !entry.includes(",")))) issues.push({ path: `wallets.${name}`, message: "At most 2 addresses." });
      }
      if (wallets.lane !== undefined && wallets.lane !== "production" && wallets.lane !== "testnet") issues.push({ path: "wallets.lane", message: "production or testnet." });
    }
  }
  if (body.model !== undefined && body.model !== "on" && body.model !== "off") issues.push({ path: "model", message: "on or off." });
  if (body.consent !== undefined && (typeof body.consent !== "string" || body.consent.length > 2_048)) issues.push({ path: "consent", message: "A consent token." });
  if (issues.length > 0) throw invalidRequest("The question is invalid.", issues);
  assertNoSecret(question, "question");
  return {
    question,
    ...(isRecord(wallets) ? { wallets: wallets as NonNullable<AssistantAskRequest["wallets"]> } : {}),
    ...(body.model === "on" || body.model === "off" ? { model: body.model } : {}),
    ...(typeof body.consent === "string" ? { consent: body.consent } : {}),
  };
}

function setOf(wallets: AssistantAskRequest["wallets"]): DataWalletSet {
  return parseWalletSet({ evm: wallets?.evm?.join(","), solana: wallets?.solana?.join(","), ...(wallets?.lane ? { lane: wallets.lane } : {}) });
}

/** An agent key's wallet set narrowed to the accounts every pinned level of its chain allows; 403 when nothing is pinned or left. */
async function agentAccounts(keyId: string, set: DataWalletSet): Promise<DataWalletSet> {
  const chain = await readKeyChain(keyId);
  if (!chain || !chain.keyActive) throw forbidden("This agent key (or one of its ancestors) is revoked or expired.");
  const pins = chain.levels.map((level) => level.policy?.accounts?.allow).filter((allow): allow is readonly string[] => Array.isArray(allow) && allow.length > 0);
  if (pins.length === 0) throw forbidden("Agent keys read only the accounts their rule book pins (accounts.allow); this key's rule book pins none.");
  const accounts = set.accounts.filter((account) => pins.every((allow) => allow.some((pattern) => accountMatchesPattern(account, pattern))));
  if (accounts.length === 0) throw forbidden("None of these wallets is an account this agent key's rule book pins.");
  const kept = (address: string) => accounts.some((account) => account.toLowerCase().endsWith(`:${address.toLowerCase()}`));
  return { ...set, evm: set.evm.filter(kept), solana: set.solana.filter(kept), accounts };
}

export type AssistantOwner = Pick<AskInput, "set" | "port" | "model" | "modelUnavailable">;

const unavailable = () => (assistantModel().configured ? ("no-consent" as const) : ("off" as const));

/** An API key's owner: its named wallets (an agent key narrowed to its pins); the model with the project setting and `model: "on"`. */
export async function keyOwner(key: { readonly keyId: string; readonly keyKind?: AuthContext["keyKind"]; readonly projectId?: string }, body: AssistantAskRequest): Promise<AssistantOwner> {
  if (key.keyKind === "publishable") throw forbidden("Publishable keys cannot ask about wallets; ask from a server with a project key, or from the Kletia desk.");
  if (!body.wallets) throw invalidRequest("Name the wallets to ask about: wallets: { evm?, solana? }.", [{ path: "wallets", message: "Required with an API key." }]);
  let set = setOf(body.wallets);
  if (key.keyKind === "agent") set = await agentAccounts(key.keyId, set);
  const model = assistantModel();
  const consented = model.configured && body.model === "on" && key.projectId !== undefined && (await projectReadingEnabled(key.projectId));
  return {
    set,
    port: dataServicePort(key.keyId),
    model: consented ? { model, scope: { scope: `key:${key.keyId}`, project: key.projectId ?? key.keyId } } : null,
    modelUnavailable: unavailable(),
  };
}

/** Who asks and about which wallets: an API key, else the desk's wallet session (its own wallet only). */
async function ownerOf(req: Request, body: AssistantAskRequest): Promise<AssistantOwner> {
  const auth = authOf(req);
  if (auth.keyId) return keyOwner({ keyId: auth.keyId, ...(auth.keyKind ? { keyKind: auth.keyKind } : {}), ...(auth.projectId ? { projectId: auth.projectId } : {}) }, body);
  const { wallet } = accountSessionOf(req);
  const own = wallet.walletKind === "evm" ? { evm: [wallet.address] } : { solana: [wallet.address] };
  const named = [...(body.wallets?.evm ?? []), ...(body.wallets?.solana ?? [])];
  if (named.some((address) => address.toLowerCase() !== wallet.address.toLowerCase())) throw forbidden("A wallet session answers for its own wallet only.");
  const set = setOf({ ...own, ...(body.wallets?.lane ? { lane: body.wallets.lane } : {}) });
  const model = assistantModel();
  const token = body.model === "on" && body.consent ? verifyReadingConsentToken(body.consent, { wallet: wallet.address }) : null;
  return {
    set,
    port: dataServicePort(null),
    model: model.configured && token?.scope === "session" ? { model, scope: { scope: `wallet:${wallet.address.toLowerCase()}` } } : null,
    modelUnavailable: unavailable(),
  };
}

/** Without a key: the desk's wallet session (first-party origin), else 401 ASSISTANT_OWNER_REQUIRED. */
const sessionWhenKeyless: RequestHandler = (req, res, next) => {
  if (authOf(req).keyId) {
    next();
    return;
  }
  if (!req.get(ACCOUNT_SESSION_HEADER)) {
    next(new PlatformError("ASSISTANT_OWNER_REQUIRED", "Send an API key with the wallets to ask about, or a wallet session from the Kletia desk.", 401));
    return;
  }
  requireAccountOrigin(req, res, (originError?: unknown) => {
    if (originError) next(originError);
    else requireAccountSession(req, res, next);
  });
};

export function assistantHandlers(): Record<string, RequestHandler[]> {
  return {
    "post /assistant/ask": [
      sessionWhenKeyless,
      handle(async (req, res) => {
        const body = parseAskRequest(req.body);
        const owner = await ownerOf(req, body);
        takeDataReads(req, owner.set.accounts.length);
        res.status(200).json({ answer: await ask({ question: body.question, ...owner }) });
      }),
    ],
    "post /assistant/consent": [
      sessionWhenKeyless,
      handle(async (req, res) => {
        if (authOf(req).keyId) {
          throw new PlatformError("CONFIRM_AUTHORITY_REQUIRED", "Only the person can turn on model help, from the Kletia desk; server keys use the project setting modelReading.", 403, [{ path: "authorization", message: "Server keys cannot mint assistant consent." }]);
        }
        if (req.get("origin") !== kletiaWebOrigin()) throw new PlatformError("CONFIRM_AUTHORITY_REQUIRED", "Model help for the assistant is turned on in the Kletia desk only.", 403, [{ path: "origin", message: "Not the desk." }]);
        if (!assistantModel().configured) {
          throw new PlatformError("ASSISTANT_MODEL_NOT_CONFIGURED", "Model help for the assistant is not configured on this deployment; questions are still answered without it where Kletia's parser can read them.", 503);
        }
        const { wallet } = accountSessionOf(req);
        const issued = issueReadingConsentToken({ scope: "session", wallet: wallet.address });
        res.status(200).json({ token: issued.token, expiresAt: new Date(issued.expiresAt).toISOString(), scope: "session" });
      }),
    ],
  };
}
