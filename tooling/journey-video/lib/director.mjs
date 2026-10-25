// The director: drives the real UI the way a person does (a visible cursor
// that travels, human typing speed, pauses to read), shows the captions,
// keeps the chapter list, and turns every expectation into a test assertion.
// A failed assertion never stops the video: it is recorded with a screenshot
// as a finding and the run exits non-zero at the end.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clock = (ms) => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};

export class Director {
  constructor({ page, outDir, pace = 1 }) {
    this.page = page;
    this.outDir = outDir;
    this.pace = pace;
    this.startedAt = Date.now();
    this.chapters = [];
    this.assertions = [];
    this.findings = [];
    this.walletEvents = [];
    /** Director times of the opening card's end and the closing card's start (see sync.mjs). */
    this.sync = {};
    this.mouse = { x: 640, y: 400 };
    this.shotDir = join(outDir, "screens");
    mkdirSync(this.shotDir, { recursive: true });
  }

  elapsed() {
    return Date.now() - this.startedAt;
  }

  async pause(ms) {
    await sleep(ms * this.pace);
  }

  /** Starts a chapter (listed in chapters.txt and the mp4's chapter track); every chapter after the first flashes the corner mark. */
  async chapter(title) {
    if (this.chapters.length > 0) await this.page.evaluate(() => window.__klFlash?.()).catch(() => undefined);
    this.chapters.push({ at: this.elapsed(), title });
    process.stdout.write(`[${clock(this.elapsed())}] ${title}\n`);
  }

  /**
   * A full-screen title card held for `ms`. Its flat colour is also the sync
   * marker: `sync.js` finds the card in the video to align the chapters.
   */
  async card(title, subtitle, ms = 3000) {
    await this.page.evaluate(([t, s]) => window.__klCard?.(t, s), [title, subtitle]);
    const shown = this.elapsed();
    await sleep(ms);
    await this.page.evaluate(() => window.__klCard?.(null));
    return { shown, hidden: this.elapsed() };
  }

  /** A lower-third caption; `fork` marks a fork limitation (amber edge). Holds `hold` ms. */
  async caption(title, text, { fork = false, hold = 2600 } = {}) {
    await this.page.evaluate(([t, x, f]) => window.__klCaption?.(t, x, f), [title, text, fork]).catch(() => undefined);
    await this.pause(hold);
  }

  async clearCaption() {
    await this.page.evaluate(() => window.__klCaption?.("", "")).catch(() => undefined);
  }

  /** Glides the cursor to a point (about 60 px per frame step, at least 12 steps). */
  async moveTo(x, y) {
    const distance = Math.hypot(x - this.mouse.x, y - this.mouse.y);
    const steps = Math.max(12, Math.min(45, Math.round(distance / 22)));
    await this.page.mouse.move(x, y, { steps });
    this.mouse = { x, y };
  }

