/**
 * `kletia listen`: the key's events (`GET /v1/events`, the same routing as
 * its webhooks) forwarded to a local endpoint, each signed with
 * KLETIA_WEBHOOK_SECRET exactly like a real delivery (integrator design
 * 4.6, P9c). Local development then receives contract, link, rule book and
 * key events too, without a public URL. Nothing is signed on-chain.
 */
import { signWebhookPayload, type AnyKletiaEvent } from "@kletia/core";
import { KletiaApiError, MAX_RETRY_DELAY_MS } from "@kletia/sdk";
import { integerOption, listOption, stringOption, UsageError } from "./args.js";
import { EXIT_OK, type Command, type CommandContext } from "./common.js";

/** Event ids remembered for de-duplication across reconnects. */
const SEEN_LIMIT = 5_000;

function localEndpoint(value: string, usage: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError(`"${value}" is not a URL.`, usage);
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (!loopback || (url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new UsageError("--forward-to must be a local endpoint such as http://localhost:3000/webhooks/kletia (real deliveries go to public HTTPS webhooks).", usage);
  }
  return url;
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** POSTs one event, signed like a webhook delivery; resolves with the endpoint's status (or why it failed). */
async function forward(context: CommandContext, target: URL, secret: string, event: AnyKletiaEvent): Promise<string> {
  const body = JSON.stringify(event);
  const fetcher = context.io.fetch ?? fetch;
  try {
    const response = await fetcher(target.toString(), {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
      headers: {
        "content-type": "application/json",
        "user-agent": "Kletia-CLI-Listen/0.1",
        "kletia-signature": await signWebhookPayload(secret, body),
        "kletia-event-id": event.id,
        "kletia-event-type": event.type,
        "kletia-webhook-id": "local-listen",
        "kletia-delivery-attempt": "1",
      },
      body,
    });
    await response.body?.cancel().catch(() => undefined);
    return String(response.status);
  } catch (error) {
    return error instanceof Error && error.name === "TimeoutError" ? "timeout" : "unreachable";
  }
}

const listen: Command = {
  name: "listen",
  summary: "Forward your key's events to a local endpoint, signed with KLETIA_WEBHOOK_SECRET like real webhook deliveries.",
  args: "--forward-to http://localhost:3000/webhooks/kletia [--event <type>] [--scope self|subtree]",
  key: true,
  options: {
    "forward-to": { type: "string", value: "<url>", description: "Local endpoint (localhost or 127.0.0.1)." },
    event: { type: "string", multiple: true, value: "<type>", description: "Only this event type (repeatable), e.g. contract.activated." },
    scope: { type: "string", value: "self|subtree", description: "subtree adds the events of your agent and publishable keys (default self)." },
    wait: { type: "string", value: "<seconds>", description: "Stop after this long (default: until Ctrl-C)." },
  },
  positionals: { min: 0, max: 0 },
  run: async (context) => {
    const to = stringOption(context.values, "forward-to");
    if (!to) throw new UsageError("--forward-to <url> is required.", context.usage);
    const target = localEndpoint(to, context.usage);
    const secret = (context.io.env.KLETIA_WEBHOOK_SECRET ?? "").split(",").map((value) => value.trim()).find(Boolean);
    if (!secret) throw new UsageError("Set KLETIA_WEBHOOK_SECRET to the signing secret your endpoint verifies with.", context.usage);
    const types = listOption(context.values, "event");
    for (const type of types) if (!/^[a-z_.]{1,64}$/u.test(type)) throw new UsageError(`"${type}" is not an event type (e.g. intent.status_changed).`, context.usage);
    const scope = stringOption(context.values, "scope") ?? "self";
    if (scope !== "self" && scope !== "subtree") throw new UsageError("--scope must be self or subtree.", context.usage);
    const waitSeconds = integerOption(context.values, "wait", 1, 86_400 * 7, context.usage);

    const controller = new AbortController();
    const stop = () => controller.abort();
    context.signal?.addEventListener("abort", stop, { once: true });
    const timer = waitSeconds === undefined ? undefined : setTimeout(stop, waitSeconds * 1000);
    const seen = new Set<string>();
    let lastEventId: string | undefined;
    let forwarded = 0;
    // Deliver in order, one at a time, like the real dispatcher.
    let queue = Promise.resolve();
    const onEvent = (event: AnyKletiaEvent) => {
      if (typeof event?.id !== "string" || typeof event.type !== "string" || seen.has(event.id)) return;
      seen.add(event.id);
      if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value as string);
      lastEventId = event.id;
      if (types.length > 0 && !types.includes(event.type)) return;
      queue = queue.then(async () => {
        const status = await forward(context, target, secret, event);
        forwarded += 1;
        if (context.json) context.print.jsonLine({ forwarded: event.id, type: event.type, status });
        else context.print.out(`${status}  ${event.type}  ${event.id}`);
      });
    };
    if (!context.json) context.print.err(`Listening for ${types.length > 0 ? types.join(", ") : "every event"} (${scope}); forwarding to ${target.toString()}. Ctrl-C stops.`);
    try {
      for (let failures = 0; !controller.signal.aborted; ) {
        try {
          await context.client().events.stream(onEvent, {
            signal: controller.signal,
            scope: scope as "self" | "subtree",
            ...(types.length > 0 ? { types } : {}),
            ...(lastEventId ? { lastEventId } : {}),
            onOpen: () => {
              failures = 0;
            },
          });
          // The API closes streams after 30 minutes: reconnect after the last event.
          if (!controller.signal.aborted) await pause(1_000, controller.signal);
        } catch (error) {
          if (controller.signal.aborted) break;
          if (!(error instanceof KletiaApiError) || !error.retryable) throw error;
          failures += 1;
          const wait = error.retryAfterSeconds !== null ? error.retryAfterSeconds * 1000 : Math.min(MAX_RETRY_DELAY_MS, 1_000 * 2 ** failures);
          if (!context.json) context.print.err(`Event stream unavailable (${error.code}); reconnecting in ${Math.round(wait / 1000)} s…`);
          await pause(wait, controller.signal);
        }
      }
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", stop);
      await queue;
    }
    if (!context.json) context.print.err(`Stopped; forwarded ${forwarded} event${forwarded === 1 ? "" : "s"}.`);
    return EXIT_OK;
  },
};

export const LISTEN_COMMANDS: readonly Command[] = Object.freeze([listen]);
