import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "./store";
import { handleEngineEvents, settledRuns, type EngineEventDeps } from "./store/engine-events";
import { sessionKey } from "./store/persistence";
import { EMPTY_SESSION, runRouting } from "./store/stream";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    rescanSessions: vi.fn(async () => {}),
  },
}));
vi.mock("@/lib/events", () => ({
  listenEngineEvents: vi.fn(async () => () => {}),
  listenSessionsChanged: vi.fn(async () => () => {}),
  listenComputerUseEscape: vi.fn(async () => () => {}),
}));

const KEY = sessionKey("claude", "s-1", "/tmp/ws");

function deps(): EngineEventDeps {
  return {
    set: useChatStore.setState,
    get: useChatStore.getState,
    drainQueue: () => {},
    markUnseenIfBackground: () => {},
    upsertSessionMeta: () => {},
  };
}

function ev(kind: "delta" | "done" | "turn_resumed", seq: number, data: unknown) {
  return { runId: "run-bg", sessionId: "s-1", engine: "claude", seq, kind, data };
}

describe("a CLI turn that follows a background task", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    runRouting.clear();
    settledRuns.clear();
    useChatStore.setState({
      openTabs: [],
      active: null,
      unseen: {},
      bySession: {
        [KEY]: {
          ...EMPTY_SESSION,
          messages: [{ seq: 1, role: "user", text: "sleep 10 in background", ts: null }],
        },
      },
      streamingByKey: {},
    });
  });

  it("goes idle at the first done, runs again for the follow-up, and settles again", () => {
    handleEngineEvents([ev("delta", 1, "started"), ev("done", 2, { usage: null })], deps());
    expect(useChatStore.getState().bySession[KEY]!.streaming).toBe(false);
    expect(useChatStore.getState().streamingByKey[KEY]).toBeFalsy();

    handleEngineEvents([ev("turn_resumed", 3, null), ev("delta", 4, "finished")], deps());
    expect(useChatStore.getState().bySession[KEY]!.streaming).toBe(true);
    expect(useChatStore.getState().streamingByKey[KEY]).toBe(true);

    handleEngineEvents([ev("done", 5, { usage: null })], deps());
    const session = useChatStore.getState().bySession[KEY]!;
    expect(session.streaming).toBe(false);
    const assistantText = session.messages
      .filter((m) => m.role === "assistant")
      .map((m) => m.text)
      .join("|");
    expect(assistantText).toContain("started");
    expect(assistantText).toContain("finished");
  });

  it("reopens the same run again for a message sent while the task was running", () => {
    handleEngineEvents([ev("delta", 1, "started"), ev("done", 2, { usage: null })], deps());
    handleEngineEvents(
      [ev("turn_resumed", 3, null), ev("delta", 4, "PONG2"), ev("done", 5, { usage: null })],
      deps(),
    );
    expect(useChatStore.getState().bySession[KEY]!.streaming).toBe(false);

    handleEngineEvents(
      [ev("turn_resumed", 6, null), ev("delta", 7, "BGFINISHED"), ev("done", 8, { usage: null })],
      deps(),
    );
    const session = useChatStore.getState().bySession[KEY]!;
    expect(session.streaming).toBe(false);
    const assistantText = session.messages
      .filter((m) => m.role === "assistant")
      .map((m) => m.text)
      .join("|");
    expect(assistantText).toContain("PONG2");
    expect(assistantText).toContain("BGFINISHED");
  });

  it("drops a delta that arrives after done without a resume marker", () => {
    handleEngineEvents([ev("delta", 1, "started"), ev("done", 2, { usage: null })], deps());
    handleEngineEvents([ev("delta", 3, "stray")], deps());
    expect(useChatStore.getState().bySession[KEY]!.streaming).toBe(false);
  });
});
