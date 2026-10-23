/**
 * Error catalog drift: every error code the API source can emit must be in
 * ERROR_CATALOG (@kletia/core) with the HTTP status it is emitted with, and
 * the catalog must not list codes nothing emits. The scan parses the source
 * with the TypeScript compiler, so multi-line constructor calls are covered.
 *
 * When this fails after adding a code, add one entry to
 * packages/core/src/errors.ts (and rebuild @kletia/core), plus a row in
 * docs/platform/errors.md.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import ts from "typescript";
import {
  ERROR_CATALOG,
  FEATURE_ERROR_CODES,
  errorCatalogRows,
  isKletiaErrorCode,
  resolveErrorCode,
  type ErrorCatalogEntry,
  type KletiaErrorCode,
} from "@kletia/core";
import { MAX_ERROR_DETAILS_BYTES, PlatformError, platformErrorDetails } from "../../errors.js";
import { REJECTION_CODES } from "../../index.js";
import { sendError } from "../context.js";

const SRC = fileURLToPath(new URL("../../../", import.meta.url));
const REPO = fileURLToPath(new URL("../../../../../../", import.meta.url));

/** Emission sites: the engine and HTTP layer, plus the Solana modules the engine calls (not their first-party routes). */
const SCAN_ROOTS = ["platform", "networks/solana"];
const SKIP_FILES = new Set([path.join("networks", "solana", "routes.ts")]);
/** The offline intent eval (goal/eval*.ts) is never served: its outcome codes ("CRASH") are not API errors. */
const SKIP_PATTERN = /^platform[\\/]engine[\\/]goal[\\/]eval[A-Z]\w*\.ts$/u;

interface Emission {
  readonly code: string;
  /** HTTP status, or "step" for `{ code, message }` step failures. */
  readonly status: number | "step";
  readonly where: string;
}

function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") walk(full);
      } else if (entry.name.endsWith(".ts") && !SKIP_FILES.has(path.relative(SRC, full)) && !SKIP_PATTERN.test(path.relative(SRC, full))) files.push(full);
    }
  };
  for (const root of SCAN_ROOTS) walk(path.join(SRC, root));
  return files;
}

/** Mirrors toPlatformError: Solana provider statuses outside the platform set become 400 (4xx) or 502 (5xx). */
function solanaStatus(status: number): number {
  if (status >= 500) return 502;
  return [400, 401, 403, 404, 409, 410, 422, 429].includes(status) ? status : 400;
}

