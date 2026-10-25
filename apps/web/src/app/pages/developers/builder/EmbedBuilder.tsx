import { CHAINS, type NetworkKey } from "@kletia/core";
import React, { useId, useMemo, useState } from "react";

import { BACKEND_URL } from "../../../../shared/config/runtime";
import { Link } from "../../../routes/Link";
import { CodeBlock } from "../../../site/ui/CodeBlock";
import { SelectField, TextField } from "../../../site/ui/Field";
import { buttonClasses, cx, FOCUS_RING, HARD_SHADOW, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { BuilderPreview, type PreviewWidth } from "./BuilderPreview";
import {
  BUILDER_ACTIONS,
  BUILDER_COLORS,
  BUILDER_PRESETS,
  builderErrors,
  builderOutput,
  contrastNotes,
  DEFAULT_BUILDER_STATE,
  previewOptions,
  type BuilderColor,
  type BuilderMode,
  type BuilderOutput,
  type BuilderState,
} from "./builderModel";
import { useEmbedManifest } from "./useEmbedManifest";

const MODES: readonly { readonly id: BuilderMode; readonly label: string }[] = [
  { id: "text", label: "Text" },
  { id: "flow", label: "Stored flow" },
  { id: "session", label: "Session" },
  { id: "intent", label: "Intent id" },
];
const OUTPUTS: readonly { readonly id: BuilderOutput; readonly label: string; readonly filename: string; readonly language: "html" | "ts" | "tsx" }[] = [
  { id: "html", label: "HTML", filename: "index.html", language: "html" },
  { id: "npm", label: "npm", filename: "widget.js", language: "ts" },
  { id: "react", label: "React", filename: "Checkout.jsx", language: "tsx" },
  { id: "iframe", label: "iframe", filename: "index.html", language: "html" },
];
const COLOR_LABELS: Readonly<Record<BuilderColor, string>> = { accent: "Accent", ink: "Ink", surface: "Surface", line: "Line" };
const NETWORKS = Object.values(CHAINS);

/** A labelled group of mutually exclusive buttons (`role="radiogroup"`). */
function Choice<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { readonly id: T; readonly label: string }[];
  onChange: (value: T) => void;
}) {
  const labelId = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <p id={labelId} className={cx(LABEL, "text-fg")}>
        {label}
      </p>
      <div role="radiogroup" aria-labelledby={labelId} className="flex flex-wrap gap-1.5">
        {options.map((option) => (
          <button
            key={String(option.id)}
            type="button"
            role="radio"
            aria-checked={option.id === value}
            onClick={() => onChange(option.id)}
            className={cx(
              "min-h-10 border-2 border-control px-2.5 text-xs font-bold",
              option.id === value ? "bg-[#121212] text-white dark:bg-white dark:text-[#0E0E10]" : "bg-[#FBFAF6] text-fg dark:bg-[#0E0E10]",
              FOCUS_RING,
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** A colour field: picker and hex text; an invalid value shows an error and the preview keeps the last valid one. */
function ColorField({ color, value, error, onChange }: { color: BuilderColor; value: string; error?: string; onChange: (value: string) => void }) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className={cx(LABEL, "text-fg")}>
        {COLOR_LABELS[color]}
      </label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${COLOR_LABELS[color]} colour picker`}
          value={/^#[0-9A-Fa-f]{6}$/u.test(value) ? value : "#ffffff"}
          onChange={(event) => onChange(event.target.value.toUpperCase())}
          className={cx("h-10 w-10 shrink-0 cursor-pointer border-2 border-control bg-[#FBFAF6] p-0.5", FOCUS_RING)}
        />
        <input
          id={id}
          value={value}
          placeholder="stock"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => onChange(event.target.value.trim())}
          className={cx("min-h-10 w-full min-w-0 border-2 border-control bg-[#FBFAF6] px-2 font-code text-[13px] text-fg dark:bg-[#0E0E10]", FOCUS_RING)}
        />
      </div>
      {error ? (
        <p id={`${id}-error`} className="text-xs font-bold text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Network chips grouped by lane; mixing lanes is refused (one intent never spans both). */
function NetworkChips({ selected, onToggle, error }: { selected: readonly NetworkKey[]; onToggle: (network: NetworkKey) => void; error?: string }) {
  const lanes = [
    { id: "mainnet", label: "Production" },
    { id: "testnet", label: "Testnet" },
  ] as const;
  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className={cx(LABEL, "text-fg")}>Networks</legend>
      <p className={cx("text-xs", TEXT_MUTED)}>None selected: every network. The wallet bar offers only what the selection needs.</p>
      {lanes.map((lane) => (
        <div key={lane.id} className="flex flex-col gap-1">
          <p className={cx("text-[12px] font-bold uppercase tracking-[0.1em]", TEXT_MUTED)}>{lane.label}</p>
          <div className="flex flex-wrap gap-1.5">
            {NETWORKS.filter((chain) => (lane.id === "testnet") === (chain.environment === "testnet")).map((chain) => {
              const checked = selected.includes(chain.key as NetworkKey);
              return (
                <label key={chain.key} className={cx("flex min-h-10 cursor-pointer items-center gap-1.5 border-2 border-control px-2 text-xs font-bold", checked ? "bg-[#FFF3B0] dark:bg-[#3B2F0B]" : "bg-[#FBFAF6] dark:bg-[#0E0E10]")}>
                  <input type="checkbox" checked={checked} onChange={() => onToggle(chain.key as NetworkKey)} className="h-4 w-4 accent-[#2F5BFF]" />
                  {chain.name}
                </label>
              );
            })}
          </div>
        </div>
      ))}
      {error ? <p className="text-xs font-bold text-danger">{error}</p> : null}
    </fieldset>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details open className="group min-w-0 border-b-2 border-control/40 pb-4 last:border-b-0">
      <summary className={cx("cursor-pointer list-none py-2 font-display text-title font-bold", FOCUS_RING)}>
        <span aria-hidden="true" className="mr-1 inline-block transition-transform group-open:rotate-90 motion-reduce:transition-none">
          ▸
        </span>
        {title}
      </summary>
      <div className="flex min-w-0 flex-col gap-4 pt-2">{children}</div>
    </details>
  );
}

/**
 * The Embed builder: controls, a live preview of this deployment's
 * `/embed` and the code for four integrations. It never reads the portal's
 * in-memory key; publishable keys are typed in, checked and the only kind
 * of key that can reach the code.
 */
export function EmbedBuilder() {
  const webOrigin = typeof window === "undefined" ? "https://kletiaai.xyz" : window.location.origin;
  const origins = useMemo(() => ({ web: webOrigin, api: BACKEND_URL }), [webOrigin]);
  const manifestState = useEmbedManifest(webOrigin);
  const manifest = manifestState.status === "ready" ? manifestState.manifest : null;
  const [state, setState] = useState<BuilderState>(DEFAULT_BUILDER_STATE);
  const [width, setWidth] = useState<PreviewWidth>("480");
  const [pageColor, setPageColor] = useState("#F6EFE3");
  const [output, setOutput] = useState<BuilderOutput>("html");
  const errors = builderErrors(state);
  const notes = contrastNotes(state);
  const set = <K extends keyof BuilderState>(key: K, value: BuilderState[K]) => setState((current) => ({ ...current, [key]: value }));
  const setColor = (color: BuilderColor, value: string) => setState((current) => ({ ...current, colors: { ...current.colors, [color]: value } }));
  // The preview keeps the last valid colours while a field holds an invalid one.
  const [lastValid, setLastValid] = useState<BuilderState>(DEFAULT_BUILDER_STATE);
  const valid = BUILDER_COLORS.every((color) => !errors[color]);
  if (valid && lastValid !== state) setLastValid(state);
  const preview = useMemo(() => previewOptions(valid ? state : lastValid, webOrigin), [lastValid, state, valid, webOrigin]);
  const code = builderOutput(output, state, origins, manifest);
  const tab = OUTPUTS.find((item) => item.id === output) ?? OUTPUTS[0]!;

  return (
    <div className="grid min-w-0 gap-8 xl:grid-cols-[minmax(320px,380px)_minmax(0,1fr)]">
      <div className="order-2 flex min-w-0 flex-col gap-2 xl:order-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className={cx(LABEL, "text-fg")}>Presets</p>
          {BUILDER_PRESETS.map((preset) => (
            <button key={preset.id} type="button" className={buttonClasses("secondary", "sm")} onClick={() => setState((current) => ({ ...current, ...preset.apply }))}>
              {preset.label}
            </button>
          ))}
          <button type="button" className={buttonClasses("ghost", "sm")} onClick={() => setState(DEFAULT_BUILDER_STATE)}>
            Reset
          </button>
        </div>
        <Section title="Mode and prompt">
          <Choice label="Mode" value={state.mode} options={MODES} onChange={(mode) => set("mode", mode)} />
          {state.mode === "text" ? (
            <>
              <TextField label="Prompt" value={state.text} maxLength={500} error={errors.text} onChange={(event) => set("text", event.target.value)} />
              <TextField
                label="Examples"
                hint="Comma separated, at most 6."
                value={state.examples}
                error={errors.examples}
                onChange={(event) => set("examples", event.target.value)}
              />
            </>
          ) : null}
          {state.mode === "text" || state.mode === "flow" ? (
            <TextField
              label={state.mode === "flow" ? "Publishable key" : "Publishable key (optional)"}
              mono
              placeholder="kl_pub_…"
              autoComplete="off"
              spellCheck={false}
              value={state.publishableKey}
              error={errors.publishableKey}
              hint={
                <>
                  Browser-safe keys of your project, from <Link to="/developers/project" className="underline">Project settings</Link>. The preview
                  runs on <span className="font-code">{webOrigin}</span>: add that origin to the project&apos;s allowed origins to preview with the
                  key, next to your own site&apos;s origin.
                </>
              }
              onChange={(event) => set("publishableKey", event.target.value)}
            />
          ) : null}
          {state.mode === "flow" ? (
            <TextField label="Flow id" mono placeholder="deposit" value={state.flow} error={errors.flow} onChange={(event) => set("flow", event.target.value)} />
          ) : null}
          {state.mode === "session" ? (
            <TextField label="Session id" mono placeholder="cs_…" value={state.sessionId} error={errors.sessionId} hint="These ids come from your server." onChange={(event) => set("sessionId", event.target.value)} />
          ) : null}
          {state.mode === "intent" ? (
            <TextField label="Intent id" mono placeholder="int_…" value={state.intentId} error={errors.intentId} hint="These ids come from your server." onChange={(event) => set("intentId", event.target.value)} />
          ) : null}
          <TextField label="Reference" hint="Your order id, echoed in events. Never personal data." value={state.reference} error={errors.reference} onChange={(event) => set("reference", event.target.value)} />
        </Section>
        <Section title="Networks and actions">
          <NetworkChips
            selected={state.networks}
            error={errors.networks}
            onToggle={(network) =>
              setState((current) => ({
                ...current,
                networks: current.networks.includes(network) ? current.networks.filter((item) => item !== network) : [...current.networks, network],
              }))
            }
          />
          <SelectField
            label="Start on"
            value={state.sourceNetwork}
            onChange={(event) => set("sourceNetwork", event.target.value)}
            options={[
              { value: "", label: "Not set" },
              { value: "auto", label: "Auto (the funded network)" },
              ...state.networks.map((network) => ({ value: network, label: CHAINS[network]?.name ?? network })),
            ]}
          />
          <fieldset className="flex flex-col gap-1.5">
            <legend className={cx(LABEL, "text-fg")}>Actions</legend>
            <div className="flex flex-wrap gap-1.5">
              {BUILDER_ACTIONS.map((action) => (
                <label key={action} className="flex min-h-10 cursor-pointer items-center gap-1.5 border-2 border-control bg-[#FBFAF6] px-2 text-xs font-bold dark:bg-[#0E0E10]">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-[#2F5BFF]"
                    checked={state.actions.includes(action)}
                    onChange={() =>
                      setState((current) => ({
                        ...current,
                        actions: current.actions.includes(action) ? current.actions.filter((item) => item !== action) : [...current.actions, action],
                      }))
                    }
                  />
                  {action}
                </label>
              ))}
            </div>
          </fieldset>
        </Section>
        <Section title="Appearance">
          <Choice
            label="Theme"
            value={state.theme}
            options={[
              { id: "auto", label: "Auto" },
              { id: "light", label: "Light" },
              { id: "dark", label: "Dark" },
            ]}
            onChange={(theme) => set("theme", theme)}
          />
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
            {BUILDER_COLORS.map((color) => (
              <ColorField key={color} color={color} value={state.colors[color]} error={errors[color]} onChange={(value) => setColor(color, value)} />
            ))}
          </div>
          {notes.length > 0 ? (
            <ul className="flex flex-col gap-2" aria-label="Contrast warnings">
              {notes.map((note) => (
                <li key={`${note.color}:${note.message}`} className="border-2 border-[#B45309] bg-[#FFF3B0] p-2 text-xs font-semibold text-[#121212]">
                  {note.color ? `${COLOR_LABELS[note.color]}: ` : ""}
                  {note.message}
                  {note.fix && note.color ? (
                    <button type="button" className={cx("ml-2 underline", FOCUS_RING)} onClick={() => setColor(note.color!, note.fix!)}>
                      Use {note.fix}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="builder-radius" className={cx(LABEL, "text-fg")}>
              Radius · {state.radius} px
            </label>
            <input id="builder-radius" type="range" min={0} max={16} value={state.radius} onChange={(event) => set("radius", Number(event.target.value))} className={cx("accent-[#2F5BFF]", FOCUS_RING)} />
          </div>
          <Choice label="Border" value={state.border} options={[{ id: 1, label: "1" }, { id: 2, label: "2" }, { id: 3, label: "3" }]} onChange={(border) => set("border", border)} />
          <Choice label="Shadow" value={state.shadow} options={[{ id: "hard", label: "Hard" }, { id: "soft", label: "Soft" }, { id: "none", label: "None" }]} onChange={(shadow) => set("shadow", shadow)} />
          <SelectField
            label="Font"
            value={state.font}
            onChange={(event) => set("font", event.target.value as BuilderState["font"])}
            options={[
              { value: "inter", label: "Inter" },
              { value: "system", label: "System" },
              { value: "serif", label: "Serif" },
              { value: "mono", label: "Mono" },
              { value: "rounded", label: "Rounded" },
            ]}
          />
          <Choice label="Density" value={state.density} options={[{ id: "comfortable", label: "Comfortable" }, { id: "compact", label: "Compact" }]} onChange={(density) => set("density", density)} />
          <Choice label="Header" value={state.header} options={[{ id: "kletia", label: "Kletia" }, { id: "none", label: "None" }]} onChange={(header) => set("header", header)} />
          <Choice label="Widget background" value={state.transparent ? "transparent" : "page"} options={[{ id: "page", label: "Its own" }, { id: "transparent", label: "Transparent" }]} onChange={(bg) => set("transparent", bg === "transparent")} />
          <div className="grid grid-cols-2 gap-3">
            <TextField label="Height" type="number" min={320} max={4000} value={state.height} onChange={(event) => set("height", Math.min(4000, Math.max(320, Number(event.target.value) || 320)))} />
            <TextField label="Max height" type="number" min={320} max={4000} value={state.maxHeight} onChange={(event) => set("maxHeight", Math.min(4000, Math.max(320, Number(event.target.value) || 1600)))} />
          </div>
          <p className={cx("text-xs", TEXT_MUTED)}>
            The host notice, warnings, the fare, contract reviews, receipts and the footer never change with appearance.
          </p>
        </Section>
      </div>

      <div className="order-1 flex min-w-0 flex-col gap-6 xl:order-2">
        <section aria-labelledby="builder-preview" className={cx("flex min-w-0 flex-col gap-3 p-4", INK_BORDER, HARD_SHADOW, SURFACE)}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="builder-preview" className="font-display text-title font-bold">
              Preview
            </h2>
            <div className="flex flex-wrap items-center gap-3">
              <Choice label="Width" value={width} options={[{ id: "360", label: "360" }, { id: "480", label: "480" }, { id: "fluid", label: "Fluid" }]} onChange={setWidth} />
              <div className="flex flex-col gap-1.5">
                <label htmlFor="builder-page" className={cx(LABEL, "text-fg")}>
                  Your page
                </label>
                <input
                  id="builder-page"
                  type="color"
                  value={pageColor}
                  onChange={(event) => setPageColor(event.target.value)}
                  className={cx("h-10 w-14 cursor-pointer border-2 border-control bg-[#FBFAF6] p-0.5", FOCUS_RING)}
                />
              </div>
            </div>
          </div>
          <BuilderPreview options={preview} width={width} pageColor={pageColor} height={state.height} webOrigin={webOrigin} />
          <p className={cx("text-xs", TEXT_MUTED)}>The preview is this site&apos;s own /embed, framed the way your page will frame it. Nothing is signed here.</p>
        </section>

        <section aria-labelledby="builder-code" className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <h2 id="builder-code" className="font-display text-title font-bold">
              Code
            </h2>
            <Choice label="Output" value={output} options={OUTPUTS.map(({ id, label }) => ({ id, label }))} onChange={setOutput} />
          </div>
          {output === "html" && manifestState.status === "loading" ? (
            <p role="status" className={cx("text-sm", TEXT_MUTED)}>
              Reading the script&apos;s integrity from /sdk/embed/manifest.json…
            </p>
          ) : (
            <CodeBlock label={`${tab.label} embed code`} code={code} language={tab.language} filename={tab.filename} maxHeightClassName="max-h-[520px]" />
          )}
          {output === "html" && manifest ? (
            <p className={cx("text-xs", TEXT_MUTED)}>
              Script {manifest.version} from this site, pinned with its SHA-384 integrity: a changed file is refused by the browser.
            </p>
          ) : null}
          {state.mode === "session" || state.mode === "intent" ? (
            <p className={cx("text-xs", TEXT_MUTED)}>
              Session and intent ids come from your server, which keeps the API key:{" "}
              <a className="underline" href="https://github.com/furkan3152/Kletia/tree/main/examples/node-server" target="_blank" rel="noreferrer">
                node-server example
              </a>
              .
            </p>
          ) : null}
        </section>
      </div>
    </div>
  );
}
