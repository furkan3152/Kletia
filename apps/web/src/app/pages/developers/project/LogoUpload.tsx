import type { ProjectView } from "@kletia/sdk";
import { ImageUp, Trash2 } from "lucide-react";
import React, { useEffect, useId, useRef, useState } from "react";

import { PLATFORM_ORIGIN, sdkSignal } from "../../../../shared/platform/kletiaClient";
import { useApiAction } from "../../../../shared/platform/useApiResource";
import { ApiErrorPanel } from "../../../site/ui/ApiErrorPanel";
import { Button } from "../../../site/ui/Button";
import { cx, INK_BORDER_THIN, LABEL, TEXT_MUTED } from "../../../site/ui/styles";
import { keyedClient } from "../keys/keyClient";
import { checkLogoBytes, type LogoCheck } from "./projectModel";

interface Picked {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly check: LogoCheck;
  /** A blob: URL of the checked bytes (PNG or WebP only), revoked when replaced. */
  readonly preview: string | null;
}

/** The uploaded logo's immutable URL on the API (served only while the domain is verified). */
function logoSrc(path: string): string | null {
  if (!/^\/v1\/projects\/prj_[A-Za-z0-9_]{1,80}\/logo\/[0-9a-f]{64}\.(png|webp)$/u.test(path)) return null;
  return `${PLATFORM_ORIGIN.replace(/\/+$/u, "")}${path}`;
}

/**
 * The brand logo: PNG or WebP, at most 64 KB, 32-512 px, 1:1 to 4:1,
 * checked here from the file header before it is sent (the API checks
 * it again). A preview, Upload and Remove. The widget shows it 20 px
 * high next to the verified name, only while the domain is verified.
 */
export function LogoUpload({
  apiKey,
  view,
  readOnly,
  onView,
}: {
  readonly apiKey: string;
  readonly view: ProjectView;
  readonly readOnly: boolean;
  readonly onView: (view: ProjectView) => void;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const upload = useApiAction((_client, signal, withKey: string, bytes: Uint8Array, type: "image/png" | "image/webp") =>
    keyedClient(withKey).projects.setLogo(bytes, type, { signal: sdkSignal(signal) }),
  );
  const remove = useApiAction((_client, signal, withKey: string) => keyedClient(withKey).projects.deleteLogo({ signal: sdkSignal(signal) }).then(() => true));
  const logo = view.logo ?? null;
  const verified = view.domain.verified;
  const current = logo && verified ? logoSrc(logo.url) : null;

  useEffect(() => () => {
    if (picked?.preview) URL.revokeObjectURL(picked.preview);
  }, [picked]);

  const choose = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    setNotice(null);
    upload.reset();
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const check = checkLogoBytes(bytes);
    const preview = check.ok ? URL.createObjectURL(new Blob([bytes], { type: check.contentType })) : null;
    setPicked({ name: file.name, bytes, check, preview });
  };

  const send = async () => {
    if (!picked?.check.ok) return;
    const next = await upload.run(apiKey, picked.bytes, picked.check.contentType);
    if (!next) return;
    setPicked(null);
    setNotice(verified ? "Logo uploaded. The widget header shows it next to your verified name." : "Logo uploaded. It stays hidden until the domain is verified.");
    onView(next);
  };

  const drop = async () => {
    const done = await remove.run(apiKey);
    if (!done) return;
    setConfirmRemove(false);
    setNotice("Logo removed.");
    onView({ ...view, logo: null });
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex min-w-0 flex-wrap items-center gap-4">
        <div className={cx("flex h-20 w-56 max-w-full items-center justify-center bg-[#FBFAF6] p-2 dark:bg-[#0E0E10]", INK_BORDER_THIN)}>
          {picked?.preview ? (
            <img src={picked.preview} alt={`Preview of ${picked.name}`} className="h-12 w-auto max-w-full object-contain" />
          ) : current ? (
            <img src={current} alt="Current logo" className="h-12 w-auto max-w-full object-contain" />
          ) : (
            <span className={cx("text-xs", TEXT_MUTED)}>{logo ? "Hidden until the domain is verified" : "No logo"}</span>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-1 text-sm">
          {logo ? (
            <p>
              <span className={LABEL}>Current</span>{" "}
              <span className="font-code text-xs">
                {logo.contentType.replace("image/", "").toUpperCase()} · {logo.width}x{logo.height} px · {logo.sha256.slice(0, 12)}…
              </span>
            </p>
          ) : null}
          {picked ? (
            <p>
              <span className={LABEL}>Chosen</span> <span className="break-all">{picked.name}</span>
              {picked.check.ok ? <span className={cx("font-code text-xs", TEXT_MUTED)}> · {picked.check.width}x{picked.check.height} px</span> : null}
            </p>
          ) : null}
        </div>
      </div>
      {picked && !picked.check.ok ? (
        <p role="alert" className="border-l-[6px] border-[#B91C1C] bg-danger-bg px-3 py-2 text-sm font-bold text-fg">
          {picked.check.message}
        </p>
      ) : null}
      {!readOnly ? (
        <div className="flex flex-wrap items-center gap-2">
          <input ref={inputRef} id={inputId} type="file" accept="image/png,image/webp" hidden onChange={(event) => void choose(event)} />
          <Button variant="secondary" onClick={() => inputRef.current?.click()}>
            <ImageUp className="h-4 w-4" aria-hidden="true" />
            Choose a PNG or WebP
          </Button>
          {picked?.check.ok ? (
            <Button loading={upload.status === "loading"} onClick={() => void send()}>
              Upload logo
            </Button>
          ) : null}
          {logo && !confirmRemove ? (
            <Button variant="ghost" onClick={() => setConfirmRemove(true)}>
              <Trash2 className="h-4 w-4" aria-hidden="true" />
              Remove logo
            </Button>
          ) : null}
          {confirmRemove ? (
            <span className="inline-flex flex-wrap items-center gap-2">
              <span className="text-sm font-bold">Remove the logo?</span>
              <Button size="sm" variant="ink" loading={remove.status === "loading"} onClick={() => void drop()}>
                Remove
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setConfirmRemove(false)}>
                Keep it
              </Button>
            </span>
          ) : null}
        </div>
      ) : null}
      <div aria-live="polite" className="flex flex-col gap-2">
        {notice ? <p className="border-l-[6px] border-[#0B7A4B] bg-success-bg px-3 py-2 text-sm text-fg">{notice}</p> : null}
        {upload.status === "error" && upload.error ? <ApiErrorPanel error={upload.error} title="Kletia refused the logo" /> : null}
        {remove.status === "error" && remove.error ? <ApiErrorPanel error={remove.error} title="Could not remove the logo" /> : null}
      </div>
      <p className={cx("text-xs", TEXT_MUTED)}>
        PNG or WebP, at most 64 KB, 32-512 px per side, width 1 to 4 times the height; no SVG, GIF or animation. Shown 20 px high in the widget
        header next to your verified name, never inside the fare, a review or a button.
      </p>
    </div>
  );
}
