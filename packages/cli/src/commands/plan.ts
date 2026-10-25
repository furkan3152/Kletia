/**
 * plan, journey and stop.
 */
import {
  HANDOFF_VIEWS,
  validateThread,
  type ClarifyQuestion,
  type ClarifyThread,
  type IntentGraph,
  type IntentPreview,
  type IntentTurnRequest,
  type Journey,
} from "@kletia/core";
import type { IntentTurnResult } from "@kletia/sdk";
import {
  integerOption,
  listOption,
  stringOption,
  UsageError,
} from "../args.js";
import {
  accountId,
  EXIT_NEEDS_INPUT,
  EXIT_OK,
  positional,
  signalOption,
  terminalPrompter,
  type Command,
  type CommandContext,
  type Prompter,
} from "../common.js";
import { readJson } from "../contracts.js";
import { formatFare } from "../preview.js";
import type { Printer } from "../output.js";
import { formatJourney, printIntent } from "./shared.js";

/* -------------------------------------------------------------------- plan */

/** At most this many questions are asked in one `kletia plan` (the API caps a thread at 50 turns). */
const MAX_PLAN_TURNS = 12;

/** `--answer <question>=<option>` (or `=text:<free text>`). */
function parseAnswer(value: string, usage: string): NonNullable<IntentTurnRequest["answer"]> {
  const separator = value.indexOf("=");
  const question = value.slice(0, separator).trim();
  const raw = value.slice(separator + 1).trim();
  if (separator <= 0 || !/^q\.[\w.[\]-]{1,94}$/u.test(question) || !raw) {
    throw new UsageError("--answer takes <question id>=<option id>, e.g. q.actions.0.amount=all (or =text:2.5 for a typed answer).", usage);
  }
  if (raw.startsWith("text:")) return { question, text: raw.slice(5).trim() };
  // Option ids are words (network keys, symbols, all, half, …); anything else is a typed answer.
  return /^[A-Za-z][\w.:[\]-]{0,127}$/u.test(raw) ? { question, option: raw } : { question, text: raw };
}

function printQuestion(print: Printer, question: ClarifyQuestion): void {
  print.err(`${question.prompt}${question.why ? `  ${question.why}` : ""}`);
  question.options.forEach((option, index) => {
    print.err(`  ${index + 1}) ${option.label}${option.detail ? `   ${option.detail}` : ""}${option.recommended ? "   (suggested)" : ""}`);
  });
  if (question.allowsText) print.err(`  or type ${question.placeholder ? question.placeholder.toLowerCase() : "an answer"}`);
}

/** One typed line as an answer: a listed number picks that option, anything else is text when the question allows it. */
function answerFromLine(question: ClarifyQuestion, line: string): NonNullable<IntentTurnRequest["answer"]> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (/^\d+$/u.test(trimmed)) {
    const option = question.options[Number(trimmed) - 1];
    if (option) return { question: question.id, option: option.id };
  }
  const byId = question.options.find((option) => option.id === trimmed);
  if (byId) return { question: question.id, option: byId.id };
  return question.allowsText ? { question: question.id, text: trimmed } : null;
}

function printPlanned(context: CommandContext, response: Extract<IntentTurnResult, { status: "planned" }>, save: boolean): void {
  context.print.out(`Planned: ${response.sentence}`);
  for (const assumption of response.assumptions) {
    context.print.out(`Kletia assumed: ${assumption.label}${assumption.reason ? ` (${assumption.reason})` : ""}`);
  }
  context.print.out("");
  printIntent(context.print, response.intent);
  if (response.preview) {
    context.print.out("");
    context.print.out(formatFare(response.preview));
  }
  if (response.journey) {
    context.print.out("");
    context.print.out(formatJourney(response.journey));
  }
  context.print.err(save ? `Saved. Follow it with: kletia intents watch ${response.intent.id}` : "Dry run: nothing was stored. Pass --save to store the intent.");
}

/** The output of a strict plan (no questions): the intent, then the fare and the journey when asked for. */
function printStrictPlan(context: CommandContext, intent: IntentGraph, fare: IntentPreview | null | undefined, journey: Journey | null | undefined, save: boolean): void {
  if (context.json) {
    context.print.json(fare === undefined && journey === undefined ? intent : { intent, ...(fare !== undefined ? { preview: fare } : {}), ...(journey !== undefined ? { journey } : {}) });
    return;
  }
  printIntent(context.print, intent);
  if (fare) {
    context.print.out("");
    context.print.out(formatFare(fare));
  } else if (fare === null) context.print.err("The API returned no preview for this plan.");
  if (journey) {
    context.print.out("");
    context.print.out(formatJourney(journey));
  } else if (journey === null) context.print.err("The API returned no journey for this plan.");
  context.print.err(save ? `Saved. Follow it with: kletia intents watch ${intent.id}` : "Dry run: nothing was stored. Pass --save to store the intent.");
}

