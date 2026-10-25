import { ButtonLink } from "../../site/ui/Button";
import { Eyebrow } from "../../site/ui/Eyebrow";
import { CONTAINER, cx, FOCUS_RING, TEXT_MUTED } from "../../site/ui/styles";
import { PRIVACY_SECTIONS, RETENTION_WORDS, type PrivacySection } from "./privacyContent";

function Section({ section, index }: { readonly section: PrivacySection; readonly index: number }) {
  const headingId = `${section.id}-heading`;
  return (
    <section id={section.id} aria-labelledby={headingId} className="scroll-mt-24 border-t-[3px] border-[#121212] py-12 first:border-t-0 first:pt-0 dark:border-[#4A4A52]">
      <p className={cx("font-code text-xs font-extrabold uppercase tracking-[0.12em]", TEXT_MUTED)}>{String(index + 1).padStart(2, "0")}</p>
      <h2 id={headingId} className="mt-2 font-display text-3xl font-bold tracking-[-0.03em] sm:text-4xl">
        <a href={`#${section.id}`} className={cx("hover:underline", FOCUS_RING)}>
          {section.title}
        </a>
      </h2>
      <p className="mt-3 max-w-3xl border-l-[3px] border-signal pl-4 text-lg font-semibold leading-relaxed">{section.lead}</p>
      <div className="mt-6 flex max-w-3xl flex-col gap-4">
        {section.paragraphs.map((paragraph) => (
          <p key={paragraph} className={cx("leading-relaxed", TEXT_MUTED)}>
            {paragraph}
          </p>
        ))}
      </div>
      {section.rows ? (
        <dl className="mt-6 grid max-w-3xl gap-0 border-[3px] border-[#121212] dark:border-[#4A4A52]">
          {section.rows.map((row) => (
            <div key={row.what} className="grid gap-1 border-t-2 border-[#121212] p-4 first:border-t-0 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-4 dark:border-[#4A4A52]">
              <dt className="font-code text-xs font-extrabold uppercase tracking-[0.1em]">{row.what}</dt>
              <dd className={cx("leading-relaxed", TEXT_MUTED)}>{row.detail}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}

/** /privacy: what Kletia stores, for how long, who receives what, and how to delete it. */
export default function PrivacyPage() {
  return (
    <>
      <header className="kla-grain border-b-[3px] border-[#121212] dark:border-[#4A4A52]">
        <div className={cx(CONTAINER, "py-14 sm:py-20")}>
          <Eyebrow>Privacy &amp; data</Eyebrow>
          <h1 className="mt-6 font-display text-[clamp(2.5rem,6vw,4.25rem)] font-bold leading-[1] tracking-[-0.045em]">What Kletia keeps</h1>
          <p className={cx("mt-6 max-w-3xl text-lg leading-relaxed", TEXT_MUTED)}>
            What Kletia stores, where, for how long, who else receives what, and how to delete it. A request&apos;s text is kept until{" "}
            {RETENTION_WORDS.text} after its intent is final; the intent until {RETENTION_WORDS.intent} after. Every period on this page is
            enforced by the code, and where nothing deletes a record automatically, this page says so.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <ButtonLink to="/app" size="lg">
              Open the desk
            </ButtonLink>
            <ButtonLink to="/help" variant="secondary" size="lg">
              Help
            </ButtonLink>
          </div>
        </div>
      </header>
      <div className={cx(CONTAINER, "grid gap-10 py-12 sm:py-16 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-14")}>
        <nav aria-label="Privacy topics" className="lg:sticky lg:top-28 lg:self-start">
          <p className="font-code text-xs font-extrabold uppercase tracking-[0.12em]">Topics</p>
          <ol className="mt-3 flex flex-wrap gap-2 lg:flex-col lg:gap-1">
            {PRIVACY_SECTIONS.map((section) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  className={cx(
                    "inline-flex min-h-11 items-center border-2 border-[#121212] px-3 text-sm font-bold dark:border-[#4A4A52] lg:min-h-9 lg:border-0 lg:px-0 lg:underline lg:decoration-2 lg:underline-offset-4",
                    FOCUS_RING,
                  )}
                >
                  {section.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>
        <div className="min-w-0">
          {PRIVACY_SECTIONS.map((section, index) => (
            <Section key={section.id} section={section} index={index} />
          ))}
        </div>
      </div>
    </>
  );
}
