/**
 * npm run mine:reading -w apps/api [-- --mode replay|live] [--out <file>]
 *
 * Development-time vocabulary mining (design A.7.9): runs the reading layer
 * over the corpus prompts the deterministic reader refuses as unreadable, and
 * writes a reviewable proposal file: per clause, its masked token list, the
 * pre-filter code or the agreed reading, and the word order it suggests for a
 * new frame. Nothing is applied: people review proposals into the lexicon
 * (goal/lexicon.ts, goal/frames.ts) or the shared word lists. Only synthetic
 * corpus text is used (no traffic), and no key is printed.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseSentence } from "../platform/engine/clarify/slots.js";
import type { UnreadClause } from "../platform/engine/clarify/types.js";
import { loadIntentEval } from "../platform/engine/goal/evalHarness.js";
import { EVAL_CORPUS_FILES } from "../platform/engine/goal/evalTransitions.js";
import { maskClause } from "../platform/engine/reading/mask.js";
import { evalReader, type ReadingEvalMode } from "./readingEval.js";

interface Proposal {
  readonly id: string;
  readonly masked: string | null;
  readonly prefilter?: string;
  readonly reading?: unknown;
  /** The token types in order: the shape a new deterministic frame would need. */
  readonly shape?: string;
}

function unreadOf(text: string): readonly UnreadClause[] {
  try {
    parseSentence(text, []);
    return [];
  } catch (error) {
    const unread = (error as { unreadClauses?: readonly UnreadClause[] }).unreadClauses;
    return Array.isArray(unread) ? unread : [];
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const at = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const mode = (at("--mode") ?? "replay") as ReadingEvalMode;
  const out = at("--out");
  const reader = evalReader(mode);
  const proposals: Proposal[] = [];
  for (const name of ["repo", "hard"]) {
    const corpus = loadIntentEval(fileURLToPath(new URL(`../platform/engine/__tests__/fixtures/${EVAL_CORPUS_FILES[name]}`, import.meta.url)));
    for (const prompt of corpus.prompts) {
      for (const clause of unreadOf(prompt.say)) {
        const masked = maskClause(clause);
        if (!masked.ok) {
          proposals.push({ id: prompt.id, masked: null, prefilter: masked.code });
          continue;
        }
        const goals = await reader.hook.readClauses([clause], null);
        const goal = goals.get(clause.index)?.[0];
        proposals.push({
          id: prompt.id,
          masked: masked.masked.text,
          ...(goal ? { reading: goal } : {}),
          shape: masked.masked.tokens.map((entry) => entry.token.t).join(" "),
        });
      }
    }
  }
  const shapes = new Map<string, number>();
  for (const proposal of proposals) if (proposal.shape) shapes.set(proposal.shape, (shapes.get(proposal.shape) ?? 0) + 1);
  const report = {
    note: "Proposals for review only; nothing here is applied.",
    clauses: proposals.length,
    readings: proposals.filter((entry) => entry.reading).length,
    prefilter: Object.fromEntries([...proposals.reduce((map, entry) => (entry.prefilter ? map.set(entry.prefilter, (map.get(entry.prefilter) ?? 0) + 1) : map), new Map<string, number>())]),
    shapes: [...shapes].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([shape, count]) => ({ shape, count })),
    proposals,
  };
  const text = `${JSON.stringify(report, null, 1)}\n`;
  if (out) writeFileSync(out, text);
  console.log(`${report.clauses} unread clauses, ${report.readings} readings; prefilter ${JSON.stringify(report.prefilter)}`);
  for (const { shape, count } of report.shapes.slice(0, 10)) console.log(`${String(count).padStart(4)}  ${shape}`);
  return 0;
}

main().then((code) => process.exit(code), (error: unknown) => {
  console.error(error instanceof Error ? error.message : "reading mine failed");
  process.exit(1);
});
