import { KeyRound } from "lucide-react";
import React from "react";

import { Link } from "../../../routes/Link";
import { Icon } from "../../../site/art/Icon";
import { Button, ButtonLink } from "../../../site/ui/Button";
import { cx, FOCUS_RING, HARD_SHADOW, INK_BORDER, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { portalKeyKind, useSessionKey } from "../keys/sessionKey";
import { usePortal } from "./portalContext";
import { GET_KEY_HREF } from "./portalRoutes";

export interface KeyGateProps {
  /** What the page does with a key: "list, rotate and revoke the keys of your project". */
  readonly purpose: string;
  /** Agent keys may use the page too (they read their own subtree). */
  readonly agentKeys?: boolean;
  readonly children: React.ReactNode;
}

/**
 * Stands in for a "Your project" page until the key it needs is in memory
 * (portal design 4.5): what the page does, one "Load a key" (the key menu in
 * the portal bar: pages never render a key field of their own) and one
 * "Get a key". Malformed keys and agent keys on developer-only pages get
 * their own explanation. With a usable key it renders the page.
 */
export function KeyGate({ purpose, agentKeys = false, children }: KeyGateProps) {
  const { key } = useSessionKey();
  const { openKeyMenu } = usePortal();
  const kind = portalKeyKind(key);
  if (kind === "developer" || (kind === "agent" && agentKeys)) return <>{children}</>;

  const wanted = agentKeys ? "a developer or agent key" : "a developer key";
  const state = kind === "agent" ? "agent" : key ? "malformed" : "none";
  const title =
    state === "agent" ? "This page needs a developer key" : state === "malformed" ? "That is not a Kletia key" : `Load ${wanted} to use this page`;

  return (
    <section aria-labelledby="key-gate-title" className={cx("flex min-w-0 flex-col gap-4 p-5 sm:p-6", INK_BORDER, HARD_SHADOW, SURFACE)}>
      <div className="flex min-w-0 items-start gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center border-[3px] border-[#1A1A1A] bg-white dark:border-[#4B5563] dark:bg-[#0B1120]">
          <Icon name="key" size={26} />
        </span>
        <div className="flex min-w-0 flex-col gap-2">
          <h2 id="key-gate-title" className="font-display text-title font-bold">
            {title}
          </h2>
          <p className="max-w-2xl text-body-s">
            {state === "agent" ? (
              <>
                Agent keys never manage project keys or project settings. Load a <code className="font-code">kl_dev_</code> key of the project
                to {purpose}. What this agent key may do is in its{" "}
                <Link to="/developers/rule-book" className={cx("font-bold underline decoration-2 underline-offset-2", FOCUS_RING)}>
                  rule book
                </Link>
                .
              </>
            ) : state === "malformed" ? (
              <>
                Developer keys start with <code className="font-code">kl_dev_</code> and agent keys with{" "}
                <code className="font-code">kl_agt_</code>, each followed by 32 letters and digits. Load {wanted} to {purpose}.
              </>
            ) : (
              <>
                With {wanted} in this tab you can {purpose}.
              </>
            )}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-3">
        <Button onClick={openKeyMenu}>
          <KeyRound className="h-4 w-4" aria-hidden="true" />
          {state === "none" ? "Load a key" : state === "agent" ? "Load a developer key" : "Load another key"}
        </Button>
        <ButtonLink to={GET_KEY_HREF} variant="secondary">
          Get a key
        </ButtonLink>
      </div>
      <p className={cx("text-xs", TEXT_MUTED)}>
        A key you load stays in this tab&apos;s memory only: never stored, never put in a link or a snippet, and gone when you reload.
      </p>
    </section>
  );
}
