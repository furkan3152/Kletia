/**
 * Newly minted secrets (API keys, agent keys, webhook signing secrets,
 * receipt share links): where they go is decided before the API call, so a
 * secret is never created only to be lost or shown on a terminal by surprise.
 */
import { open, rm } from "node:fs/promises";
import { stringOption, UsageError, type OptionSpec } from "./args.js";
import type { CommandContext } from "./common.js";

export type SecretSink = { readonly kind: "stdout" } | { readonly kind: "file"; readonly path: string; readonly handle: Awaited<ReturnType<typeof open>> };

export const SECRET_OPTIONS = {
  "secret-file": { type: "string", value: "<path>", description: "Write the new secret to this file (mode 600; must not exist)." },
  reveal: { type: "boolean", description: "Print the new secret on this terminal." },
} as const satisfies Record<string, OptionSpec>;

/**
 * Decides where a newly minted secret goes, before the API call, so a
 * secret is never created only to be lost or shown on a terminal by surprise.
 */
export async function openSecretSink(context: CommandContext, fileOption = "secret-file"): Promise<SecretSink> {
  const path = stringOption(context.values, fileOption);
  if (path) {
    try {
      return { kind: "file", path, handle: await open(path, "wx", 0o600) };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new UsageError(code === "EEXIST" ? `${path} already exists; choose a new file.` : `Cannot create ${path} (${code ?? "error"}).`, context.usage);
    }
  }
  if (context.values.reveal === true || !context.print.stdoutIsTerminal) return { kind: "stdout" };
  throw new UsageError(
    `This command prints a new secret once. Redirect stdout (e.g. \`> secret.txt\`), pass --${fileOption} <path>, or pass --reveal to show it on this terminal.`,
    context.usage,
  );
}

export async function abandonSecretSink(sink: SecretSink): Promise<void> {
  if (sink.kind !== "file") return;
  await sink.handle.close().catch(() => undefined);
  await rm(sink.path, { force: true }).catch(() => undefined);
}

/** Writes the secret to its sink; `record` (without the secret) is the JSON/summary for stdout. */
export async function deliverSecret(
  context: CommandContext,
  sink: SecretSink,
  secret: string,
  record: Record<string, unknown>,
  secretField: string,
  summary: string,
): Promise<void> {
  if (sink.kind === "file") {
    try {
      await sink.handle.writeFile(`${secret}\n`, "utf8");
    } finally {
      await sink.handle.close();
    }
    if (context.json) context.print.json(record);
    else context.print.out(summary);
    context.print.err(`The secret was written to ${sink.path} (mode 600). It is not shown again.`);
    return;
  }
  if (context.json) {
    context.print.secret(JSON.stringify({ ...record, [secretField]: secret }, null, 2));
    return;
  }
  context.print.err(summary);
  context.print.err("The secret below is shown once; store it now:");
  context.print.secret(secret);
}
