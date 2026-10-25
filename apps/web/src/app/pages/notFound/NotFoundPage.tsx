import { useRoute } from "../../routes/useRoute";
import { ButtonLink } from "../../site/ui/Button";
import { CONTAINER, cx, TEXT_MUTED } from "../../site/ui/styles";
import { Eyebrow, NoServiceScene } from "../../site/ui/Eyebrow";

/** 404: the machine jams on an address it has no card for. The heading says what happened; the scene is decorative. */
export default function NotFoundPage() {
  const { location } = useRoute();
  return (
    <div className="kla-grain border-b-[3px] border-[#121212] dark:border-[#4A4A52]">
      <div
        className={cx(
          CONTAINER,
          "grid min-h-[70vh] items-center gap-12 py-16 sm:py-20 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-14",
        )}
      >
        <div className="min-w-0">
          <Eyebrow>No service</Eyebrow>
          <h1 className="mt-5 text-balance font-display text-[clamp(2.6rem,6.4vw,4.6rem)] font-bold leading-[0.98] tracking-[-0.045em]">
            No card for this address.
          </h1>
          <p className={cx("mt-6 max-w-xl text-lg leading-relaxed", TEXT_MUTED)}>
            Nothing runs to{" "}
            <code className="break-all rounded-key border border-[var(--k-line-2)] px-1.5 py-0.5 font-code text-base">
              {location.pathname}
            </code>
            . The link may be old, or the page moved. These pages are open:
          </p>
          <nav aria-label="Open pages" className="mt-9 flex flex-wrap gap-3">
            <ButtonLink to="/" size="lg">
              Home
            </ButtonLink>
            <ButtonLink to="/studio" variant="secondary" size="lg">
              Intent Studio
            </ButtonLink>
            <ButtonLink to="/protocols" variant="secondary" size="lg">
              Protocols
            </ButtonLink>
            <ButtonLink to="/developers" variant="secondary" size="lg">
              Developer docs
            </ButtonLink>
          </nav>
        </div>
        <div className="min-w-0">
          <NoServiceScene code="404" />
        </div>
      </div>
    </div>
  );
}