function scan(): { emissions: Emission[]; dynamic: string[] } {
  const emissions: Emission[] = [];
  const dynamic: string[] = [];
  for (const file of sourceFiles()) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true);
    const where = (node: ts.Node) => `${path.relative(SRC, file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
    const literal = (node: ts.Expression | undefined) =>
      node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
    const numeric = (node: ts.Expression | undefined) => (node && ts.isNumericLiteral(node) ? Number(node.text) : null);
    const visit = (node: ts.Node) => {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
        const args = node.arguments ?? [];
        const kind = node.expression.text;
        if (kind === "PlatformError" || kind === "HttpError" || kind === "SolanaProviderError") {
          const codeArg = kind === "PlatformError" ? args[0] : args[1];
          const statusArg = kind === "PlatformError" ? args[2] : kind === "HttpError" ? args[0] : args[2];
          const code = literal(codeArg);
          let status = statusArg === undefined ? (kind === "SolanaProviderError" ? 502 : 400) : numeric(statusArg);
          if (code === null || status === null) dynamic.push(`${kind} at ${where(node)}: ${codeArg?.getText(source).slice(0, 80) ?? "<none>"}`);
          else {
            if (kind === "SolanaProviderError") status = solanaStatus(status);
            emissions.push({ code, status, where: where(node) });
          }
        }
      }
      if (ts.isObjectLiteralExpression(node)) {
        const names = node.properties.map((property) => (property.name && ts.isIdentifier(property.name) ? property.name.text : ""));
        const code = node.properties.find(
          (property): property is ts.PropertyAssignment => ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === "code",
        );
        const value = code ? literal(code.initializer) : null;
        if (value && names.includes("message")) emissions.push({ code: value, status: "step", where: where(node) });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { emissions, dynamic };
}

const { emissions, dynamic } = scan();

/**
 * Codes core catalogues before the API emits them (FEATURE_ERROR_CODES
 * "reading" and "routes", design 2026-10). A code drops out of this set as
 * soon as the scan sees it emitted, and from then on the status check above
 * applies to it.
 */
const OWED_CODES: ReadonlySet<KletiaErrorCode> = new Set<KletiaErrorCode>([
  "CLARIFY_REQUIRED", // strict text that needs a question (P3-M3 strict Goal-reader fallback, P2-M1 fee and size questions)
  "CONFIRM_AUTHORITY_REQUIRED", // a model-assisted reading confirmed by an API or agent caller (P5-M1)
  "PLAN_TIMEOUT", // the 15 s planning deadline (P3-M1)
  "PLAN_TOO_LARGE", // the signature and auction caps (P3-M1)
  "LEG_BELOW_PLANNED_MINIMUM", // a later leg re-quoted below its planned floor at prepare (P3-M2)
].filter((code) => !emissions.some((emission) => emission.code === code)) as KletiaErrorCode[]);

describe("error catalog drift", () => {
  it("finds the API's error sites", () => {
    assert.ok(emissions.length > 150, `found ${emissions.length} emission sites`);
    for (const code of ["INTENT_UNSUPPORTED", "RATE_LIMITED", "IDEMPOTENCY_KEY_REUSED", "KEY_NOT_MANAGEABLE", "MCP_ORIGIN_FORBIDDEN", "REFERENCE_WRONG_SENDER"]) {
      assert.ok(emissions.some((emission) => emission.code === code), `scan sees ${code}`);
    }
  });

  it("catalogues every literal code the API can emit", () => {
    const missing = [...new Set(emissions.filter((emission) => !isKletiaErrorCode(emission.code)).map((emission) => `${emission.code} (${emission.where})`))];
    assert.deepEqual(missing, [], "add these codes to ERROR_CATALOG in packages/core/src/errors.ts");
  });

  it("matches each catalogued status to how the code is emitted", () => {
    const wrong: string[] = [];
    for (const emission of emissions) {
      if (!isKletiaErrorCode(emission.code)) continue;
      const entry: ErrorCatalogEntry = ERROR_CATALOG[emission.code];
      if (emission.status === "step") {
        if (!entry.step) wrong.push(`${emission.code} is a step failure code (${emission.where}) but not marked step`);
        continue;
      }
      const allowed: readonly number[] = [...(entry.status === null ? [] : [entry.status]), ...(entry.otherStatuses ?? [])];
      if (!allowed.includes(emission.status)) wrong.push(`${emission.code} emitted with ${emission.status} at ${emission.where}, catalog allows ${allowed.join("/") || "none"}`);
    }
    // Rejected references are returned as 422 by submit (service.ts rejectionError).
    for (const code of REJECTION_CODES) {
      const entry = isKletiaErrorCode(code) ? ERROR_CATALOG[code] : undefined;
      if (entry?.status !== 422) wrong.push(`${code} is a reference rejection and must be catalogued as 422`);
    }
    assert.deepEqual(wrong, []);
  });

  it("has no catalog entry that nothing emits (except provider families, the generic fallbacks and codes still owed)", () => {
    const emitted = new Set(emissions.map((emission) => emission.code));
    const families = new Set<KletiaErrorCode>(["PROVIDER_UNAVAILABLE", "PROVIDER_REJECTED", "PLATFORM_ERROR"]);
    const unused = errorCatalogRows()
      .map((row) => row.code)
      .filter((code) => !emitted.has(code) && !families.has(code) && !OWED_CODES.has(code));
    assert.deepEqual(unused, []);
  });

  it("owes only codes of the 2026-10 reading and routes features, each still catalogued", () => {
    const owed = new Set<KletiaErrorCode>([...FEATURE_ERROR_CODES.reading, ...FEATURE_ERROR_CODES.routes]);
    for (const code of OWED_CODES) {
      assert.ok(isKletiaErrorCode(code), `${code} is catalogued`);
      assert.ok(owed.has(code), `${code} belongs to the reading or routes feature`);
    }
  });

  it("only builds dynamic codes from provider names (resolved by family)", () => {
    for (const site of dynamic) {
      assert.match(site, /providerCode\(|error\.code|failure\.code|CODE_PATTERN\.test\(error\.code\)/u, `unexpected dynamic error code: ${site}`);
    }
    for (const provider of ["RELAY", "JUPITER", "KAMINO", "LI_FI", "DEBRIDGE"]) {
      assert.equal(resolveErrorCode(`${provider}_UNAVAILABLE`), "PROVIDER_UNAVAILABLE");
      assert.equal(resolveErrorCode(`${provider}_REJECTED`), "PROVIDER_REJECTED");
    }
  });

  it("documents every catalogued code in docs/platform/errors.md", () => {
    const doc = fs.readFileSync(path.join(REPO, "docs", "platform", "errors.md"), "utf8");
    const undocumented = errorCatalogRows().map((row) => row.code).filter((code) => !doc.includes(`\`${code}\``));
    assert.deepEqual(undocumented, [], "add a row per code to docs/platform/errors.md");
  });
});

