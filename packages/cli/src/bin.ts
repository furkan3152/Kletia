#!/usr/bin/env node
import { run } from "./cli.js";

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

run(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  readStdin,
  signal: controller.signal,
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`kletia: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
