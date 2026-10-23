/**
 * The desk's sticky header: the Kletia mark and "Console", a site menu
 * (Home, Studio, Developers), the view nav (Desk, Tools, Activity) from
 * 1024 px, a "Tasks (n)" popover between 1024 and 1279 px (the left rail
 * shows the list wider than that), both wallets and the site theme
 * toggle.
 */
import { useEffect, useId, useRef, useState } from "react";

import { Link } from "../../routes/Link";
import { KletiaMark } from "../../site/KletiaMark";
import { ThemeToggle } from "../../site/ThemeToggle";
import type { SiteTheme } from "../../site/theme";
import { DESK_COPY } from "../content/copy";
import type { DeskView } from "../state/deskModel";
import { TaskList } from "../tasks/TaskList";
import { DeskSiteMenu } from "./DeskSiteMenu";
import { WalletBar } from "./WalletBar";

const copy = DESK_COPY.header;

const NAV_ITEM =
  "inline-flex min-h-11 items-center whitespace-nowrap px-3 text-xs font-black uppercase tracking-[0.14em] text-fg underline-offset-8 hover:underline focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[var(--kl-focus)] aria-[current=page]:underline aria-[current=page]:decoration-[3px]";

export interface DeskHeaderProps {
  readonly view: DeskView;
  readonly onView: (view: DeskView) => void;
  readonly taskCount: number;
  readonly onOpenTask: (taskId: string) => void;
  readonly onNewTask: () => void;
  readonly theme: SiteTheme;
  readonly onToggleTheme: (origin?: { x: number; y: number }) => void;
}

function TasksPopover({ count, onOpenTask, onNewTask }: { readonly count: number; readonly onOpenTask: (id: string) => void; readonly onNewTask: () => void }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, [open]);
  return (
    <div ref={rootRef} className="relative hidden lg:block xl:hidden">
      <button ref={buttonRef} type="button" className={NAV_ITEM} aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((current) => !current)}>
        {copy.tasksButton(count)}
      </button>
      {open ? (
        <div id={panelId} className="absolute left-0 top-full z-50 mt-2 max-h-[70dvh] w-80 overflow-y-auto border-[3px] border-control bg-[var(--kl-paper)] p-3 shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569]">
          <TaskList
            headingLevel={2}
            onOpenTask={(id) => {
              setOpen(false);
              onOpenTask(id);
            }}
            onNewTask={() => {
              setOpen(false);
              onNewTask();
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

export function DeskHeader({ view, onView, taskCount, onOpenTask, onNewTask, theme, onToggleTheme }: DeskHeaderProps) {
  const item = (target: DeskView, label: string) => (
    <button type="button" className={NAV_ITEM} aria-current={view === target ? "page" : undefined} onClick={() => onView(target)}>
      {label}
    </button>
  );
  return (
    <header className="kd-header">
      <div className="mx-auto flex h-full max-w-[1440px] items-center gap-2 px-4 lg:gap-4 lg:px-6">
        <Link to="/" className="group flex shrink-0 items-center gap-2 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[var(--kl-focus)]" aria-label={`${copy.brand} home`}>
          <KletiaMark size="sm" />
          <span className="hidden font-display text-lg font-bold uppercase tracking-[0.08em] sm:inline">{copy.brand}</span>
        </Link>
        <span className="hidden border-l-[3px] border-[var(--kl-line)] pl-2 text-xs font-black uppercase tracking-[0.16em] sm:inline">{copy.product}</span>
        <DeskSiteMenu />
        <nav aria-label={copy.navLabel} className="ml-2 hidden items-center lg:flex">
          {item("desk", copy.views.desk)}
          {item("tools", copy.views.tools)}
          {item("activity", copy.views.activity)}
          {item("perps", copy.views.perps)}
        </nav>
        <TasksPopover count={taskCount} onOpenTask={onOpenTask} onNewTask={onNewTask} />
        <div className="ml-auto flex min-w-0 items-center gap-2">
          <WalletBar />
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        </div>
      </div>
    </header>
  );
}
