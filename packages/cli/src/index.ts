/** Programmatic entry of `@kletia/cli` (the `kletia` binary wraps `run`). */
export { CLI_VERSION, run } from "./cli.js";
export { COMMANDS, EXIT_ERROR, EXIT_NOT_COMPLETED, EXIT_OK, EXIT_USAGE } from "./commands.js";
export type { Command, CommandContext } from "./commands.js";
export { redact } from "./output.js";
export type { CliIo, CliOutput } from "./output.js";
