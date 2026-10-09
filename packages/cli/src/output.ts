/**
 * Terminal output. stdout carries the data a command produces (tables or
 * JSON); stderr carries progress, notices and errors.
 *
 * Secrets are never printed by accident: everything written through the
 * printer is redacted (API keys `kl_dev_…`/`kl_op_…`, webhook secrets
 * `whsec_…`, and the configured key and webhook secret verbatim). The one
 * exception is `secret()`, used once by the commands that mint a secret.
 */

export interface CliOutput {
  write(chunk: string): unknown;
  readonly isTTY?: boolean;
}

export interface CliIo {
  readonly stdout: CliOutput;
  readonly stderr: CliOutput;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Reads stdin to the end (`webhooks verify`). */
  readonly readStdin?: () => Promise<string>;
  /** Custom fetch (tests). */
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Aborted on Ctrl-C. */
  readonly signal?: AbortSignal;
}

const KEY_PATTERN = /\b(kl_(?:dev|op)_|whsec_)([0-9A-Za-z]{6,})/gu;

/** Replaces anything that looks like a Kletia secret (and the given literal values) with a masked form. */
export function redact(text: string, literals: readonly string[] = []): string {
  let result = text;
  for (const literal of literals) {
    if (literal.length >= 8) result = result.split(literal).join("[redacted]");
  }
  return result.replace(KEY_PATTERN, (_match, prefix: string, body: string) => `${prefix}…${body.slice(-4)}`);
}

export class Printer {
  private readonly io: CliIo;
  private readonly literals: readonly string[];

  constructor(io: CliIo, literals: readonly (string | undefined)[]) {
    this.io = io;
    this.literals = literals.filter((value): value is string => typeof value === "string" && value.length > 0);
  }

  get stdoutIsTerminal(): boolean {
    return this.io.stdout.isTTY === true;
  }

  /** Data on stdout. */
  out(text = ""): void {
    this.io.stdout.write(`${redact(text, this.literals)}\n`);
  }

  /** Progress, notices and errors on stderr. */
  err(text = ""): void {
    this.io.stderr.write(`${redact(text, this.literals)}\n`);
  }

  json(value: unknown): void {
    this.out(JSON.stringify(value, null, 2));
  }

  /** One JSON document per line (streams). */
  jsonLine(value: unknown): void {
    this.out(JSON.stringify(value));
  }

  /** A newly minted secret, unredacted. Callers check `secretSink` first. */
  secret(text: string): void {
    this.io.stdout.write(`${text}\n`);
  }
}

/** Left-aligned columns separated by two spaces. */
export function table(rows: readonly (readonly string[])[], header?: readonly string[]): string {
  const all = header ? [header, ...rows] : [...rows];
  if (all.length === 0) return "";
  const widths: number[] = [];
  for (const row of all) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }
  return all
    .map((row) =>
      row
        .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

/** A compact decimal: at most 6 significant fraction digits, no trailing zeros. */
export function amount(value: string | undefined | null): string {
  if (!value) return "-";
  const [whole = "0", fraction = ""] = value.split(".");
  const trimmed = fraction.slice(0, 6).replace(/0+$/u, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

export function when(value: string | null | undefined): string {
  return value ? value.replace("T", " ").replace(/\.\d+Z$/u, "Z") : "-";
}
