/**
 * The deploy checklist (admin design C.1): per network, the catalog's targets
 * in order with their chips, the network profile (owner, guardian, treasury)
 * behind a step-up signature, and for each target the arguments, a preview
 * ticket, the wallet deploy, the wait for two confirmations and the server's
 * verification. A pending deploy survives a reload (sessionStorage).
 */
import { CHAINS } from "@kletia/core";
import { useQueryClient } from "@tanstack/react-query";
import { FileInput, Pencil, Rocket } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatEther, type Hex } from "viem";

import { readSessionStorage, removeSessionStorage, writeSessionStorage } from "../../../../shared/state/safeStorage";
import { Stamp } from "../../../site/art/Stamp";
import { Button } from "../../../site/ui/Button";
import { Card } from "../../../site/ui/Card";
import { SelectField, TextField } from "../../../site/ui/Field";
import { Skeleton } from "../../../site/ui/Skeleton";
import { StatusPill } from "../../../site/ui/StatusPill";
import { cx, LABEL, TEXT_MUTED } from "../../../site/ui/styles";
import { toast } from "../../../site/ui/toast";
import { AdminApiError } from "../api/adminClient";
import { useAdmin, useArtifact, useDeployments, useProfiles, useStepUp } from "../api/useAdmin";
import { AddressText } from "../components/AddressText";
import { errorText } from "../api/errors";
import { AdminError } from "../components/AdminError";
import { NetworkTabs } from "../components/NetworkTabs";
import { EmptyState, Panel, SectionHeader } from "../components/SectionHeader";
import { StepRow } from "../components/StepRow";
import { TxPreviewTicket } from "../components/TxPreviewTicket";
import { buildDeployData, eoaAckPhrase, resolveArgs, validateRoles, type ArgContext } from "../model/args";
import { CONFIRM_ACTIONS } from "../model/confirm";
import { ADMIN_PANEL_NETWORKS, isEvmNetwork, networkName, planFor, type PlanRow } from "../model/plan";
import { nameFor } from "../model/preview";
import type { AdminDeploymentRecord, AdminEvmNetwork, AdminNetworkProfile, AdminPanelNetwork } from "../model/types";

const PENDING_KEY = "kl-admin-pending";

interface PendingDeploy {
  readonly network: AdminEvmNetwork;
  readonly targetId: string;
  readonly txHash: string;
  readonly args: Readonly<Record<string, string>>;
}

function readPending(): PendingDeploy | null {
  try {
    const raw = readSessionStorage(PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingDeploy>;
    if (typeof parsed.network !== "string" || !isEvmNetwork(parsed.network) || typeof parsed.targetId !== "string" || typeof parsed.txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/u.test(parsed.txHash)) return null;
    return { network: parsed.network, targetId: parsed.targetId, txHash: parsed.txHash, args: parsed.args && typeof parsed.args === "object" ? parsed.args : {} };
  } catch {
    return null;
  }
}

function initialNetwork(): AdminPanelNetwork {
  const pending = readPending();
  if (pending) return pending.network;
  const focus = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("focus");
  return ADMIN_PANEL_NETWORKS.includes(focus as AdminPanelNetwork) ? (focus as AdminPanelNetwork) : "base";
}

/** Records a deploy, retrying while the API waits for confirmations (409 ADMIN_TX_PENDING). */
async function recordWithRetry(record: () => Promise<AdminDeploymentRecord>): Promise<AdminDeploymentRecord> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await record();
    } catch (error) {
      if (error instanceof AdminApiError && error.code === "ADMIN_TX_PENDING" && attempt < 6) {
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        continue;
      }
      throw error;
    }
  }
}

