/**
 * The sticky top of the desk. From 1024 px: a thin line (status lamp, the active task's title and
 * state word, the Tasks popover, the site menu). Under 1024 px: the mini nameplate bar (binder,
 * sound and night keys) and the mode bar, where the rotary dial becomes a segmented bar of the
 * six sections with a sliding key.
 */
import type { ReactNode } from "react";

import { Icon, Led, MiniPlate, Segmented, keyClass, useSoundEnabled, type IconName } from "../../../kit";
import { playSound } from "../../../kit/sound";
import type { SiteTheme } from "../../../site/theme";
import { DESK_COPY } from "../../content/copy";
import { PHONE_SECTIONS, type DeskSection } from "../../state/deskNav";
import { DESK_MORE_COPY } from "../deskCopy";

const copy = DESK_MORE_COPY.machine;
const header = DESK_COPY.header;

const SECTION_ICON: Record<DeskSection, IconName> = { desk: "desk", tasks: "tasks", portfolio: "port", trade: "trade", automate: "auto", more: "more" };

export interface MachineTopbarProps {
  readonly title: string;
  readonly status: string | null;
  readonly tone: "on" | "blue" | "magenta" | "off";
  readonly section: DeskSection;
  readonly onSection: (section: DeskSection) => void;
  readonly taskCount: number;
  readonly binderCount: number;
  readonly onOpenBinder: () => void;
  readonly theme: SiteTheme;
  readonly onToggleTheme: () => void;
  /** Right side of the wide topbar (Tasks popover, site menu). */
  readonly tools: ReactNode;
  /** The site menu on phones. */
  readonly phoneMenu: ReactNode;
  /** Shown while the start-up plays (skips it). */
  readonly onSkipBoot?: (() => void) | null;
}

export function MachineTopbar({ title, status, tone, section, onSection, taskCount, binderCount, onOpenBinder, theme, onToggleTheme, tools, phoneMenu, onSkipBoot }: MachineTopbarProps) {
  const [sound, setSound] = useSoundEnabled();
  return (
    <header className="kd-header">
      <div className="kd-topbar">
        <Led tone={tone} />
        <span className="kd-topbar-title">{title}</span>
        {status ? <span className="kd-topbar-status">{status}</span> : null}
        <span style={{ flex: 1 }} />
        {onSkipBoot ? (
          <button type="button" className={keyClass({ tone: "flat", size: "sm" })} onClick={onSkipBoot}>
            {copy.skipBoot}
          </button>
        ) : null}
        {tools}
      </div>
      <div className="kd-phonebar">
        <MiniPlate label={copy.homeLabel} />
        <span className="kd-sp" />
        {phoneMenu}
        <button type="button" className={keyClass({ size: "sm", square: true })} aria-label={copy.binderOpen(binderCount)} onClick={onOpenBinder}>
          <Icon name="binder" />
        </button>
        <button
          type="button"
          className={keyClass({ size: "sm", square: true })}
          role="switch"
          aria-checked={sound}
          aria-label={copy.sound}
          onClick={() => {
            setSound(!sound);
            playSound("toggle");
          }}
        >
          <Icon name={sound ? "snd" : "mute"} />
        </button>
        <button type="button" className={keyClass({ size: "sm", square: true })} aria-pressed={theme === "dark"} aria-label={copy.night} onClick={onToggleTheme}>
          <Icon name={theme === "dark" ? "sun" : "moon"} />
        </button>
      </div>
      <div className="kd-viewnav">
        <Segmented
          mode="page"
          fill
          ariaLabel={header.viewNavLabel}
          value={section}
          onChange={onSection}
          options={PHONE_SECTIONS.map((id) => ({
            id,
            ariaLabel: id === "tasks" ? header.tasksView(taskCount) : undefined,
            label: (
              <>
                <Icon name={SECTION_ICON[id]} />
                <span>{id === "tasks" ? header.tasksView(taskCount) : header.sections[id]}</span>
              </>
            ),
          }))}
        />
      </div>
    </header>
  );
}
