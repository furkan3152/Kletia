import { ArrowRight } from "lucide-react";

import { Link } from "../../routes/Link";
import { PlatformNumber } from "../../site/art/Ornaments";
import { ButtonLink } from "../../site/ui/Button";
import { CONTAINER, cx, FOCUS_RING, TEXT_MUTED } from "../../site/ui/styles";
import { HELP_SECTIONS, type HelpSection } from "./helpContent";

const LINK = cx("inline-flex min-h-11 items-center gap-1.5 font-semibold underline decoration-2 underline-offset-2 hover:text-accent-text", FOCUS_RING);

function Section({ section, index }: { readonly section: HelpSection; readonly index: number }) {
  const headingId = `${section.id}-heading`;
  return (
    <section id={section.id} aria-labelledby={headingId} className="scroll-mt-24 border-t-[3px] border-[#1A1A1A] py-12 first:border-t-0 first:pt-0 dark:border-[#4B5563]">
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
      {section.steps ? (
        <ol className="mt-6 flex max-w-3xl list-none flex-col gap-2.5 [counter-reset:step]">
          {section.steps.map((step) => (
            <li
              key={step}
              className="relative pl-9 leading-relaxed [counter-increment:step] before:absolute before:left-0 before:top-0 before:flex before:h-6 before:w-6 before:items-center before:justify-center before:border-2 before:border-[#1A1A1A] before:bg-[#FFD60A] before:font-code before:text-xs before:font-bold before:text-[#1A1A1A] before:content-[counter(step)]"
            >
              {step}
            </li>
          ))}
        </ol>
      ) : null}
      {section.links && section.links.length > 0 ? (
        <p className="mt-6 flex flex-wrap gap-x-5 gap-y-1 text-sm">
          {section.links.map((link) => (
            <Link key={link.to} to={link.to} className={LINK}>
              {link.label}
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          ))}
        </p>
      ) : null}
    </section>
  );
}

/** /help: using the console. Connecting a wallet, what a preview is, failed steps, test and live networks, safety. */
export default function HelpPage() {
  return (
    <>
      <header className="kla-grain border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563]">
        <div className={cx(CONTAINER, "py-14 sm:py-20")}>
          <PlatformNumber code="HLP">Help</PlatformNumber>
          <h1 className="mt-6 font-display text-[clamp(2.5rem,6vw,4.25rem)] font-bold leading-[1] tracking-[-0.045em]">Using Kletia</h1>
          <p className={cx("mt-6 max-w-3xl text-lg leading-relaxed", TEXT_MUTED)}>
            You write what you want to do with your money in one sentence. Kletia plans it across networks and shows you the plan; your own
            wallet signs every step. These answers cover the questions people ask most.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <ButtonLink to="/app" size="lg">
              Open the console
            </ButtonLink>
            <ButtonLink to="/#faq" variant="secondary" size="lg">
              FAQ
            </ButtonLink>
          </div>
        </div>
      </header>
      <div className={cx(CONTAINER, "grid gap-10 py-12 sm:py-16 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-14")}>
        <nav aria-label="Help topics" className="lg:sticky lg:top-28 lg:self-start">
          <p className="font-code text-xs font-extrabold uppercase tracking-[0.12em]">Topics</p>
          <ol className="mt-3 flex flex-wrap gap-2 lg:flex-col lg:gap-1">
            {HELP_SECTIONS.map((section) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  className={cx(
                    "inline-flex min-h-11 items-center border-2 border-[#1A1A1A] px-3 text-sm font-bold dark:border-[#4B5563] lg:min-h-9 lg:border-0 lg:px-0 lg:underline lg:decoration-2 lg:underline-offset-4",
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
          {HELP_SECTIONS.map((section, index) => (
            <Section key={section.id} section={section} index={index} />
          ))}
          <p className={cx("max-w-3xl border-t-[3px] border-[#1A1A1A] pt-8 text-sm dark:border-[#4B5563]", TEXT_MUTED)}>
            Building on Kletia instead? The{" "}
            <Link to="/developers" className={cx("font-semibold underline decoration-2 underline-offset-2", FOCUS_RING)}>
              developer portal
            </Link>{" "}
            covers keys, the API, the SDK and the widget.
          </p>
        </div>
      </div>
    </>
  );
}
