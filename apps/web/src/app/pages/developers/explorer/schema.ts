/**
 * The small slice of JSON Schema 2020-12 the API explorer needs: `$ref`
 * resolution against an OpenAPI document, example generation and a
 * best-effort validator for request bodies. The API stays the authority:
 * the validator only warns before a request is sent.
 */

export interface JsonSchema {
  readonly $ref?: string;
  readonly type?: string | readonly string[];
  readonly title?: string;
  readonly description?: string;
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly default?: unknown;
  readonly examples?: readonly unknown[];
  readonly example?: unknown;
  readonly format?: string;
  readonly pattern?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly items?: JsonSchema;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly maxProperties?: number;
  readonly oneOf?: readonly JsonSchema[];
  readonly anyOf?: readonly JsonSchema[];
  readonly allOf?: readonly JsonSchema[];
}

/** Loose OpenAPI 3.1 document: only the parts the explorer reads are typed. */
export interface OpenApiDoc {
  readonly openapi?: string;
  readonly info?: { readonly title?: string; readonly version?: string; readonly description?: string };
  readonly tags?: readonly { readonly name: string; readonly description?: string }[];
  readonly paths?: Readonly<Record<string, unknown>>;
  readonly components?: Readonly<Record<string, unknown>>;
}

const MAX_DEPTH = 10;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Follows a local `#/a/b/c` pointer; null when it does not resolve. */
export function resolvePointer(doc: OpenApiDoc, ref: string): unknown {
  if (!ref.startsWith("#/")) return null;
  let node: unknown = doc;
  for (const raw of ref.slice(2).split("/")) {
    const key = raw.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (!isRecord(node)) return null;
    node = node[key];
  }
  return node ?? null;
}

/** Resolves a top-level `$ref` chain (shallow). */
export function resolveRef<T>(doc: OpenApiDoc, value: unknown): T | null {
  let node = value;
  for (let hop = 0; hop < MAX_DEPTH && isRecord(node) && typeof node.$ref === "string"; hop += 1) {
    node = resolvePointer(doc, node.$ref);
  }
  return isRecord(node) ? (node as T) : null;
}

/**
 * Fully dereferences a schema (nested properties, items and combinators)
 * up to a fixed depth, so cyclic schemas cannot loop. Sibling keywords next
 * to `$ref` override the referenced schema's (OpenAPI 3.1 semantics).
 */
export function derefSchema(doc: OpenApiDoc, schema: unknown, depth = 0): JsonSchema {
  if (!isRecord(schema) || depth > MAX_DEPTH) return {};
  let base: Record<string, unknown> = schema;
  if (typeof schema.$ref === "string") {
    const target = resolveRef<Record<string, unknown>>(doc, schema);
    const { $ref: _ref, ...siblings } = schema;
    void _ref;
    base = { ...(target ?? {}), ...siblings };
  }
  const out: Record<string, unknown> = { ...base };
  delete out.$ref;
  if (isRecord(base.properties)) {
    const properties: Record<string, JsonSchema> = {};
    for (const [key, value] of Object.entries(base.properties)) properties[key] = derefSchema(doc, value, depth + 1);
    out.properties = properties;
  }
  if (isRecord(base.items)) out.items = derefSchema(doc, base.items, depth + 1);
  if (isRecord(base.additionalProperties)) out.additionalProperties = derefSchema(doc, base.additionalProperties, depth + 1);
  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    const list = base[key];
    if (Array.isArray(list)) out[key] = list.map((item) => derefSchema(doc, item, depth + 1));
  }
  return out as JsonSchema;
}

/** Types a schema allows (empty when unconstrained). */
export function schemaTypes(schema: JsonSchema): string[] {
  if (Array.isArray(schema.type)) return [...schema.type];
  if (typeof schema.type === "string") return [schema.type];
  if (schema.properties) return ["object"];
  if (schema.items) return ["array"];
  return [];
}

/** One-line type label for docs, e.g. `string`, `integer 1..100`, `"24h" | "7d"`. */
export function describeSchemaType(schema: JsonSchema): string {
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum && schema.enum.length > 0 && schema.enum.length <= 6) {
    return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  }
  const alternatives = schema.oneOf ?? schema.anyOf;
  if (alternatives && !schema.type) {
    return alternatives.map((item) => item.title ?? describeSchemaType(item)).join(" | ");
  }
  const types = schemaTypes(schema).filter((type) => type !== "null");
  let label = types.length > 0 ? types.join(" | ") : "any";
  if (types.includes("array") && schema.items) label = `${describeSchemaType(schema.items)}[]`;
  if (schema.enum && schema.enum.length > 6) label = `enum (${schema.enum.length} values)`;
  if (schemaTypes(schema).includes("null")) label += " | null";
  return label;
}

/** Human constraints, e.g. ["1-100", "pattern ^key_…"]. */
export function describeConstraints(schema: JsonSchema): string[] {
  const out: string[] = [];
  if (schema.minimum !== undefined || schema.maximum !== undefined) {
    out.push(`${schema.minimum ?? "…"}–${schema.maximum ?? "…"}`);
  }
  if (schema.minLength !== undefined || schema.maxLength !== undefined) {
    out.push(`${schema.minLength ?? 0}–${schema.maxLength ?? "…"} chars`);
  }
  if (schema.minItems !== undefined || schema.maxItems !== undefined) {
    out.push(`${schema.minItems ?? 0}–${schema.maxItems ?? "…"} items`);
  }
  if (schema.default !== undefined) out.push(`default ${JSON.stringify(schema.default)}`);
  if (schema.format) out.push(schema.format);
  return out;
}

