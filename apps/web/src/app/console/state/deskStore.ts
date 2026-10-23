/**
 * The desk's state (console design 5.2): the next task's departure, the tasks
 * of this tab, focus, the signing lock, the engine pin set by tools, the task
 * the composer answers, and the current view. Derived data (accounts,
 * network status, holdings, URL state) lives in hooks, never here.
 *
 * Rules the store enforces whatever the components do:
 * - one task signs at a time: `acquireSigning` refuses a second task, and the
 *   lock is released when its task leaves `executing` or is removed;
 * - a signing task is never removed (unmounting its execution would cancel
 *   the run and refuse any open gate);
 * - the sentence, the question, the turns and the clarify thread stay in
 *   memory; the tab's index (`deskSession.ts`) keeps redacted titles only;
 * - the composer answers a task only while that task has an open question,
 *   and edits one only while it is armed for that task (`edit`).
 *
 * `createDeskStore` builds a vanilla store (node --test drives it); the app
 * uses the lazily created singleton through `useDeskStore`.
 */
import type { ClarifyQuestion, ClarifyThread, NetworkKey } from "@kletia/core";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";

import { readStorage, writeStorage } from "../../../shared/state/safeStorage.ts";
import {
  DEPARTURE_STORAGE_KEY,
  isLegacyNetwork,
  laneOf,
  parseDeparture,
  type Departure,
  type DeskView,
  type Lane,
  type LegacyNetwork,
} from "./deskModel.ts";
import {
  capTasks,
  createTaskId,
  deskIntentSessionKey,
  importLegacyResumeRecords,
  isFinishedStatus,
  isResumable,
  readTaskIndex,
  tabStorage,
  writeTaskIndex,
  type TabStorage,
  type TaskIndexEntry,
  type TaskOrigin,
} from "./deskSession.ts";

export type TaskEngine =
  | { readonly kind: "platform" }
  /** A read-only rate question answered from `GET /v1/venues` (nothing is planned or signed). */
  | { readonly kind: "rates" }
  | { readonly kind: "network"; readonly network: LegacyNetwork; readonly why: "tool" | "fallback" | "offer" };

export type TaskStatus =
  | "planning"
  | "preview"
  | "question"
  | "review"
  | "executing"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "unsupported"
  | "engine";

/**
 * What is known about the wallet's signatures for a task's intent (memory
 * only): "signed" once a wallet returned a reference, "unknown" while a
 * request is open or its outcome never came back, "none" when nothing was
 * signed. Only "signed" may be shown as signed.
 */
export type SignatureState = "none" | "unknown" | "signed";

/** One open question on a task (console design 3.11, widened by the clarify design 8.1). */
export interface DeskQuestion {
  readonly id: string;
  readonly kind: "clarify" | "journey" | (string & {});
  /** "Where should the 25 USDC come from?" */
  readonly prompt: string;
  readonly options: readonly {
    readonly id: string;
    readonly label: string;
    readonly detail?: string;
    readonly network?: NetworkKey;
    readonly recommended?: boolean;
  }[];
  /** Free-text answers through the composer's Answering chip. */
  readonly allowsText: boolean;
  /** clarify: up to two independent questions shown in one card (R12); the first mirrors the fields above. */
  readonly questions?: readonly ClarifyQuestion[];
}

/** A structured answer to one of the open clarify questions (the id is the question's). */
export interface TaskAnswer {
  readonly question: string;
  readonly option?: string;
  readonly text?: string;
}

export type TaskTurn =
  /** The sentence itself is `TaskRecord.sentence`. */
  | { readonly kind: "sentence"; readonly at: number }
  /** The user answered: `label` as shown (a chip's label or the typed text), `answer` when a chip of a known question was chosen. */
  | { readonly kind: "answer"; readonly at: number; readonly label: string; readonly answer?: TaskAnswer }
  /** A follow-up typed with the Editing chip ("make it 2", "undo", "cancel"); memory only. */
  | { readonly kind: "edit"; readonly at: number; readonly text: string }
  /** Another value for one of Kletia's assumptions (an "assumed" chip). */
  | { readonly kind: "assumption"; readonly at: number; readonly id: string; readonly option: string; readonly label: string }
  /** What Kletia answered: the question it asked, or the sentence it planned. */
  | { readonly kind: "kletia"; readonly at: number; readonly label: string }
  | { readonly kind: "note"; readonly at: number; readonly text: string };

