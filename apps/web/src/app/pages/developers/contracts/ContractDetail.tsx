import type { ContractView, EvmContractPins, IntentGraph, SolanaProgramPin } from "@kletia/core";
import type { ContractWithRevisions } from "@kletia/sdk";
import { ArrowUpRight, RefreshCw, ShieldX, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";

import { sdkSignal } from "../../../../shared/platform/kletiaClient";
import { useApiAction, useApiResource } from "../../../../shared/platform/useApiResource";
import { ApiErrorPanel } from "../../../site/ui/ApiErrorPanel";
import { Button } from "../../../site/ui/Button";
import { CodeBlock } from "../../../site/ui/CodeBlock";
import { Skeleton, SkeletonGroup } from "../../../site/ui/Skeleton";
import { StatusPill } from "../../../site/ui/StatusPill";
import { cx, FOCUS_RING, INK_BORDER_THIN, LABEL, TEXT_MUTED } from "../../../site/ui/styles";
import { keyedClient } from "../keys/keyClient";
import { formatWhen, hostOf, httpsUrl, shortAddress, shortId } from "../portal/portalFormat";
import { WELL_KNOWN_PATH, wellKnownSnippet } from "./contractModel";
import { ContractTestForm } from "./ContractTestForm";

function isEvmPins(pins: ContractView["pins"]): pins is EvmContractPins {
  return !Array.isArray(pins);
}

function ExternalLink({ href, children }: { readonly href: string | null; readonly children: ReactNode }) {
  if (!href) return <>{children}</>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cx("inline-flex items-center gap-1 font-bold underline decoration-2 underline-offset-2", FOCUS_RING)}>
      {children}
      <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

function Pins({ contract }: { readonly contract: ContractView }) {
  if (isEvmPins(contract.pins)) {
    const pins = contract.pins;
    return (
      <dl className="grid min-w-0 gap-x-4 gap-y-1.5 font-code text-[12px] sm:grid-cols-[10rem_minmax(0,1fr)]">
        <dt className="font-bold">code hash</dt>
        <dd className="min-w-0 break-all">{pins.codeHash}</dd>
        <dt className="font-bold">code size</dt>
        <dd>{pins.codeSize.toLocaleString("en-US")} bytes</dd>
        {pins.proxy ? (
          <>
            <dt className="font-bold">proxy</dt>
            <dd className="min-w-0 break-all">
              {pins.proxy.kind} → {pins.proxy.implementation}
            </dd>
            <dt className="font-bold">implementation hash</dt>
            <dd className="min-w-0 break-all">{pins.proxy.implementationCodeHash}</dd>
          </>
        ) : null}
        {pins.addresses.map((entry) => (
          <div key={entry.label} className="contents">
            <dt className="font-bold">{entry.label}</dt>
            <dd className="min-w-0 break-all">
              {entry.address} · {entry.codeHash}
            </dd>
          </div>
        ))}
        <dt className="font-bold">read at block</dt>
        <dd>
          {pins.blockNumber} ({formatWhen(pins.checkedAt)})
        </dd>
      </dl>
    );
  }
  const programs = contract.pins as readonly SolanaProgramPin[];
  return (
    <ul className="flex flex-col gap-2 font-code text-[12px]">
      {programs.map((pin) => (
        <li key={pin.program} className="min-w-0 break-all">
          <span className="font-bold">{pin.program}</span>
          <span className={cx("block", TEXT_MUTED)}>
            {pin.upgradeAuthority ? `upgradeable by ${pin.upgradeAuthority}` : "immutable"}
            {pin.lastDeploySlot ? ` · deployed at slot ${pin.lastDeploySlot}` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Recent call steps of this registration, from the key's latest intents (filtered here, not by the API). */
function RecentCalls({ contract, apiKey }: { readonly contract: ContractView; readonly apiKey: string }) {
  const intents = useApiResource<IntentGraph[]>(`contract-calls:${contract.id}`, (_client, signal) =>
    keyedClient(apiKey).intents.list(50, { signal: sdkSignal(signal) }),
  );
  if (intents.status === "loading") {
    return (
      <SkeletonGroup label="Loading recent calls" className="flex flex-col gap-2">
        <Skeleton surface="card" className="h-10" />
      </SkeletonGroup>
    );
  }
  if (intents.status === "error" && intents.error) return <ApiErrorPanel error={intents.error} title="Could not read recent intents" onRetry={intents.reload} />;
  const rows = (intents.data ?? []).flatMap((intent) =>
    intent.steps.filter((step) => step.call?.contract === contract.id).map((step) => ({ intent, step })),
  );
  if (rows.length === 0) return <p className={cx("text-sm", TEXT_MUTED)}>No intent among your latest 50 calls this registration yet.</p>;
  return (
    <ul className={cx("divide-y-2 divide-[#121212]/10 dark:divide-white/10", INK_BORDER_THIN)}>
      {rows.slice(0, 12).map(({ intent, step }) => (
        <li key={`${intent.id}-${step.id}`} className="flex min-w-0 flex-wrap items-center justify-between gap-2 p-3 text-sm">
          <span className="min-w-0">
            <span className="block break-words font-semibold">{step.title}</span>
            <span className={cx("block font-code text-[12px]", TEXT_MUTED)}>
              {shortId(intent.id)} · entry {step.call?.entry} · revision {step.call?.revision} · {formatWhen(intent.createdAt)}
            </span>
          </span>
          <StatusPill tone={step.status === "settled" || step.status === "confirmed" ? "success" : step.status === "failed" || step.status === "indeterminate" ? "danger" : "neutral"}>
            {step.status.replace(/_/gu, " ")}
          </StatusPill>
        </li>
      ))}
    </ul>
  );
}

/** The entries of a registration: id, label, function or href, phrases and limits. */
export function ContractEntries({ contract }: { readonly contract: ContractView }) {
  return (
    <ul className="grid gap-3 lg:grid-cols-2">
      {contract.actions.map((action) => (
        <li key={action.id} className={cx("flex min-w-0 flex-col gap-1.5 p-3 text-sm", INK_BORDER_THIN)}>
          <p className="flex min-w-0 flex-wrap items-center gap-2">
            <code className="font-code text-[12px] font-bold">{action.id}</code>
            <span className="min-w-0 break-words font-semibold">{action.label}</span>
          </p>
          <p className={cx("break-all font-code text-[12px]", TEXT_MUTED)}>
            {"function" in action ? `${action.function} · ${action.selector}` : "href" in action ? action.href : null}
          </p>
          {action.phrases ? (
            <p className="text-[13px]">
              Phrases: {action.phrases.verbs.join(", ")} {action.phrases.aliases.length > 0 ? `· ${action.phrases.aliases.map((alias) => `"${alias}"`).join(", ")}` : ""}
            </p>
          ) : null}
          {action.limits?.maxAmount || action.limits?.minAmount ? (
            <p className="text-[13px]">
              Limits: {action.limits.minAmount ? `min ${action.limits.minAmount}` : ""}
              {action.limits.minAmount && action.limits.maxAmount ? ", " : ""}
              {action.limits.maxAmount ? `max ${action.limits.maxAmount}` : ""}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** Pinned code identity and source verification. */
export function ContractPinsAndVerification({ contract }: { readonly contract: ContractView }) {
  const sourceUrl = contract.verification.source?.url ? httpsUrl(contract.verification.source.url) : null;
  return (
    <div className="grid min-w-0 gap-6 xl:grid-cols-2">
      <section aria-labelledby="contract-pins" className="min-w-0">
        <h3 id="contract-pins" className={cx(LABEL, "mb-2")}>
          Pinned code identity
        </h3>
        <Pins contract={contract} />
        <p className={cx("mt-3 text-[13px]", TEXT_MUTED)}>
          Re-read at every prepare and every 10 minutes; a change suspends the registration. Definition hash{" "}
          <code className="break-all font-code">{contract.definitionHash}</code>.
        </p>
      </section>
      <section aria-labelledby="contract-verification" className="flex min-w-0 flex-col gap-3">
        <h3 id="contract-verification" className={LABEL}>
          Verification
        </h3>
        <ul className="flex flex-col gap-1.5 text-sm">
          {contract.vm === "evm" ? (
            <li>
              Source: <strong>{contract.verification.source?.status?.replace("_", " ") ?? "unknown"}</strong>{" "}
              {sourceUrl ? <ExternalLink href={sourceUrl}>Sourcify</ExternalLink> : null}
              {contract.verification.implementationSource ? (
                <span> · implementation {contract.verification.implementationSource.status.replace("_", " ")}</span>
              ) : null}
            </li>
          ) : (
            (contract.verification.programs ?? []).map((program) => (
              <li key={program.program} className="break-all">
                {shortAddress(program.program)}: OtterSec {program.verified === true ? "verified" : program.verified === false ? "not verified" : "unknown"}
              </li>
            ))
          )}
        </ul>
      </section>
    </div>
  );
}

/** The registration's revisions, the serving and the pending one marked. */
export function ContractRevisions({ contract }: { readonly contract: ContractWithRevisions }) {
  const revisions = contract.revisions ?? [];
  if (revisions.length === 0) return <p className={cx("text-sm", TEXT_MUTED)}>Revision {contract.revision} is the only one.</p>;
  return (
    <ol className="flex flex-col gap-1.5 font-code text-[13px]">
      {revisions.map((revision) => (
        <li key={revision.revision} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-bold">r{revision.revision}</span>
          <span className="min-w-0 break-all">{revision.definitionHash.slice(0, 16)}…</span>
          <span className={TEXT_MUTED}>{formatWhen(revision.createdAt)}</span>
          {revision.revision === contract.activeRevision ? <StatusPill tone="success">Serving</StatusPill> : null}
          {revision.revision === contract.pendingRevision ? <StatusPill tone="info">Pending</StatusPill> : null}
        </li>
      ))}
    </ol>
  );
}

/** The integrator's domain: verified, or the `.well-known` file to publish and Reverify. */
export function ContractDomain({ contract }: { readonly contract: ContractView }) {
  const website = httpsUrl(contract.integrator.website);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="text-sm">
        Domain: <strong>{contract.integrator.domainVerified ? "verified" : "not verified"}</strong>
        {website ? (
          <>
            {" "}
            for <ExternalLink href={website}>{hostOf(website) ?? website}</ExternalLink>
          </>
        ) : null}
      </p>
      {!contract.integrator.domainVerified && website ? (
        <>
          <p className={cx("max-w-3xl text-sm", TEXT_MUTED)}>
            Publish this file at <code className="break-all font-code">{`${website.replace(/\/+$/u, "")}${WELL_KNOWN_PATH}`}</code> (HTTPS, no redirects, at most 16 KB), then
            press Reverify. Unverified integrators keep working with a $1,000 per-step cap and a warning in every review.
          </p>
          <CodeBlock code={wellKnownSnippet([contract.id])} language="json" label="Domain verification file" filename="kletia.json" />
        </>
      ) : !website ? (
        <p className={cx("text-sm", TEXT_MUTED)}>The registration names no website, so there is no domain to verify.</p>
      ) : null}
    </div>
  );
}

/** Recent call steps of this registration, from the key's latest intents. */
export function ContractRecentCalls({ contract, apiKey }: { readonly contract: ContractView; readonly apiKey: string }) {
  return <RecentCalls contract={contract} apiKey={apiKey} />;
}

/** The test form: what your users would see, simulated, nothing signed. */
export function ContractTest({ contract, apiKey }: { readonly contract: ContractView; readonly apiKey: string }) {
  return <ContractTestForm contract={contract} apiKey={apiKey} />;
}

export interface ContractActionsProps {
  readonly contract: ContractView;
  readonly apiKey: string;
  /** The registration changed (reverify) or is gone (delete). */
  readonly onChanged: (message: string, removed?: boolean) => void;
  /** Developer keys reverify and delete; agent keys only read. */
  readonly canWrite: boolean;
}

/** Reverify and delete (with a confirmation), and their failures. */
export function ContractActions({ contract, apiKey, onChanged, canWrite }: ContractActionsProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const reverify = useApiAction((_client, signal, id: string) => keyedClient(apiKey).contracts.reverify(id, { signal: sdkSignal(signal) }));
  const remove = useApiAction((_client, signal, id: string) => keyedClient(apiKey).contracts.delete(id, { signal: sdkSignal(signal) }).then(() => id));
  if (!canWrite) return null;

  const doReverify = async () => {
    const view = await reverify.run(contract.id);
    if (view) onChanged(view.revision > contract.revision ? `Reverified: the code changed, revision ${view.revision} was created.` : "Reverified: pins and verification refreshed.");
  };
  const doDelete = async () => {
    const id = await remove.run(contract.id);
    if (id) onChanged(`${contract.integrator.name} (${shortId(contract.id)}) was deleted. Intents planned on it stop preparing.`, true);
  };
  const failure = reverify.status === "error" ? reverify.error : remove.status === "error" ? remove.error : null;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" loading={reverify.status === "loading"} onClick={() => void doReverify()}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Reverify
        </Button>
        {!confirmDelete ? (
          <Button variant="ghost" onClick={() => setConfirmDelete(true)}>
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            Delete
          </Button>
        ) : null}
      </div>
      {confirmDelete ? (
        <div className="flex flex-col gap-3 border-[3px] border-danger bg-danger-bg p-3 text-fg">
          <p className="flex items-start gap-2 text-sm font-bold">
            <ShieldX className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            Delete {contract.integrator.name} ({shortId(contract.id)})? Intents planned on it stop preparing; submitted steps keep verifying.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ink" loading={remove.status === "loading"} onClick={() => void doDelete()}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              Delete registration
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setConfirmDelete(false)}>
              Keep it
            </Button>
          </div>
        </div>
      ) : null}
      <div aria-live="polite">{failure ? <ApiErrorPanel error={failure} title="The action failed" /> : null}</div>
    </div>
  );
}
