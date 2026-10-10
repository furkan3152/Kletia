import { POLICY_LIMITS, POLICY_TEMPLATES, policyFromTemplate, type ContractView, type PolicyTemplateId } from "@kletia/core";
import type { ApiKeySummary, CreatedChildKey } from "@kletia/sdk";
import { Bot, ShieldX, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";

import { sdkSignal } from "../../../../shared/platform/kletiaClient";
import { useApiAction } from "../../../../shared/platform/useApiResource";
import { ApiErrorPanel } from "../../../site/ui/ApiErrorPanel";
import { Button } from "../../../site/ui/Button";
import { SelectField, TextAreaField, TextField } from "../../../site/ui/Field";
import { cx, HARD_SHADOW, INK_BORDER, INK_BORDER_THIN, LABEL, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { keyedClient } from "../keys/keyClient";
import { SecretReveal, type Secret } from "../keys/KeyManager";
import { useSessionKey } from "../keys/sessionKey";
import { formatWhen, splitLines } from "../portal/portalFormat";
import { AGENT_EXPIRY_OPTIONS, findNode, subtreeKeys, type TreeNode } from "./policyModel";

const NAME_PATTERN = /^[\w .:-]{1,64}$/u;

export interface AgentKeyFormProps {
  readonly apiKey: string;
  readonly keys: readonly ApiKeySummary[];
  readonly tree: readonly TreeNode<ApiKeySummary>[];
  readonly contracts: readonly ContractView[] | null;
  /** The station selected on the tree (the default parent). */
  readonly selected: string;
  readonly onChanged: (message: string) => void;
}

/**
 * Agent keys (`kl_agt_…`): issue one under a key with an expiry and a first
 * rule book from a template (the secret is shown once), or revoke a key and
 * its whole subtree.
 */
export function AgentKeyForm({ apiKey, keys, tree, contracts, selected, onChanged }: AgentKeyFormProps) {
  const { setKey } = useSessionKey();
  const parents = keys.filter((key) => !key.revokedAt && (key.depth ?? 0) < POLICY_LIMITS.maxAgentDepth);
  const [parentId, setParentId] = useState(() => (parents.some((key) => key.id === selected) ? selected : parents[0]?.id ?? ""));
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState("2592000");
  const [template, setTemplate] = useState<PolicyTemplateId>("observer");
  const [accounts, setAccounts] = useState("");
  const [recipients, setRecipients] = useState("");
  const [wallets, setWallets] = useState("");
  const [contractIds, setContractIds] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);
  const [secret, setSecret] = useState<Secret | null>(null);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const create = useApiAction((_client, signal, parent: string, body: Parameters<ReturnType<typeof keyedClient>["keys"]["createChild"]>[1]) =>
    keyedClient(apiKey).keys.createChild(parent, body, { signal: sdkSignal(signal) }),
  );
  const revoke = useApiAction((_client, signal, id: string) => keyedClient(apiKey).keys.revoke(id, { signal: sdkSignal(signal) }).then(() => id));

  const info = POLICY_TEMPLATES[template];
  const fill = {
    ...(info.fill.includes("accounts.allow") && splitLines(accounts, { commas: true }).length > 0 ? { accounts: splitLines(accounts, { commas: true }) } : {}),
    ...(info.fill.includes("recipients.allow") && splitLines(recipients, { commas: true }).length > 0 ? { recipients: splitLines(recipients, { commas: true }) } : {}),
    ...(info.fill.includes("confirm.approvers.wallets") && splitLines(wallets, { commas: true }).length > 0 ? { approverWallets: splitLines(wallets, { commas: true }) } : {}),
    ...(info.fill.includes("contracts.allow") && contractIds.length > 0 ? { contracts: contractIds.map((id) => ({ id })) } : {}),
  };
  const preview = policyFromTemplate(template, fill);
  const nameOk = NAME_PATTERN.test(name.trim());
  const parent = parents.find((key) => key.id === parentId);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!nameOk || !parent || !preview.ok) return;
    setSecret(null);
    const created: CreatedChildKey | undefined = await create.run(parent.id, { name: name.trim(), expiresInSeconds: Number(expiry), template, ...(Object.keys(fill).length > 0 ? { fill } : {}) });
    if (created?.key.key) {
      setSecret({ kind: "agent", id: created.key.id, name: created.key.name, key: created.key.key, expiresAt: created.key.expiresAt });
      setName("");
      onChanged(`Agent key ${created.key.name} issued under ${parent.name}, rule book edition ${created.policy.version}.`);
    }
  };

  const revokeNode = revokeId ? findNode(tree, revokeId) : null;
  const cascade = revokeNode ? subtreeKeys(revokeNode) : [];
  const doRevoke = async () => {
    if (!revokeNode) return;
    const done = await revoke.run(revokeNode.key.id);
    if (done) {
      setRevokeId(null);
      onChanged(`${revokeNode.key.name} was revoked${cascade.length > 0 ? `, and with it ${cascade.map((key) => key.name).join(", ")}` : ""}.`);
    }
  };
  const agents = keys.filter((key) => key.kind === "agent" && !key.revokedAt);

  return (
    <div className="grid min-w-0 gap-6 2xl:grid-cols-2 2xl:items-start">
      <form onSubmit={submit} noValidate className={cx("flex min-w-0 flex-col gap-4 p-4 sm:p-5", INK_BORDER, HARD_SHADOW, SURFACE)}>
        <p className="flex items-center gap-2 font-display text-xl font-bold">
          <Bot className="h-5 w-5" aria-hidden="true" />
          Issue an agent key
        </p>
        <p className={cx("text-sm", TEXT_MUTED)}>
          An agent key always expires, never manages project keys, never writes or approves rule books, and is checked against every rule book above it.
        </p>
        <SelectField
          label="Under"
          value={parentId}
          onChange={(event) => setParentId(event.target.value)}
          options={parents.map((key) => ({ value: key.id, label: `${key.name} (${key.kind === "agent" ? `agent, level ${key.depth}` : "project key"})` }))}
          hint="At most two levels of agent keys below a project key."
        />
        <TextField
          label="Name"
          value={name}
          maxLength={64}
          onChange={(event) => setName(event.target.value)}
          placeholder="payouts-bot"
          autoComplete="off"
          error={touched && !nameOk ? "Use 1-64 letters, numbers, spaces, dots, colons, dashes or underscores." : undefined}
        />
        <SelectField
          label="Expires after"
          value={expiry}
          onChange={(event) => setExpiry(event.target.value)}
          options={AGENT_EXPIRY_OPTIONS}
          hint={parent?.expiresAt ? `Never later than its parent (${formatWhen(parent.expiresAt)}).` : undefined}
        />
        <SelectField
          label="First rule book"
          value={template}
          onChange={(event) => setTemplate(event.target.value as PolicyTemplateId)}
          options={Object.values(POLICY_TEMPLATES).map((entry) => ({ value: entry.id, label: entry.title }))}
          hint={info.summary}
        />
        {info.fill.includes("accounts.allow") ? (
          <TextAreaField label="Accounts it may spend from" mono rows={2} value={accounts} onChange={(event) => setAccounts(event.target.value)} placeholder="eip155:*:0x4f18…" hint="CAIP-10 patterns, one per line." spellCheck={false} />
        ) : null}
        {info.fill.includes("recipients.allow") ? (
          <TextAreaField label="Recipients it may pay" mono rows={2} value={recipients} onChange={(event) => setRecipients(event.target.value)} placeholder="eip155:8453:0x1111…" spellCheck={false} />
        ) : null}
        {info.fill.includes("confirm.approvers.wallets") ? (
          <TextAreaField label="Wallets that approve held intents" mono rows={2} value={wallets} onChange={(event) => setWallets(event.target.value)} placeholder="eip155:8453:0x9a…" spellCheck={false} />
        ) : null}
        {info.fill.includes("contracts.allow") ? (
          <fieldset className="flex min-w-0 flex-col gap-1.5">
            <legend className={cx(LABEL, "mb-1")}>Contracts it may call</legend>
            {(contracts ?? []).length === 0 ? <p className={cx("text-sm", TEXT_MUTED)}>No registrations visible to the key in memory.</p> : null}
            {(contracts ?? []).map((contract) => (
              <label key={contract.id} className="inline-flex min-h-9 cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[#0052FF]"
                  checked={contractIds.includes(contract.id)}
                  onChange={(event) => setContractIds((current) => (event.target.checked ? [...current, contract.id] : current.filter((id) => id !== contract.id)))}
                />
                <span className="min-w-0 break-words">{contract.integrator.name}</span>
                <code className={cx("font-code text-[11px]", TEXT_MUTED)}>{contract.id}</code>
              </label>
            ))}
          </fieldset>
        ) : null}
        {!preview.ok ? (
          <ul className="flex flex-col gap-1" aria-label="Rule book issues">
            {preview.issues.map((issue, index) => (
              <li key={`${issue.path}-${index}`} className="text-xs font-bold text-[#B91C1C] dark:text-[#FCA5A5]">
                {issue.path}: {issue.message}
              </li>
            ))}
          </ul>
        ) : preview.warnings.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {preview.warnings.map((warning) => (
              <li key={warning.code} className="text-xs font-bold text-[#92400E] dark:text-[#FBBF24]">
                Warning: {warning.message}
              </li>
            ))}
          </ul>
        ) : null}
        <Button type="submit" loading={create.status === "loading"} disabled={!parent} className="self-start">
          <Bot className="h-4 w-4" aria-hidden="true" />
          Issue agent key
        </Button>
        <p className={cx("text-xs", TEXT_MUTED)}>
          Calls <code className="font-code">POST /v1/keys/{"{id}"}/children</code> with an Idempotency-Key. A project holds at most {POLICY_LIMITS.agentKeysPerProject} active agent keys.
        </p>
        <div aria-live="polite" className="flex flex-col gap-3">
          {secret ? <SecretReveal secret={secret} onUse={() => setKey(secret.key)} onDone={() => setSecret(null)} /> : null}
          {create.status === "error" && create.error ? <ApiErrorPanel error={create.error} title="Could not issue the agent key" /> : null}
        </div>
      </form>

      <div className={cx("flex min-w-0 flex-col gap-4 p-4 sm:p-5", INK_BORDER, SURFACE)}>
        <p className="font-display text-xl font-bold">Agent keys</p>
        {agents.length === 0 ? (
          <p className={cx("text-sm", TEXT_MUTED)}>No agent keys yet.</p>
        ) : (
          <ul className={cx("divide-y-2 divide-[#1A1A1A]/10 dark:divide-white/10", INK_BORDER_THIN)}>
            {agents.map((agent) => {
              const node = findNode(tree, agent.id);
              const below = node ? subtreeKeys(node) : [];
              return (
                <li key={agent.id} className="flex min-w-0 flex-wrap items-start justify-between gap-3 p-3">
                  <div className="min-w-0">
                    <p className="break-words font-bold">{agent.name}</p>
                    <p className={cx("break-all font-code text-[11px]", TEXT_MUTED)}>
                      {agent.id} · level {agent.depth ?? 1} · expires {formatWhen(agent.expiresAt)}
                      {below.length > 0 ? ` · ${below.length} below it` : ""}
                    </p>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => setRevokeId(agent.id)} aria-label={`Revoke ${agent.name}`}>
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    Revoke
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        {revokeNode ? (
          <div className="kl-rise flex flex-col gap-3 border-[3px] border-[#B91C1C] bg-[#FFE4E4] p-3 text-[#1A1A1A] dark:border-[#7F1D1D] dark:bg-[#2A1215] dark:text-[#FEE2E2]">
            <p className="flex items-start gap-2 text-sm font-bold">
              <ShieldX className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>
                Revoke {revokeNode.key.name}? It stops at once here and within 15 seconds everywhere, and intents it created stop being prepared.
                {cascade.length > 0
                  ? ` Its whole subtree goes with it: ${cascade.map((key) => key.name).join(", ")} (${cascade.length} ${cascade.length === 1 ? "key" : "keys"}).`
                  : ""}{" "}
                This cannot be undone.
              </span>
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="ink" loading={revoke.status === "loading"} onClick={() => void doRevoke()}>
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                {cascade.length > 0 ? `Revoke ${cascade.length + 1} keys` : "Revoke the key"}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setRevokeId(null)}>
                Keep it
              </Button>
            </div>
          </div>
        ) : null}
        <div aria-live="polite">{revoke.status === "error" && revoke.error ? <ApiErrorPanel error={revoke.error} title="Could not revoke the key" /> : null}</div>
        <p className={cx("text-xs", TEXT_MUTED)}>Project keys are revoked in Keys and auth above; revoking one also revokes every agent key below it.</p>
      </div>
    </div>
  );
}