/** A plausible example value for a schema (documented examples first). */
export function exampleFor(schema: JsonSchema, depth = 0): unknown {
  if (depth > MAX_DEPTH) return null;
  if (schema.examples && schema.examples.length > 0) return schema.examples[0];
  if (schema.example !== undefined) return schema.example;
  if (schema.const !== undefined) return schema.const;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum && schema.enum.length > 0) return schema.enum[0];
  if (schema.allOf && schema.allOf.length > 0) {
    return schema.allOf.reduce<Record<string, unknown>>((merged, part) => {
      const value = exampleFor(part, depth + 1);
      return isRecord(value) ? { ...merged, ...value } : merged;
    }, {});
  }
  const alternative = schema.oneOf?.[0] ?? schema.anyOf?.[0];
  if (alternative && !schema.type && !schema.properties) return exampleFor(alternative, depth + 1);
  const types = schemaTypes(schema).filter((type) => type !== "null");
  switch (types[0]) {
    case "object": {
      const out: Record<string, unknown> = {};
      for (const key of schema.required ?? []) {
        const property = schema.properties?.[key];
        if (property) out[key] = exampleFor(property, depth + 1);
      }
      return out;
    }
    case "array":
      return schema.items ? [exampleFor(schema.items, depth + 1)] : [];
    case "integer":
    case "number":
      return schema.minimum ?? 0;
    case "boolean":
      return false;
    case "string":
      return schema.format === "date-time" ? "2026-10-09T12:00:00.000Z" : "";
    default:
      return null;
  }
}

export interface SchemaIssue {
  readonly path: string;
  readonly message: string;
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(value: unknown, types: readonly string[]): boolean {
  if (types.length === 0) return true;
  const actual = typeOf(value);
  return types.some((type) => type === actual || (type === "number" && actual === "integer"));
}

function join(path: string, key: string | number): string {
  if (typeof key === "number") return `${path}[${key}]`;
  return path ? `${path}.${key}` : key;
}

function safePattern(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "u");
  } catch {
    return null;
  }
}

/**
 * Best-effort validation (type, required, enum, const, pattern, lengths,
 * ranges, item counts, oneOf/anyOf as "at least one"). Returns at most
 * `limit` issues; an empty list does not promise the API will accept it.
 */
export function validateAgainstSchema(schema: JsonSchema, value: unknown, path = "", limit = 8, depth = 0): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const push = (issue: SchemaIssue) => {
    if (issues.length < limit) issues.push(issue);
  };
  if (depth > MAX_DEPTH) return issues;
  const label = path || "body";

  if (schema.allOf) {
    for (const part of schema.allOf) for (const issue of validateAgainstSchema(part, value, path, limit, depth + 1)) push(issue);
  }
  const alternatives = schema.oneOf ?? schema.anyOf;
  if (alternatives && alternatives.length > 0) {
    const results = alternatives.map((alternative) => validateAgainstSchema(alternative, value, path, limit, depth + 1));
    if (!results.some((result) => result.length === 0)) {
      const best = results.reduce((a, b) => (b.length < a.length ? b : a));
      for (const issue of best) push(issue);
    }
  }

  const types = schemaTypes(schema);
  if (!matchesType(value, types)) {
    push({ path: label, message: `expected ${types.join(" or ")}, got ${typeOf(value)}` });
    return issues;
  }
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    push({ path: label, message: `must be ${JSON.stringify(schema.const)}` });
  }
  if (schema.enum && !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) {
    const options = schema.enum.slice(0, 6).map((option) => JSON.stringify(option)).join(", ");
    push({ path: label, message: `must be one of ${options}${schema.enum.length > 6 ? ", …" : ""}` });
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) push({ path: label, message: `at least ${schema.minLength} characters` });
    if (schema.maxLength !== undefined && value.length > schema.maxLength) push({ path: label, message: `at most ${schema.maxLength} characters` });
    const pattern = schema.pattern ? safePattern(schema.pattern) : null;
    if (pattern && !pattern.test(value)) push({ path: label, message: `does not match ${schema.pattern}` });
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) push({ path: label, message: `at least ${schema.minimum}` });
    if (schema.maximum !== undefined && value > schema.maximum) push({ path: label, message: `at most ${schema.maximum}` });
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) push({ path: label, message: `at least ${schema.minItems} item(s)` });
    if (schema.maxItems !== undefined && value.length > schema.maxItems) push({ path: label, message: `at most ${schema.maxItems} items` });
    if (schema.items) {
      value.forEach((item, index) => {
        for (const issue of validateAgainstSchema(schema.items!, item, join(path, index), limit, depth + 1)) push(issue);
      });
    }
  }
  if (isRecord(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) push({ path: join(path, key), message: "is required" });
    }
    for (const [key, item] of Object.entries(value)) {
      const property = schema.properties?.[key];
      if (property) {
        for (const issue of validateAgainstSchema(property, item, join(path, key), limit, depth + 1)) push(issue);
      } else if (schema.additionalProperties === false) {
        push({ path: join(path, key), message: "is not a known property" });
      } else if (isRecord(schema.additionalProperties)) {
        for (const issue of validateAgainstSchema(schema.additionalProperties, item, join(path, key), limit, depth + 1)) push(issue);
      }
    }
  }
  return issues;
}
