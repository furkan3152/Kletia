import { CHAINS } from "@kletia/core";
import { DEFAULT_BASE_URL, KletiaApiError, KletiaClient, SDK_VERSION } from "@kletia/sdk";
import { GLOBAL_OPTIONS, parseCommandLine, stringOption, UsageError, type OptionSpec } from "./args.js";
import { COMMANDS, EXIT_ERROR, EXIT_OK, EXIT_USAGE, type Command, type CommandContext } from "./commands.js";
import { Printer, type CliIo } from "./output.js";

/** Kept equal to the @kletia/core and @kletia/sdk versions (packages move in lockstep). */
export const CLI_VERSION = "0.1.0";

function optionHelp(options: Readonly<Record<string, OptionSpec>>): string[] {
  return Object.entries(options).map(([name, spec]) => {
    const flag = `${spec.short ? `-${spec.short}, ` : ""}--${name}${spec.value ? ` ${spec.value}` : ""}`;
    return `  ${flag.padEnd(30)} ${spec.description}`;
  });
}

function usageLine(command: Command): string {
  return `kletia ${command.name}${command.args ? ` ${command.args}` : ""}`;
}

function commandHelp(command: Command): string {
  return [
    `Usage: ${usageLine(command)} [options]`,
    "",
    command.summary,
    ...(command.key ? ["", "Needs an API key in KLETIA_API_KEY."] : []),
    "",
    "Options:",
    ...optionHelp(command.options ?? {}),
    ...optionHelp(GLOBAL_OPTIONS),
  ].join("\n");
}

function mainHelp(): string {
  const width = Math.max(...COMMANDS.map((command) => command.name.length));
  return [
    `kletia ${CLI_VERSION}: the Kletia intent API from your terminal. It never signs or holds funds.`,
    "",
    "Usage: kletia <command> [options]",
    "",
    "Commands:",
    ...COMMANDS.map((command) => `  ${command.name.padEnd(width)}  ${command.summary}`),
    "",
    "Environment:",
    "  KLETIA_API_KEY         Developer key (kl_dev_…). Never passed as a flag.",
    "  KLETIA_BASE_URL        API origin (default https://api.kletiaai.xyz).",
    "  KLETIA_WEBHOOK_SECRET  Signing secret for `webhooks verify` and `webhooks forward`.",
    "",
    "Global options:",
    ...optionHelp(GLOBAL_OPTIONS),
    "",
    "Exit codes: 0 ok, 1 error, 2 intent ended without completing, 64 usage error.",
    `Networks: ${Object.keys(CHAINS).join(", ")}`,
  ].join("\n");
}

/** The command named by the leading words of argv, and the remaining arguments. */
function findCommand(argv: readonly string[]): { command: Command | undefined; rest: readonly string[]; words: string } {
  const words: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("-")) break;
    words.push(arg);
    if (words.length === 2) break;
  }
  for (let count = words.length; count > 0; count -= 1) {
    const name = words.slice(0, count).join(" ");
    const command = COMMANDS.find((candidate) => candidate.name === name);
    if (command) {
      const index = argv.indexOf(words[count - 1] as string);
      return { command, rest: [...argv.slice(0, argv.indexOf(words[0] as string)), ...argv.slice(index + 1)], words: name };
    }
  }
  return { command: undefined, rest: argv, words: words.join(" ") };
}

