/**
 * Toast store: a tiny module-level queue with listeners and no React import,
 * so any module (and the router) can emit toasts cheaply. `Toaster.tsx`
 * renders them; toasts emitted before it mounts wait in the queue.
 *
 * A toast is never the only way to an action or a piece of information:
 * every action button (Retry, Show plan) must also exist inline.
 */

export type ToastTone = "info" | "success" | "error" | "warning";

export interface ToastAction {
  readonly label: string;
  readonly onClick: () => void;
}

export interface ToastOptions {
  readonly title: string;
  readonly description?: string;
  readonly tone?: ToastTone;
  readonly action?: ToastAction;
  /** ms, or "persistent" (until dismissed). Default: info/success 4 s, warning 6 s, error 8 s. */
  readonly duration?: number | "persistent";
  /** Same id replaces the existing toast instead of stacking. */
  readonly id?: string;
  /**
   * Render visually only, outside the live regions. Use it when another live
   * region already announced the same thing.
   */
  readonly silent?: boolean;
}

export interface ToastRecord {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly tone: ToastTone;
  readonly action?: ToastAction;
  readonly duration: number | "persistent";
  readonly silent: boolean;
  /** Increments when a toast with the same id is replaced (restarts its timer). */
  readonly revision: number;
  /** Exit animation in progress; removed shortly after. */
  readonly leaving: boolean;
}

export const DEFAULT_TOAST_DURATION: Readonly<Record<ToastTone, number>> = Object.freeze({
  info: 4000,
  success: 4000,
  warning: 6000,
  error: 8000,
});

/** Visible at once; the rest wait in order. */
export const MAX_VISIBLE_TOASTS = 3;
/** Exit animation length before a dismissed toast is removed. */
export const TOAST_EXIT_MS = 160;

type Listener = () => void;

let toasts: readonly ToastRecord[] = [];
let counter = 0;
const listeners = new Set<Listener>();
const removals = new Map<string, ReturnType<typeof setTimeout>>();

function emit() {
  for (const listener of [...listeners]) listener();
}

/** Pure: builds a record from options. */
export function createToastRecord(options: ToastOptions, id: string, revision = 0): ToastRecord {
  const tone = options.tone ?? "info";
  const duration =
    options.duration === "persistent"
      ? "persistent"
      : typeof options.duration === "number" && Number.isFinite(options.duration) && options.duration > 0
        ? options.duration
        : DEFAULT_TOAST_DURATION[tone];
  return {
    id,
    title: options.title,
    description: options.description,
    tone,
    action: options.action,
    duration,
    silent: options.silent ?? false,
    revision,
    leaving: false,
  };
}

/** Pure: inserts `record`, replacing (in place) a toast with the same id. */
export function upsertToast(list: readonly ToastRecord[], record: ToastRecord): readonly ToastRecord[] {
  const index = list.findIndex((toast) => toast.id === record.id);
  if (index < 0) return [...list, record];
  const next = [...list];
  next[index] = { ...record, revision: list[index]!.revision + 1 };
  return next;
}

/** Pure: the toasts on screen (oldest first, at most `max`, leaving ones included). */
export function visibleToasts(list: readonly ToastRecord[], max = MAX_VISIBLE_TOASTS): readonly ToastRecord[] {
  return list.slice(0, Math.max(0, max));
}

export function getToasts(): readonly ToastRecord[] {
  return toasts;
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function show(options: ToastOptions): string {
  const id = options.id ?? `kl-toast-${(counter += 1)}`;
  const pending = removals.get(id);
  if (pending !== undefined) {
    clearTimeout(pending);
    removals.delete(id);
  }
  toasts = upsertToast(toasts, createToastRecord(options, id));
  emit();
  return id;
}

function remove(id: string) {
  removals.delete(id);
  const next = toasts.filter((toast) => toast.id !== id);
  if (next.length === toasts.length) return;
  toasts = next;
  emit();
}

/** Starts the exit of one toast (by id) or of every toast. */
function dismiss(id?: string) {
  let changed = false;
  toasts = toasts.map((toast) => {
    if ((id !== undefined && toast.id !== id) || toast.leaving) return toast;
    changed = true;
    removals.set(
      toast.id,
      setTimeout(() => remove(toast.id), TOAST_EXIT_MS),
    );
    return { ...toast, leaving: true };
  });
  if (changed) emit();
}

type ShortcutOptions = Omit<ToastOptions, "title" | "tone">;

/**
 * Shows a toast and returns its id.
 *
 *   toast({ title: "Plan ready", description: "2 steps · 1 signature", tone: "success" });
 *   toast.success("Link copied", { id: "studio-link" });
 *   toast.error("Planning failed", { description, action: { label: "Retry", onClick: retry } });
 *   toast.dismiss(id);
 */
export const toast = Object.assign(show, {
  success: (title: string, options: ShortcutOptions = {}) => show({ ...options, title, tone: "success" }),
  error: (title: string, options: ShortcutOptions = {}) => show({ ...options, title, tone: "error" }),
  info: (title: string, options: ShortcutOptions = {}) => show({ ...options, title, tone: "info" }),
  warning: (title: string, options: ShortcutOptions = {}) => show({ ...options, title, tone: "warning" }),
  dismiss,
});
