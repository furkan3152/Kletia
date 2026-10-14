import { cx, HARD_SHADOW, INK_BORDER, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { AUTH_TIERS } from "../devContent";
import { KeyManager } from "../keys/KeyManager";
import { PortalPageHeader } from "../shell/PortalPageHeader";

/**
 * Keys and usage (`/developers/keys`). The key manager explains its own
 * key-less state and keeps "Issue a key" open without a key, so this page
 * has no key gate: it is where a first key can come from.
 */
export default function KeysPage() {
  return (
    <>
      <PortalPageHeader
        title="Keys and usage"
        intro="Issue, rotate and revoke the keys of your project and read their usage. Keys belong on servers: a kl_dev_ key manages your webhooks and keys, and browsers use the public tier."
      />
      <KeyManager />
      <section aria-labelledby="auth-heading" className="flex min-w-0 flex-col gap-4 pt-12">
        <h2 id="auth-heading" className="font-display text-display-s font-bold">
          Authentication
        </h2>
        <p className={cx("max-w-3xl text-body", TEXT_MUTED)}>
          Three tiers share one API. Every response carries X-Request-Id and RateLimit headers, and errors use stable UPPER_SNAKE_CASE codes.
        </p>
        <ul className="grid gap-4 md:grid-cols-2 2xl:grid-cols-4">
          {AUTH_TIERS.map((tier) => (
            <li key={tier.name} className={cx("flex flex-col", INK_BORDER, HARD_SHADOW, SURFACE)}>
              <div className="h-2.5 border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563]" style={{ backgroundColor: tier.accent }} aria-hidden="true" />
              <div className="flex flex-1 flex-col gap-2 p-4">
                <h3 className="font-display text-2xl font-bold">{tier.name}</h3>
                <p className="break-words font-code text-xs">{tier.how}</p>
                <p className="font-bold">{tier.limit}</p>
                <p className={cx("text-sm", TEXT_MUTED)}>{tier.capabilities}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
