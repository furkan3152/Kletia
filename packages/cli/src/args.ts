import { parseArgs } from "node:util";

export type OptionSpec = {
  readonly type: "string" | "boolean";
  readonly multiple?: boolean;
  readonly short?: string;
  readonly description: string;
  /** Placeholder in help text, e.g. `<network>`. */
  readonly value?: string;
};

export type OptionValues = Readonly<Record<string, string | boolean | string[] | undefined>>;

/** Wrong invocation: printed with the command's usage, exit code 64. */
export class UsageError extends Error {
  readonly usage: string | undefined;

  constructor(message: string, usage?: string) {
    super(message);
    this.name = "UsageError";
    this.usage = usage;
  }
}

export const GLOBAL_OPTIONS = {
  json: { type: "boolean", description: "Print JSON instead of tables." },
  "base-url": { type: "string", value: "<url>", description: "API origin (default $KLETIA_BASE_URL or https://api.kletiaai.xyz)." },
  timeout: { type: "string", value: "<seconds>", description: "Per-request timeout (default 20)." },
  help: { type: "boolean", short: "h", description: "Show help." },
} as const satisfies Record<string, OptionSpec>;

/** Flags that would put a secret in shell history or the process list. */
const SECRET_FLAGS = new Set(["--api-key", "--key", "--token", "--secret"]);

export interface ParsedCommandLine {
  readonly values: OptionValues;
  readonly positionals: readonly string[];
}

export function parseCommandLine(
  argv: readonly string[],
  options: Readonly<Record<string, OptionSpec>>,
  usage: string,
): ParsedCommandLine {
  for (const arg of argv) {
    const flag = arg.split("=", 1)[0] ?? "";
    if (SECRET_FLAGS.has(flag)) {
      throw new UsageError(
        `${flag} is not accepted: secrets passed as flags end up in shell history and process lists. ` +
          "Set KLETIA_API_KEY (API key) or KLETIA_WEBHOOK_SECRET (webhook secret) in the environment instead.",
        usage,
      );
    }
  }
  const config: Record<string, { type: "string" | "boolean"; multiple?: boolean; short?: string }> = {};
  const all: Readonly<Record<string, OptionSpec>> = { ...GLOBAL_OPTIONS, ...options };
  for (const [name, spec] of Object.entries(all)) {
    config[name] = {
      type: spec.type,
      ...(spec.multiple ? { multiple: true } : {}),
      ...(spec.short ? { short: spec.short } : {}),
    };
  }
  try {
    const parsed = parseArgs({ args: [...argv], options: config, allowPositionals: true, strict: true });
    return { values: parsed.values as OptionValues, positionals: parsed.positionals };
  } catch (error) {
    const message = error instanceof Error ? error.message.replace(/\. To specify a positional argument.*$/su, ".") : "Invalid arguments.";
    throw new UsageError(message, usage);
  }
}

export function stringOption(values: OptionValues, name: string): string | undefined {
  const value = values[name];
  return typeof value === "string" ? value : undefined;
}

export function listOption(values: OptionValues, name: string): string[] {
  const value = values[name];
  if (Array.isArray(value)) return value.flatMap((entry) => entry.split(",")).map((entry) => entry.trim()).filter(Boolean);
  return typeof value === "string" ? [value] : [];
}

export function integerOption(values: OptionValues, name: string, min: number, max: number, usage: string): number | undefined {
  const raw = stringOption(values, name);
  if (raw === undefined) return undefined;
  if (!/^\d+$/u.test(raw)) throw new UsageError(`--${name} must be a whole number between ${min} and ${max}.`, usage);
  const value = Number(raw);
  if (value < min || value > max) throw new UsageError(`--${name} must be between ${min} and ${max}.`, usage);
  return value;
}