export interface TaskRecord {
  /** uuid: also the resume key suffix and the legacy thread id. */
  readonly id: string;
  readonly createdAt: number;
  /** As typed; memory only, never persisted. Empty for a task restored after a reload. */
  readonly sentence: string;
  /** `summary.title` once planned, the sentence before; persisted redacted. */
  readonly title: string;
  /** What the user chose for this task; later tasks never change it. */
  readonly departure: Departure;
  readonly lane: Lane;
  readonly engine: TaskEngine;
  /** The platform intent once persisted (or the dry run's id). */
  readonly intentId: string | null;
  readonly status: TaskStatus;
  /** At most one open question. */
  readonly question: DeskQuestion | null;
  readonly turns: readonly TaskTurn[];
  readonly ends: { readonly from: NetworkKey; readonly to: NetworkKey } | null;
  /** Restored from the tab's index after a reload: sentence, question and turns are gone. */
  readonly restored?: boolean;
  /** Picked up once from a Studio or Solana Ask resume record. */
  readonly origin?: TaskOrigin;
  /**
   * The task's clarify thread (client-held, clarify design 5.2 and 5.5), sent
   * back with every turn. Memory only: never persisted, never shared with
   * another task, gone after a reload (open questions are then cleared).
   */
  readonly thread?: ClarifyThread | null;
  /** The signature state of the task's intent while it signs (absent: not known, treated as "unknown"). */
  readonly signature?: SignatureState;
}

export interface NewTask {
  readonly sentence: string;
  readonly departure: Departure;
  readonly engine?: TaskEngine;
  readonly title?: string;
  readonly status?: TaskStatus;
}

export type TaskPatch = Partial<Pick<TaskRecord, "title" | "intentId" | "status" | "question" | "ends" | "engine" | "lane" | "thread" | "signature">> & {
  /** Appended to the task's turns. */
  readonly turn?: TaskTurn;
};

export interface DeskState {
  /** The next task's departure (localStorage, mirrored to `?from=` by the desk). */
  readonly departure: Departure;
  /** Tasks of this tab in creation order. */
  readonly tasks: readonly TaskRecord[];
  readonly focusedTaskId: string | null;
  /** The signing lock. */
  readonly signingTaskId: string | null;
  /** Set by a tool: the next sentence goes to that network engine. */
  readonly enginePin: LegacyNetwork | null;
  /** The task whose open question the composer answers. */
  readonly answering: string | null;
  /** The task the composer's next message edits (its Edit button armed the Editing chip). */
  readonly editing: string | null;
  readonly view: DeskView;
  readonly toolId: string | null;
  setDeparture(departure: Departure): void;
  addTask(task: NewTask): TaskRecord;
  /**
   * A stored intent planned elsewhere (an automation run from the inbox) as a
   * paused task: it opens "Pick up" and signs through the normal flow. An
   * intent already on the desk is focused instead.
   */
  adoptIntent(input: { readonly intentId: string; readonly title: string }): TaskRecord;
  patchTask(id: string, patch: TaskPatch): void;
  /** Refused (false) for the signing task. */
  removeTask(id: string): boolean;
  clearFinished(): void;
  focusTask(id: string | null): void;
  /** True when this task now holds the signing lock (or already did). */
  acquireSigning(id: string): boolean;
  releaseSigning(id: string): void;
  pinEngine(network: LegacyNetwork | null): void;
  answer(id: string | null): void;
  /** Arms (or clears) the composer's Editing chip for a planned task. */
  edit(id: string | null): void;
  setView(view: DeskView): void;
  openTool(toolId: string | null): void;
}

export interface DeskStoreOptions {
  /** Tab storage for the index and the resume records (default: guarded sessionStorage). */
  readonly storage?: TabStorage;
  /** Per-browser departure choice (default: guarded localStorage). */
  readonly departureStorage?: { read(): string | null; write(value: string): void };
  readonly newId?: () => string;
  readonly now?: () => number;
}

const browserDepartureStorage = {
  read: () => readStorage(DEPARTURE_STORAGE_KEY),
  write: (value: string) => writeStorage(DEPARTURE_STORAGE_KEY, value),
};

/**
 * A task as restored after a reload. A persisted intent that was in review or
 * executing comes back paused (the desk offers "Pick up where you left off";
 * nothing resumes on its own). Planning and dry-run previews have nothing left
 * to show (the sentence stays in memory only) and are not restored. An open
 * question is cleared.
 */
