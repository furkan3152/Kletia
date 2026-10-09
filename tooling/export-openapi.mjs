#!/usr/bin/env node
// Exports the Platform API v1 OpenAPI document to docs/platform/openapi.json.
//
//   node tooling/export-openapi.mjs           # write the file
//   node tooling/export-openapi.mjs --check   # fail when the committed file is stale
//
// The document comes from `buildOpenApiDocument()` in the API source, the same
// function behind GET /v1/openapi.json, loaded through tsx so no API build is
// needed (the @kletia/* packages must be built). Before writing or comparing,
// the document passes a structural lint: every $ref resolves, operation ids
// are unique, every operation has a summary and a declared, described tag,
// every path template parameter is declared and every security requirement
// names a defined scheme.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "apps/api/src/platform/http/openapi.ts");
const output = resolve(root, "docs/platform/openapi.json");
const check = process.argv.includes("--check");
const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

/** Loads the API module quietly: configuration warnings only matter if the import fails. */
async function loadDocument() {
  process.env.DOTENV_CONFIG_QUIET ??= "true";
  const buffered = [];
  const original = { log: console.log, info: console.info, warn: console.warn };
  for (const level of Object.keys(original)) console[level] = (...args) => buffered.push(args);
  try {
    const { tsImport } = await import("tsx/esm/api");
    const module = await tsImport(pathToFileURL(source).href, import.meta.url);
    return module.buildOpenApiDocument();
  } catch (error) {
    Object.assign(console, original);
    for (const args of buffered) console.error(...args);
    console.error(`Could not load ${relative(root, source)}. Build the packages first (npm run build:packages).`);
    throw error;
  } finally {
    Object.assign(console, original);
  }
}

function lint(document) {
  const problems = [];
  const resolvePointer = (pointer) => {
    if (!pointer.startsWith("#/")) return undefined;
    let node = document;
    for (const raw of pointer.slice(2).split("/")) {
      const key = raw.replace(/~1/gu, "/").replace(/~0/gu, "~");
      if (node === null || typeof node !== "object" || !(key in node)) return undefined;
      node = node[key];
    }
    return node;
  };
  const visit = (node, at) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${at}/${index}`));
      return;
    }
    if (node === null || typeof node !== "object") return;
    if (typeof node.$ref === "string" && resolvePointer(node.$ref) === undefined) {
      problems.push(`${at}: $ref ${node.$ref} does not resolve`);
    }
    for (const [key, value] of Object.entries(node)) visit(value, `${at}/${key}`);
  };
  visit(document, "#");

  if (!/^3\.1\.\d+$/u.test(String(document.openapi))) problems.push(`openapi must be 3.1.x, found ${document.openapi}`);
  if (!document.info?.title || !document.info?.version) problems.push("info.title and info.version are required");
  const tags = new Map((document.tags ?? []).map((tag) => [tag.name, tag]));
  for (const [name, tag] of tags) if (!tag.description) problems.push(`tag ${name} has no description`);
  const schemes = new Set(Object.keys(document.components?.securitySchemes ?? {}));
  const checkSecurity = (requirements, at) => {
    for (const requirement of requirements ?? []) {
      for (const scheme of Object.keys(requirement)) {
        if (!schemes.has(scheme)) problems.push(`${at}: security scheme ${scheme} is not defined`);
      }
    }
  };
  checkSecurity(document.security, "security");
  for (const server of document.servers ?? []) {
    if (String(server.url).endsWith("/")) problems.push(`server ${server.url} must not end with a slash`);
  }

  const operationIds = new Map();
  const deref = (value) => (typeof value?.$ref === "string" ? resolvePointer(value.$ref) : value);
  const operations = (paths, prefix) => {
    for (const [path, item] of Object.entries(paths ?? {})) {
      const shared = (item.parameters ?? []).map(deref);
      for (const method of HTTP_METHODS) {
        const operation = item[method];
        if (!operation) continue;
        const at = `${prefix}${method.toUpperCase()} ${path}`;
        if (!operation.operationId) problems.push(`${at}: missing operationId`);
        else if (operationIds.has(operation.operationId)) {
          problems.push(`${at}: operationId ${operation.operationId} is also used by ${operationIds.get(operation.operationId)}`);
        } else operationIds.set(operation.operationId, at);
        if (!operation.summary) problems.push(`${at}: missing summary`);
        if (!operation.responses || Object.keys(operation.responses).length === 0) problems.push(`${at}: no responses`);
        if (prefix) continue; // webhooks have no path template or tags to check
        if (!operation.tags?.length) problems.push(`${at}: no tag`);
        for (const tag of operation.tags ?? []) if (!tags.has(tag)) problems.push(`${at}: tag ${tag} is not declared`);
        checkSecurity(operation.security, at);
        const parameters = [...shared, ...(operation.parameters ?? []).map(deref)].filter(Boolean);
        for (const [, name] of path.matchAll(/\{([^}]+)\}/gu)) {
          const declared = parameters.find((parameter) => parameter.in === "path" && parameter.name === name);
          if (!declared) problems.push(`${at}: path parameter {${name}} is not declared`);
          else if (declared.required !== true) problems.push(`${at}: path parameter {${name}} must be required`);
        }
        for (const parameter of parameters) {
          if (parameter.in === "path" && !path.includes(`{${parameter.name}}`)) {
            problems.push(`${at}: path parameter ${parameter.name} is not in the path`);
          }
        }
      }
    }
  };
  operations(document.paths, "");
  operations(document.webhooks, "webhook ");
  return { problems, operations: operationIds.size };
}

const document = await loadDocument();
const { problems, operations } = lint(document);
if (problems.length > 0) {
  console.error("OpenAPI lint failed:");
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}

const json = `${JSON.stringify(document, null, 2)}\n`;
const target = relative(root, output);
const summary = `OpenAPI ${document.openapi}, API ${document.info.version}: ${Object.keys(document.paths).length} paths, ${operations} operations, ${Object.keys(document.components?.schemas ?? {}).length} schemas`;

if (!check) {
  writeFileSync(output, json);
  console.log(`Wrote ${target} (${summary}).`);
} else {
  const committed = existsSync(output) ? readFileSync(output, "utf8") : null;
  if (committed === json) {
    console.log(`${target} is up to date (${summary}).`);
  } else {
    console.error(`${target} is out of date with ${relative(root, source)}.`);
    if (committed !== null) {
      try {
        const previous = JSON.parse(committed);
        const before = new Set(Object.keys(previous.paths ?? {}));
        const after = new Set(Object.keys(document.paths));
        for (const path of after) if (!before.has(path)) console.error(`- added path ${path}`);
        for (const path of before) if (!after.has(path)) console.error(`- removed path ${path}`);
        for (const key of Object.keys({ ...previous, ...document })) {
          if (JSON.stringify(previous[key]) !== JSON.stringify(document[key])) console.error(`- "${key}" changed`);
        }
      } catch {
        console.error("- the committed file is not valid JSON");
      }
    }
    console.error("Run `npm run generate:openapi` and commit docs/platform/openapi.json and docs/platform/collections/.");
    process.exitCode = 1;
  }
}