function reportError(print: Printer, error: unknown, json: boolean): number {
  if (error instanceof UsageError) {
    print.err(`kletia: ${error.message}`);
    if (error.usage) print.err(`Usage: ${error.usage}`);
    return EXIT_USAGE;
  }
  if (error instanceof KletiaApiError) {
    if (json) {
      print.err(
        JSON.stringify({
          error: {
            code: error.code,
            message: error.message,
            status: error.status,
            issues: error.issues,
            hints: error.hints,
            docs: error.docsUrl,
            requestId: error.requestId,
          },
        }),
      );
      return EXIT_ERROR;
    }
    print.err(`kletia: ${error.code}${error.status ? ` (HTTP ${error.status})` : ""}: ${error.message}`);
    for (const issue of error.issues) print.err(`  ${issue.path || "request"}: ${issue.message}`);
    for (const hint of error.hints.slice(0, 5)) print.err(`  try: ${hint}`);
    if (error.retryAfterSeconds !== null) print.err(`  retry after ${error.retryAfterSeconds}s`);
    if (error.docsUrl) print.err(`  docs: ${error.docsUrl}`);
    if (error.requestId) print.err(`  request id: ${error.requestId}`);
    return EXIT_ERROR;
  }
  print.err(`kletia: ${error instanceof Error ? error.message : String(error)}`);
  return EXIT_ERROR;
}

/**
 * Runs one `kletia` invocation and resolves with its exit code. All output
 * goes through `io`; nothing is read from or written to the process here,
 * which keeps it testable (see bin.ts for the process wiring).
 */
export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  const apiKey = io.env.KLETIA_API_KEY?.trim() || undefined;
  const print = new Printer(io, [apiKey, io.env.KLETIA_WEBHOOK_SECRET]);
  const json = argv.includes("--json");
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    const topic = argv[0] === "help" ? findCommand(argv.slice(1)).command : undefined;
    print.out(topic ? commandHelp(topic) : mainHelp());
    return EXIT_OK;
  }
  if (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "version") {
    print.out(`@kletia/cli ${CLI_VERSION} (sdk js/${SDK_VERSION})`);
    return EXIT_OK;
  }
  const { command, rest, words } = findCommand(argv);
  if (!command) {
    const group = COMMANDS.filter((candidate) => candidate.name.startsWith(`${words.split(" ")[0]} `));
    if (group.length > 0) {
      print.err(`kletia: choose a command:\n${group.map((candidate) => `  ${usageLine(candidate)}`).join("\n")}`);
      return EXIT_USAGE;
    }
    print.err(`kletia: unknown command "${words || argv[0]}". Run \`kletia help\`.`);
    return EXIT_USAGE;
  }
  const usage = usageLine(command);
  try {
    const { values, positionals } = parseCommandLine(rest, command.options ?? {}, usage);
    if (values.help === true) {
      print.out(commandHelp(command));
      return EXIT_OK;
    }
    if (positionals.length < command.positionals.min || positionals.length > command.positionals.max) {
      throw new UsageError(
        positionals.length < command.positionals.min ? "Missing argument." : `Unexpected argument "${positionals[command.positionals.max]}".`,
        usage,
      );
    }
    if (command.key && !apiKey) throw new UsageError(`kletia ${command.name} needs an API key: set KLETIA_API_KEY.`, usage);
    const timeout = stringOption(values, "timeout");
    if (timeout !== undefined && !/^\d+$/u.test(timeout)) throw new UsageError("--timeout must be a whole number of seconds.", usage);
    let client: KletiaClient | null = null;
    const context: CommandContext = {
      values,
      positionals,
      print,
      io,
      json: values.json === true,
      signal: io.signal,
      usage,
      hasApiKey: Boolean(apiKey),
      client: () => {
        if (client) return client;
        const baseUrl = stringOption(values, "base-url") ?? io.env.KLETIA_BASE_URL ?? DEFAULT_BASE_URL;
        try {
          client = new KletiaClient({
            baseUrl,
            ...(apiKey ? { apiKey } : {}),
            ...(timeout !== undefined ? { timeoutMs: Math.max(1, Number(timeout)) * 1000 } : {}),
            ...(io.fetch ? { fetch: io.fetch } : {}),
            headers: { "x-kletia-client": `cli/${CLI_VERSION}` },
          });
        } catch (error) {
          throw new UsageError(error instanceof Error ? error.message : "Invalid base URL.", usage);
        }
        return client;
      },
    };
    return await command.run(context);
  } catch (error) {
    if (io.signal?.aborted && !(error instanceof UsageError)) {
      print.err("kletia: interrupted.");
      return 130;
    }
    return reportError(print, error, json);
  }
}
