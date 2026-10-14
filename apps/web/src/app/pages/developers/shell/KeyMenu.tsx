import type { ApiKeySummary } from "@kletia/sdk";
import { ChevronDown, CircleAlert, ClipboardCopy, Eye, EyeOff, KeyRound, Trash2 } from "lucide-react";
import React, { useId, useRef, useState } from "react";

import { sdkSignal } from "../../../../shared/platform/kletiaClient";
import { useApiResource } from "../../../../shared/platform/useApiResource";
import { copyText } from "../../../site/ui/clipboard";
import { Button, ButtonLink } from "../../../site/ui/Button";
import { Sheet } from "../../../site/ui/Sheet";
import { StatusPill } from "../../../site/ui/StatusPill";
import { CONTROL_BORDER, cx, FOCUS_RING, LABEL, TEXT_MUTED } from "../../../site/ui/styles";
import { keyedClient } from "../keys/keyClient";
import { maskKey, portalKeyKind, useSessionKey } from "../keys/sessionKey";
import { GET_KEY_HREF } from "./portalRoutes";

/** What the key in memory is, as far as this browser can tell. */
type KeyState = "none" | "malformed" | "refused" | "developer" | "agent";

interface KeyInfo {
  readonly state: KeyState;
  readonly name: string | null;
  readonly sandbox: boolean;
  readonly projectKeys: number | null;
  readonly agentKeys: number | null;
}

/** Reads the loaded key's own row (name, lane) and its project's key count from GET /v1/keys. */
function useKeyInfo(key: string): KeyInfo {
  const kind = portalKeyKind(key);
  const keys = useApiResource<ApiKeySummary[]>(kind ? `key-menu:${maskKey(key)}` : null, (_client, signal) =>
    keyedClient(key).keys.list({ signal: sdkSignal(signal) }),
  );
  if (!key) return { state: "none", name: null, sandbox: false, projectKeys: null, agentKeys: null };
  if (!kind) return { state: "malformed", name: null, sandbox: false, projectKeys: null, agentKeys: null };
  if (keys.status === "error" && keys.error?.status === 401) {
    return { state: "refused", name: null, sandbox: false, projectKeys: null, agentKeys: null };
  }
  const live = (keys.data ?? []).filter((item) => !item.revokedAt);
  const self = live.find((item) => item.current) ?? null;
  // `lane` arrives with sandbox keys; older APIs do not send it.
  const lane = self && "lane" in self ? (self as { readonly lane?: unknown }).lane : undefined;
  return {
    state: kind,
    name: self?.name ?? null,
    sandbox: lane === "testnet",
    projectKeys: keys.data ? live.filter((item) => item.kind !== "agent").length : null,
    agentKeys: keys.data ? live.filter((item) => item.kind === "agent").length : null,
  };
}

function chipText(info: KeyInfo, key: string): string {
  switch (info.state) {
    case "none":
      return "Public tier";
    case "malformed":
      return "Not a Kletia key";
    case "refused":
      return "Key refused";
    default:
      return [maskKey(key), info.name, info.state === "agent" ? "agent" : null, info.sandbox ? "Sandbox" : null].filter(Boolean).join(" · ");
  }
}

/** Accepts what the menu's field holds as a key: anything non-empty, classified by shape in the chip. */
function UseAnotherKey({ onUsed, inputRef }: { readonly onUsed: () => void; readonly inputRef: React.RefObject<HTMLInputElement> }) {
  const id = useId();
  const { setKey } = useSessionKey();
  const [draft, setDraft] = useState("");
  const [visible, setVisible] = useState(false);
  const trimmed = draft.trim();
  const shapeNote = trimmed && !portalKeyKind(trimmed) ? "That does not look like a kl_dev_ or kl_agt_ key; it will be sent as it is." : null;
  return (
    <form
      className="flex flex-col gap-2"
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        if (!trimmed) return;
        setKey(trimmed);
        setDraft("");
        setVisible(false);
        onUsed();
      }}
    >
      <label htmlFor={id} className={cx(LABEL, "text-fg")}>
        Use another key
      </label>
      <div className="flex min-w-0">
        <input
          ref={inputRef}
          id={id}
          type={visible ? "text" : "password"}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="kl_dev_… or kl_agt_…"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-1p-ignore=""
          data-lpignore="true"
          data-bwignore=""
          data-form-type="other"
          aria-describedby={`${id}-note`}
          className={cx(
            "min-h-11 w-full min-w-0 border-r-0 bg-white px-3 py-2 font-code text-[13px] text-fg placeholder:text-placeholder dark:bg-[#0B1120]",
            CONTROL_BORDER,
            FOCUS_RING,
            "focus-visible:-outline-offset-4",
          )}
        />
        <button
          type="button"
          onClick={() => setVisible((value) => !value)}
          aria-pressed={visible}
          aria-label={visible ? "Hide the key" : "Show the key"}
          className={cx(
            "inline-flex min-h-11 w-11 shrink-0 items-center justify-center border-r-0 bg-[#F1EFE8] text-[#1A1A1A] hover:bg-[#FFD60A] dark:bg-[#1A2841] dark:text-white dark:hover:bg-[#22345A]",
            CONTROL_BORDER,
            FOCUS_RING,
          )}
        >
          {visible ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
        </button>
        <Button type="submit" disabled={!trimmed} className="shrink-0 !shadow-none">
          Use
        </Button>
      </div>
      <p id={`${id}-note`} className={cx("text-xs", shapeNote ? "font-bold text-danger" : TEXT_MUTED)}>
        {shapeNote ?? "Paste a key only on a device you trust. Production keys belong on your server."}
      </p>
    </form>
  );
}

