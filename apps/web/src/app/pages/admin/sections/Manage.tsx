/**
 * Management: pick a pinned or recorded contract, read its state at one
 * block, then run a curated owner action or any other function of its
 * ABI, directly or as a Safe proposal. Every call is simulated and
 * previewed before the wallet prompt; renounceOwnership is never offered.
 */
import { CHAINS } from "@kletia/core";
import { ChevronDown, Play, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { encodeFunctionData, parseEther, type Abi } from "viem";

import { LineBullet } from "../../../site/art/LineBullet";
import { lineFor } from "../../../site/art/tokens";
import { Button } from "../../../site/ui/Button";
import { Card } from "../../../site/ui/Card";
import { SelectField, TextField } from "../../../site/ui/Field";
import { Skeleton } from "../../../site/ui/Skeleton";
import { StatusPill } from "../../../site/ui/StatusPill";
import { cx, FOCUS_RING, INK_BORDER_THIN, LABEL, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { toast } from "../../../site/ui/toast";
import { useAdmin, useAdminQuery, useArtifact, useDeployments } from "../api/useAdmin";
import { useOwnerCall } from "../api/useOwnerCall";
import { AddressText } from "../components/AddressText";
import { errorText } from "../api/errors";
import { AdminError } from "../components/AdminError";
import { ConfirmSheet } from "../components/ConfirmSheet";
import { OwnerBadge } from "../components/OwnerBadge";
import { EmptyState, Panel, SectionHeader } from "../components/SectionHeader";
import { TxPreviewTicket } from "../components/TxPreviewTicket";
import { formatTokenAmount, formatUsd } from "../model/fees";
import { networkName } from "../model/plan";
import { decodeCall, nameFor, OTHER_FUNCTION_NOTE, parseInput, transferOwnerProblems, writeFunctions, type WriteFunction } from "../model/preview";
import { actorFor, cannotActReason, sameAddress, type ActorMode } from "../model/session";
import type { AdminContractSpec, AdminContractState, AdminEvmNetwork } from "../model/types";

interface ContractOption {
  readonly key: string;
  readonly network: AdminEvmNetwork;
  readonly address: string;
  readonly contractId: AdminContractSpec["id"];
  readonly label: string;
}

function readFocus(): string | null {
  return typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("focus");
}

export function ManageSection() {
  const { catalog } = useAdmin();
  const deployments = useDeployments();
  const options = useMemo<ContractOption[]>(() => {
    if (!catalog) return [];
    const pinned = catalog.pinned.map((pin) => ({
      key: `pinned:${pin.network}:${pin.address}`,
      network: pin.network,
      address: pin.address,
      contractId: pin.contractId,
      label: `${catalog.contracts[pin.contractId]?.name ?? pin.contractId}${pin.lifecycle === "legacy" ? " (legacy)" : ""}`,
    }));
    const recorded = (deployments.data?.records ?? [])
      .filter((record) => record.status === "verified")
      .map((record) => ({ key: record.id, network: record.network, address: record.address, contractId: record.contractId, label: `${catalog.contracts[record.contractId]?.name ?? record.contractId} (new)` }));
    return [...recorded, ...pinned];
  }, [catalog, deployments.data]);
  const [selected, setSelected] = useState<string | null>(readFocus);
  const current = options.find((option) => option.key === selected) ?? options[0] ?? null;

  return (
    <div className="flex flex-col gap-8">
      <SectionHeader
        icon="key"
        eyebrow="Manage"
        title="Owner actions"
        intro="Read a contract's owner, roles and balances at one block, then act on it. Calls go out from the EVM admin wallet when it owns the contract, or as a Safe proposal when a Safe it co-owns does."
      />
      {!catalog ? <Skeleton className="h-16" surface="card" /> : null}
      {catalog && options.length === 0 ? <EmptyState>No contracts to manage yet.</EmptyState> : null}
      {current ? (
        <>
          <SelectField
            label="Contract"
            value={current.key}
            onChange={(event) => setSelected(event.target.value)}
            options={options.map((option) => ({ value: option.key, label: `${networkName(option.network)}: ${option.label} ${option.address.slice(0, 8)}…${option.address.slice(-4)}` }))}
            containerClassName="max-w-2xl"
          />
          <ContractPanel key={current.key} option={current} />
        </>
      ) : null}
    </div>
  );
}

function ContractPanel({ option }: { readonly option: ContractOption }) {
  const { catalog, signer, session, book } = useAdmin();
  const spec = catalog?.contracts[option.contractId] ?? null;
  const state = useAdminQuery(["state", option.key], (api) => api.contractState(option.key));
  const artifact = useArtifact(spec?.artifactId ?? null);
  const signerAddress = signer.ready ? signer.address : null;
  const actor: ActorMode = state.data ? actorFor(state.data, signerAddress) : "no";
  const groups = useMemo(() => (artifact.data && spec ? writeFunctions(artifact.data.abi, spec.actions, spec.ownerModel) : null), [artifact.data, spec]);
  const [showOther, setShowOther] = useState(false);
  const line = lineFor(option.network);

  return (
    <div className="flex flex-col gap-6">
      <Card className="flex flex-col gap-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-sm font-bold">
              {line ? <LineBullet line={line} decorative /> : null}
              {networkName(option.network)}
            </p>
            <h2 className="mt-1 font-display text-2xl font-bold">{spec?.name ?? option.contractId}</h2>
            <AddressText address={option.address} network={option.network} full className="mt-1" />
          </div>
          <div className="flex flex-col items-end gap-2">
            {state.data ? (
              <StatusPill tone={state.data.codeMatches === false ? "danger" : state.data.codeMatches ? "success" : "neutral"}>
                {state.data.codeMatches === false ? "Code differs from the artifact" : state.data.codeMatches ? "Code matches" : "Code not checked"}
              </StatusPill>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => void state.refetch()} loading={state.isFetching}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Read again
            </Button>
          </div>
        </div>
        {state.error ? <AdminError error={state.error} title="The contract state could not be read" onRetry={() => void state.refetch()} /> : null}
        {state.isLoading ? <Skeleton className="h-28" surface="card" /> : null}
        {state.data ? (
          <>
            <OwnerBadge state={state.data} actor={actor} network={option.network} book={book} />
            {actor === "no" && state.data.ownerKind !== "none" ? <p className={cx("text-sm", TEXT_MUTED)}>{state.data.adminCanActReason ?? cannotActReason(state.data, signerAddress, session)}</p> : null}
            <div className="grid gap-5 lg:grid-cols-2">
              <div>
                <p className={cx(LABEL, "mb-2", TEXT_MUTED)}>Reads at block {state.data.block}</p>
                <dl className="grid gap-1.5 text-sm">
                  {Object.entries(state.data.values).map(([name, value]) => (
                    <div key={name} className="grid min-w-0 grid-cols-[minmax(8rem,auto)_1fr] gap-3 border-b-2 border-dotted border-[#1A1A1A]/15 pb-1.5 dark:border-white/10">
                      <dt className="font-code text-[13px] font-bold">{name}</dt>
                      <dd className="min-w-0 break-all font-code text-[13px]">
                        {typeof value === "string" && /^0x[0-9a-fA-F]{40}$/u.test(value) ? <AddressText address={value} network={option.network} book={book} copy={false} /> : String(value ?? "none")}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
              <div>
                <p className={cx(LABEL, "mb-2", TEXT_MUTED)}>Balances</p>
                {state.data.balances.length === 0 ? (
                  <p className={cx("text-sm", TEXT_MUTED)}>None held.</p>
                ) : (
                  <ul className="flex flex-col gap-1.5 text-sm">
                    {state.data.balances.map((balance) => (
                      <li key={balance.token} className="flex justify-between gap-3 border-b-2 border-dotted border-[#1A1A1A]/15 pb-1.5 dark:border-white/10">
                        <span className="font-code font-bold">{formatTokenAmount(balance)}</span>
                        <span className={TEXT_MUTED}>{formatUsd(balance.usd)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </>
        ) : null}
      </Card>

      {artifact.error ? <AdminError error={artifact.error} title="The ABI could not load" onRetry={() => void artifact.refetch()} /> : null}
      {groups && state.data && spec ? (
        <>
          <Panel title="Owner actions">
            {groups.owner.length === 0 ? <EmptyState>No owner actions: this contract is read only.</EmptyState> : null}
            <ul className="flex flex-col gap-3">
              {groups.owner.map((fn) => (
                <FunctionRow key={fn.signature} fn={fn} option={option} spec={spec} state={state.data} actor={actor} abi={artifact.data?.abi as unknown as Abi} />
              ))}
            </ul>
          </Panel>
          {groups.other.length > 0 ? (
            <Panel
              title="Other functions"
              aside={
                <Button size="sm" variant="ghost" onClick={() => setShowOther((value) => !value)} aria-expanded={showOther}>
                  <ChevronDown className={cx("h-4 w-4 transition-transform", showOther && "rotate-180")} aria-hidden="true" />
                  {showOther ? "Hide" : `Show ${groups.other.length}`}
                </Button>
              }
            >
              <p className={cx("text-sm", TEXT_MUTED)}>{OTHER_FUNCTION_NOTE}</p>
              {showOther ? (
                <ul className="flex flex-col gap-3">
                  {groups.other.map((fn) => (
                    <FunctionRow key={fn.signature} fn={fn} option={option} spec={spec} state={state.data} actor={actor} abi={artifact.data?.abi as unknown as Abi} />
                  ))}
                </ul>
              ) : null}
            </Panel>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** Whether the connected wallet may call this function, and how. */
function callPath(fn: WriteFunction, state: AdminContractState, actor: ActorMode, signer: string | null): { readonly via: "direct" | { safe: string } | null; readonly reason: string | null } {
  if (fn.disabled) return { via: null, reason: fn.disabled };
  const caller = fn.action?.caller ?? "owner";
  const paused = state.values.paused;
  if (fn.action?.requires === "paused" && paused === false) return { via: null, reason: "Only while paused." };
  if (fn.action?.requires === "not-paused" && paused === true) return { via: null, reason: "Only while not paused." };
  if (!signer) return { via: null, reason: "Connect the EVM admin wallet to act." };
  if (caller === "anyone") return { via: "direct", reason: null };
  if (caller === "pending-owner") return actor === "pending-owner" ? { via: "direct", reason: null } : { via: null, reason: "Only the pending owner can accept." };
  if (caller === "pending-treasury") {
    const pending = typeof state.values.pendingTreasury === "string" ? state.values.pendingTreasury : null;
    return pending && sameAddress("evm", pending, signer) ? { via: "direct", reason: null } : { via: null, reason: "Only the pending treasury can accept." };
  }
  if (caller === "guardian-or-owner") {
    const guardian = typeof state.values.guardian === "string" ? state.values.guardian : null;
    if (guardian && sameAddress("evm", guardian, signer)) return { via: "direct", reason: null };
  }
  if (actor === "direct") return { via: "direct", reason: null };
  if (actor === "via-safe" && state.owner) return { via: { safe: state.owner }, reason: null };
  return { via: null, reason: "The connected wallet does not own this contract." };
}

function FunctionRow({ fn, option, spec, state, actor, abi }: { readonly fn: WriteFunction; readonly option: ContractOption; readonly spec: AdminContractSpec; readonly state: AdminContractState; readonly actor: ActorMode; readonly abi: Abi }) {
  const { signer, book, goTo } = useAdmin();
  const run = useOwnerCall();
  const signerAddress = signer.ready ? signer.address : null;
  const [open, setOpen] = useState(false);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [value, setValue] = useState("");
  const [confirmTwice, setConfirmTwice] = useState("");
  const [sheet, setSheet] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const path = callPath(fn, state, actor, signerAddress);
  const params = fn.item.inputs ?? [];
  const parsed = params.map((param, index) => parseInput(param, inputs[param.name || `arg${index}`] ?? ""));
  const ready = parsed.every((item) => item.ok);
  const args = parsed.map((item) => (item.ok ? item.value : undefined));
  const isTransfer = fn.item.name === "transferOwnership";
  const transferProblems = isTransfer ? transferOwnerProblems({ newOwner: inputs[params[0]?.name || "arg0"] ?? "", confirm: confirmTwice, contract: option.address, singleStep: fn.danger.singleStepTransfer }) : [];
  let valueWei = 0n;
  let valueError: string | null = null;
  if (fn.payable && value.trim()) {
    try {
      valueWei = parseEther(value.trim());
    } catch {
      valueError = "Enter an amount like 0.5.";
    }
  }
  const calldata = ready ? (() => {
    try {
      return encodeFunctionData({ abi, functionName: fn.item.name ?? "", args: args as unknown[] });
    } catch {
      return null;
    }
  })() : null;
  const decoded = calldata ? decodeCall([fn.item], calldata) : null;
  const symbol = CHAINS[option.network]?.nativeAsset.symbol ?? "ETH";
  const canRun = Boolean(path.via) && ready && !valueError && transferProblems.length === 0;

  const execute = async () => {
    if (!path.via) return;
    setError(null);
    setSheet(false);
    try {
      const result = await run(
        {
          network: option.network,
          address: option.address,
          abi,
          functionName: fn.item.name ?? "",
          args,
          value: valueWei,
          actionId: fn.action?.id ?? null,
          description: `${fn.action?.label ?? fn.item.name} on ${spec.name} (${networkName(option.network)})`,
          via: path.via,
        },
        (next) => setStep(next),
      );
      if (result.kind === "sent") toast.success(`${fn.action?.label ?? fn.item.name} confirmed`, { description: "The API re-read the transaction and logged it." });
      else toast.success("Safe proposal signed", { description: `${result.proposal.signatures.length} of ${result.proposal.threshold} signatures. Open the Safe queue for the rest.`, action: { label: "Safe queue", onClick: () => goTo("safe") } });
      setOpen(false);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setStep(null);
    }
  };

  const tone = fn.danger.level === "dangerous" ? "danger" : fn.danger.level === "sensitive" ? "warning" : "neutral";
  return (
    <li className={cx("flex flex-col gap-3 p-4", INK_BORDER_THIN, SURFACE)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" className={cx("flex min-w-0 flex-col items-start text-left", FOCUS_RING)} onClick={() => setOpen((value) => !value)} aria-expanded={open}>
          <span className="font-display text-lg font-bold">{fn.action?.label ?? fn.item.name}</span>
          <code className={cx("break-all font-code text-[13px]", TEXT_MUTED)}>{fn.signature}</code>
        </button>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill tone={tone}>{fn.danger.level}</StatusPill>
          {path.via && path.via !== "direct" ? <StatusPill tone="info">Via Safe</StatusPill> : null}
          {!path.via ? <StatusPill tone="neutral" title={path.reason ?? undefined}>{fn.disabled ? "Disabled" : "Not available"}</StatusPill> : null}
        </div>
      </div>
      {!path.via && path.reason ? <p className={cx("text-sm", TEXT_MUTED)}>{path.reason}</p> : null}
      {fn.danger.message && open ? <p className={cx("border-l-[4px] px-3 py-2 text-sm font-semibold", fn.danger.singleStepTransfer ? "border-[#B91C1C] bg-danger-bg text-danger" : "border-[#B45309] bg-warning-bg text-warning")}>{fn.danger.message}</p> : null}
      {open && !fn.disabled ? (
        <div className="flex flex-col gap-4">
          {params.length > 0 || fn.payable ? (
            <div className="grid gap-3 md:grid-cols-2">
              {params.map((param, index) => {
                const key = param.name || `arg${index}`;
                const result = parsed[index];
                const raw = inputs[key] ?? "";
                return (
                  <TextField
                    key={key}
                    label={`${key} (${param.type})`}
                    mono
                    value={raw}
                    onChange={(event) => setInputs((value) => ({ ...value, [key]: event.target.value }))}
                    error={raw && result && !result.ok ? result.error : undefined}
                    hint={param.type === "address" && raw ? nameFor(book, raw.trim()) ?? "Not in your address book" : undefined}
                    autoComplete="off"
                    spellCheck={false}
                  />
                );
              })}
              {isTransfer && fn.danger.singleStepTransfer ? (
                <TextField label="New owner, typed again" mono value={confirmTwice} onChange={(event) => setConfirmTwice(event.target.value)} autoComplete="off" spellCheck={false} />
              ) : null}
              {fn.payable ? <TextField label={`Value (${symbol})`} value={value} onChange={(event) => setValue(event.target.value)} error={valueError ?? undefined} inputMode="decimal" /> : null}
            </div>
          ) : null}
          {transferProblems.length > 0 && (inputs[params[0]?.name || "arg0"] ?? "") ? (
            <ul className="flex flex-col gap-1 text-sm font-semibold text-danger">
              {transferProblems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          ) : null}
          {calldata && decoded ? (
            <TxPreviewTicket
              label={`Preview of ${fn.signature}`}
              icon="key"
              title={path.via && path.via !== "direct" ? "Safe proposal" : "Owner call"}
              serial={calldata.slice(2, 10).toUpperCase()}
              headline={decoded.signature}
              lines={decoded.args.map((arg) => ({ label: `${arg.name} (${arg.type})`, value: arg.value, note: nameFor(book, arg.value) }))}
              fields={[
                { label: "Network", value: networkName(option.network) },
                { label: "Target", value: `${option.address.slice(0, 6)}…${option.address.slice(-4)}` },
                { label: "Value", value: `${valueWei === 0n ? "0" : value.trim()} ${symbol}` },
                { label: "Calldata", value: `${(calldata.length - 2) / 2} bytes` },
              ]}
              stubTitle={path.via === "direct" ? "Sign and send" : "Propose and sign"}
              stubBody={path.via === "direct" ? <>Simulated first; a revert stops here, before the wallet.</> : <>The API reads the Safe nonce and hash; your wallet signs the SafeTx; co-owners sign in the Safe queue.</>}
            />
          ) : null}
          {error ? (
            <p role="alert" className="text-sm font-bold text-danger">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant={fn.danger.level === "dangerous" ? "ink" : "primary"}
              onClick={() => (fn.danger.singleStepTransfer || fn.danger.level === "dangerous" ? setSheet(true) : void execute())}
              disabled={!canRun || step !== null}
              loading={step !== null}
            >
              <Play className="h-4 w-4" aria-hidden="true" />
              {path.via && path.via !== "direct" ? "Propose to the Safe" : "Simulate and send"}
            </Button>
            {step ? (
              <span role="status" className={cx("text-sm font-semibold", TEXT_MUTED)}>
                {{ wallet: "Confirm in your wallet…", confirming: "Waiting for a confirmation…", verifying: "The API is checking the transaction…", proposing: "Creating the proposal…", signing: "Sign the SafeTx in your wallet…" }[step] ?? ""}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
      <ConfirmSheet
        open={sheet}
        onClose={() => setSheet(false)}
        title={fn.action?.label ?? fn.item.name ?? "Confirm"}
        warning={fn.danger.message ?? "This action is marked dangerous."}
        phrase={fn.danger.singleStepTransfer ? "transfer ownership" : undefined}
        confirmLabel={path.via && path.via !== "direct" ? "Propose" : "Send"}
        onConfirm={() => void execute()}
      >
        <p>
          {fn.signature} on {spec.name} ({networkName(option.network)}).
        </p>
      </ConfirmSheet>
    </li>
  );
}
