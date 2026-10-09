import { useRoute } from "../../routes/useRoute";
import { EndOfLine } from "../../site/art/EndOfLine";
import { ButtonLink } from "../../site/ui/Button";
import { CONTAINER, cx, TEXT_MUTED } from "../../site/ui/styles";

/** 404: the line ends at a buffer stop on Platform 404. The heading says what happened; the scene is decorative. */
export default function NotFoundPage() {
  const { location } = useRoute();
  return (
    <div className="kla-grain border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563]">
      <div
        className={cx(
          CONTAINER,
          "grid min-h-[70vh] items-center gap-12 py-16 sm:py-20 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-14",
        )}
      >
        <div className="min-w-0">
          <p className="font-code text-[11px] font-bold uppercase tracking-[0.16em] text-[#0047E0] dark:text-[#7EA6FF]">404 · no service</p>
          <h1 className="mt-4 text-balance font-display text-[clamp(2.6rem,6.4vw,4.6rem)] font-bold leading-[0.98] tracking-[-0.045em]">
            This line ends here.
          </h1>
          <p className={cx("mt-6 max-w-xl text-lg leading-relaxed", TEXT_MUTED)}>
            Nothing runs to{" "}
            <code className="break-all border-2 border-[#1A1A1A] bg-[#FBFAF7] px-1.5 py-0.5 font-code text-base text-[#1A1A1A] dark:border-[#4B5563] dark:bg-[#131E32] dark:text-white">
              {location.pathname}
            </code>
            . The link may be old, or the page moved. These platforms are open:
          </p>
          <nav aria-label="Open platforms" className="mt-9 flex flex-wrap gap-3">
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
          <EndOfLine />
        </div>
      </div>
    </div>
  );
}
