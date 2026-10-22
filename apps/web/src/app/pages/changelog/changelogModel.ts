/**
 * CHANGELOG.md as data for /changelog. The Markdown is read when the site is
 * built (bundled as text, see ChangelogPage) and parsed here into releases,
 * sections and items. Only the subset the changelog uses is understood:
 * `## [Version] - date` releases, `### Section` headings, paragraphs and `-`
 * bullets with links, inline code and bold. Nothing is rendered as HTML: the
 * page prints text nodes, and links keep only https targets or repository
 * paths (resolved against the GitHub tree). Pure, so `node --test` loads it.
 */

export type Inline =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "strong"; readonly text: string }
  | { readonly kind: "link"; readonly text: string; readonly href: string };

export type ChangelogBlock =
  | { readonly kind: "paragraph"; readonly inline: readonly Inline[] }
  | { readonly kind: "list"; readonly items: readonly (readonly Inline[])[] };

export interface ChangelogSection {
  /** "Added", "Security", ...; null for notes before the first section heading. */
  readonly title: string | null;
  readonly blocks: readonly ChangelogBlock[];
}

export interface ChangelogRelease {
  /** "2.0.0", "Unreleased", "Unreleased before 2.0.0". */
  readonly version: string;
  /** ISO day when the heading carries one. */
  readonly date: string | null;
  /** The anchor: "v2-0-0", "unreleased". Unique on the page. */
  readonly id: string;
  readonly sections: readonly ChangelogSection[];
}

export interface Changelog {
  /** The paragraphs under the H1. */
  readonly intro: readonly ChangelogBlock[];
  /** Newest first. */
  readonly releases: readonly ChangelogRelease[];
}

const RELEASE = /^##\s+\[([^\]]+)\](?:\s+-\s+(\d{4}-\d{2}-\d{2}))?\s*$/u;
const SECTION = /^###\s+(.+?)\s*$/u;
const BULLET = /^[-*]\s+(.*)$/u;

/** Where repository-relative links point (docs/..., packages/...). */
export const REPOSITORY_TREE = "https://github.com/furkan3152/Kletia/blob/main/";

/** An https URL, a repository path or an in-page anchor; anything else (javascript:, http:, data:) is dropped. */
export function safeHref(target: string): string | null {
  const value = target.trim();
  if (/^https:\/\/[^\s"<>]+$/u.test(value)) return value;
  if (/^#[A-Za-z0-9_-]+$/u.test(value)) return value;
  if (/^(?:\.\/)?[A-Za-z0-9_][A-Za-z0-9_./-]*(?:#[A-Za-z0-9_-]+)?$/u.test(value) && !value.includes("..")) {
    return `${REPOSITORY_TREE}${value.replace(/^\.\//u, "")}`;
  }
  return null;
}

/** Inline Markdown: [text](href), `code`, **bold**; everything else is text. */
export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  const pattern = /\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*/gu;
  let last = 0;
  const pushText = (text: string) => {
    if (!text) return;
    const previous = out[out.length - 1];
    if (previous?.kind === "text") out[out.length - 1] = { kind: "text", text: previous.text + text };
    else out.push({ kind: "text", text });
  };
  for (const match of source.matchAll(pattern)) {
    pushText(source.slice(last, match.index));
    last = (match.index ?? 0) + match[0].length;
    if (match[1] !== undefined && match[2] !== undefined) {
      const href = safeHref(match[2]);
      if (href) out.push({ kind: "link", text: match[1], href });
      else pushText(match[1]);
    } else if (match[3] !== undefined) {
      out.push({ kind: "code", text: match[3] });
    } else if (match[4] !== undefined) {
      out.push({ kind: "strong", text: match[4] });
    }
  }
  pushText(source.slice(last));
  return out;
}

/** "2.0.0" -> "v2-0-0", "Unreleased before 2.0.0" -> "unreleased-before-2-0-0". */
export function releaseAnchor(version: string): string {
  const slug = version
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return /^\d/u.test(slug) ? `v${slug}` : slug || "release";
}

interface DraftSection {
  title: string | null;
  blocks: ChangelogBlock[];
}

/** Parses the changelog. Releases keep the file's order, which Keep a Changelog writes newest first. */
export function parseChangelog(markdown: string): Changelog {
  const intro: ChangelogBlock[] = [];
  const releases: { version: string; date: string | null; id: string; sections: DraftSection[] }[] = [];
  const used = new Set<string>();
  let paragraph: string[] = [];
  let list: string[] | null = null;

  const target = (kind: ChangelogBlock["kind"]): ChangelogBlock[] => {
    const release = releases[releases.length - 1];
    if (!release) return intro;
    let section = release.sections[release.sections.length - 1];
    // A note after a section's list (the release's next group of changes) starts an untitled section of its own.
    if (!section || (kind === "paragraph" && section.title !== null && section.blocks.some((block) => block.kind === "list"))) {
      section = { title: null, blocks: [] };
      release.sections.push(section);
    }
    return section.blocks;
  };
  const flush = () => {
    if (paragraph.length > 0) {
      target("paragraph").push({ kind: "paragraph", inline: parseInline(paragraph.join(" ")) });
      paragraph = [];
    }
    if (list) {
      target("list").push({ kind: "list", items: list.map((item) => parseInline(item)) });
      list = null;
    }
  };

  for (const raw of markdown.replace(/\r\n?/gu, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (/^#\s/u.test(line)) {
      flush();
      continue;
    }
    const release = RELEASE.exec(line);
    if (release) {
      flush();
      let id = releaseAnchor(release[1]!);
      for (let suffix = 2; used.has(id); suffix += 1) id = `${releaseAnchor(release[1]!)}-${suffix}`;
      used.add(id);
      releases.push({ version: release[1]!.trim(), date: release[2] ?? null, id, sections: [] });
      continue;
    }
    const section = SECTION.exec(line);
    if (section && releases.length > 0) {
      flush();
      releases[releases.length - 1]!.sections.push({ title: section[1]!, blocks: [] });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet) {
      if (paragraph.length > 0) {
        const pending: string[] | null = list;
        list = null;
        flush();
        list = pending;
      }
      (list ??= []).push(bullet[1]!);
      continue;
    }
    if (list && /^\s+\S/u.test(raw)) {
      // A wrapped bullet continues the last item.
      list[list.length - 1] = `${list[list.length - 1]} ${line.trim()}`;
      continue;
    }
    if (list) flush();
    paragraph.push(line.trim());
  }
  flush();

  return {
    intro,
    releases: releases.map((release) => ({
      version: release.version,
      date: release.date,
      id: release.id,
      sections: release.sections.filter((section) => section.blocks.length > 0 || section.title !== null),
    })),
  };
}

/** True when dated releases run newest first (undated "Unreleased" entries may sit anywhere above their release). */
export function isNewestFirst(releases: readonly Pick<ChangelogRelease, "date">[]): boolean {
  const dates = releases.map((release) => release.date).filter((date): date is string => date !== null);
  return dates.every((date, index) => index === 0 || dates[index - 1]! >= date);
}

