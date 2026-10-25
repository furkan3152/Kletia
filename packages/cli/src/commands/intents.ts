/**
 * intents get, list and watch.
 */
import type { AnyKletiaEvent, IntentGraph } from "@kletia/core";
import { watchIntent } from "@kletia/sdk";
import { integerOption, stringOption } from "../args.js";
import {
  EXIT_NOT_COMPLETED,
  EXIT_OK,
  positional,
  type Command,
  type CommandContext,
} from "../common.js";
import { table, when } from "../output.js";
import { printIntent } from "./shared.js";

export const intentsGet: Command = {
  name: "intents get",
  summary: "Show an intent.",
  args: "<intent id>",
  positionals: { min: 1, max: 1 },
  run: async (context) => {
    const intent = await context.client().intents.get(positional(context, 0), { ...(context.signal ? { signal: context.signal } : {}) });
    if (context.json) context.print.json(intent);
    else printIntent(context.print, intent);
    return EXIT_OK;
  },
};

export const intentsList: Command = {
  name: "intents list",
  summary: "Intents created with your key.",
  key: true,
  options: {
    limit: { type: "string", value: "<1-100>", description: "How many (default 20)." },
    owner: { type: "string", value: "<key id>", description: "Intents of an agent or publishable key below yours." },
  },
  positionals: { min: 0, max: 0 },
  run: async (context) => {
    const limit = integerOption(context.values, "limit", 1, 100, context.usage) ?? 20;
    const owner = stringOption(context.values, "owner");
    const list = await context.client().intents.list({ limit, ...(owner ? { owner } : {}) }, { ...(context.signal ? { signal: context.signal } : {}) });
    if (context.json) context.print.json(list);
    else {
      context.print.out(
        table(
          list.map((intent) => [intent.id, intent.status, when(intent.createdAt), intent.summary.title]),
          ["intent", "status", "created", "title"],
        ),
      );
    }
    return EXIT_OK;
  },
};

function describeEvent(event: AnyKletiaEvent): string {
  switch (event.type) {
    case "intent.created":
      return `created: ${event.data.summary.title}`;
    case "intent.status_changed":
      return `status ${event.data.previous} → ${event.data.status}`;
    case "intent.step_updated":
      return `step ${event.data.stepId} on ${event.data.network}: ${event.data.status}${event.data.evidence?.url ? ` ${event.data.evidence.url}` : ""}`;
    default:
      return event.type;
  }
}

export function timeoutOption(context: CommandContext, fallbackSeconds: number): number {
  return (integerOption(context.values, "wait", 1, 86_400, context.usage) ?? fallbackSeconds) * 1000;
}

export const intentsWatch: Command = {
  name: "intents watch",
  summary: "Follow an intent's events until it ends (exit 0 completed, 2 otherwise).",
  args: "<intent id>",
  options: { wait: { type: "string", value: "<seconds>", description: "Give up after this long (default 1800)." } },
  positionals: { min: 1, max: 1 },
  run: async (context) => {
    const id = positional(context, 0);
    const final = await follow(context, id, timeoutOption(context, 1800), (event) => {
      if (context.json) context.print.jsonLine({ event });
      else context.print.out(`${when(event.at)}  ${describeEvent(event)}`);
    });
    if (context.json) context.print.jsonLine({ intent: final });
    else context.print.out(`${final.id} ${final.status}`);
    return final.status === "completed" ? EXIT_OK : EXIT_NOT_COMPLETED;
  },
};

/** Watches until terminal, `waitMs` or Ctrl-C. */
export async function follow(context: CommandContext, id: string, waitMs: number, onEvent: (event: AnyKletiaEvent) => void): Promise<IntentGraph> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  context.signal?.addEventListener("abort", stop, { once: true });
  let timedOut = false;
  let announced = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, waitMs);
  try {
    return await watchIntent(context.client(), id, {
      signal: controller.signal,
      onEvent,
      onTransport: (transport) => {
        // The first "poll" is the initial read; report later switches only.
        if (transport === "poll" && !announced) {
          announced = true;
          return;
        }
        announced = true;
        if (!context.json) context.print.err(transport === "stream" ? "Following the event stream…" : "Event stream unavailable; polling…");
      },
    });
  } catch (error) {
    if (timedOut) throw new Error(`The intent did not end within ${Math.round(waitMs / 1000)} s.`);
    throw error;
  } finally {
    clearTimeout(timer);
    context.signal?.removeEventListener("abort", stop);
  }
}
