/**
 * webhooks list, create, delete, test, deliveries, verify and forward.
 */
import { readFile } from "node:fs/promises";
import { signWebhookPayload, type AnyKletiaEvent } from "@kletia/core";
import {
  KletiaApiError,
  MAX_RETRY_DELAY_MS,
  TERMINAL_INTENT_STATUSES,
  type KletiaClient,
} from "@kletia/sdk";
import { constructWebhookEvent, KletiaWebhookError } from "@kletia/sdk/server";
import {
  integerOption,
  listOption,
  stringOption,
  UsageError,
} from "../args.js";
import {
  EXIT_ERROR,
  EXIT_NOT_COMPLETED,
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
import { follow, timeoutOption } from "./intents.js";

/* ---------------------------------------------------------------- webhooks */

export const webhooksList: Command = {
  name: "webhooks list",
  summary: "Your webhooks.",
  key: true,
  positionals: { min: 0, max: 0 },
  run: async (context) => {
    const list = await context.client().webhooks.list({ ...(context.signal ? { signal: context.signal } : {}) });
    if (context.json) context.print.json(list);
    else context.print.out(table(list.map((hook) => [hook.id, hook.url, hook.events.join(","), when(hook.createdAt)]), ["webhook", "url", "events", "created"]));
    return EXIT_OK;
  },
};

export const webhooksCreate: Command = {
  name: "webhooks create",
  summary: "Register a public HTTPS endpoint; its signing secret is shown once.",
  args: "<https url>",
  key: true,
  options: {
    event: { type: "string", multiple: true, value: "<type>", description: "Event type to send (repeatable; default all intent events)." },
    ...SECRET_OPTIONS,
  },
  positionals: { min: 1, max: 1 },
  run: async (context) => {
    const url = positional(context, 0);
    const events = listOption(context.values, "event");
    const sink = await openSecretSink(context);
    let created;
    try {
      created = await context.client().webhooks.create(
        { url, ...(events.length > 0 ? { events } : {}) },
        { ...(context.signal ? { signal: context.signal } : {}) },
      );
    } catch (error) {
      await abandonSecretSink(sink);
      throw error;
    }
    const { secret, ...record } = created;
    if (!secret) {
      await abandonSecretSink(sink);
      throw new Error("The API did not return the signing secret.");
    }
    await deliverSecret(context, sink, secret, record, "secret", `Created ${record.id} for ${record.url}.`);
    return EXIT_OK;
  },
};

export const webhooksDelete: Command = {
  name: "webhooks delete",
  summary: "Delete a webhook and its delivery log.",
  args: "<webhook id> --yes",
  key: true,
  options: confirm,
  positionals: { min: 1, max: 1 },
  run: async (context) => {
    if (context.values.yes !== true) throw new UsageError("Deleting a webhook cannot be undone; pass --yes.", context.usage);
    const id = positional(context, 0);
    await context.client().webhooks.delete(id, { ...(context.signal ? { signal: context.signal } : {}) });
    if (context.json) context.print.json({ deleted: id });
    else context.print.out(`Deleted ${id}.`);
    return EXIT_OK;
  },
};

function deliveryRow(delivery: Awaited<ReturnType<KletiaClient["webhooks"]["test"]>>): string[] {
  return [
    when(delivery.at),
    delivery.eventType,
    delivery.status,
    delivery.httpStatus !== undefined ? String(delivery.httpStatus) : "-",
    delivery.durationMs !== undefined ? `${delivery.durationMs}ms` : "-",
    delivery.error ?? "",
    `${delivery.attempt}${delivery.test ? " (test)" : ""}`,
  ];
}

const DELIVERY_HEADER = ["at", "event", "status", "http", "time", "error", "attempt"];

export const webhooksTest: Command = {
  name: "webhooks test",
  summary: "Send a signed webhook.test event now and show what the endpoint answered.",
  args: "<webhook id>",
  key: true,
  positionals: { min: 1, max: 1 },
  run: async (context) => {
    const delivery = await context.client().webhooks.test(positional(context, 0), { ...(context.signal ? { signal: context.signal } : {}) });
    if (context.json) context.print.json(delivery);
    else context.print.out(table([deliveryRow(delivery)], DELIVERY_HEADER));
    return delivery.status === "succeeded" ? EXIT_OK : EXIT_ERROR;
  },
};

export const webhooksDeliveries: Command = {
  name: "webhooks deliveries",
  summary: "Recent delivery attempts of a webhook.",
  args: "<webhook id>",
  key: true,
  options: { limit: { type: "string", value: "<1-100>", description: "How many (default 20)." } },
  positionals: { min: 1, max: 1 },
  run: async (context) => {
    const limit = integerOption(context.values, "limit", 1, 100, context.usage);
    const list = await context.client().webhooks.deliveries(positional(context, 0), {
      ...(limit !== undefined ? { limit } : {}),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    if (context.json) context.print.json(list);
    else context.print.out(table(list.map(deliveryRow), DELIVERY_HEADER));
    return EXIT_OK;
  },
};

function webhookSecrets(context: CommandContext): string[] {
  const secrets = (context.io.env.KLETIA_WEBHOOK_SECRET ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (secrets.length === 0) {
    throw new UsageError("Set KLETIA_WEBHOOK_SECRET to the webhook's signing secret (comma-separated during a rotation).", context.usage);
  }
  return secrets;
}

export const webhooksVerify: Command = {
  name: "webhooks verify",
  summary: "Check a delivery's Kletia-Signature against its raw body (stdin or --file), using KLETIA_WEBHOOK_SECRET.",
  args: "--signature \"t=…,v1=…\" [--file <body.json>]",
  options: {
    signature: { type: "string", value: "<header>", description: "The Kletia-Signature header value." },
    file: { type: "string", value: "<path>", description: "Raw body file (default: stdin)." },
    tolerance: { type: "string", value: "<seconds>", description: "Accepted signature age (default 300)." },
  },
  positionals: { min: 0, max: 0 },
  run: async (context) => {
    const signature = stringOption(context.values, "signature");
    if (!signature) throw new UsageError("--signature is required.", context.usage);
    const secrets = webhookSecrets(context);
    const tolerance = integerOption(context.values, "tolerance", 0, 31_536_000, context.usage);
    const file = stringOption(context.values, "file");
    let body: Uint8Array | string;
    if (file) body = await readFile(file);
    else if (context.io.readStdin) body = await context.io.readStdin();
    else throw new UsageError("Pass --file <path> or pipe the body on stdin.", context.usage);
    try {
      const event = await constructWebhookEvent(body, signature, secrets, tolerance !== undefined ? { toleranceSeconds: tolerance } : {});
      if (context.json) context.print.json({ valid: true, event });
      else context.print.out(`valid: ${event.type} ${event.id}`);
      return EXIT_OK;
    } catch (error) {
      if (!(error instanceof KletiaWebhookError)) throw error;
      if (context.json) context.print.json({ valid: false, reason: error.reason });
      else context.print.err(`invalid (${error.reason}): ${error.message}`);
      return EXIT_ERROR;
    }
  },
};

function loopbackUrl(value: string, usage: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError(`"${value}" is not a URL.`, usage);
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (!loopback || (url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new UsageError("--to must be a local endpoint such as http://localhost:3000/webhooks/kletia (real deliveries go to public HTTPS).", usage);
  }
  return url;
}

export const webhooksForward: Command = {
  name: "webhooks forward",
  summary: "Forward an intent's events to a local endpoint, signed like real deliveries with KLETIA_WEBHOOK_SECRET.",
  args: "--intent <id> --to http://localhost:3000/…",
  options: {
    intent: { type: "string", value: "<id>", description: "Intent whose events to forward." },
    to: { type: "string", value: "<url>", description: "Local endpoint (localhost or 127.0.0.1)." },
    wait: { type: "string", value: "<seconds>", description: "Give up after this long (default 1800)." },
  },
  positionals: { min: 0, max: 0 },
  run: async (context) => {
    const id = stringOption(context.values, "intent");
    const to = stringOption(context.values, "to");
    if (!id || !to) throw new UsageError("--intent and --to are required.", context.usage);
    const target = loopbackUrl(to, context.usage);
    const [secret] = webhookSecrets(context);
    const deliver = async (event: AnyKletiaEvent): Promise<void> => {
      const body = JSON.stringify(event);
      const fetcher = context.io.fetch ?? fetch;
      let status = "error";
      try {
        const response = await fetcher(target.toString(), {
          method: "POST",
          redirect: "manual",
          signal: AbortSignal.timeout(5_000),
          headers: {
            "content-type": "application/json",
            "user-agent": "Kletia-CLI-Forward/0.1",
            "kletia-signature": await signWebhookPayload(secret as string, body),
            "kletia-event-id": event.id,
            "kletia-event-type": event.type,
            "kletia-webhook-id": "local-forward",
            "kletia-delivery-attempt": "1",
          },
          body,
        });
        await response.body?.cancel().catch(() => undefined);
        status = String(response.status);
      } catch (error) {
        status = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "unreachable";
      }
      if (context.json) context.print.jsonLine({ forwarded: event.id, type: event.type, status });
      else context.print.out(`${status}  ${event.type}  ${event.id}`);
    };
    // Deliver in order, one at a time, like the real dispatcher.
    let queue = Promise.resolve();
    const state: ForwardState = { forwarded: new Set(), lastEventId: undefined, finalForwarded: false };
    const forward = (event: AnyKletiaEvent) => {
      if (typeof event?.id !== "string" || state.forwarded.has(event.id)) return;
      state.forwarded.add(event.id);
      state.lastEventId = event.id;
      if (event.type === "intent.status_changed" && TERMINAL_INTENT_STATUSES.includes(event.data.status)) state.finalForwarded = true;
      queue = queue.then(() => deliver(event));
    };
    const waitMs = timeoutOption(context, 1800);
    const deadline = Date.now() + waitMs;
    const final = await follow(context, id, waitMs, forward);
    // A read can see the end before the stream delivered every event (the intent had already ended, or the
    // stream was unavailable): forward what the API still holds for it.
    const missing = state.finalForwarded ? null : await replayEndedIntent(context, id, deadline, state, forward);
    await queue;
    if (!context.json) context.print.err(`${final.id} ${final.status}`);
    if (missing) {
      const warning = `not every event of ${final.id} was forwarded (${state.forwarded.size} were): ${missing}. Run the command again to replay the events the API still holds.`;
      if (context.json) context.print.err(JSON.stringify({ warning, forwarded: state.forwarded.size }));
      else context.print.err(`warning: ${warning}`);
      return EXIT_ERROR;
    }
    return final.status === "completed" ? EXIT_OK : EXIT_NOT_COMPLETED;
  },
};

interface ForwardState {
  readonly forwarded: Set<string>;
  lastEventId: string | undefined;
  /** The intent's terminal `intent.status_changed` was forwarded. */
  finalForwarded: boolean;
}

/** How long a replay stream may stay quiet (the API sends what it holds as soon as the stream opens). */
const REPLAY_IDLE_MS = 2_000;

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * For an intent that has ended: opens its event stream after the last
 * forwarded event and forwards what the API replays, until the terminal
 * `intent.status_changed` or REPLAY_IDLE_MS of quiet. An unavailable stream
 * (e.g. 429 TOO_MANY_STREAMS) is retried until `deadline`. Resolves with null
 * once the terminal event was forwarded, else with why it was not.
 */
async function replayEndedIntent(
  context: CommandContext,
  id: string,
  deadline: number,
  state: ForwardState,
  forward: (event: AnyKletiaEvent) => void,
): Promise<string | null> {
  let announced = false;
  for (let failures = 1; ; failures += 1) {
    if (context.signal?.aborted) throw new Error("Interrupted.");
    const controller = new AbortController();
    const stopped: { by: "quiet" | "deadline" | null } = { by: null };
    const stop = (reason: "quiet" | "deadline" | null) => () => {
      if (!controller.signal.aborted) stopped.by = reason;
      controller.abort();
    };
    const interrupt = stop(null);
    context.signal?.addEventListener("abort", interrupt, { once: true });
    const cap = setTimeout(stop("deadline"), Math.max(0, deadline - Date.now()));
    let idle: ReturnType<typeof setTimeout> | undefined;
    const quiet = () => {
      clearTimeout(idle);
      idle = setTimeout(stop("quiet"), REPLAY_IDLE_MS);
    };
    let failure: unknown = null;
    try {
      const after = state.lastEventId;
      await context.client().intents.stream(
        id,
        (event) => {
          forward(event);
          if (state.finalForwarded) controller.abort();
          else quiet();
        },
        { signal: controller.signal, ...(after ? { lastEventId: after } : {}), onOpen: quiet },
      );
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(cap);
      clearTimeout(idle);
      context.signal?.removeEventListener("abort", interrupt);
    }
    if (state.finalForwarded) return null;
    if (context.signal?.aborted) throw failure ?? new Error("Interrupted.");
    if (stopped.by === "deadline") return "--wait ran out before the intent's final event arrived";
    if (failure === null) return "the API no longer holds the intent's final event";
    const reason = failure instanceof KletiaApiError ? failure.code : failure instanceof Error ? failure.message : String(failure);
    if (!(failure instanceof KletiaApiError) || !failure.retryable) return `the event stream could not be opened (${reason})`;
    const wait =
      failure.retryAfterSeconds !== null ? failure.retryAfterSeconds * 1000 : Math.min(MAX_RETRY_DELAY_MS, 1_000 * 2 ** failures);
    if (Date.now() + wait >= deadline) return `the event stream stayed unavailable within --wait (${reason})`;
    if (!announced && !context.json) context.print.err(`Event stream unavailable (${reason}); retrying to forward the intent's events…`);
    announced = true;
    await pause(wait, context.signal);
  }
}