/**
 * The portal's one key slot (portal design 4.3): a chip in the portal bar
 * that names the key in memory (masked, its name, agent or sandbox) and
 * opens the key menu: forget it, copy it as an .env line, use another key,
 * or get one. The key stays in this tab's memory only.
 */
export function KeyMenu({ open, onOpen, onClose }: { readonly open: boolean; readonly onOpen: () => void; readonly onClose: () => void }) {
  const { key, clear } = useSessionKey();
  const info = useKeyInfo(key);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const inputRef = useRef<HTMLInputElement>(null);
  const loaded = info.state === "developer" || info.state === "agent";
  const warning = info.state === "malformed" || info.state === "refused";
  const text = chipText(info, key);

  return (
    <>
      <button
        type="button"
        onClick={onOpen}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Key in this tab: ${text}. Open the key menu`}
        className={cx(
          "inline-flex min-h-11 min-w-0 max-w-[16rem] items-center gap-1.5 px-2.5 text-xs font-bold sm:max-w-[22rem]",
          CONTROL_BORDER,
          warning ? "bg-danger-bg text-danger" : loaded ? "bg-[#FFD60A] text-[#1A1A1A]" : "bg-surface text-fg",
          FOCUS_RING,
        )}
      >
        {warning ? <CircleAlert className="h-4 w-4 shrink-0" aria-hidden="true" /> : <KeyRound className="h-4 w-4 shrink-0" aria-hidden="true" />}
        <span className={cx("min-w-0 truncate", loaded && "font-code")}>
          <span className="sm:hidden">{loaded ? maskKey(key) : text}</span>
          <span className="hidden sm:inline">{text}</span>
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      </button>

      <Sheet
        open={open}
        onClose={() => {
          setCopied("idle");
          onClose();
        }}
        title="Key in this tab"
        side="menu"
        phone="bottom"
        widthClassName="md:w-[26rem]"
        initialFocusRef={key ? undefined : inputRef}
      >
        <div className="flex flex-col gap-5 p-4">
          {key ? (
            <div className="flex flex-col gap-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <code className="font-code text-sm font-bold">{maskKey(key)}</code>
                {info.name ? <span className="min-w-0 break-words text-sm font-bold">{info.name}</span> : null}
                {info.state === "agent" ? <StatusPill tone="info">Agent key</StatusPill> : null}
                {info.state === "developer" ? <StatusPill tone="success">{info.sandbox ? "Sandbox" : "Developer key"}</StatusPill> : null}
                {info.state === "malformed" ? <StatusPill tone="danger">Not a Kletia key</StatusPill> : null}
                {info.state === "refused" ? <StatusPill tone="danger">Refused by the API</StatusPill> : null}
              </div>
              {info.state === "malformed" ? (
                <p className="text-sm">
                  Developer keys start with <code className="font-code">kl_dev_</code> and agent keys with{" "}
                  <code className="font-code">kl_agt_</code>, each followed by 32 letters and digits.
                </p>
              ) : info.state === "refused" ? (
                <p className="text-sm">The API does not accept this key: it was revoked, rotated past its grace window or mistyped.</p>
              ) : info.projectKeys !== null ? (
                <p className={cx("text-sm", TEXT_MUTED)}>
                  {info.state === "agent"
                    ? `This agent key and ${Math.max(0, (info.agentKeys ?? 1) - 1)} agent keys below it.`
                    : `Project with ${info.projectKeys} ${info.projectKeys === 1 ? "key" : "keys"} and ${info.agentKeys} agent ${info.agentKeys === 1 ? "key" : "keys"}.`}
                </p>
              ) : null}
              <p className={cx("text-xs", TEXT_MUTED)}>
                Held in this tab&apos;s memory while you move around the site; reloading the page or Forget drops it. Never stored, never
                put in a link or a snippet.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={async () => setCopied((await copyText(`KLETIA_API_KEY=${key}`)) ? "copied" : "failed")}
                >
                  <ClipboardCopy className="h-3.5 w-3.5" aria-hidden="true" />
                  Copy .env line
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    clear();
                    setCopied("idle");
                    window.setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 0);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  Forget key
                </Button>
              </div>
              <p role="status" className="text-xs font-bold">
                {copied === "copied"
                  ? "Copied. Paste it into your server's .env file, never into browser code."
                  : copied === "failed"
                    ? "This browser refused clipboard access."
                    : ""}
              </p>
            </div>
          ) : (
            <p className="text-sm">
              No key in this tab: pages use the public tier (30 requests a minute per IP). Load a key to manage your project.
            </p>
          )}
          <div className="border-t-2 border-dashed border-[#1A1A1A]/25 pt-4 dark:border-white/15">
            <UseAnotherKey inputRef={inputRef} onUsed={() => setCopied("idle")} />
          </div>
          <p className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-bold">No key yet?</span>
            <ButtonLink to={GET_KEY_HREF} size="sm" variant="accent" onClick={onClose}>
              Get a key
            </ButtonLink>
          </p>
        </div>
      </Sheet>
    </>
  );
}
