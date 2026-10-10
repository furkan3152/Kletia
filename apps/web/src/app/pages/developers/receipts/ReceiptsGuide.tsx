import type { ReceiptKey } from "@kletia/core";
import type { ReceiptKeySet, ReceiptLogBatchView } from "@kletia/sdk";
import { RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react";

import { PLATFORM_ORIGIN, sdkSignal } from "../../../../shared/platform/kletiaClient";
import { useApiResource } from "../../../../shared/platform/useApiResource";
import { Link } from "../../../routes/Link";
import { Icon } from "../../../site/art/Icon";
import { RECEIPT_KEYS_MIRROR, RECEIPT_VERIFY_CLI, RECEIPT_VERIFY_PYTHON, RECEIPT_VERIFY_SDK } from "../../../site/snippets";
import { ApiErrorPanel } from "../../../site/ui/ApiErrorPanel";
import { Badge } from "../../../site/ui/Badge";
import { Button } from "../../../site/ui/Button";
import { CodeBlock } from "../../../site/ui/CodeBlock";
import { Skeleton, SkeletonGroup } from "../../../site/ui/Skeleton";
import { cx, FOCUS_RING, HARD_SHADOW, INK_BORDER, INK_BORDER_THIN, LABEL, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { formatWhen } from "../portal/portalFormat";

interface KeyCheck {
  readonly api: readonly ReceiptKey[];
  readonly mirror: readonly ReceiptKey[] | null;
  readonly mirrorError: string | null;
}

function isKey(value: unknown): value is ReceiptKey {
  const key = value as Partial<ReceiptKey> | null;
  return Boolean(key && typeof key.kid === "string" && typeof key.x === "string" && typeof key.notBefore === "string");
}

/** The web origin's mirror of the key set (same origin as this page). */
async function readMirror(signal: AbortSignal): Promise<readonly ReceiptKey[]> {
  const response = await fetch(`${window.location.origin}${RECEIPT_KEYS_MIRROR}`, { signal, headers: { accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = (await response.json()) as { keys?: unknown };
  return Array.isArray(body.keys) ? body.keys.filter(isKey) : [];
}

const STEPS: readonly { readonly title: string; readonly body: string }[] = [
  { title: "The signature", body: "Recompute the digest of the payload (RFC 8785 JSON, SHA-256) and check the Ed25519 signature over kletia.receipt.v1:<digest>. No network needed." },
  { title: "The key", body: "Trust a key only when both the API and this site's /.well-known mirror list it (two services), or when @kletia/core pins it." },
  { title: "The disclosures", body: "Each shared part must match its salted commitment in the signed payload, so nothing can be swapped after signing." },
  { title: "The chain", body: "Re-read every transaction from public nodes (a quorum of providers) and recompute the EVM quote binding from the landed calldata." },
  { title: "The log", body: "The receipt digest sits in an hourly, signed, hash-chained Merkle log; anyone can anchor a batch on Base with EAS." },
];

/**
 * Receipts in the developer portal: how to verify one (CLI, SDK, browser,
 * Python), the public keys as both origins list them, and the latest
 * transparency-log batches. Everything here is public: no key is needed.
 */
export default function ReceiptsGuide() {
  const keys = useApiResource<KeyCheck>("receipt-keys", async (client, signal) => {
    const [api, mirror] = await Promise.all([
      client.receipts.keys({ signal: sdkSignal(signal) }) as Promise<ReceiptKeySet>,
      readMirror(signal).then(
        (list) => ({ list, error: null as string | null }),
        (error: unknown) => ({ list: null, error: error instanceof Error ? error.message : "unreadable" }),
      ),
    ]);
    return { api: api.keys, mirror: mirror.list, mirrorError: mirror.error };
  });
  const log = useApiResource<ReceiptLogBatchView[]>("receipt-log", (client, signal) => client.receipts.log({ limit: 5, signal: sdkSignal(signal) }));
  const mirrorById = new Map((keys.data?.mirror ?? []).map((key) => [key.kid, key]));
  const confirmed = (key: ReceiptKey) => {
    const mirror = mirrorById.get(key.kid);
    return Boolean(mirror && mirror.x === key.x && mirror.notBefore === key.notBefore);
  };

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <ol className="grid min-w-0 gap-3 md:grid-cols-5">
        {STEPS.map((step, index) => (
          <li key={step.title} className={cx("flex min-w-0 flex-col gap-2 p-4", INK_BORDER, SURFACE)}>
            <span className="font-display text-2xl font-bold leading-none">{index + 1}</span>
            <p className="font-display text-[15px] font-bold">{step.title}</p>
            <p className={cx("text-[13px] leading-relaxed", TEXT_MUTED)}>{step.body}</p>
          </li>
        ))}
      </ol>

      <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)] xl:items-start">
        <CodeBlock
          label="Verify a receipt"
          maxHeightClassName="max-h-[30rem]"
          tabs={[
            { id: "cli", label: "CLI", language: "bash", code: RECEIPT_VERIFY_CLI, filename: "terminal" },
            { id: "sdk", label: "SDK", language: "ts", code: RECEIPT_VERIFY_SDK, filename: "verify.ts" },
            { id: "python", label: "Python", language: "text", code: RECEIPT_VERIFY_PYTHON, filename: "verify.py" },
          ]}
        />
        <div className={cx("flex min-w-0 flex-col gap-3 p-5", INK_BORDER, HARD_SHADOW, SURFACE)}>
          <p className="flex items-center gap-2 font-display text-xl font-bold">
            <Icon name="verify" size={26} />
            In the browser
          </p>
          <p className={cx("text-sm leading-relaxed", TEXT_MUTED)}>
            Open a share link (<code className="font-code text-[12px]">/r/rcpt_…#s=…&amp;k=…</code>). The receipt page checks the signature and every disclosed part in your browser,
            reads the keys from both origins, and can re-read the transactions from public nodes. The decryption key stays in the fragment, which the browser never sends.
          </p>
          <p className={cx("text-sm leading-relaxed", TEXT_MUTED)}>
            Owners share a finished intent&apos;s receipt from{" "}
            <Link to="/studio" className={cx("font-bold underline decoration-2 underline-offset-2", FOCUS_RING)}>
              Intent Studio
            </Link>
            , the SDK (<code className="font-code text-[12px]">receipts.share</code>) or the CLI (<code className="font-code text-[12px]">receipt share</code>). Receipts are private until shared.
          </p>
        </div>
      </div>

      <section aria-labelledby="receipt-keys-heading" className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 id="receipt-keys-heading" className="font-display text-2xl font-bold tracking-[-0.02em]">
            Public keys
          </h3>
          <Button size="sm" variant="ghost" onClick={keys.reload} aria-label="Reload the receipt keys">
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Reload
          </Button>
        </div>
        <p className={cx("max-w-3xl text-sm", TEXT_MUTED)}>
          Read live from <code className="font-code text-[12px]">{PLATFORM_ORIGIN.replace(/^https?:\/\//u, "")}/v1/receipts/keys</code> and from this site&apos;s{" "}
          <code className="font-code text-[12px]">{RECEIPT_KEYS_MIRROR}</code>. A key only one of them lists is never trusted.
        </p>
        {keys.status === "loading" && !keys.data ? (
          <SkeletonGroup label="Loading the receipt keys">
            <Skeleton surface="card" className="h-24" />
          </SkeletonGroup>
        ) : keys.status === "error" && keys.error ? (
          <ApiErrorPanel error={keys.error} title="Could not read the receipt keys" onRetry={keys.reload} />
        ) : keys.data ? (
          keys.data.api.length === 0 ? (
            <p className={cx("flex items-start gap-2 p-4 text-sm", INK_BORDER_THIN)}>
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              The API lists no receipt key yet. Until the operator configures one, receipts are not issued (or are signed with a development key that verifiers flag).
            </p>
          ) : (
            <div className={cx("min-w-0 overflow-x-auto", FOCUS_RING)} tabIndex={0} role="region" aria-label="Receipt signing keys (scrolls sideways)">
              <table className={cx("w-full min-w-[36rem] text-left text-sm", INK_BORDER_THIN)}>
                <caption className="sr-only">Receipt signing keys</caption>
                <thead className="bg-[#F1EFE8] dark:bg-[#0F1A2C]">
                  <tr>
                    <th scope="col" className="px-3 py-2">Key id</th>
                    <th scope="col" className="px-3 py-2">Status</th>
                    <th scope="col" className="px-3 py-2">Signs from</th>
                    <th scope="col" className="px-3 py-2">Both origins</th>
                  </tr>
                </thead>
                <tbody>
                  {keys.data.api.map((key) => (
                    <tr key={key.kid} className="border-t-2 border-[#1A1A1A]/10 dark:border-white/10">
                      <th scope="row" className="max-w-[16rem] break-all px-3 py-2 font-code text-[12px]">
                        {key.kid}
                      </th>
                      <td className="px-3 py-2">
                        <Badge tone={key.status === "active" ? "green" : key.status === "revoked" ? "red" : key.status === "development" ? "yellow" : "neutral"}>{key.status}</Badge>
                      </td>
                      <td className="px-3 py-2 font-code text-[12px]">
                        {key.notBefore}
                        {key.revokedOn ? ` · revoked on ${key.revokedOn}` : ""}
                      </td>
                      <td className="px-3 py-2">
                        {confirmed(key) ? (
                          <span className="inline-flex items-center gap-1.5 font-bold text-[#0B7A4B] dark:text-[#4ADE80]">
                            <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                            Confirmed
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 font-bold text-[#B91C1C] dark:text-[#FCA5A5]">
                            <ShieldAlert className="h-4 w-4" aria-hidden="true" />
                            Not in the mirror: not trusted
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : null}
        {keys.data?.mirrorError ? <p className="text-sm font-bold">The mirror on this site did not answer ({keys.data.mirrorError}), so no key can be confirmed from here.</p> : null}
        {keys.data && keys.data.mirror !== null && keys.data.mirror.length === 0 ? (
          <p className={cx("text-sm", TEXT_MUTED)}>
            This site&apos;s mirror lists no key yet. It is updated in the same release that sets the production signing key; until then receipts show &ldquo;key not confirmed&rdquo; (fail closed).
          </p>
        ) : null}
      </section>

      <section aria-labelledby="receipt-log-heading" className="flex min-w-0 flex-col gap-3">
        <h3 id="receipt-log-heading" className="font-display text-2xl font-bold tracking-[-0.02em]">
          Transparency log
        </h3>
        <p className={cx("max-w-3xl text-sm", TEXT_MUTED)}>
          Every hour the log closes a batch of the receipts issued since the last one: a Merkle root over their digests, signed and chained to the previous batch.
        </p>
        {log.status === "error" && log.error ? <ApiErrorPanel error={log.error} title="Could not read the log" onRetry={log.reload} /> : null}
        {log.data ? (
          log.data.length === 0 ? (
            <p className={cx("text-sm", TEXT_MUTED)}>No batch closed yet.</p>
          ) : (
            <ul className={cx("divide-y-2 divide-[#1A1A1A]/10 dark:divide-white/10", INK_BORDER_THIN)}>
              {log.data.map((batch) => (
                <li key={batch.seq} className="flex min-w-0 flex-col gap-1 p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                  <span className="min-w-0">
                    <span className="font-bold">Batch {batch.seq}</span> · {batch.batch.size} {batch.batch.size === 1 ? "receipt" : "receipts"} · closed {formatWhen(batch.closedAt)}
                    <span className={cx("block break-all font-code text-[11px]", TEXT_MUTED)}>root {batch.batch.root}</span>
                  </span>
                  <Badge tone={batch.anchor ? "green" : "neutral"}>{batch.anchor ? "Anchored on Base" : "Not anchored"}</Badge>
                </li>
              ))}
            </ul>
          )
        ) : null}
        <p className={cx(LABEL, "!text-[10px]", TEXT_MUTED)}>A receipt proves what Kletia observed and signed; not best execution, solvency, or that a third-party contract is honest.</p>
      </section>
    </div>
  );
}
