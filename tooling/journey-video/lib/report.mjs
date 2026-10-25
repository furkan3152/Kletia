// FINDINGS.md for one run: failed checks and journey notes (each with its
// screenshot), browser console errors, and every request the fork guards
// stopped (browser and API), so the rough edges of the session are listed
// next to the video.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";

import { clock } from "./director.mjs";

function blockedInApiLog(file) {
  if (!file) return [];
  const counts = new Map();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^\[netguard\] blocked (\S+) (\S+) \((.+)\)$/u.exec(line.trim());
    if (!match) continue;
    const key = `${match[1]} ${match[2].replace(/\?.*$/u, "")} (${match[3]})`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()];
}

export function writeFindings(file, { director, cut, consoleErrors, blocked, apiLog, video, readOnly, solana }) {
  const at = (ms) => clock(video.toVideo ? video.toVideo(ms) : ms);
  const link = (path) => (path ? `[screenshot](${relative(dirname(file), path)})` : "");
  const failed = director.assertions.filter((entry) => !entry.ok);
  const notes = director.findings.filter((entry) => entry.source === "journey");
  const lines = [
    `# Journey findings (${cut})`,
    "",
    `Run ${new Date().toISOString()} · ${readOnly ? "read-only against a deployed API" : `local forks (Base, Arbitrum, Polygon${solana ? ", Solana" : ""})`} · video \`${video.mp4}\` (${clock(video.seconds * 1000)}).`,
    `Checks: ${director.assertions.length - failed.length} of ${director.assertions.length} passed. Times are on the video's clock.`,
    "",
    "## Failed checks",
    "",
    ...(failed.length ? failed.map((entry) => `- [${at(entry.at)} · ${entry.chapter}] ${entry.description} ${link(director.findings.find((finding) => finding.at === entry.at)?.screenshot)}`) : ["None."]),
    "",
    "## Seen on the way",
    "",
    ...(notes.length ? notes.map((entry) => `- **${entry.severity}** [${at(entry.at)} · ${entry.chapter}] ${entry.title}${entry.detail ? `: ${entry.detail}` : ""} ${link(entry.screenshot)}`) : ["Nothing."]),
    "",
    "## Browser console errors",
    "",
    ...(consoleErrors.length ? consoleErrors.map((entry) => `- [${entry.chapter}] ×${entry.count} \`${entry.text.replace(/`/gu, "'")}\``) : ["None."]),
    "",
    "## Requests the fork guards stopped",
    "",
    "Nothing written by this run may reach a real network; these are the attempts the guards refused.",
    "",
    ...blocked.map((entry) => `- browser: ${entry.method} ${entry.url.replace(/\?.*$/u, "")} (${entry.reason})`),
    ...blockedInApiLog(apiLog).map(([key, count]) => `- api: ${key} ×${count}`),
    ...(blocked.length || blockedInApiLog(apiLog).length ? [] : ["None."]),
    "",
  ];
  writeFileSync(file, lines.join("\n"));
}
