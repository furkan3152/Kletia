/**
 * "Sign in to manage your projects" (developer accounts): a wallet is the
 * durable identity of a project, so a lost key never means a lost project.
 * Signed out it offers wallet sign-in (loaded on demand); signed in it lists
 * the wallet's projects, creates new ones, links the project of the key in
 * this tab, and issues, rotates and revokes keys of an owned project. The
 * anonymous key flow next to it keeps working without any of this.
 *
 * `variant="project"` (Project settings) shows only whether the loaded key's
 * project belongs to the signed-in wallet, and the button that links it.
 */
import type { AccountKeyView, AccountProjectView } from "@kletia/core";
import { Link2, LogOut, Plus, RefreshCw, RotateCw, ShieldCheck, Trash2, Wallet } from "lucide-react";
import React, { Suspense, useCallback, useEffect, useState } from "react";

import type { PlatformError } from "../../../../shared/platform/kletiaClient";
import { ApiErrorPanel } from "../../../site/ui/ApiErrorPanel";
import { Badge } from "../../../site/ui/Badge";
import { Button } from "../../../site/ui/Button";
import { SelectField, TextField } from "../../../site/ui/Field";
import { cx, HARD_SHADOW, INK_BORDER, INK_BORDER_THIN, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { shortAddress } from "../../admin/model/session";
import { useNow } from "../portal/useNow";
import { accountApi, isPlatformError } from "./accountClient";
import { accountErrorText, accountKeyStatus, sortAccountKeys } from "./accountModel";
import { useAccountSession } from "./accountSession";
import { clearAccountSession, type AccountSessionState } from "./accountSessionStore";
import { formatTimestamp, GRACE_OPTIONS } from "./keyClient";
import { KEY_NAME_PATTERN, SecretReveal, type Secret } from "./KeyManager";
import { portalKeyKind, useSessionKey } from "./sessionKey";

const AccountSignIn = React.lazy(() => import("./AccountSignIn"));

function asPlatformError(error: unknown): PlatformError {
  if (isPlatformError(error)) return error;
  return { code: "CLIENT_ERROR", message: error instanceof Error ? error.message : "Unexpected error.", status: 0, issues: [], requestId: null, retryable: false, unreachable: false };
}

/** An account call's failure: an ended session signs the tab out (the projects stay the wallet's). */
function useFailure(): [PlatformError | null, (error: unknown) => void, () => void] {
  const [failure, setFailure] = useState<PlatformError | null>(null);
  const fail = useCallback((error: unknown) => {
    if (error instanceof DOMException && error.name === "AbortError") return;
    const platform = asPlatformError(error);
    if (platform.code === "ACCOUNT_SESSION_REQUIRED") clearAccountSession();
    setFailure({ ...platform, message: accountErrorText(platform.code, platform.message) });
  }, []);
  return [failure, fail, () => setFailure(null)];
}

/** Loads the wallet's projects for `token`; `reload()` reads them again. */
function useOwnedProjects(token: string | null): { projects: AccountProjectView[] | null; failure: PlatformError | null; reload: () => void } {
  const [projects, setProjects] = useState<AccountProjectView[] | null>(null);
  const [generation, setGeneration] = useState(0);
  const [failure, fail, clear] = useFailure();
  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    accountApi.projects(token, controller.signal).then((list) => {
      clear();
      setProjects(list);
    }, fail);
    return () => controller.abort();
    // `clear` and `fail` are stable for the purpose of reloading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, generation]);
  return { projects: token ? projects : null, failure, reload: () => setGeneration((value) => value + 1) };
}

function Shell({ title, intro, actions, children }: { readonly title: string; readonly intro?: React.ReactNode; readonly actions?: React.ReactNode; readonly children?: React.ReactNode }) {
  return (
    <section aria-labelledby="account-panel-title" className={cx("flex min-w-0 flex-col gap-4 p-4 sm:p-6", INK_BORDER, HARD_SHADOW, SURFACE)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id="account-panel-title" className="font-display text-title font-bold">
            {title}
          </h2>
          {intro ? <p className={cx("max-w-3xl text-body-s", TEXT_MUTED)}>{intro}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

function SignedOut({ compact }: { readonly compact: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Shell
      title="Sign in to manage your projects"
      intro={
        compact
          ? "Link this project to a wallet, so a lost key never means a lost project: sign in again on any device and issue a new key."
          : "Sign in with an EVM or Solana wallet to see the projects it owns and issue, rotate or revoke their keys, also after every key was lost. Signing in moves no funds and approves no transaction. Keys still work without an account."
      }
      actions={
        open ? null : (
          <Button onClick={() => setOpen(true)}>
            <Wallet className="h-4 w-4" aria-hidden="true" />
            Sign in with a wallet
          </Button>
        )
      }
    >
      {open ? (
        <Suspense fallback={<p className={cx("text-sm", TEXT_MUTED)}>Loading wallets…</p>}>
          <AccountSignIn onCancel={() => setOpen(false)} />
        </Suspense>
      ) : null}
    </Shell>
  );
}

function WalletLine({ session, onSignedOut }: { readonly session: AccountSessionState; readonly onSignedOut?: () => void }) {
  const [busy, setBusy] = useState(false);
  const signOut = async () => {
    setBusy(true);
    try {
      await accountApi.signOut(session.token);
    } catch {
      // The tab forgets the session either way; it ends on its own on the API.
    } finally {
      setBusy(false);
      clearAccountSession();
      onSignedOut?.();
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Badge tone={session.walletKind === "solana" ? "green" : "blue"}>{session.walletKind === "solana" ? "Solana" : "EVM"}</Badge>
      <code className="font-code text-[13px]" title={session.address}>
        {shortAddress(session.address)}
      </code>
      <Button size="sm" variant="ghost" onClick={() => void signOut()} loading={busy}>
        <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
        Sign out
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------ keys of one project */

type Pending = { readonly id: string; readonly kind: "rotate" | "revoke" } | null;

function OwnedKeys({ token, project, onChanged }: { readonly token: string; readonly project: AccountProjectView; readonly onChanged: () => void }) {
  const { setKey } = useSessionKey();
  const now = useNow(30_000);
  const [keys, setKeys] = useState<AccountKeyView[] | null>(null);
  const [generation, setGeneration] = useState(0);
  const [failure, fail, clearFailure] = useFailure();
  const [pending, setPending] = useState<Pending>(null);
  const [grace, setGrace] = useState("86400");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<Secret | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    accountApi.keys(token, project.id, controller.signal).then((list) => {
      clearFailure();
      setKeys(list);
    }, fail);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, project.id, generation]);

  const changed = () => {
    setGeneration((value) => value + 1);
    onChanged();
  };

  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    clearFailure();
    try {
      await task();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const issue = () =>
    run(async () => {
      const issued = await accountApi.issueKey(token, project.id, name.trim(), false);
      setSecret({ kind: "issued", id: issued.id, name: issued.name, key: issued.key });
      setName("");
      changed();
    });

  const rotate = (id: string) =>
    run(async () => {
      const rotated = await accountApi.rotateKey(token, project.id, id, Number.parseInt(grace, 10));
      setPending(null);
      setSecret({ kind: "rotated", id: rotated.id, name: rotated.name, key: rotated.key, previousExpiresAt: rotated.previousExpiresAt });
      changed();
    });

  const revoke = (id: string) =>
    run(async () => {
      await accountApi.revokeKey(token, project.id, id);
      setPending(null);
      changed();
    });

  const nameValid = KEY_NAME_PATTERN.test(name.trim());
  const sorted = keys ? sortAccountKeys(keys, now) : [];
  const target = pending ? sorted.find((item) => item.id === pending.id) ?? null : null;

  return (
    <div className={cx("flex min-w-0 flex-col gap-3 p-3 sm:p-4", INK_BORDER_THIN)}>
      {secret ? <SecretReveal secret={secret} onUse={() => setKey(secret.key)} onDone={() => setSecret(null)} /> : null}
      {failure ? <ApiErrorPanel error={failure} title="The key change did not go through" /> : null}
      {keys === null && !failure ? <p className={cx("text-sm", TEXT_MUTED)}>Loading keys…</p> : null}
      {keys !== null ? (
        <ul className="flex flex-col gap-2" aria-label={`Keys of ${project.id}`}>
          {sorted.map((item) => {
            const status = accountKeyStatus(item, now);
            const live = status === "active" || status === "grace";
            return (
              <li key={item.id} className={cx("flex flex-wrap items-center justify-between gap-2 px-3 py-2", INK_BORDER_THIN, !live && "opacity-70")}>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-bold">
                    {item.name}
                    <Badge tone={item.kind === "project" ? "ink" : "outline"}>{item.kind}</Badge>
                    <Badge tone={status === "active" ? "green" : status === "grace" ? "yellow" : "red"}>{status === "grace" ? "old secret in grace" : status}</Badge>
                  </p>
                  <p className={cx("font-code text-xs", TEXT_MUTED)}>
                    {item.id} · …{item.last4 ?? "????"} · created {formatTimestamp(item.createdAt)} · last used {formatTimestamp(item.lastUsedAt)}
                  </p>
                </div>
                {live ? (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="secondary" onClick={() => setPending({ id: item.id, kind: "rotate" })} disabled={busy}>
                      <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
                      Rotate
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setPending({ id: item.id, kind: "revoke" })} disabled={busy}>
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      Revoke
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
          {sorted.length === 0 ? <li className={cx("text-sm", TEXT_MUTED)}>No keys yet.</li> : null}
        </ul>
      ) : null}
      {target && pending ? (
        <div role="group" aria-label={pending.kind === "rotate" ? "Confirm rotation" : "Confirm revocation"} className={cx("flex flex-col gap-3 p-3", INK_BORDER_THIN)}>
          {pending.kind === "rotate" ? (
            <>
              <p className="text-sm">
                Rotate <span className="font-bold">{target.name}</span>: same id, new secret, shown once.
              </p>
              <SelectField label="Old secret" options={GRACE_OPTIONS} value={grace} onChange={(event) => setGrace(event.target.value)} />
            </>
          ) : (
            <p className="text-sm">
              Revoke <span className="font-bold">{target.name}</span> and every key issued under it? Their webhooks are deleted. The project stays yours.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant={pending.kind === "revoke" ? "ink" : "primary"} loading={busy} onClick={() => void (pending.kind === "rotate" ? rotate(target.id) : revoke(target.id))}>
              {pending.kind === "rotate" ? "Rotate the key" : "Revoke the key"}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setPending(null)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          if (nameValid && !busy) void issue();
        }}
      >
        <TextField label="New project key" placeholder="server" value={name} onChange={(event) => setName(event.target.value)} containerClassName="min-w-0 flex-1" maxLength={64} />
        <Button type="submit" size="sm" disabled={!nameValid || busy} loading={busy && !pending}>
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Issue a key
        </Button>
      </form>
    </div>
  );
}

/* ------------------------------------------------------------ panels */

function ProjectsPanel({ session }: { readonly session: AccountSessionState }) {
  const { key: tabKey, setKey } = useSessionKey();
  const { projects, failure: loadFailure, reload } = useOwnedProjects(session.token);
  const [open, setOpen] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [sandbox, setSandbox] = useState(false);
  const [busy, setBusy] = useState<"create" | "claim" | null>(null);
  const [secret, setSecret] = useState<Secret | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, fail, clearFailure] = useFailure();
  const nameValid = KEY_NAME_PATTERN.test(name.trim());

  const create = async () => {
    setBusy("create");
    clearFailure();
    setNotice(null);
    try {
      const created = await accountApi.createProject(session.token, name.trim(), sandbox);
      setSecret({ kind: "issued", id: created.key.id, name: created.key.name, key: created.key.key });
      setName("");
      setOpen(created.project.id);
      reload();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(null);
    }
  };

  const claim = async () => {
    setBusy("claim");
    clearFailure();
    setNotice(null);
    try {
      const claimed = await accountApi.claim(session.token, tabKey);
      setNotice(claimed.claimed ? `${claimed.project.id} is now owned by your wallet.` : `${claimed.project.id} was already owned by your wallet.`);
      reload();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Shell
      title="Your projects"
      intro="Projects owned by the signed-in wallet. Sign in again on any device to get back here; issue a new key when every key was lost."
      actions={
        <>
          <WalletLine session={session} />
          <Button size="sm" variant="ghost" onClick={reload} aria-label="Reload projects">
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Reload
          </Button>
        </>
      }
    >
      {secret ? <SecretReveal secret={secret} onUse={() => setKey(secret.key)} onDone={() => setSecret(null)} /> : null}
      {notice ? (
        <p role="status" className="text-sm font-bold">
          {notice}
        </p>
      ) : null}
      {failure ? <ApiErrorPanel error={failure} title="That did not go through" /> : null}
      {loadFailure ? <ApiErrorPanel error={loadFailure} title="Could not list your projects" onRetry={reload} /> : null}
      {portalKeyKind(tabKey) === "developer" ? (
        <div className={cx("flex flex-wrap items-center justify-between gap-3 p-3", INK_BORDER_THIN)}>
          <p className="text-sm">Link the project of the key in this tab to your wallet. A project has one owner wallet for good.</p>
          <Button size="sm" variant="secondary" onClick={() => void claim()} loading={busy === "claim"} disabled={busy !== null}>
            <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
            Link to my wallet
          </Button>
        </div>
      ) : null}
      {projects === null && !loadFailure ? <p className={cx("text-sm", TEXT_MUTED)}>Loading projects…</p> : null}
      {projects !== null ? (
        projects.length === 0 ? (
          <p className={cx("text-sm", TEXT_MUTED)}>This wallet owns no project yet. Create one below, or load a key and link its project.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {projects.map((project) => (
              <li key={project.id} className="flex min-w-0 flex-col gap-2">
                <div className={cx("flex flex-wrap items-center justify-between gap-2 px-3 py-2", INK_BORDER_THIN)}>
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-bold">
                      {project.name ?? "Unnamed project"}
                      <Badge tone="outline">{project.source}</Badge>
                    </p>
                    <p className={cx("font-code text-xs", TEXT_MUTED)}>
                      {project.id} · {project.activeKeys} active project {project.activeKeys === 1 ? "key" : "keys"}
                      {project.activeChildKeys > 0 ? ` · ${project.activeChildKeys} agent or publishable` : ""} · owned since {formatTimestamp(project.ownedSince)}
                    </p>
                  </div>
                  <Button size="sm" variant={open === project.id ? "ink" : "secondary"} aria-expanded={open === project.id} onClick={() => setOpen(open === project.id ? null : project.id)}>
                    {open === project.id ? "Hide keys" : project.activeKeys === 0 ? "Recover access" : "Manage keys"}
                  </Button>
                </div>
                {open === project.id ? <OwnedKeys token={session.token} project={project} onChanged={reload} /> : null}
              </li>
            ))}
          </ul>
        )
      ) : null}
      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          if (nameValid && busy === null) void create();
        }}
      >
        <TextField label="New project (its first key's name)" placeholder="my-app" value={name} onChange={(event) => setName(event.target.value)} containerClassName="min-w-0 flex-1" maxLength={64} />
        <label className="flex min-h-11 items-center gap-2 text-sm font-bold">
          <input type="checkbox" checked={sandbox} onChange={(event) => setSandbox(event.target.checked)} />
          Sandbox (testnets only)
        </label>
        <Button type="submit" size="sm" disabled={!nameValid || busy !== null} loading={busy === "create"}>
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Create a project
        </Button>
      </form>
    </Shell>
  );
}

function ProjectOwnership({ session, projectId }: { readonly session: AccountSessionState; readonly projectId: string }) {
  const { key: tabKey } = useSessionKey();
  const { projects, failure: loadFailure, reload } = useOwnedProjects(session.token);
  const [busy, setBusy] = useState(false);
  const [failure, fail, clearFailure] = useFailure();
  const owned = projects?.some((project) => project.id === projectId) ?? false;

  const claim = async () => {
    setBusy(true);
    clearFailure();
    try {
      await accountApi.claim(session.token, tabKey);
      reload();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell title={owned ? "Owned by your wallet" : "Link this project to your wallet"} actions={<WalletLine session={session} />}>
      {owned ? (
        <p className="flex items-center gap-2 text-sm">
          <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
          Sign in with this wallet on any device to issue a new key for {projectId}, even when every key is lost.
        </p>
      ) : projects !== null ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm">A project has one owner wallet for good. Linking uses the key in this tab to prove the project is yours.</p>
          <Button size="sm" onClick={() => void claim()} loading={busy} disabled={busy || portalKeyKind(tabKey) !== "developer"}>
            <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
            Link to my wallet
          </Button>
        </div>
      ) : null}
      {failure ? <ApiErrorPanel error={failure} title="The project was not linked" /> : null}
      {loadFailure ? <ApiErrorPanel error={loadFailure} title="Could not read your projects" onRetry={reload} /> : null}
    </Shell>
  );
}

export interface AccountPanelProps {
  readonly variant?: "keys" | "project";
  /** Project settings: the `prj_…` id of the loaded key's project. */
  readonly currentProjectId?: string;
}

export function AccountPanel({ variant = "keys", currentProjectId }: AccountPanelProps) {
  const session = useAccountSession();
  if (!session) return <SignedOut compact={variant === "project"} />;
  if (variant === "project" && currentProjectId) return <ProjectOwnership session={session} projectId={currentProjectId} />;
  return <ProjectsPanel session={session} />;
}