export function restoreTask(entry: TaskIndexEntry): TaskRecord | null {
  if (entry.status === "planning" || entry.status === "preview") return null;
  const resumable = isResumable(entry);
  const status: TaskStatus = resumable
    ? "paused"
    : entry.status === "review" || entry.status === "executing" || entry.status === "paused"
      ? "cancelled"
      : entry.status;
  return {
    id: entry.id,
    createdAt: entry.createdAt,
    sentence: "",
    title: entry.title,
    departure: entry.departure,
    lane: entry.lane,
    engine: entry.engine,
    intentId: entry.intentId,
    status,
    question: null,
    turns: [],
    ends: entry.ends,
    thread: null,
    restored: true,
    ...(entry.origin ? { origin: entry.origin } : {}),
  };
}

export function createDeskStore(options: DeskStoreOptions = {}): StoreApi<DeskState> {
  const storage = options.storage ?? tabStorage;
  const departureStorage = options.departureStorage ?? browserDepartureStorage;
  const newId = options.newId ?? createTaskId;
  const now = options.now ?? Date.now;

  const entries = readTaskIndex(storage);
  const imported = importLegacyResumeRecords({ existing: entries, storage, newId, now: now() });
  const restored = [...entries, ...imported].map(restoreTask).filter((task): task is TaskRecord => task !== null);
  const initialDeparture = parseDeparture(departureStorage.read()) ?? "auto";

  const forget = (ids: readonly string[]) => {
    for (const id of ids) storage.removeItem(deskIntentSessionKey(id));
  };

  const store = createStore<DeskState>()((set, get) => ({
    departure: initialDeparture,
    tasks: restored,
    focusedTaskId: null,
    signingTaskId: null,
    enginePin: null,
    answering: null,
    editing: null,
    view: "desk",
    toolId: null,

    setDeparture(departure) {
      const parsed = parseDeparture(departure);
      if (!parsed) return;
      departureStorage.write(parsed);
      set({ departure: parsed });
    },

    addTask(input) {
      const sentence = input.sentence.trim();
      const task: TaskRecord = {
        id: newId(),
        createdAt: now(),
        sentence,
        title: input.title ?? sentence,
        departure: input.departure,
        lane: laneOf(input.departure),
        engine: input.engine ?? { kind: "platform" },
        intentId: null,
        status: input.status ?? "planning",
        question: null,
        turns: [{ kind: "sentence", at: now() }],
        ends: null,
        thread: null,
      };
      const { kept, dropped } = capTasks([...get().tasks, task]);
      forget(dropped.map((entry) => entry.id));
      set({ tasks: kept, focusedTaskId: task.id, answering: null, editing: null, enginePin: null });
      return task;
    },

    adoptIntent({ intentId, title }) {
      const known = get().tasks.find((task) => task.intentId === intentId);
      if (known) {
        set({ focusedTaskId: known.id });
        return known;
      }
      const task: TaskRecord = {
        id: newId(),
        createdAt: now(),
        sentence: "",
        title,
        departure: "auto",
        lane: "production",
        engine: { kind: "platform" },
        intentId,
        status: "paused",
        question: null,
        turns: [],
        ends: null,
        thread: null,
        restored: true,
        origin: "automation",
      };
      // The execution hook resumes from this record (intentSession.ts format), nothing signed yet.
      storage.setItem(deskIntentSessionKey(task.id), JSON.stringify({ v: 1, intentId, savedAt: now(), signing: {}, references: {} }));
      const { kept, dropped } = capTasks([...get().tasks, task]);
      forget(dropped.map((entry) => entry.id));
      set({ tasks: kept, focusedTaskId: task.id, answering: null, editing: null });
      return task;
    },

    patchTask(id, patch) {
      const state = get();
      const current = state.tasks.find((task) => task.id === id);
      if (!current) return;
      const { turn, ...fields } = patch;
      if (fields.engine && fields.engine.kind === "network" && !isLegacyNetwork(fields.engine.network)) return;
      const next: TaskRecord = {
        ...current,
        ...fields,
        turns: turn ? [...current.turns, turn] : current.turns,
      };
      // The lock goes with the execution: released when the task leaves `executing`, or
      // finishes before it got there (an execution that failed while preparing).
      const leavesExecution =
        state.signingTaskId === id &&
        ((current.status === "executing" && next.status !== "executing") || isFinishedStatus(next.status));
      const answeringClosed = state.answering === id && (next.question === null || isFinishedStatus(next.status));
      // A task that started signing (or finished) can no longer be edited.
      const editingClosed = state.editing === id && !isEditable(next);
      set({
        tasks: state.tasks.map((task) => (task.id === id ? next : task)),
        ...(leavesExecution ? { signingTaskId: null } : {}),
        ...(answeringClosed ? { answering: null } : {}),
        ...(editingClosed ? { editing: null } : {}),
      });
    },

    removeTask(id) {
      const state = get();
      const task = state.tasks.find((entry) => entry.id === id);
      if (!task) return true;
      if (state.signingTaskId === id || task.status === "executing") return false;
      forget([id]);
      set({
        tasks: state.tasks.filter((entry) => entry.id !== id),
        focusedTaskId: state.focusedTaskId === id ? null : state.focusedTaskId,
        answering: state.answering === id ? null : state.answering,
        editing: state.editing === id ? null : state.editing,
      });
      return true;
    },

    clearFinished() {
      const state = get();
      const finished = state.tasks.filter((task) => isFinishedStatus(task.status) && task.id !== state.signingTaskId);
      if (finished.length === 0) return;
      const ids = new Set(finished.map((task) => task.id));
      forget([...ids]);
      set({
        tasks: state.tasks.filter((task) => !ids.has(task.id)),
        focusedTaskId: state.focusedTaskId && ids.has(state.focusedTaskId) ? null : state.focusedTaskId,
        answering: state.answering && ids.has(state.answering) ? null : state.answering,
        editing: state.editing && ids.has(state.editing) ? null : state.editing,
      });
    },

    focusTask(id) {
      if (id !== null && !get().tasks.some((task) => task.id === id)) return;
      set({ focusedTaskId: id });
    },

    acquireSigning(id) {
      const state = get();
      if (!state.tasks.some((task) => task.id === id)) return false;
      if (state.signingTaskId !== null && state.signingTaskId !== id) return false;
      if (state.signingTaskId !== id) set({ signingTaskId: id });
      return true;
    },

    releaseSigning(id) {
      if (get().signingTaskId === id) set({ signingTaskId: null });
    },

    pinEngine(network) {
      if (network !== null && !isLegacyNetwork(network)) return;
      set({ enginePin: network });
    },

    answer(id) {
      if (id === null) {
        set({ answering: null });
        return;
      }
      const task = get().tasks.find((entry) => entry.id === id);
      if (!task || task.question === null || isFinishedStatus(task.status)) return;
      set({ answering: id, editing: null, focusedTaskId: id });
    },

    edit(id) {
      if (id === null) {
        set({ editing: null });
        return;
      }
      const task = get().tasks.find((entry) => entry.id === id);
      if (!task || !isEditable(task)) return;
      set({ editing: id, answering: null, focusedTaskId: id });
    },

    setView(view) {
      set({ view, ...(view === "tools" ? {} : { toolId: null }) });
    },

    openTool(toolId) {
      set({ view: "tools", toolId });
    },
  }));

  // The index follows the task list: redacted titles, capped, every change.
  writeTaskIndex(store.getState().tasks, storage);
  store.subscribe((state, previous) => {
    if (state.tasks !== previous.tasks) writeTaskIndex(state.tasks, storage);
  });
  return store;
}

/**
 * A task the composer may edit (clarify design 8.3 W5): a platform task with
 * a plan or a question and a sentence in memory, before anything is signed.
 */
export function isEditable(task: Pick<TaskRecord, "engine" | "status" | "sentence">): boolean {
  return task.engine.kind === "platform" && task.sentence.length > 0 && (task.status === "preview" || task.status === "review" || task.status === "question");
}

let deskStoreInstance: StoreApi<DeskState> | null = null;

/** The app's desk store, created on first use (never at import, so tests and site routes touch no storage). */
export function getDeskStore(): StoreApi<DeskState> {
  deskStoreInstance ??= createDeskStore();
  return deskStoreInstance;
}

export function useDeskStore<T>(selector: (state: DeskState) => T): T {
  return useStore(getDeskStore(), selector);
}

/** Tasks for the list: newest first (a later task wins a tie on time). */
export function tasksNewestFirst(state: Pick<DeskState, "tasks">): readonly TaskRecord[] {
  return state.tasks
    .map((task, index) => ({ task, index }))
    .sort((a, b) => b.task.createdAt - a.task.createdAt || b.index - a.index)
    .map((entry) => entry.task);
}
