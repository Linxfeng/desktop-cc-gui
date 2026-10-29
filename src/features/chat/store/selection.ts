/**
 * Session selection for plugin events: the channel a session runs with and
 * the model selector the picker spells. Facts only — deriving a provider id
 * from a `provider/model` selector stays with the plugin, which knows its
 * engine's selector convention.
 */

import {
  emitSessionSelectionChanged,
  type SessionSelection,
} from "@/features/plugins/runtime/events";
import { PSEUDO_LOCAL } from "@/features/settings/providers";
import { sameTab, sessionKey, type ActiveSession } from "./persistence";
import {
  resolveSessionModel,
  resolveSessionProvider,
  type SessionState,
} from "./stream";

/** The slice of the chat store the resolver reads. */
export interface SelectionState {
  active: ActiveSession | null;
  openTabs: ActiveSession[];
  bySession: Record<
    string,
    Pick<SessionState, "activeProvider" | "activeModel" | "messages">
  >;
  providers: Record<string, string>;
  models: Record<string, string>;
  /** Session rows: the only place that remembers a session's last model
   *  before its history has loaded. */
  sessions: { engine: string; sessionId: string; model?: string | null; provider?: string | null }[];
}

/**
 * Resolve what `engine`/`sessionId` runs right now — the same precedence the
 * composer menus show (tab pick → session state → history → engine default).
 *
 * `provider` is the selected channel id; the pseudo "use the engine's own
 * settings" marker is reported as null so plugins never have to know host
 * sentinels. `model` is the picker's selector (may include a `provider/`
 * prefix, e.g. `deepseek/deepseek-flash`) or null for the CLI default.
 */
export function sessionSelection(
  state: SelectionState,
  engine: string,
  sessionId: string | null,
  workspacePath: string,
): SessionSelection {
  // `active` first: a session event adopting the pending tab moves `active`
  // and `openTabs` in two separate sets, and the watcher below runs between
  // them — the stale tab-strip entry must not read as a model change.
  const tab =
    state.active && sameTab(state.active, engine, sessionId, workspacePath)
      ? state.active
      : state.openTabs.find((item) =>
          sameTab(item, engine, sessionId, workspacePath),
        );
  const target = tab ?? { engine, sessionId };
  const session = state.bySession[sessionKey(engine, sessionId, workspacePath)];
  const ownChannel = resolveSessionProvider(target, session);
  const ownModel = resolveSessionModel(target, session);
  // The row scan only runs when the tab and the session say nothing: the
  // watcher resolves on every stream flush of the active session.
  const meta =
    sessionId && (ownChannel === undefined || ownModel === undefined)
      ? state.sessions.find(
          (item) => item.engine === engine && item.sessionId === sessionId,
        )
      : undefined;
  const channel = ownChannel ?? meta?.provider ?? state.providers[engine];
  const model = ownModel ?? meta?.model ?? state.models[engine];
  return {
    provider: channel && channel !== PSEUDO_LOCAL ? channel : null,
    model: model || null,
  };
}

/**
 * Keep plugins in step with what the active session runs: any store change
 * that moves its provider or model emits `session://selection-changed` once,
 * whichever path made it — the composer pickers, a channel edit in Settings
 * (refreshEngines), history that reveals the model, a pick made in another
 * window (refreshSessions), or the model the engine reports running.
 *
 * Moving to another session is not a change here: activateTab, selectSession,
 * startNewChat and the native-id adoption announce it with
 * `session://activated`. Returns the unsubscribe.
 */
export function watchSessionSelection(
  subscribe: (listener: (state: SelectionState) => void) => () => void,
): () => void {
  let last: { key: string; selection: SessionSelection } | null = null;
  let inputs: readonly unknown[] = [];
  return subscribe((state) => {
    const active = state.active;
    if (!active) {
      last = null;
      inputs = [];
      return;
    }
    const key = sessionKey(active.engine, active.sessionId, active.workspacePath);
    const session = state.bySession[key];
    // The session's fields, not its record: usage and status patches swap
    // the record without touching the selection, and resolving would walk
    // the history again. Most other writes (other sessions' stream flushes,
    // drafts, unseen marks) touch none of the inputs.
    const next = [
      active,
      state.openTabs,
      session?.activeProvider,
      session?.activeModel,
      session?.messages,
      state.providers,
      state.models,
      state.sessions,
    ];
    if (next.every((value, i) => value === inputs[i])) return;
    inputs = next;
    const selection = sessionSelection(
      state,
      active.engine,
      active.sessionId,
      active.workspacePath,
    );
    const previous = last;
    last = { key, selection };
    if (
      previous?.key !== key ||
      (previous.selection.provider === selection.provider &&
        previous.selection.model === selection.model)
    ) {
      return;
    }
    emitSessionSelectionChanged(active.engine, active.sessionId, selection);
  });
}
