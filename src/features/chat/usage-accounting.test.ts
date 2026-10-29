import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "./store";
import { handleEngineEvents, type ChatEngineEvent, type EngineEventDeps } from "./store/engine-events";
import { sessionKey } from "./store/persistence";
import { EMPTY_SESSION, runRouting } from "./store/stream";
import { parseUsage } from "./usage";

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

const KEY = sessionKey("codex", "s-1", "/tmp/ws");
let runCounter = 0;
let runId: string;

function deps(): EngineEventDeps {
  return {
    set: useChatStore.setState,
    get: useChatStore.getState,
    drainQueue: () => {},
    markUnseenIfBackground: () => {},
    upsertSessionMeta: () => {},
  };
}

function event(kind: ChatEngineEvent["kind"], seq: number, data: unknown, engine = "codex"): ChatEngineEvent {
  return { runId, sessionId: "s-1", engine, seq, kind, data };
}

function report(inputTokens: number, outputTokens: number) {
  return { last_token_usage: { input_tokens: inputTokens, output_tokens: outputTokens } };
}

function session() {
  return useChatStore.getState().bySession[KEY]!;
}

describe("usage accounting", () => {
  beforeEach(() => {
    runId = `usage-run-${++runCounter}`;
    localStorage.clear();
    vi.clearAllMocks();
    runRouting.clear();
    runRouting.set(runId, KEY);
    useChatStore.setState({
      openTabs: [],
      active: null,
      bySession: {
        [KEY]: {
          ...EMPTY_SESSION,
          streaming: true,
          messages: [{ seq: 2, role: "assistant", text: "…", live: true, ts: null }],
        },
      },
      streamingByKey: {},
    });
  });

  it("sums the reply's reports for the strip and keeps occupancy separate", () => {
    handleEngineEvents([event("usage", 2, report(1000, 40))], deps());
    handleEngineEvents([event("usage", 3, report(500, 10))], deps());
    // The strip counts what this reply spent...
    expect(parseUsage(session().turnUsage)).toMatchObject({ input: 1500, output: 50 });
    // ...while the context meter still reads the newest single report.
    expect(parseUsage(session().usage)).toMatchObject({ input: 500, output: 10 });

    handleEngineEvents([event("done", 9, { usage: report(1500, 50) })], deps());
    // The aggregate in done must not replace the newest context occupancy.
    // The settled row carries the reply's total, and the running counter is
    // gone so the next reply starts from zero.
    const settled = session();
    expect(parseUsage(settled.turnUsage)).toBeNull();
    const assistant = settled.messages.filter((m) => m.role === "assistant").at(-1);
    expect(parseUsage(assistant?.usage)).toMatchObject({ input: 1500, output: 50 });
    expect(parseUsage(settled.usage)).toMatchObject({ input: 500, output: 10 });
  });

  it("stamps Claude's resolved custom model instead of the selected family alias", () => {
    const tab = { engine: "claude", sessionId: "s-1", workspacePath: "/tmp/ws", model: "haiku" };
    const key = sessionKey(tab.engine, tab.sessionId, tab.workspacePath);
    const model = "gpt-6-astra-cc-format[1m]";
    runRouting.set(runId, key);
    useChatStore.setState({
      active: tab,
      openTabs: [tab],
      models: { claude: "sonnet" },
      bySession: { [key]: { ...EMPTY_SESSION, streaming: true, activeModel: tab.model } },
    });

    handleEngineEvents([
      event("model", 1, model, "claude"),
      event("delta", 2, "Custom model reply", "claude"),
      event("done", 3, { usage: { input_tokens: 7, output_tokens: 3 } }, "claude"),
    ], deps());

    expect(useChatStore.getState().bySession[key]!.messages.at(-1)).toMatchObject({
      role: "assistant", text: "Custom model reply", model, live: false,
    });
    // Keep the selector for the next send: aliases must still follow channel remaps.
    expect(useChatStore.getState().openTabs[0].model).toBe("haiku");
  });

});
