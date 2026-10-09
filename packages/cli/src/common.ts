/**
 * Shared pieces of the command table: the command shape, exit codes and the
 * argument helpers every command module uses.
 */
import { CHAINS, formatAccountId, parseAccountId, type AccountId, type NetworkKey } from "@kletia/core";
import type { KletiaClient } from "@kletia/sdk";
import { UsageError, type OptionSpec, type OptionValues } from "./args.js";
import type { CliIo, Printer } from "./output.js";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
/** `intents watch` / `webhooks forward`: the intent ended without completing. */
export const EXIT_NOT_COMPLETED = 2;
/** Receipt checks: invalid (signature, digest, commitment, key, share link, EAS envelope); decision chain broken. */
export const EXIT_INVALID = 3;
/** `receipt reverify`: an on-chain source proved a difference, or sources disagree. */
export const EXIT_MISMATCH = 4;
/** Receipt checks: nothing proved wrong, but not everything could be checked (sources unavailable, groups sealed, still pending). */
export const EXIT_INCONCLUSIVE = 5;
export const EXIT_USAGE = 64;

export interface CommandContext {
  readonly values: OptionValues;
  readonly positionals: readonly string[];
  readonly print: Printer;
  readonly io: CliIo;
  readonly json: boolean;
  readonly signal: AbortSignal | undefined;
  readonly usage: string;
  /** The API client (built on first use from the environment and flags). */
  client(): KletiaClient;
  readonly hasApiKey: boolean;
}

export interface Command {
  /** Words that select the command, e.g. `intents watch`. */
  readonly name: string;
  readonly summary: string;
  /** Arguments after the name, e.g. `<id> [--timeout <seconds>]`. */
  readonly args?: string;
  readonly options?: Readonly<Record<string, OptionSpec>>;
  readonly positionals: { readonly min: number; readonly max: number };
  /** Needs KLETIA_API_KEY. */
  readonly key?: boolean;
  readonly run: (context: CommandContext) => Promise<number>;
}

/* --------------------------------------------------------------- helpers */

export function networkKey(value: string, usage: string): NetworkKey {
  if (!Object.prototype.hasOwnProperty.call(CHAINS, value)) {
    throw new UsageError(`Unknown network "${value}". Run \`kletia networks\` for the list.`, usage);
  }
  return value as NetworkKey;
}

/** A CAIP-10 account, or the `<network>:<address>` shorthand. */
export function accountId(value: string, usage: string): AccountId {
  const parsed = parseAccountId(value);
  if (parsed) return parsed.id;
  const separator = value.indexOf(":");
  if (separator > 0 && value.indexOf(":", separator + 1) === -1) {
    const network = value.slice(0, separator);
    if (Object.prototype.hasOwnProperty.call(CHAINS, network)) {
      try {
        return formatAccountId(network as NetworkKey, value.slice(separator + 1));
      } catch {
        // Reported below.
      }
    }
  }
  throw new UsageError(`"${value}" is not an account. Use a CAIP-10 id or <network>:<address>, e.g. base:0xAbc… or solana:9WzD….`, usage);
}

export function positional(context: CommandContext, index: number): string {
  const value = context.positionals[index];
  if (value === undefined) throw new UsageError("Missing argument.", context.usage);
  return value;
}

/** `{ signal }` when the command can be interrupted, for SDK request options. */
export function signalOption(context: CommandContext): { readonly signal?: AbortSignal } {
  return context.signal ? { signal: context.signal } : {};
}

/** `--yes`, required by commands that remove something. */
export const CONFIRM_OPTION = { yes: { type: "boolean", description: "Confirm; nothing is removed without it." } } as const satisfies Record<string, OptionSpec>;

/** `<network>=<url>` pairs (`--rpc base=https://…`, repeatable). */
export function networkUrls(values: readonly string[], option: string, usage: string): Partial<Record<NetworkKey, string[]>> {
  const out: Partial<Record<NetworkKey, string[]>> = {};
  for (const entry of values) {
    const separator = entry.indexOf("=");
    if (separator <= 0) throw new UsageError(`--${option} takes <network>=<url>, e.g. base=https://mainnet.base.org.`, usage);
    const network = networkKey(entry.slice(0, separator), usage);
    const url = entry.slice(separator + 1);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new UsageError(`"${url}" is not a URL.`, usage);
    }
    const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) throw new UsageError(`--${option} URLs must use https (http only for localhost).`, usage);
    (out[network] ??= []).push(url);
  }
  return out;
}

/** `30d`, `12h`, `90m` or a number of seconds. */
export function durationSeconds(value: string, option: string, usage: string): number {
  const match = /^(\d{1,9})([smhd]?)$/u.exec(value.trim());
  if (!match) throw new UsageError(`--${option} takes a duration such as 30d, 12h, 90m or seconds.`, usage);
  const unit = match[2] === "d" ? 86_400 : match[2] === "h" ? 3_600 : match[2] === "m" ? 60 : 1;
  return Number(match[1]) * unit;
}
