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
import { ERROR_CATALOG, errorCatalogRows, isKletiaErrorCode, resolveErrorCode, type ErrorCatalogEntry, type KletiaErrorCode } from "@kletia/core";
import { REJECTION_CODES } from "../../index.js";

const SRC = fileURLToPath(new URL("../../../", import.meta.url));
const REPO = fileURLToPath(new URL("../../../../../../", import.meta.url));

/** Emission sites: the engine and HTTP layer, plus the Solana modules the engine calls (not their first-party routes). */
const SCAN_ROOTS = ["platform", "networks/solana"];
const SKIP_FILES = new Set([path.join("networks", "solana", "routes.ts")]);

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
      } else if (entry.name.endsWith(".ts") && !SKIP_FILES.has(path.relative(SRC, full))) files.push(full);
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

  it("has no catalog entry that nothing emits (except provider families and the generic fallbacks)", () => {
    const emitted = new Set(emissions.map((emission) => emission.code));
    const families = new Set<KletiaErrorCode>(["PROVIDER_UNAVAILABLE", "PROVIDER_REJECTED", "PLATFORM_ERROR"]);
    const unused = errorCatalogRows().map((row) => row.code).filter((code) => !emitted.has(code) && !families.has(code));
    assert.deepEqual(unused, []);
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