  /**
   * Brings the element into view the way a person does (the wheel, over the
   * column it lives in) until its centre is on screen and not covered by the
   * sticky composer or a popover, then glides the cursor onto it.
   */
  async pointAt(locator) {
    await locator.waitFor({ state: "visible", timeout: 30_000 });
    const viewport = this.page.viewportSize();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const box = await locator.boundingBox();
      if (!box) break;
      const point = { x: box.x + box.width / 2, y: box.y + Math.min(box.height / 2, 20) };
      const onScreen = point.y > 64 && point.y < viewport.height - 24;
      const hit = onScreen && (await locator.evaluate((element, at) => {
        const top = document.elementFromPoint(at.x, at.y);
        return Boolean(top) && (top === element || element.contains(top) || (element instanceof HTMLLabelElement && element.control === top));
      }, point, { timeout: 3000 }).catch(() => false));
      if (hit) {
        await this.moveTo(point.x, point.y);
        return;
      }
      // Wheel from over the element's column so its own scroll container moves; aim for the upper middle.
      await this.moveTo(Math.min(Math.max(point.x, 40), viewport.width - 40), viewport.height * 0.4);
      const delta = Math.max(-viewport.height * 0.8, Math.min(viewport.height * 0.8, point.y - viewport.height * 0.38 || 120));
      await this.page.mouse.wheel(0, delta);
      await this.pause(650);
    }
    await locator.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await this.pause(400);
    const box = await locator.boundingBox();
    if (!box) throw new Error("The element has no box to point at.");
    await this.moveTo(box.x + box.width / 2, box.y + Math.min(box.height / 2, 20));
  }

  /** A real mouse click at the element's centre, after the cursor travelled there. */
  async click(locator, { timeout = 30_000 } = {}) {
    await locator.waitFor({ state: "visible", timeout });
    await this.pointAt(locator);
    await this.pause(300);
    await this.page.mouse.down();
    await this.pause(70);
    await this.page.mouse.up();
    await this.pause(450);
  }

  /** Clicks a field and types like a person (about 12 characters a second). */
  async type(locator, text, { clear = false } = {}) {
    await this.click(locator);
    if (clear) {
      await this.page.keyboard.press("ControlOrMeta+A");
      await this.page.keyboard.press("Backspace");
    }
    for (const char of text) {
      await this.page.keyboard.type(char);
      await sleep((55 + Math.random() * 60) * this.pace);
    }
    await this.pause(350);
  }

  async press(key) {
    await this.page.keyboard.press(key);
    await this.pause(300);
  }

  /** Chooses an option of a native <select> after pointing at it (a native list is not drawn headless). */
  async select(locator, option) {
    await this.pointAt(locator);
    await this.pause(250);
    await locator.selectOption(option);
    await this.pause(500);
  }

  /** Scrolls an element into view with the wheel (the cursor ends on it). */
  async scrollTo(locator) {
    await this.pointAt(locator.first()).catch(() => undefined);
    await this.pause(500);
  }

  /** Waits for the test wallet's popup, lets it be read, then clicks Approve (or Reject). */
  async wallet(action = "approve", { timeout = 90_000, expect } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const rect = await this.page.evaluate((which) => window.__klWalletPopupRect?.(which) ?? null, action).catch(() => null);
      if (rect) {
        if (expect && !expect.test(rect.title)) {
          await this.check(false, `Wallet popup "${rect.title}" matches ${expect}`);
        }
        await this.pause(1400);
        await this.moveTo(rect.x, rect.y);
        await this.pause(350);
        await this.page.mouse.down();
        await this.pause(70);
        await this.page.mouse.up();
        await this.pause(600);
        return rect.title;
      }
      if (Date.now() > deadline) {
        await this.check(false, `A wallet popup appeared (${action})`);
        return null;
      }
      await sleep(250);
    }
  }

  /** Resolves with the first wallet event from index `from` on that matches (sent transactions, receipts, signatures). */
  async walletEvent(predicate, { from = 0, timeout = 120_000 } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const match = this.walletEvents.slice(from).find(predicate);
      if (match) return match;
      if (Date.now() > deadline) return null;
      await sleep(300);
    }
  }

  async screenshot(name) {
    const file = join(this.shotDir, `${String(this.findings.length + this.assertions.length).padStart(3, "0")}-${name.replace(/[^a-z0-9]+/giu, "-").slice(0, 60)}.png`);
    await this.page.screenshot({ path: file }).catch(() => undefined);
    return file;
  }

  /** Records one assertion; a failure also becomes a finding with a screenshot. */
  async check(ok, description, { finding } = {}) {
    const entry = { at: this.elapsed(), chapter: this.chapters.at(-1)?.title ?? "", description, ok: Boolean(ok) };
    this.assertions.push(entry);
    process.stdout.write(`  ${ok ? "ok  " : "FAIL"} ${description}\n`);
    if (!ok) {
      const shot = await this.screenshot(description);
      this.findings.push({ severity: finding?.severity ?? "bug", title: finding?.title ?? `Expected: ${description}`, detail: finding?.detail ?? "", chapter: entry.chapter, at: entry.at, screenshot: shot, source: "assertion" });
    }
    return Boolean(ok);
  }

  /** Asserts that the locator becomes visible within `timeout`. */
  async expectVisible(locator, description, { timeout = 60_000, finding } = {}) {
    let ok = true;
    try {
      await locator.first().waitFor({ state: "visible", timeout });
    } catch {
      ok = false;
    }
    return this.check(ok, description, { finding });
  }

  /** A rough edge seen on the way (not an assertion failure). */
  async note({ title, detail = "", severity = "rough edge", screenshot = true }) {
    const shot = screenshot ? await this.screenshot(title) : null;
    this.findings.push({ severity, title, detail, chapter: this.chapters.at(-1)?.title ?? "", at: this.elapsed(), screenshot: shot, source: "journey" });
    process.stdout.write(`  note ${title}\n`);
  }

  /** Chapter lines with times on the video's clock (`toVideo(ms, index)` maps the director's clock). */
  chaptersText(toVideo = (ms) => ms) {
    return this.chapters.map((chapter, index) => `${clock(toVideo(chapter.at, index))} ${chapter.title}`).join("\n") + "\n";
  }

  /** FFMETADATA chapters for the mp4. */
  chaptersMetadata(totalMs, toVideo = (ms) => ms) {
    const lines = [";FFMETADATA1"];
    this.chapters.forEach((chapter, index) => {
      const start = Math.round(toVideo(chapter.at, index));
      const end = Math.round(index + 1 < this.chapters.length ? toVideo(this.chapters[index + 1].at, index + 1) : totalMs);
      lines.push("[CHAPTER]", "TIMEBASE=1/1000", `START=${start}`, `END=${Math.max(end, start + 1)}`, `title=${chapter.title.replace(/[=;#\\\n]/gu, " ")}`);
    });
    return lines.join("\n") + "\n";
  }
}

export { clock, sleep };
