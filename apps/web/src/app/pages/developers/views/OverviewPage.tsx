import { PROTOCOLS } from "@kletia/core";
import type { ApiKeyRecord } from "@kletia/sdk";
import { ArrowUpRight, KeyRound } from "lucide-react";
import React, { useId, useState } from "react";

import { PLATFORM_ORIGIN, sdkSignal } from "../../../../shared/platform/kletiaClient";
import { useApiAction } from "../../../../shared/platform/useApiResource";
import { Icon } from "../../../site/art/Icon";
import { PlatformNumber } from "../../../site/art/Ornaments";
import { SpecSheet } from "../../../site/art/SpecSheet";
import { SDK_PACKAGE_URL } from "../../../site/siteLinks";
import { REST_STRUCTURED, SDK_INSTALL, SDK_PLAN_AND_EXECUTE, SDK_QUICKSTART } from "../../../site/snippets";
import { ApiErrorPanel } from "../../../site/ui/ApiErrorPanel";
import { Button, ButtonLink } from "../../../site/ui/Button";
import { CodeBlock } from "../../../site/ui/CodeBlock";
import { TextField } from "../../../site/ui/Field";
import { cx, FOCUS_RING, HARD_SHADOW, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { keyedClient } from "../keys/keyClient";
import { SecretReveal, type Secret } from "../keys/KeyManager";
import { maskKey, portalKeyKind, useSessionKey } from "../keys/sessionKey";
import { PortalPageHeader } from "../shell/PortalPageHeader";
import { GET_KEY_HREF } from "../shell/portalRoutes";

/** The drawing shows "your contract" only while the registry has bring-your-own-contract venues; the caption follows it. */
const HAS_CONTRACTS = PROTOCOLS.some((protocol) => protocol.category === "custom");
const NAME_PATTERN = /^[\w .:-]{1,64}$/u;

/**
 * Station one of "Start here" (`#start-key`, where every "Get a key" lands):
 * name a key and issue it, then the one-time reveal. A new key starts a new
 * project; Keys and usage adds keys to an existing one.
 */
function GetKeyCard() {
  const { key, setKey } = useSessionKey();
  const kind = portalKeyKind(key);
  const formId = useId();
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const [secret, setSecret] = useState<Secret | null>(null);
  const issue = useApiAction((_client, signal, keyName: string) => keyedClient("").keys.create(keyName, { signal: sdkSignal(signal) }));
  const trimmed = name.trim();
  const invalid = touched && !NAME_PATTERN.test(trimmed);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!NAME_PATTERN.test(trimmed)) return;
    setSecret(null);
    const record: ApiKeyRecord | undefined = await issue.run(trimmed);
    if (record?.key) setSecret({ kind: "issued", id: record.id, name: record.name, key: record.key });
  };

  return (
    <div className={cx("flex min-w-0 flex-col gap-4 p-5", INK_BORDER, HARD_SHADOW, SURFACE)}>
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center border-[3px] border-[#1A1A1A] bg-[#FFD60A] font-display text-lg font-bold text-[#1A1A1A]">
          1
        </span>
        <h3 className="font-display text-title font-bold">Get a key</h3>
      </div>
      {kind === "developer" ? (
        <p className="text-sm">
          A developer key is in this tab: <code className="font-code font-bold">{maskKey(key)}</code>. Issue another one below, or add keys to its
          project on{" "}
          <ButtonLink to="/developers/keys" variant="ghost" size="sm" className="!inline-flex align-middle">
            Keys and usage
          </ButtonLink>
          .
        </p>
      ) : (
        <p className={cx("text-sm", TEXT_MUTED)}>
          The public tier needs no key (30 requests a minute per IP). A free developer key raises that to 300, lists your intents and
          manages webhooks, contracts, links and rule books.
        </p>
      )}
      <form onSubmit={submit} noValidate className="flex flex-col gap-4" aria-labelledby={`${formId}-title`}>
        <span id={`${formId}-title`} className="sr-only">
          Issue a developer key
        </span>
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
          error={invalid ? "Use 1-64 letters, numbers, spaces, dots, colons, dashes or underscores." : undefined}
          required
        />
        <Button type="submit" loading={issue.status === "loading"} className="self-start">
          <KeyRound className="h-4 w-4" aria-hidden="true" />
          Get a developer key
        </Button>
      </form>
      <div aria-live="polite">
        {secret ? (
          <SecretReveal secret={secret} onUse={() => setKey(secret.key)} onDone={() => setSecret(null)} />
        ) : issue.status === "error" && issue.error ? (
          <ApiErrorPanel error={issue.error} title="Could not issue a key" />
        ) : null}
      </div>
    </div>
  );
}

