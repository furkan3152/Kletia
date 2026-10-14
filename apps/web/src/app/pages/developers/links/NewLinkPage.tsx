import type { ContractView } from "@kletia/core";
import type { ApiKeySummary, PolicyReadResponse } from "@kletia/sdk";

import { sdkSignal } from "../../../../shared/platform/kletiaClient";
import { useApiResource } from "../../../../shared/platform/useApiResource";
import { ButtonLink } from "../../../site/ui/Button";
import { cx, INK_BORDER, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { keyedClient } from "../keys/keyClient";
import { maskKey, portalKeyKind, useSessionKey } from "../keys/sessionKey";
import { KeyGate } from "../shell/KeyGate";
import { PortalPageHeader } from "../shell/PortalPageHeader";
import { LinkBuilder } from "./LinkBuilder";

function NewLinkForm() {
  const { key } = useSessionKey();
  const tag = maskKey(key);
  const developer = portalKeyKind(key) === "developer";
  const contracts = useApiResource<ContractView[]>(developer ? `links-contracts:${tag}` : null, (_client, signal) => keyedClient(key).contracts.list({}, { signal: sdkSignal(signal) }));
  const keys = useApiResource<ApiKeySummary[]>(developer ? `links-keys:${tag}` : null, (_client, signal) => keyedClient(key).keys.list({ signal: sdkSignal(signal) }));
  const currentId = keys.data?.find((item) => item.current)?.id ?? null;
  const policy = useApiResource<PolicyReadResponse>(developer && currentId ? `links-policy:${tag}:${currentId}` : null, (_client, signal) =>
    keyedClient(key).policies.get(currentId!, { signal: sdkSignal(signal) }),
  );

  if (!developer) {
    return (
      <div className={cx("flex flex-col items-start gap-3 p-5 sm:p-6", INK_BORDER, SURFACE)}>
        <p className="font-display text-title font-bold">This key cannot publish links here</p>
        <p className={cx("max-w-2xl text-sm", TEXT_MUTED)}>
          Publishing takes a developer key (kl_dev_), or an agent key whose rule book grants permissions.links (through the API or the CLI).
        </p>
        <ButtonLink to="/developers/links" size="sm" variant="secondary">
          Back to the links
        </ButtonLink>
      </div>
    );
  }
  const ruleBook = (policy.data?.effective?.chain.length ?? 0) > 0;
  return <LinkBuilder apiKey={key} contracts={contracts.data ?? null} ruleBook={ruleBook} keyId={currentId} onCreated={() => undefined} />;
}

/** New link (`/developers/links/new`): three templates, the live ticket preview, local checks, then the published link. */
export function NewLinkPage() {
  return (
    <>
      <PortalPageHeader
        title="New intent link"
        back={{ label: "Links", to: "/developers/links" }}
        intro="Choose what the link does and where the money goes. Visitors choose where it comes from and sign in their own wallet."
      />
      <KeyGate purpose="publish intent links" agentKeys>
        <NewLinkForm />
      </KeyGate>
    </>
  );
}