export function DeploySection() {
  const { catalog } = useAdmin();
  const deployments = useDeployments();
  const profiles = useProfiles();
  const [network, setNetwork] = useState<AdminPanelNetwork>(initialNetwork);
  const [active, setActive] = useState<string | null>(() => readPending()?.targetId ?? null);
  const records = deployments.data?.records ?? [];
  const plan = catalog ? planFor(network, catalog, records) : null;
  const profile = profiles.data?.find((item) => item.network === network) ?? null;

  return (
    <div className="flex flex-col gap-8">
      <SectionHeader
        icon="route"
        eyebrow="Deploy"
        title="Deploy, step by step"
        intro="Pick a network, check its roles, then deploy each target in order with the EVM admin wallet. The API verifies every deploy from chain data before it counts."
      />
      <NetworkTabs networks={ADMIN_PANEL_NETWORKS} value={network} onChange={(next) => { setNetwork(next); setActive(null); }} label="Network" idBase="admin-deploy" />
      <div id="admin-deploy-panel" role="tabpanel" aria-labelledby={`admin-deploy-tab-${network}`} className="flex flex-col gap-8">
        {deployments.error ? <AdminError error={deployments.error} title="The deployments could not load" onRetry={() => void deployments.refetch()} /> : null}
        {!plan ? <Skeleton className="h-64" surface="card" /> : null}
        {plan?.kind === "no-programs" ? <EmptyState>{plan.message}</EmptyState> : null}
        {plan?.kind === "evm" ? (
          <>
            <ProfileCard network={plan.network} testnet={plan.testnet} profile={profile} loading={profiles.isLoading} />
            {!plan.testnet ? (
              <p className="border-l-[4px] border-[#B45309] bg-warning-bg px-3 py-2 text-sm font-semibold text-warning">
                Production policy (DEPLOYMENT.md): a router, factory or registry on a mainnet is owned by a Safe, with a distinct guardian and treasury. An EOA owner needs the typed acknowledgement in the profile and is recorded as such.
              </p>
            ) : (
              <StatusPill tone="info">Testnet: roles may repeat, deploys cost test gas only</StatusPill>
            )}
            {plan.network !== "base" ? (
              <p className={cx("text-sm", TEXT_MUTED)}>A deployment here is prepared, not wired: the product keeps using pinned addresses until the lead pins the exported record in a release.</p>
            ) : null}
            <ol className="kl-admin__steps flex flex-col gap-4" aria-label={`Deploy checklist for ${networkName(plan.network)}`}>
              {plan.rows.map((row, index) => (
                <StepRow
                  key={row.target.id}
                  n={index + 1}
                  title={row.title}
                  chip={row.chip}
                  detail={row.detail}
                  muted={row.deploy === null}
                  actions={
                    row.deploy ? (
                      <Button variant={row.deploy === "deploy" ? "primary" : "secondary"} size="sm" onClick={() => setActive(active === row.target.id ? null : row.target.id)} aria-expanded={active === row.target.id}>
                        <Rocket className="h-4 w-4" aria-hidden="true" />
                        {active === row.target.id ? "Close" : row.deploy === "deploy" ? "Prepare deploy" : "Deploy a replacement"}
                      </Button>
                    ) : null
                  }
                >
                  {row.target.postDeploy.length > 0 ? (
                    <div className="flex flex-col gap-1">
                      <p className={cx(LABEL, TEXT_MUTED)}>After deploy</p>
                      <ul className="flex flex-col gap-1 text-sm">
                        {row.target.postDeploy.map((step) => (
                          <li key={step.id} className="flex items-center gap-2">
                            <span aria-hidden="true">→</span>
                            {step.label} <code className="font-code text-[13px]">{step.fn}</code> (owner action, in Manage)
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {active === row.target.id ? <DeployFlow row={row} profile={profile} testnet={plan.testnet} records={records} /> : null}
                </StepRow>
              ))}
            </ol>
            <ImportPanel network={plan.network} rows={plan.rows} profile={profile} testnet={plan.testnet} records={records} />
          </>
        ) : null}
      </div>
    </div>
  );
}

/* ---------------- Network profile ---------------- */

function ProfileCard({ network, testnet, profile, loading }: { readonly network: AdminEvmNetwork; readonly testnet: boolean; readonly profile: AdminNetworkProfile | null; readonly loading: boolean }) {
  const { client, catalog, book, ops } = useAdmin();
  const stepUp = useStepUp();
  const queryClient = useQueryClient();
  const defaults = catalog?.constants[network]?.defaultRoles;
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ owner: "", guardian: "", treasury: "" });
  const [ack, setAck] = useState("");
  const [codeCheck, setCodeCheck] = useState<{ readonly address: string; readonly hasCode: boolean | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const ownerInput = form.owner.trim();
  const ownerHasCode = codeCheck && codeCheck.address === ownerInput ? codeCheck.hasCode : null;
  const [error, setError] = useState<string | null>(null);

  const current = {
    owner: profile?.owner ?? defaults?.owner ?? null,
    guardian: profile?.guardian ?? defaults?.guardian ?? null,
    treasury: profile?.treasury ?? defaults?.treasury ?? null,
  };
  const check = validateRoles(form, { testnet, wrappedNative: catalog?.constants[network]?.wrappedNative, ownerHasCode });
  const phrase = eoaAckPhrase(networkName(network));
  const ackOk = !check.needsEoaAck || ack.trim() === phrase;

  useEffect(() => {
    if (!editing || !/^0x[0-9a-fA-F]{40}$/u.test(ownerInput)) return undefined;
    let live = true;
    ops
      .publicClient(network)
      .getCode({ address: ownerInput as Hex })
      .then((code: Hex | undefined) => live && setCodeCheck({ address: ownerInput, hasCode: Boolean(code && code !== "0x") }))
      .catch(() => live && setCodeCheck({ address: ownerInput, hasCode: null }));
    return () => {
      live = false;
    };
  }, [editing, ownerInput, network, ops]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const body = {
        owner: form.owner.trim(),
        guardian: form.guardian.trim(),
        treasury: form.treasury.trim(),
        eoaOwnerAcknowledged: check.needsEoaAck ? true : Boolean(profile?.eoaOwnerAcknowledged && ownerHasCode === false),
      };
      const confirmation = await stepUp(CONFIRM_ACTIONS.profile, body, network);
      await client.saveProfile(network, { ...body, confirmation });
      await queryClient.invalidateQueries({ queryKey: ["admin", "profiles"] });
      toast.success(`Roles saved for ${networkName(network)}`);
      setEditing(false);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card padded className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-display text-xl font-bold">Roles on {networkName(network)}</h2>
          <p className={cx("text-sm", TEXT_MUTED)}>
            {profile?.updatedAt ? `Saved ${profile.updatedAt.slice(0, 10)} by ${profile.updatedBy ?? "an admin"}.` : defaults ? "Defaults from the repository (the Base Safes)." : "Not set yet: deploys that need a role wait for it."}
          </p>
        </div>
        {!editing ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setForm({ owner: current.owner ?? "", guardian: current.guardian ?? "", treasury: current.treasury ?? "" });
              setAck("");
              setEditing(true);
            }}
          >
            <Pencil className="h-4 w-4" aria-hidden="true" />
            Edit roles
          </Button>
        ) : null}
      </div>
      {loading ? <Skeleton className="h-20" surface="card" /> : null}
      {!editing && !loading ? (
        <dl className="grid gap-3 sm:grid-cols-3">
          {(["owner", "guardian", "treasury"] as const).map((role) => (
            <div key={role} className="min-w-0">
              <dt className={cx(LABEL, TEXT_MUTED)}>{role}</dt>
              <dd className="mt-1 min-w-0">{current[role] ? <AddressText address={current[role]} network={network} book={book} /> : <span className={TEXT_MUTED}>Not set</span>}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {editing ? (
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (check.errors.length === 0 && ackOk) void save();
          }}
        >
          <div className="grid gap-4 md:grid-cols-3">
            {(["owner", "guardian", "treasury"] as const).map((role) => (
              <TextField
                key={role}
                label={role}
                mono
                value={form[role]}
                onChange={(event) => setForm((value) => ({ ...value, [role]: event.target.value }))}
                hint={nameFor(book, form[role].trim()) ?? (role === "owner" && ownerHasCode === false ? "A plain wallet (no code)." : role === "owner" && ownerHasCode ? "A contract (a Safe or similar)." : undefined)}
                autoComplete="off"
                spellCheck={false}
              />
            ))}
          </div>
          {check.errors.length > 0 || check.warnings.length > 0 ? (
            <ul className="flex flex-col gap-1.5 text-sm">
              {check.errors.map((line) => (
                <li key={line} className="border-l-[4px] border-[#B91C1C] bg-danger-bg px-3 py-1.5 font-semibold text-danger">
                  {line}
                </li>
              ))}
              {check.warnings.map((line) => (
                <li key={line} className="border-l-[4px] border-[#B45309] bg-warning-bg px-3 py-1.5 font-semibold text-warning">
                  {line}
                </li>
              ))}
            </ul>
          ) : null}
          {check.needsEoaAck ? <TextField label={`Type "${phrase}" to accept it`} value={ack} onChange={(event) => setAck(event.target.value)} autoComplete="off" /> : null}
          {error ? (
            <p role="alert" className="text-sm font-bold text-danger">
              {error}
            </p>
          ) : null}
          <p className={cx("text-sm", TEXT_MUTED)}>Saving asks the wallet that holds this session to sign a confirmation bound to these three addresses.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" loading={saving} disabled={check.errors.length > 0 || !ackOk}>
              Sign and save
            </Button>
            <Button variant="secondary" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </Card>
  );
}

/* ---------------- One deploy ---------------- */

type Phase =
  | { readonly step: "idle" }
  | { readonly step: "sending" }
  | { readonly step: "waiting"; readonly txHash: string }
  | { readonly step: "recording"; readonly txHash: string }
  | { readonly step: "done"; readonly record: AdminDeploymentRecord }
  | { readonly step: "error"; readonly message: string; readonly txHash?: string };

function DeployFlow({ row, profile, testnet, records }: { readonly row: PlanRow; readonly profile: AdminNetworkProfile | null; readonly testnet: boolean; readonly records: readonly AdminDeploymentRecord[] }) {
  const { client, catalog, signer, book, ops } = useAdmin();
  const queryClient = useQueryClient();
  const network = row.target.network;
  const spec = row.spec;
  const artifact = useArtifact(spec?.artifactId ?? null);
  const [literals, setLiterals] = useState<Record<string, string>>({});
  const [estimated, setEstimated] = useState<{ readonly key: string; readonly result: { gas: bigint; fee: bigint } | { error: string } } | null>(null);
  const [eoaCheck, setEoaCheck] = useState<{ readonly address: string; readonly eoa: boolean | null } | null>(null);
  const [phase, setPhase] = useState<Phase>({ step: "idle" });
  const signerAddress = signer.ready ? signer.address : null;

  const context: ArgContext = {
    network,
    testnet,
    profile,
    constants: catalog?.constants[network],
    records,
    pinned: catalog?.pinned ?? [],
    signer: signerAddress,
    literals,
  };
  const resolved = resolveArgs(spec?.constructorInputs ?? [], context);
  const valuesKey = JSON.stringify(resolved.values);
  const deployData = useMemo(() => {
    if (!resolved.ready || !artifact.data?.bytecode) return null;
    try {
      return { data: buildDeployData(artifact.data.abi, artifact.data.bytecode, resolved.values), error: null };
    } catch (error) {
      return { data: null, error: error instanceof Error ? error.message : "The deploy data could not be built." };
    }
    // valuesKey stands for resolved.values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifact.data, resolved.ready, valuesKey]);

  const ownerArg = spec?.constructorInputs.find((input) => input.source.kind === "role" && input.source.role === "owner");
  const ownerValue = ownerArg ? resolved.values[ownerArg.name] : undefined;

  const ownerIsEoa = !testnet && ownerValue && eoaCheck?.address === ownerValue ? eoaCheck.eoa : null;
  useEffect(() => {
    if (!ownerValue || testnet) return undefined;
    let live = true;
    ops
      .publicClient(network)
      .getCode({ address: ownerValue as Hex })
      .then((code: Hex | undefined) => live && setEoaCheck({ address: ownerValue, eoa: !code || code === "0x" }))
      .catch(() => live && setEoaCheck({ address: ownerValue, eoa: null }));
    return () => {
      live = false;
    };
  }, [network, ops, ownerValue, testnet]);

  const estimateKey = deployData?.data && signerAddress ? `${signerAddress}:${deployData.data}` : null;
  const estimate = estimated && estimated.key === estimateKey ? estimated.result : null;
  useEffect(() => {
    if (!estimateKey || !deployData?.data || !signerAddress) return undefined;
    let live = true;
    const reader = ops.publicClient(network);
    Promise.all([reader.estimateGas({ account: signerAddress as Hex, data: deployData.data }), reader.getGasPrice()])
      .then(([gas, price]) => live && setEstimated({ key: estimateKey, result: { gas, fee: gas * price } }))
      .catch((error: unknown) => live && setEstimated({ key: estimateKey, result: { error: errorText(error) } }));
    return () => {
      live = false;
    };
  }, [deployData?.data, estimateKey, network, ops, signerAddress]);

  // Resume a deploy sent before a reload.
  useEffect(() => {
    const pending = readPending();
    if (pending && pending.targetId === row.target.id && phase.step === "idle") void finish(pending.txHash as Hex, pending.args);
    // Runs once per opened target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.target.id]);

  const eoaBlocked = !testnet && ownerIsEoa === true && !profile?.eoaOwnerAcknowledged;
  const blocked = !signer.ready
    ? signer.reason
    : !resolved.ready
      ? resolved.blocked
      : artifact.error
        ? "The artifact could not load."
        : artifact.data && !artifact.data.bytecode
          ? "This artifact carries no bytecode: it is not deployable from the panel."
          : deployData?.error
            ? deployData.error
            : eoaBlocked
              ? `The owner is a plain wallet. Accept an EOA owner on ${networkName(network)} in the roles above first.`
              : null;

  async function finish(txHash: Hex, args: Readonly<Record<string, string>>) {
    try {
      setPhase({ step: "waiting", txHash });
      const receipt = await ops.waitReceipt(network, txHash, 2);
      if (receipt.status !== "success") throw new Error("The deploy transaction reverted on-chain.");
      setPhase({ step: "recording", txHash });
      const record = await recordWithRetry(() => client.recordDeployment({ targetId: row.target.id, txHash, constructorArgs: args }));
      removeSessionStorage(PENDING_KEY);
      setPhase({ step: "done", record });
      void queryClient.invalidateQueries({ queryKey: ["admin", "deployments"] });
      void queryClient.invalidateQueries({ queryKey: ["admin", "overview"] });
      if (record.status === "verified") toast.success(`${row.title} verified on ${networkName(network)}`);
      else toast.warning(`${row.title} was recorded, but some checks failed`);
    } catch (error) {
      setPhase({ step: "error", message: errorText(error), txHash });
    }
  }

  const deploy = async () => {
    if (!deployData?.data || blocked) return;
    setPhase({ step: "sending" });
    try {
      const txHash = await ops.sendDeploy(network, deployData.data);
      writeSessionStorage(PENDING_KEY, JSON.stringify({ network, targetId: row.target.id, txHash, args: resolved.values } satisfies PendingDeploy));
      await finish(txHash, resolved.values);
    } catch (error) {
      setPhase({ step: "error", message: errorText(error) });
    }
  };

  const symbol = CHAINS[network]?.nativeAsset.symbol ?? "ETH";
  const sizeBytes = deployData?.data ? (deployData.data.length - 2) / 2 : null;

  return (
    <div className="flex flex-col gap-4 border-t-2 border-dashed border-[#1A1A1A]/25 pt-4 dark:border-white/15">
      {spec && spec.constructorInputs.some((input) => input.source.kind === "literal" && input.source.editable) ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {spec.constructorInputs.map((input) =>
            input.source.kind === "literal" && input.source.editable ? (
              <TextField
                key={input.name}
                label={input.label}
                value={literals[input.name] ?? input.source.value}
                onChange={(event) => setLiterals((value) => ({ ...value, [input.name]: event.target.value }))}
                hint={[input.source.min !== undefined ? `min ${input.source.min}` : null, input.source.max !== undefined ? `max ${input.source.max}` : null].filter(Boolean).join(", ") || undefined}
                inputMode={input.type === "string" ? "text" : "numeric"}
              />
            ) : null,
          )}
        </div>
      ) : null}
      {artifact.isLoading ? <Skeleton className="h-40" surface="card" /> : null}
      {artifact.error ? <AdminError error={artifact.error} title="The artifact could not load" onRetry={() => void artifact.refetch()} /> : null}
      {spec ? (
        <TxPreviewTicket
          label={`Deploy preview for ${row.title}`}
          icon="contract"
          title="Contract deploy"
          serial={row.target.id.toUpperCase().replace(/[^A-Z0-9]+/gu, "-").slice(0, 18)}
          headline={`new ${spec.name}(${(spec.constructorInputs.map((input) => input.name)).join(", ")})`}
          lines={resolved.args.map((arg) => ({
            label: arg.input.label,
            value: arg.ok ? arg.value : `Missing: ${arg.reason}`,
            note: arg.ok ? nameFor(book, arg.value) ?? (arg.origin === "default-role" ? "Repository default" : null) : null,
          }))}
          warnings={[
            ...(!testnet && ownerIsEoa ? ["EOA owner: recorded as ownerKind eoa. Move ownership to a Safe later."] : []),
            ...(row.deploy === "replace" ? ["A replacement is not wired: the product keeps the pinned address until the lead pins this one."] : []),
          ]}
          fields={[
            { label: "Network", value: networkName(network) },
            { label: "Deployer", value: signerAddress ? `${signerAddress.slice(0, 6)}…${signerAddress.slice(-4)}` : "Not connected" },
            { label: "Init code", value: sizeBytes ? `${sizeBytes.toLocaleString("en-US")} bytes` : "…" },
            {
              label: "Est. fee",
              value: estimate && "fee" in estimate ? `${Number(formatEther(estimate.fee)).toPrecision(3)} ${symbol}` : estimate && "error" in estimate ? "No estimate" : "…",
            },
            { label: "Compiler", value: artifact.data ? `solc ${artifact.data.compiler.solc}, ${artifact.data.compiler.optimizer ? `${artifact.data.compiler.runs} runs` : "no optimizer"}, ${artifact.data.compiler.evmVersion}` : "…" },
          ]}
          stubTitle="Deploy with wallet"
          stubBody={<>One contract creation from the connected EVM wallet, then two confirmations and the API's checks.</>}
        />
      ) : null}
      {estimate && "error" in estimate ? <p className="text-sm font-semibold text-warning">Gas estimate failed: {estimate.error} The deploy would likely revert.</p> : null}
      {blocked ? <p className="border-l-[4px] border-[#B45309] bg-warning-bg px-3 py-2 text-sm font-semibold text-warning">{blocked}</p> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="accent" onClick={() => void deploy()} disabled={Boolean(blocked) || phase.step === "sending" || phase.step === "waiting" || phase.step === "recording"} loading={phase.step === "sending"}>
          <Rocket className="h-4 w-4" aria-hidden="true" />
          Deploy with wallet
        </Button>
        <PhaseLine phase={phase} network={network} />
      </div>
      {phase.step === "done" ? (
        <div className="flex flex-wrap items-start gap-4 border-[3px] border-control bg-surface-2 p-4">
          <Stamp state={phase.record.status === "verified" ? "settled" : "failed"} detail={phase.record.status === "verified" ? "VERIFIED" : "CHECKS FAILED"} className="h-20 w-auto" labelled />
          <div className="flex min-w-0 flex-col gap-1 text-sm">
            <p className="font-bold">{phase.record.status === "verified" ? "Deployed and verified." : "Deployed; some checks failed."}</p>
            <AddressText address={phase.record.address} network={network} full />
            <ul className="mt-1 flex flex-col gap-0.5">
              {phase.record.checks.filter((check) => !check.ok).map((check) => (
                <li key={check.id} className="text-danger">
                  <span className="font-code font-bold">{check.id}</span> {check.detail}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PhaseLine({ phase, network }: { readonly phase: Phase; readonly network: AdminEvmNetwork }) {
  if (phase.step === "idle") return null;
  if (phase.step === "sending") return <span className={cx("text-sm font-semibold", TEXT_MUTED)} role="status">Confirm in your wallet…</span>;
  if (phase.step === "waiting" || phase.step === "recording") {
    return (
      <span className="flex flex-wrap items-center gap-2 text-sm font-semibold" role="status">
        {phase.step === "waiting" ? "Waiting for two confirmations" : "The API is verifying the deploy"}
        <AddressText address={phase.txHash} network={network} tx />
      </span>
    );
  }
  if (phase.step === "error") {
    return (
      <span role="alert" className="flex flex-wrap items-center gap-2 text-sm font-bold text-danger">
        {phase.message}
        {phase.txHash ? <AddressText address={phase.txHash} network={network} tx /> : null}
      </span>
    );
  }
  return null;
}

/* ---------------- Import by transaction hash ---------------- */

function ImportPanel({ network, rows, profile, testnet, records }: { readonly network: AdminEvmNetwork; readonly rows: readonly PlanRow[]; readonly profile: AdminNetworkProfile | null; readonly testnet: boolean; readonly records: readonly AdminDeploymentRecord[] }) {
  const { client, catalog, signer } = useAdmin();
  const queryClient = useQueryClient();
  const options = rows.filter((row) => row.deploy !== null);
  const [targetId, setTargetId] = useState(options[0]?.target.id ?? "");
  const [txHash, setTxHash] = useState("");
  const [literals, setLiterals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AdminDeploymentRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const row = options.find((item) => item.target.id === targetId) ?? options[0] ?? null;
  if (!row || !row.spec) return null;
  const resolved = resolveArgs(row.spec.constructorInputs, {
    network,
    testnet,
    profile,
    constants: catalog?.constants[network],
    records,
    pinned: catalog?.pinned ?? [],
    signer: signer.ready ? signer.address : null,
    literals,
  });
  const hashOk = /^0x[0-9a-fA-F]{64}$/u.test(txHash.trim());

  return (
    <Panel title="Import by transaction hash">
      <p className={cx("text-sm", TEXT_MUTED)}>For a deploy made outside the panel (Hardhat, another wallet): the API runs the same checks against the transaction, and records whoever deployed it.</p>
      <form
        className="grid gap-4 md:grid-cols-2"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!hashOk || !resolved.ready) return;
          setBusy(true);
          setError(null);
          setResult(null);
          try {
            const record = await client.recordDeployment({ targetId: row.target.id, txHash: txHash.trim(), constructorArgs: resolved.values, import: true });
            setResult(record);
            void queryClient.invalidateQueries({ queryKey: ["admin", "deployments"] });
          } catch (failure) {
            setError(errorText(failure));
          } finally {
            setBusy(false);
          }
        }}
      >
        <SelectField label="Target" value={row.target.id} onChange={(event) => setTargetId(event.target.value)} options={options.map((item) => ({ value: item.target.id, label: item.title }))} />
        <TextField label="Transaction hash" mono value={txHash} onChange={(event) => setTxHash(event.target.value)} placeholder="0x…" error={txHash && !hashOk ? "A transaction hash is 0x and 64 hex digits." : undefined} autoComplete="off" spellCheck={false} />
        {row.spec.constructorInputs.filter((input) => input.source.kind === "literal" && input.source.editable).map((input) => (
          <TextField key={input.name} label={input.label} value={literals[input.name] ?? (input.source.kind === "literal" ? input.source.value : "")} onChange={(event) => setLiterals((value) => ({ ...value, [input.name]: event.target.value }))} />
        ))}
        <div className="flex flex-col gap-2 md:col-span-2">
          {!resolved.ready ? <p className="text-sm font-semibold text-warning">{resolved.blocked}</p> : null}
          {error ? (
            <p role="alert" className="text-sm font-bold text-danger">
              {error}
            </p>
          ) : null}
          {result ? (
            <p role="status" className="text-sm font-bold">
              Recorded: {result.status === "verified" ? "verified" : "checks failed"} at {result.address}.
            </p>
          ) : null}
          <Button type="submit" variant="secondary" className="self-start" loading={busy} disabled={!hashOk || !resolved.ready}>
            <FileInput className="h-4 w-4" aria-hidden="true" />
            Import and verify
          </Button>
        </div>
      </form>
    </Panel>
  );
}
