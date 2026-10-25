// Aligns the director's clock with the recorded video. Under load the
// screencast starts late and drifts, so the journey marks its timeline in the
// picture: a full-screen #FF6A3D title card at the start and the end, and a
// 16 px corner flash of the same colour at every chapter after the first.
// This samples one corner block 10 times a second, finds those runs, and
// places each chapter on its own flash; when the count does not match, it
// maps times linearly between the two cards.
import { spawnSync } from "node:child_process";

const CARD = [255, 106, 61];
const isCard = (r, g, b) => Math.abs(r - CARD[0]) < 45 && Math.abs(g - CARD[1]) < 45 && Math.abs(b - CARD[2]) < 45;

/** Runs of card-coloured samples as [startMs, endMs] (end exclusive), or null when ffmpeg fails. */
export function findMarks(videoFile) {
  const result = spawnSync("ffmpeg", ["-loglevel", "error", "-i", videoFile, "-vf", "fps=10,crop=8:8:4:4,scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) return null;
  const runs = [];
  let start = -1;
  const pixels = result.stdout;
  const samples = Math.floor(pixels.length / 3);
  for (let index = 0; index <= samples; index += 1) {
    const on = index < samples && isCard(pixels[index * 3], pixels[index * 3 + 1], pixels[index * 3 + 2]);
    if (on && start < 0) start = index;
    if (!on && start >= 0) {
      // A single lost sample (compression) must not split one mark into two.
      const last = runs.at(-1);
      if (last && start * 100 - last[1] <= 300) last[1] = index * 100;
      else runs.push([start * 100, index * 100]);
      start = -1;
    }
  }
  return runs;
}

/**
 * `(ms, chapterIndex) => videoMs`. `marks.start` / `marks.end`: director times
 * when the opening card was hidden and the closing card shown.
 */
export function videoClock(marks, runs, chapterCount = 0) {
  if (!runs || runs.length < 1 || marks.start === undefined) return (ms) => ms;
  const opening = runs[0];
  const closing = runs.length > 1 ? runs.at(-1) : null;
  const linear =
    !closing || marks.end === undefined || marks.end <= marks.start
      ? (ms) => Math.max(0, Math.round(ms + opening[1] - marks.start))
      : (ms) => Math.max(0, Math.round(opening[1] + (ms - marks.start) * ((closing[0] - opening[1]) / (marks.end - marks.start))));
  // The first chapter opens the video. Then: opening card, one flash per later chapter, closing card.
  if (chapterCount > 1 && runs.length === chapterCount + 1) return (ms, index) => (index === 0 ? 0 : index === undefined ? linear(ms) : runs[index][0]);
  return (ms, index) => (index === 0 ? 0 : linear(ms));
}
