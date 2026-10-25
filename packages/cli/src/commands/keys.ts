/**
 * keys create, list, rotate and revoke.
 */
import { isKletiaError } from "@kletia/sdk";
import { integerOption, UsageError } from "../args.js";
import {
  EXIT_OK,
  positional,
  type Command,
  type CommandContext,
} from "../common.js";
import {
  abandonSecretSink,
  deliverSecret,
  openSecretSink,
  SECRET_OPTIONS,
} from "../secrets.js";
import { table, when } from "../output.js";
import { confirm } from "./shared.js";

/* -------------------------------------------------------------------- keys */

/** Id of the key in KLETIA_API_KEY (the one `keys list` marks current). */
async function currentKeyId(context: CommandContext): Promise<string | undefined> {
  const list = await context.client().keys.list({ ...(context.signal ? { signal: context.signal } : {}) });
  return list.find((key) => key.current)?.id;
}

export const keysCreate: Command = {
  name: "keys create",
  summary: "Issue a developer key (a new project without KLETIA_API_KEY, a sibling key with it); --sandbox keeps it on testnets.",
  args: "<name> [--sandbox]",
  options: {
    sandbox: { type: "boolean", description: "A sandbox key: its rule book keeps it on the testnet lane (Arbitrum Sepolia, Arc Testnet, Solana Devnet)." },
    ...SECRET_OPTIONS,
  },
  positionals: { min: 1, max: 1 },
  run: async (context) => {
    const sink = await openSecretSink(context);
    let issued;
    try {
      issued = await context.client().keys.create(positional(context, 0), {
        ...(context.values.sandbox === true ? { sandbox: true } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
      });
    } catch (error) {
      await abandonSecretSink(sink);
      throw error;
    }
    const { key: secret, ...record } = issued;
    if (!secret) {
      await abandonSecretSink(sink);
      throw new Error("The API did not return the new key.");
    }
    await deliverSecret(context, sink, secret, record, "key", `Created ${record.id} (${record.name}, ${record.tier}${record.lane ? `, ${record.lane} lane` : ""}).`);
    return EXIT_OK;
  },
};

export const keysList: Command = {
  name: "keys list",
  summary: "Keys of your project (never secrets).",
  key: true,
  positionals: { min: 0, max: 0 },
  run: async (context) => {
    const list = await context.client().keys.list({ ...(context.signal ? { signal: context.signal } : {}) });
    if (context.json) context.print.json(list);
    else {
      context.print.out(
        table(
          list.map((key) => [
            `${key.id}${key.current ? " *" : ""}`,
            key.name,
            key.last4 ? `…${key.last4}` : "-",
            key.revokedAt ? `revoked ${when(key.revokedAt)}` : key.previousExpiresAt ? `rotated; old secret until ${when(key.previousExpiresAt)}` : "active",
            key.lane ?? "-",
            when(key.lastUsedAt),
          ]),
          ["key", "name", "secret", "state", "lane", "last used"],
        ),
      );
    }
    return EXIT_OK;
  },
};

export const keysRotate: Command = {
  name: "keys rotate",
  summary: "New secret for a key, same id; the old secret works for --grace-seconds (default 86400) but cannot manage keys.",
  args: "<key id>",
  key: true,
  options: {
    "grace-seconds": { type: "string", value: "<0-604800>", description: "How long the old secret keeps working (0 ends it now)." },
    ...SECRET_OPTIONS,
  },
  positionals: { min: 1, max: 1 },
  run: async (context) => {
    const id = positional(context, 0);
    const graceSeconds = integerOption(context.values, "grace-seconds", 0, 604_800, context.usage);
    const sink = await openSecretSink(context);
    let rotated;
    try {
      if (graceSeconds === 0 && (await currentKeyId(context)) === id) {
        // Its secret would stop working at once: a lost response could not be replayed to it.
        throw new UsageError(
          `${id} is the key this command uses. With --grace-seconds 0 its secret stops working at once, so if the response were lost the new secret could not be recovered. Rotate it with another key of the project in KLETIA_API_KEY (\`kletia keys create <name>\` makes one), or keep a grace period.`,
          context.usage,
        );
      }
      rotated = await context.client().keys.rotate(id, {
        ...(graceSeconds !== undefined ? { graceSeconds } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
      });
    } catch (error) {
      // OUTCOME_UNKNOWN (the response was lost) is reported as such; the file never held a secret.
      await abandonSecretSink(sink);
      throw error;
    }
    const { key: secret, ...record } = rotated;
    const grace = record.previousExpiresAt ? `the old secret works until ${when(record.previousExpiresAt)}` : "the old secret no longer works";
    await deliverSecret(context, sink, secret, record, "key", `Rotated ${record.id}; ${grace}.`);
    return EXIT_OK;
  },
};

export const keysRevoke: Command = {
  name: "keys revoke",
  summary: "Revoke a key (stops working within 15 s everywhere).",
  args: "<key id> --yes",
  key: true,
  options: confirm,
  positionals: { min: 1, max: 1 },
  run: async (context) => {
    if (context.values.yes !== true) throw new UsageError("Revoking a key cannot be undone; pass --yes.", context.usage);
    const id = positional(context, 0);
    // Known before the call: once a key revoked itself, nothing can be read with it.
    const own = (await currentKeyId(context).catch(() => undefined)) === id;
    try {
      await context.client().keys.revoke(id, { ...(context.signal ? { signal: context.signal } : {}) });
    } catch (error) {
      // The key revoked itself, the response was lost and the retry was refused: its secret no longer works.
      if (!own || !isKletiaError(error, "OUTCOME_UNKNOWN")) throw error;
      if (!context.json) context.print.err("The response was lost; the retry was refused because this key no longer authenticates.");
    }
    if (context.json) context.print.json({ revoked: id });
    else context.print.out(`Revoked ${id}.`);
    return EXIT_OK;
  },
};