export const plan: Command = {
  name: "plan",
  summary:
    "Plan an intent (a dry run unless --save), e.g. `kletia plan \"swap SOL to USDC\" --account …`. Kletia asks what is missing; without a terminal it prints the question and exits 6.",
  args: "\"<intent text>\" | --thread <file> --answer <question>=<option>",
  options: {
    account: { type: "string", multiple: true, value: "<account>", description: "Your account, as CAIP-10 or <network>:<address> (repeatable)." },
    "max-slippage-bps": { type: "string", value: "<bps>", description: "Per-swap slippage ceiling." },
    "max-seconds": { type: "string", value: "<seconds>", description: "Longest settlement time a bridge step may take (10-86400, default 600)." },
    save: { type: "boolean", description: "Store the intent (to execute it later with the SDK, widget or Studio)." },
    preview: { type: "boolean", description: "Also print the asset-change preview (fare breakdown)." },
    journey: { type: "boolean", description: "Also print the journey: where the money is after every step and what follows." },
    thread: { type: "string", value: "<file>", description: "Continue a task: the thread JSON from a needs_input response (its .thread)." },
    answer: { type: "string", multiple: true, value: "<question>=<option>", description: "Answer a question, e.g. q.actions.0.amount=all (=text:<words> for a typed answer)." },
    "no-clarify": { type: "boolean", description: "Never ask: an incomplete sentence is refused, as before." },
  },
  positionals: { min: 0, max: 1 },
  run: async (context) => {
    const text = context.positionals[0]?.trim();
    const threadFile = stringOption(context.values, "thread");
    const answers = (Array.isArray(context.values.answer) ? context.values.answer : []).map((value) => parseAnswer(value, context.usage));
    const accounts = listOption(context.values, "account").map((value) => accountId(value, context.usage));
    const slippage = integerOption(context.values, "max-slippage-bps", 1, 1000, context.usage);
    const maxSeconds = integerOption(context.values, "max-seconds", 10, 86_400, context.usage);
    const constraints = {
      ...(slippage !== undefined ? { maxSlippageBps: slippage } : {}),
      ...(maxSeconds !== undefined ? { maxSeconds } : {}),
    };
    const save = context.values.save === true;
    const wantsJourney = context.values.journey === true;
    const wantsPreview = context.values.preview === true;
    const strict = context.values["no-clarify"] === true;
    if (strict && (threadFile || answers.length > 0)) throw new UsageError("--thread and --answer continue a clarify task; drop --no-clarify.", context.usage);
    if (!threadFile && answers.length > 0) throw new UsageError("--answer needs the task's --thread <file>.", context.usage);
    if (!threadFile && !text) throw new UsageError("Describe the intent to plan.", context.usage);
    if (threadFile && text) throw new UsageError("Pass either the intent text or --thread, not both.", context.usage);
    if (answers.length > 1) throw new UsageError("Answer one question per call (--answer once).", context.usage);
    if (accounts.length === 0) throw new UsageError("Pass at least one --account.", context.usage);
    const contextFields = { accounts, ...(Object.keys(constraints).length > 0 ? { constraints } : {}) };

    if (strict) {
      // Today's behaviour: one strict request, no questions.
      const request = { text: text as string, ...contextFields };
      const options = { ...(save ? {} : { dryRun: true }), ...signalOption(context) };
      let intent: IntentGraph;
      let fare: IntentPreview | null | undefined;
      let journey: Journey | null | undefined;
      if (wantsJourney) {
        const result = await context.client().intents.create(request, { ...options, journey: true });
        intent = result.intent;
        fare = wantsPreview ? result.preview : undefined;
        journey = result.journey;
      } else if (wantsPreview) {
        const result = await context.client().intents.create(request, { ...options, preview: true });
        intent = result.intent;
        fare = result.preview;
      } else intent = await context.client().intents.create(request, options);
      printStrictPlan(context, intent, fare, journey, save);
      return EXIT_OK;
    }

    let thread: ClarifyThread | undefined;
    if (threadFile) {
      const raw = await readJson(context, threadFile);
      // A whole needs_input response is accepted too (its .thread).
      const candidate = typeof raw === "object" && raw !== null && "thread" in raw && typeof (raw as { thread: unknown }).thread === "object" ? (raw as { thread: unknown }).thread : raw;
      const checked = validateThread(candidate);
      if (!checked.ok) throw new UsageError(`${threadFile} is not a Kletia thread (${checked.issues[0]?.path || "thread"}: ${checked.issues[0]?.message ?? "invalid"}).`, context.usage);
      thread = checked.value;
    }
    const turnOptions = { ...(save ? {} : { dryRun: true }), ...(wantsPreview ? { preview: true } : {}), ...(wantsJourney ? { journey: true } : {}), ...signalOption(context) };
    let request: IntentTurnRequest = thread ? { thread, ...contextFields, ...(answers[0] ? { answer: answers[0] } : {}) } : { text: text as string, ...contextFields };
    let prompter: Prompter | null = null;
    try {
      for (let turn = 1; ; turn += 1) {
        const response = await context.client().intents.turn(request, turnOptions);
        if (typeof (response as { status?: unknown }).status !== "string") {
          // An API without clarifying questions ignores ?clarify and answers like a strict plan.
          const legacy = response as unknown as { intent: IntentGraph; preview?: IntentPreview | null; journey?: Journey | null };
          if (!legacy.intent) throw new Error("The API returned neither a turn nor an intent.");
          printStrictPlan(context, legacy.intent, wantsPreview ? (legacy.preview ?? null) : undefined, wantsJourney ? (legacy.journey ?? null) : undefined, save);
          return EXIT_OK;
        }
        if (response.status === "planned") {
          if (context.json) context.print.json(response);
          else printPlanned(context, response, save);
          return EXIT_OK;
        }
        if (response.status === "cancelled") {
          if (context.json) context.print.json(response);
          else context.print.err("Cancelled: nothing was planned.");
          return EXIT_OK;
        }
        if (response.status === "handoff") {
          // A perps trade, native order or automation: it runs on its own surface, never as an intent.
          context.print.json(response);
          context.print.err(`${response.handoff.summary}: this runs on Kletia's ${response.handoff.surface} surface (${HANDOFF_VIEWS[response.handoff.surface]} on the desk), not as an intent. Nothing was planned or signed; .handoff.input is that surface's request.`);
          return EXIT_OK;
        }
        const question = response.questions[0];
        prompter ??= turn === 1 ? terminalPrompter(context) : prompter;
        if (!question || !prompter || turn > MAX_PLAN_TURNS) {
          // No one to ask: hand the question over and say how to continue.
          context.print.json(response);
          if (question) {
            const example = question.options[0] ? `${question.id}=${question.options[0].id}` : `${question.id}=text:<answer>`;
            context.print.err(`Kletia needs an answer: ${question.prompt} Save .thread to a file and run kletia plan --thread <file> --answer ${example} with the same --account flags.`);
          }
          return EXIT_NEEDS_INPUT;
        }
        printQuestion(context.print, question);
        let answer: NonNullable<IntentTurnRequest["answer"]> | null = null;
        while (!answer) {
          const line = await prompter.ask("> ");
          if (line === null) {
            context.print.json(response);
            return EXIT_NEEDS_INPUT;
          }
          answer = answerFromLine(question, line);
          if (!answer) context.print.err(`Pick 1-${question.options.length}${question.allowsText ? " or type an answer" : ""}.`);
        }
        const held = response.thread;
        request = "spec" in held ? { thread: held, ...contextFields, answer } : { threadId: held.id, expectedRev: held.rev, ...contextFields, answer };
      }
    } finally {
      prompter?.close();
    }
  },
};

