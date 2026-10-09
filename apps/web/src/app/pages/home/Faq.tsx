import { ArrowRight, ArrowUpRight, BookOpen } from "lucide-react";

import { Link } from "../../routes/Link";
import { Icon } from "../../site/art/Icon";
import { PlatformNumber } from "../../site/art/Ornaments";
import { Reveal } from "../../site/motion/Reveal";
import { GITHUB_URL } from "../../site/siteLinks";
import { CONTAINER, cx, FOCUS_RING, INK_BORDER, SHADOW_HARD, TEXT_MUTED } from "../../site/ui/styles";
import { FAQ_ITEMS, fillCounts } from "./faqContent";

export interface FaqProps {
  readonly networks: number;
  readonly protocols: number;
}

/** Frequently asked questions as native disclosures (keyboard and screen-reader friendly without JS). */
export function Faq({ networks, protocols }: FaqProps) {
  return (
    <section
      id="faq"
      aria-labelledby="faq-heading"
      className="relative scroll-mt-24 border-y-[3px] border-[#1A1A1A] bg-[#EDE9DF] py-16 dark:border-[#4B5563] dark:bg-[#0E1729] sm:py-20 lg:py-24"
    >
      <div className={cx(CONTAINER, "grid gap-10 lg:grid-cols-[minmax(0,0.75fr)_minmax(0,1.25fr)] lg:gap-14")}>
        <div className="flex flex-col gap-8 lg:sticky lg:top-28 lg:self-start">
          <Reveal stagger>
            <div data-reveal-item className="mb-5">
              <PlatformNumber n={9}>FAQ</PlatformNumber>
            </div>
            <h2 data-reveal-item id="faq-heading" className="text-balance font-display text-[2rem] font-bold leading-[1.05] tracking-[-0.03em] sm:text-5xl">
              Questions teams ask before they integrate.
            </h2>
            <p data-reveal-item className={cx("mt-5 text-base leading-relaxed sm:text-lg", TEXT_MUTED)}>
              Custody, coverage, failure handling and what we have not done yet.
            </p>
          </Reveal>
          <div className={cx("flex flex-col gap-4 bg-[#FFD60A] p-6 text-[#1A1A1A]", INK_BORDER, SHADOW_HARD)}>
            <p className="flex items-center gap-2.5 font-display text-xl font-bold [--kla-plate:#FFFFFF]">
              <Icon name="board" size={24} />
              Something missing here?
            </p>
            <p className="text-sm leading-relaxed text-[#1A1A1A]/85">
              The developer docs cover every endpoint, and the issue tracker on GitHub is open.
            </p>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              <Link
                to="/developers"
                className={cx("inline-flex min-h-9 items-center gap-1.5 text-xs font-black uppercase tracking-[0.12em] underline decoration-2 underline-offset-4", FOCUS_RING)}
              >
                <BookOpen className="h-3.5 w-3.5" aria-hidden="true" />
                Read the docs
              </Link>
              <a
                href={`${GITHUB_URL}/issues`}
                target="_blank"
                rel="noopener noreferrer"
                className={cx("inline-flex min-h-9 items-center gap-1.5 text-xs font-black uppercase tracking-[0.12em] underline decoration-2 underline-offset-4", FOCUS_RING)}
              >
                Open an issue
                <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </div>
          </div>
        </div>

        <Reveal as="div" stagger className="flex flex-col gap-3">
          {FAQ_ITEMS.map((item) => (
            <details
              key={item.id}
              id={`faq-${item.id}`}
              data-reveal-item
              className={cx(
                "kl-details group border-[3px] border-[#1A1A1A] bg-white transition-shadow duration-150 open:shadow-hard-sm motion-reduce:transition-none dark:border-[#4B5563] dark:bg-[#131E32]",
              )}
            >
              <summary
                className={cx(
                  "flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 px-5 py-3 font-display text-lg font-bold leading-snug transition-colors duration-150 hover:bg-[#FFF7CC] motion-reduce:transition-none dark:hover:bg-[#1A2841] [&::-webkit-details-marker]:hidden",
                  FOCUS_RING,
                  "focus-visible:-outline-offset-[6px]",
                )}
              >
                {item.question}
                <span aria-hidden="true" className="relative flex h-8 w-8 shrink-0 items-center justify-center border-2 border-[#1A1A1A] bg-[#FFD60A] text-[#1A1A1A] dark:border-[#4B5563]">
                  <span className="absolute h-[3px] w-3.5 bg-current" />
                  <span className="absolute h-3.5 w-[3px] bg-current transition-transform duration-240 ease-kl-snap group-open:rotate-90 motion-reduce:transition-none" />
                </span>
              </summary>
              <div className="border-t-2 border-dashed border-[#1A1A1A]/20 px-5 pb-5 pt-4 dark:border-white/10">
                {item.answer.map((paragraph, index) => (
                  <p key={index} className={cx("text-[15px] leading-relaxed", TEXT_MUTED, index > 0 && "mt-3")}>
                    {fillCounts(paragraph, { networks, protocols })}
                  </p>
                ))}
                {item.links && item.links.length > 0 ? (
                  <p className="mt-4 flex flex-wrap gap-x-5 gap-y-2">
                    {item.links.map((link) => (
                      <Link
                        key={link.to}
                        to={link.to}
                        className={cx(
                          "inline-flex min-h-9 items-center gap-1.5 text-xs font-black uppercase tracking-[0.12em] text-[#0047E0] underline decoration-2 underline-offset-4 dark:text-[#7EA6FF]",
                          FOCUS_RING,
                        )}
                      >
                        {link.label}
                        <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                      </Link>
                    ))}
                  </p>
                ) : null}
              </div>
            </details>
          ))}
        </Reveal>
      </div>
    </section>
  );
}
