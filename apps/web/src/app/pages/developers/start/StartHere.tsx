import { KletiaApiError, type ApiKeyRecord } from "@kletia/sdk";
import { ArrowRight, ClipboardCopy, KeyRound, Trash2 } from "lucide-react";
import React, { useId, useRef, useState } from "react";

import { PLATFORM_ORIGIN, toPlatformError, type PlatformError } from "../../../../shared/platform/kletiaClient";
import { PREVIEW_ACCOUNTS } from "../../../../shared/platform/previewAccounts";
import { Link } from "../../../routes/Link";
import { EMBED_VERSION } from "../../../site/snippets";
import { ApiErrorPanel } from "../../../site/ui/ApiErrorPanel";
import { Button } from "../../../site/ui/Button";
import { CodeBlock } from "../../../site/ui/CodeBlock";
import { TextField } from "../../../site/ui/Field";
import { copyText } from "../../../site/ui/clipboard";
import { cx, FOCUS_RING, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { nextTabIndex } from "../../../site/ui/tabKeys";
import { keyedClient } from "../keys/keyClient";
import { SecretReveal, type Secret } from "../keys/KeyManager";
import { maskKey, portalKeyKind, useSessionKey } from "../keys/sessionKey";
import { useNow } from "../portal/useNow";
import { usePortal } from "../shell/portalContext";
import { RunStep } from "./RunStep";
import { envLine, issueKeyBody, issueLimitMessage, keyNameError, shipFiles, START_SURFACES, type KeyLaneChoice, type StartSurface } from "./startModel";

const STATIONS = [
  { id: "start-station-key", n: 1, label: "Key" },
  { id: "start-station-surface", n: 2, label: "Surface" },
  { id: "start-station-call", n: 3, label: "First call" },
  { id: "start-station-ship", n: 4, label: "Ship" },
] as const;

type KeyLane = "testnet" | "production" | "any" | null;

const LINK = cx("font-bold underline decoration-2 underline-offset-2", FOCUS_RING);

function Station({ n, id, title, children }: { readonly n: number; readonly id: string; readonly title: string; readonly children: React.ReactNode }) {
  return (
    <section aria-labelledby={`${id}-title`} id={id} className={cx("flex min-w-0 scroll-mt-48 flex-col gap-4 p-4 sm:p-5", INK_BORDER, SURFACE)}>
      <h3 id={`${id}-title`} className="flex items-center gap-3 font-display text-title font-bold">
        <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center border-[3px] border-[#1A1A1A] bg-[#FFD60A] text-[#1A1A1A]">
          {n}
        </span>
        <span>
          <span className="sr-only">Step {n}: </span>
          {title}
        </span>
      </h3>
      {children}
    </section>
  );
}

interface IssueFailure {
  readonly error: PlatformError;
  readonly retryAfter: number | null;
  readonly at: number;
}

/** Station one: sandbox or live, a name, Get a key, the one-time reveal, then the key in memory with Copy .env line and Forget. */
function KeyStation({ onIssued }: { readonly onIssued: (key: string, lane: KeyLane) => void }) {
  const { key, setKey, clear } = useSessionKey();
  const { openKeyMenu } = usePortal();
  const kind = portalKeyKind(key);
  const laneName = useId();
  const [lane, setLane] = useState<KeyLaneChoice>("sandbox");
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<Secret | null>(null);
  const [failure, setFailure] = useState<IssueFailure | null>(null);
  const [copied, setCopied] = useState<"idle" | "copied" | "blocked">("idle");
  const now = useNow(30_000, failure?.error.status === 429);
  const nameError = touched ? keyNameError(name) : null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (keyNameError(name)) return;
    setBusy(true);
    setFailure(null);
    setSecret(null);
    try {
      // POST /v1/keys answers { key: { id, name, key, lane, … } }; the secret is shown once.
      const { key: record } = await keyedClient("").request<{ key: ApiKeyRecord & { lane?: KeyLane } }>("POST", "/keys", issueKeyBody(name, lane));
      if (record?.key) {
        setSecret({ kind: "issued", id: record.id, name: record.name, key: record.key });
        onIssued(record.key, record.lane ?? (lane === "sandbox" ? "testnet" : null));
      }
    } catch (error) {
      setFailure({
        error: toPlatformError(error),
        retryAfter: error instanceof KletiaApiError ? error.retryAfterSeconds : null,
        at: Date.now(),
      });
    } finally {
      setBusy(false);
    }
  };

  const copyEnv = async () => {
    // The only place the full key leaves memory: the clipboard, on request.
    const ok = await copyText(envLine(key));
    setCopied(ok ? "copied" : "blocked");
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {kind ? (
        <div className="flex min-w-0 flex-col gap-3 border-l-[6px] border-success bg-success-bg px-3 py-3 text-sm">
          <p className="font-bold">
            <code className="font-code">{maskKey(key)}</code> is in this tab{kind === "agent" ? " (an agent key)" : ""}.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => void copyEnv()}>
              <ClipboardCopy className="h-3.5 w-3.5" aria-hidden="true" />
              Copy .env line
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                clear();
                setCopied("idle");
              }}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              Forget
            </Button>
          </div>
          <p aria-live="polite" className={cx("text-xs", TEXT_MUTED)}>
            {copied === "copied"
              ? "Copied. Paste it into your server's .env file, never into browser code."
              : copied === "blocked"
                ? "Your browser blocked the clipboard."
                : "Copied lines hold the key; code blocks on this page never do."}
          </p>
        </div>
      ) : null}
      <form onSubmit={submit} noValidate className="flex min-w-0 flex-col gap-4" aria-label="Issue a key">
        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className={cx(LABEL, "mb-2")}>Lane</legend>
          {(
            [
              { value: "sandbox", title: "Sandbox", detail: "Testnets only: transfers and own contracts on Arbitrum Sepolia and Arc, Solana Devnet." },
              { value: "live", title: "Live", detail: "Every network. Dry runs move no money; stored intents still need the user's wallet." },
            ] as const
          ).map((option) => (
            <label key={option.value} className="flex min-h-11 cursor-pointer items-start gap-3 text-sm">
              <input
                type="radio"
                name={laneName}
                value={option.value}
                checked={lane === option.value}
                onChange={() => setLane(option.value)}
                className="mt-1 h-4 w-4 accent-[#0052FF]"
              />
              <span>
                <span className="font-bold">{option.title}</span>
                <span className={cx("block", TEXT_MUTED)}>{option.detail}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <TextField
          id="start-key"
          label="Key name"
          value={name}
          maxLength={64}
          autoComplete="off"
          placeholder="my-first-app"
          onChange={(event) => setName(event.target.value)}
          onBlur={() => setTouched(true)}
          hint="One key per environment. Never put secrets in the name."
          error={nameError ?? undefined}
          required
        />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Button type="submit" loading={busy} className="max-sm:w-full">
            <KeyRound className="h-4 w-4" aria-hidden="true" />
            Get a key
          </Button>
          <button type="button" onClick={openKeyMenu} className={cx("min-h-11 text-sm", LINK)}>
            Paste one you have
          </button>
        </div>
      </form>
      <div aria-live="polite">
        {secret ? (
          <SecretReveal secret={secret} onUse={() => setKey(secret.key)} onDone={() => setSecret(null)} />
        ) : failure ? (
          failure.error.status === 429 ? (
            <p role="alert" className="border-l-[6px] border-warning bg-warning-bg px-3 py-2 text-sm font-bold">
              {issueLimitMessage(failure.retryAfter, now, failure.at)}
            </p>
          ) : (
            <ApiErrorPanel error={failure.error} title="Could not issue a key" />
          )
        ) : null}
      </div>
    </div>
  );
}

function SurfacePicker({ value, onChange }: { readonly value: StartSurface; readonly onChange: (next: StartSurface) => void }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const current = START_SURFACES.find((surface) => surface.id === value) ?? START_SURFACES[0]!;
  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = nextTabIndex(event.key, index, START_SURFACES.length);
    if (next === null) return;
    event.preventDefault();
    onChange(START_SURFACES[next]!.id);
    refs.current[next]?.focus();
  };
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div role="radiogroup" aria-label="Surface" className="flex min-w-0 flex-wrap gap-2">
        {START_SURFACES.map((surface, index) => {
          const selected = surface.id === value;
          return (
            <button
              key={surface.id}
              ref={(element) => {
                refs.current[index] = element;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(surface.id)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={cx(
                "min-h-11 border-[3px] px-3 text-sm font-bold",
                selected ? "border-[#1A1A1A] bg-[#1A1A1A] text-white dark:border-[#FFD60A] dark:bg-[#FFD60A] dark:text-[#1A1A1A]" : "border-control bg-surface",
                FOCUS_RING,
              )}
            >
              {surface.label}
            </button>
          );
        })}
      </div>
      <p className={cx("text-sm", TEXT_MUTED)}>
        {current.blurb} About {current.minutes} minutes.
      </p>
    </div>
  );
}

/**
 * "Start here": four stations from no key to shipped files in about five
 * minutes, sandbox first. The key stays in the portal's memory; code on this
 * page reads $KLETIA_API_KEY.
 */
export function StartHere({ keyLane = null }: { readonly keyLane?: KeyLane }) {
  const { key } = useSessionKey();
  const [surface, setSurface] = useState<StartSurface>("embed");
  const [issued, setIssued] = useState<{ readonly key: string; readonly lane: KeyLane } | null>(null);
  const account = PREVIEW_ACCOUNTS.solana;
  const webOrigin = typeof window === "undefined" ? "https://kletiaai.xyz" : window.location.origin;
  // A key issued here knows its lane; for a pasted one the Overview reads it from GET /v1/keys.
  const lane = issued && issued.key === key ? issued.lane : keyLane;
  const files = shipFiles({ surface, apiOrigin: PLATFORM_ORIGIN, webOrigin, embedVersion: EMBED_VERSION, account });

  return (
    <section id="start" tabIndex={-1} aria-labelledby="start-heading" className="flex min-w-0 scroll-mt-40 flex-col gap-5 pt-4 outline-none">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
        <h2 id="start-heading" className="font-display text-display-s font-bold">
          Start here
        </h2>
        <p className={cx("text-sm font-bold", TEXT_MUTED)}>4 steps · about 5 minutes</p>
      </div>
      <nav aria-label="Start here steps" className="sticky top-[124px] z-20 -mx-4 border-y-2 border-line bg-paper px-4 py-2 md:hidden">
        <ol className="flex gap-2">
          {STATIONS.map((station) => (
            <li key={station.id}>
              <a href={`#${station.id}`} className={cx("inline-flex min-h-11 items-center gap-1.5 px-1 text-sm font-bold", FOCUS_RING)}>
                <span aria-hidden="true" className="flex h-7 w-7 items-center justify-center border-2 border-[#1A1A1A] bg-[#FFD60A] text-[#1A1A1A]">
                  {station.n}
                </span>
                <span className="sr-only">Step {station.n}: </span>
                <span className="max-[380px]:sr-only">{station.label}</span>
              </a>
            </li>
          ))}
        </ol>
      </nav>
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <Station n={1} id="start-station-key" title="Get a key">
          <KeyStation onIssued={(issuedKey, issuedLane) => setIssued({ key: issuedKey, lane: issuedLane })} />
        </Station>
        <Station n={2} id="start-station-surface" title="Pick a surface">
          <SurfacePicker value={surface} onChange={setSurface} />
        </Station>
        <Station n={3} id="start-station-call" title="Make the first call">
          <RunStep apiKey={key} lane={lane} account={account} />
        </Station>
        <Station n={4} id="start-station-ship" title="Ship it">
          {files.length > 1 ? (
            <CodeBlock
              tabs={files.map((file) => ({ id: file.id, label: file.label, language: file.language, code: file.code, filename: file.filename }))}
              label={`${surface} files`}
              maxHeightClassName="max-h-80"
            />
          ) : (
            <CodeBlock code={files[0]!.code} language={files[0]!.language} filename={files[0]!.filename} label={`${files[0]!.label}`} maxHeightClassName="max-h-80" />
          )}
          <p className={cx("flex flex-wrap gap-x-4 gap-y-1 text-sm", TEXT_MUTED)}>
            <span>Next:</span>
            <Link to="/developers/embed" className={LINK}>
              Embed builder
            </Link>
            <Link to="/developers/webhooks" className={LINK}>
              Webhooks
            </Link>
            <Link to="/developers/contracts" className={LINK}>
              Your own contract
            </Link>
            <Link to="/developers/recipes" className={cx("inline-flex items-center gap-1", LINK)}>
              All recipes
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          </p>
        </Station>
      </div>
    </section>
  );
}
