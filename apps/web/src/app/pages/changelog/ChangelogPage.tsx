import { ArrowUpRight } from "lucide-react";
import { Fragment, type ReactNode } from "react";

// CHANGELOG.md is read when the site is built: the release notes ship as text in this page's chunk.
import changelogSource from "../../../../../../CHANGELOG.md?raw";
import { PlatformNumber } from "../../site/art/Ornaments";
import { GITHUB_URL } from "../../site/siteLinks";
import { CONTAINER, cx, FOCUS_RING, TEXT_MUTED } from "../../site/ui/styles";
import { parseChangelog, type ChangelogBlock, type ChangelogRelease, type Inline } from "./changelogModel";

const CHANGELOG = parseChangelog(changelogSource);
const SOURCE_URL = `${GITHUB_URL}/blob/main/CHANGELOG.md`;

const LINK = cx("font-semibold underline decoration-2 underline-offset-2 hover:text-accent-text", FOCUS_RING);

function InlineText({ inline }: { readonly inline: readonly Inline[] }) {
  return (
    <>
      {inline.map((part, index) => {
        switch (part.kind) {
          case "code":
            return (
              <code key={index} className="break-words border border-[#1A1A1A]/20 bg-surface-2 px-1 py-px font-code text-[0.88em] dark:border-white/15">
                {part.text}
              </code>
            );
          case "strong":
            return <strong key={index}>{part.text}</strong>;
          case "link":
            return part.href.startsWith("#") ? (
              <a key={index} href={part.href} className={LINK}>
                {part.text}
              </a>
            ) : (
              <a key={index} href={part.href} target="_blank" rel="noopener noreferrer" className={LINK}>
                {part.text}
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            );
          default:
            return <Fragment key={index}>{part.text}</Fragment>;
        }
      })}
    </>
  );
}

function Blocks({ blocks, note = false }: { readonly blocks: readonly ChangelogBlock[]; readonly note?: boolean }): ReactNode {
  return blocks.map((block, index) =>
    block.kind === "paragraph" ? (
      <p key={index} className={cx("max-w-3xl leading-relaxed", note ? "border-l-[3px] border-signal pl-4 font-semibold" : TEXT_MUTED)}>
        <InlineText inline={block.inline} />
      </p>
    ) : (
      <ul key={index} className="flex max-w-3xl flex-col gap-2.5">
        {block.items.map((item, itemIndex) => (
          <li key={itemIndex} className="relative pl-5 leading-relaxed before:absolute before:left-0 before:top-[0.6em] before:h-2 before:w-2 before:bg-[#1A1A1A] dark:before:bg-[#F1F5F9]">
            <InlineText inline={item} />
          </li>
        ))}
      </ul>
    ),
  );
}

function formatDay(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime())
    ? parsed.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
    : date;
}

function Release({ release }: { readonly release: ChangelogRelease }) {
  const headingId = `${release.id}-heading`;
  return (
    <section id={release.id} aria-labelledby={headingId} className="scroll-mt-24 border-t-[3px] border-[#1A1A1A] py-12 first:border-t-0 first:pt-0 dark:border-[#4B5563]">
      <h2 id={headingId} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 font-display text-3xl font-bold tracking-[-0.03em] sm:text-4xl">
        <a href={`#${release.id}`} className={cx("hover:underline", FOCUS_RING)}>
          {release.version}
        </a>
        {release.date ? (
          <time dateTime={release.date} className={cx("font-code text-sm font-semibold tracking-normal", TEXT_MUTED)}>
            {formatDay(release.date)}
          </time>
        ) : null}
      </h2>
      <div className="mt-6 flex flex-col gap-8">
        {release.sections.map((section, index) => (
          <div key={index} className="flex flex-col gap-3">
            {section.title ? <h3 className="font-code text-sm font-extrabold uppercase tracking-[0.12em]">{section.title}</h3> : null}
            <Blocks blocks={section.blocks} note={section.title === null} />
          </div>
        ))}
      </div>
    </section>
  );
}

/** /changelog: CHANGELOG.md as a page, newest release first, an anchor per release. */
export default function ChangelogPage() {
  return (
    <>
      <header className="kla-grain border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563]">
        <div className={cx(CONTAINER, "py-14 sm:py-20")}>
          <PlatformNumber code="LOG">Release notes</PlatformNumber>
          <h1 className="mt-6 font-display text-[clamp(2.5rem,6vw,4.25rem)] font-bold leading-[1] tracking-[-0.045em]">Changelog</h1>
          <div className="mt-6 flex max-w-3xl flex-col gap-3 text-lg">
            <Blocks blocks={CHANGELOG.intro} />
          </div>
          <p className="mt-6 text-sm">
            <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer" className={cx("inline-flex min-h-11 items-center gap-1.5", LINK)}>
              CHANGELOG.md on GitHub
              <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </p>
        </div>
      </header>
      <div className={cx(CONTAINER, "grid gap-10 py-12 sm:py-16 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-14")}>
        <nav aria-label="Releases" className="lg:sticky lg:top-28 lg:self-start">
          <p className="font-code text-xs font-extrabold uppercase tracking-[0.12em]">Releases</p>
          <ol className="mt-3 flex flex-wrap gap-2 lg:flex-col lg:gap-1">
            {CHANGELOG.releases.map((release) => (
              <li key={release.id}>
                <a
                  href={`#${release.id}`}
                  className={cx(
                    "inline-flex min-h-11 items-center border-2 border-[#1A1A1A] px-3 text-sm font-bold dark:border-[#4B5563] lg:min-h-9 lg:border-0 lg:px-0 lg:underline lg:decoration-2 lg:underline-offset-4",
                    FOCUS_RING,
                  )}
                >
                  {release.version}
                </a>
              </li>
            ))}
          </ol>
        </nav>
        <div className="min-w-0">
          {CHANGELOG.releases.length > 0 ? (
            CHANGELOG.releases.map((release) => <Release key={release.id} release={release} />)
          ) : (
            <p className={TEXT_MUTED}>No releases are recorded yet.</p>
          )}
        </div>
      </div>
    </>
  );
}