export const journeyCommand: Command = {
  name: "journey",
  summary: "Where an intent's money is after every step, and what follows (stops, legs, consequences).",
  args: "<intent id>",
  options: {
    refresh: { type: "boolean", description: "Read the facts again instead of the caches (once per 10 s per intent)." },
    reads: { type: "string", value: "live|none", description: "none skips account reads (default live)." },
  },
  positionals: { min: 1, max: 1 },
  run: async (context) => {
    const reads = stringOption(context.values, "reads");
    if (reads !== undefined && reads !== "live" && reads !== "none") throw new UsageError("--reads must be live or none.", context.usage);
    const journey = await context.client().intents.journey(positional(context, 0), {
      ...(context.values.refresh === true ? { refresh: true } : {}),
      ...(reads ? { reads: reads as "live" | "none" } : {}),
      ...signalOption(context),
    });
    if (context.json) context.print.json({ journey });
    else context.print.out(formatJourney(journey));
    return EXIT_OK;
  },
};

export const stop: Command = {
  name: "stop",
  summary: "End an intent at its current stop: nothing further is signed and the money stays where the journey shows.",
  args: "<intent id>",
  positionals: { min: 1, max: 1 },
  run: async (context) => {
    const stopped = await context.client().intents.stop(positional(context, 0), signalOption(context));
    if (context.json) context.print.json(stopped);
    else {
      printIntent(context.print, stopped.intent);
      if (stopped.journey) {
        context.print.out("");
        context.print.out(formatJourney(stopped.journey));
      }
    }
    return EXIT_OK;
  },
};