describe("error details", () => {
  /** Minimal Express stand-ins: sendError only reads headers and writes status + JSON. */
  function capture(error: unknown): { status: number; body: { error: Record<string, unknown> } } {
    const headers = new Map<string, string>();
    let status = 0;
    let body: unknown;
    const req = { get: () => undefined } as unknown as Parameters<typeof sendError>[0];
    const res = {
      headersSent: false,
      setHeader: (name: string, value: string) => headers.set(name.toLowerCase(), value),
      getHeader: (name: string) => headers.get(name.toLowerCase()),
      destroy: () => undefined,
      status(code: number) {
        status = code;
        return { json: (value: unknown) => { body = value; } };
      },
    } as unknown as Parameters<typeof sendError>[1];
    sendError(req, res, error);
    return { status, body: body as { error: Record<string, unknown> } };
  }

  it("serialises details beside issues and hints", () => {
    const details = { asset: "USDC", amount: "25", toNetwork: "solana", candidates: [{ network: "base", balance: "3.10", enough: false }] };
    const error = new PlatformError("SOURCE_REQUIRED", "No network holds 25 USDC for this bridge.", 422, [{ path: "sourceNetwork", message: "x" }], ["bridge 25 USDC from base to solana"], details);
    assert.deepEqual(error.toJSON().details, details);
    const { status, body } = capture(error);
    assert.equal(status, 422);
    assert.deepEqual(Object.keys(body.error), ["code", "message", "issues", "hints", "details", "docs"]);
    assert.deepEqual(body.error.details, details);
    assert.ok(Object.isFrozen(error.details), "details are a frozen copy");
    details.candidates[0]!.balance = "999";
    assert.equal((error.details?.candidates as { balance: string }[])[0]?.balance, "3.10", "later changes to the input do not leak in");
  });

  it("refuses details above 4 KB or outside plain JSON, keeping the error itself", () => {
    const large = { blob: "x".repeat(MAX_ERROR_DETAILS_BYTES) };
    const big = new PlatformError("SOURCE_REQUIRED", "too much", 422, undefined, undefined, large);
    assert.equal(big.details, undefined);
    assert.equal("details" in big.toJSON(), false);
    assert.equal(capture(big).body.error.code, "SOURCE_REQUIRED");
    const fits = { blob: "x".repeat(MAX_ERROR_DETAILS_BYTES - 20) };
    assert.ok(platformErrorDetails(fits), "4 KB including the JSON punctuation is accepted");
    assert.equal(platformErrorDetails({ blob: "é".repeat(MAX_ERROR_DETAILS_BYTES / 2) }), null, "the limit counts UTF-8 bytes");
    for (const bad of [[1, 2], "text", null, { when: new Date(0) }, { amount: 1n }, { ratio: Number.NaN }, { nested: { fn: () => 1 } }]) {
      assert.equal(platformErrorDetails(bad), null, String(bad));
    }
    assert.equal(new PlatformError("INVALID_REQUEST", "plain").toJSON().details, undefined, "no details unless given");
  });
});