/** Overview (`/developers`): what the API is, the first call, a key, and how the pieces fit. */
export default function OverviewPage() {
  return (
    <>
      <PortalPageHeader
        eyebrow={<PlatformNumber n={1}>Developers · Platform API v1</PlatformNumber>}
        title={
          <>
            Put <span className="whitespace-nowrap">cross-network</span> routes inside your own product.
          </>
        }
        intro="One REST API, a TypeScript SDK, a React widget, an iframe embed and an MCP server for agents. You plan on your server, your users sign in their wallets, and Kletia tells your server when each leg lands, then signs a receipt you can check without trusting us."
      >
        <div className="flex flex-wrap gap-3">
          <ButtonLink to={GET_KEY_HREF} className="[--kla-plate:#FFD60A]">
            <Icon name="key" size={18} />
            Get a key
          </ButtonLink>
          <ButtonLink to="/developers/api" variant="secondary">
            Open the API explorer
          </ButtonLink>
          <ButtonLink to="/developers/recipes" variant="secondary">
            Recipes
          </ButtonLink>
          <ButtonLink to={`${PLATFORM_ORIGIN}/v1/openapi.json`} variant="ghost">
            OpenAPI JSON
            <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
          </ButtonLink>
        </div>
        <div className="flex max-w-xl flex-col gap-1.5">
          <p className={cx(LABEL, TEXT_MUTED)}>Base URL</p>
          <CodeBlock variant="inline" code={`${PLATFORM_ORIGIN}/v1`} label="the base URL" />
        </div>
      </PortalPageHeader>

      <section id="start" tabIndex={-1} aria-labelledby="start-heading" className="flex min-w-0 scroll-mt-40 flex-col gap-6 pt-6 outline-none">
        <div className="flex min-w-0 flex-col gap-2">
          <h2 id="start-heading" className="font-display text-display-s font-bold">
            Start here
          </h2>
          <p className={cx("max-w-3xl text-body", TEXT_MUTED)}>
            Install the SDK, list networks and plan your first intent as a dry run: dry runs move no money and nothing here signs. Source:{" "}
            <a className={cx("font-bold underline decoration-2 underline-offset-2", FOCUS_RING)} href={SDK_PACKAGE_URL} target="_blank" rel="noopener noreferrer">
              packages/sdk
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            .
          </p>
        </div>
        <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] xl:items-start">
          <GetKeyCard />
          <div className="flex min-w-0 flex-col gap-6">
            <CodeBlock variant="inline" code={SDK_INSTALL} language="bash" label="the install command" />
            <CodeBlock code={SDK_QUICKSTART} language="ts" label="First dry run" filename="quickstart.ts" />
            <CodeBlock
              code={SDK_PLAN_AND_EXECUTE}
              language="ts"
              label="Plan and execute"
              filename="execute.ts"
              footer={
                <>
                  <code className="font-code">executeIntent</code> prepares each ready step, asks the wallet bound to that step to sign,
                  submits references for on-chain verification and waits for settlement before unlocking dependent steps.
                </>
              }
            />
            <div className="grid min-w-0 gap-4 md:grid-cols-2">
              <CodeBlock code={REST_STRUCTURED} language="json" label="Structured actions" filename="structured-intent.json" />
              <div className={cx("flex flex-col justify-center gap-3 p-5", INK_BORDER, SURFACE)}>
                <p className={LABEL}>Prefer a UI?</p>
                <p className={cx("text-sm", TEXT_MUTED)}>Intent Studio sends the same dry-run request and renders the returned graph step by step.</p>
                <ButtonLink to="/studio" variant="accent" size="sm" className="self-start">
                  Open Intent Studio
                </ButtonLink>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section aria-labelledby="fits-heading" className="flex min-w-0 flex-col gap-4 pt-14">
        <h2 id="fits-heading" className="font-display text-display-s font-bold">
          How it fits
        </h2>
        <figure className="m-0 min-w-0 max-w-4xl [container-type:inline-size]">
          <SpecSheet />
          <figcaption className={cx("mt-5 max-w-2xl font-code text-xs font-medium leading-relaxed", TEXT_MUTED)}>
            Drawing KL-INT-01. Yellow boxes are yours: your site, your server
            {HAS_CONTRACTS ? " and, when you need it, your contract" : ""}. Kletia never sits between the user and their keys.
          </figcaption>
        </figure>
      </section>
    </>
  );
}
