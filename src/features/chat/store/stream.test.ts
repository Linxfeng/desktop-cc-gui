import { describe, expect, it } from "vitest";
import type { Message } from "@/lib/ipc";
import { appendToolMessage, appendToolMessages, applyStreamParts, settleLiveRows, EMPTY_SESSION, type BySessionSlice } from "./stream";

function harness() {
  let state: BySessionSlice = { bySession: { k: { ...EMPTY_SESSION, messages: [] } } };
  const set = (fn: (s: BySessionSlice) => Partial<BySessionSlice>) => {
    state = { ...state, ...fn(state) };
  };
  return {
    set,
    messages: () => state.bySession.k.messages,
  };
}

describe("appendToolMessage", () => {
  it("stores args on a new tool row", () => {
    const h = harness();
    appendToolMessage(h.set, "k", "Read", null, "src/a.ts", null, { file_path: "src/a.ts" });
    expect(h.messages()).toHaveLength(1);
    expect(h.messages()[0]).toMatchObject({
      role: "tool",
      text: "Read",
      path: "src/a.ts",
      args: { file_path: "src/a.ts" },
    });
  });

  it("patches the oldest args-less tool row of the same name", () => {
    const h = harness();
    appendToolMessage(h.set, "k", "Read", null);
    appendToolMessage(h.set, "k", "Read", null);
    appendToolMessage(h.set, "k", "Read", null, "src/a.ts", null, { file_path: "src/a.ts" }, true);
    expect(h.messages()).toHaveLength(2);
    expect(h.messages()[0].args).toEqual({ file_path: "src/a.ts" });
    expect(h.messages()[0].path).toBe("src/a.ts");
    expect(h.messages()[1].args).toBeUndefined();
  });

  it("drops a patch when no matching args-less row exists", () => {
    const h = harness();
    appendToolMessage(h.set, "k", "Read", null, "src/a.ts", null, { file_path: "src/a.ts" });
    appendToolMessage(h.set, "k", "Read", null, "src/b.ts", null, { file_path: "src/b.ts" }, true);
    expect(h.messages()).toHaveLength(1);
    expect(h.messages()[0].path).toBe("src/a.ts");
  });

  it("settles parallel same-name calls on their own ids, not the first row", () => {
    // Four TaskCreate in one batch share a name, so a name-keyed result patch
    // can only ever land on one of them; every later id then goes missing and
    // the task list keeps reading "pending".
    const h = harness();
    const created = (id: string, subject: string) => ({
      text: "TaskCreate",
      args: { subject },
      todos: { replace: false, items: [{ content: subject, status: "pending" as const }] },
      toolCallId: id,
    });
    appendToolMessages(
      h.set,
      "k",
      [created("c1", "A"), created("c2", "B"), created("c3", "C"), created("c4", "D")],
      null,
    );
    appendToolMessages(
      h.set,
      "k",
      [
        { text: "TaskCreate", patch: true, toolCallId: "c1", result: "Task #1 created successfully: A" },
        { text: "TaskCreate", patch: true, toolCallId: "c2", result: "Task #2 created successfully: B" },
        { text: "TaskCreate", patch: true, toolCallId: "c3", result: "Task #3 created successfully: C" },
        { text: "TaskCreate", patch: true, toolCallId: "c4", result: "Task #4 created successfully: D" },
      ],
      null,
    );
    expect(h.messages().map((m) => m.result)).toEqual([
      "Task #1 created successfully: A",
      "Task #2 created successfully: B",
      "Task #3 created successfully: C",
      "Task #4 created successfully: D",
    ]);
  });

  it("stamps model and effort on assistant stream messages", () => {
    const out = applyStreamParts([], [{ kind: "delta", text: "hello" }], "gemini-3.8-flash", "high");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      role: "assistant",
      text: "hello",
      model: "gemini-3.8-flash",
      effort: "high",
    });
  });
});

describe("applyStreamParts / settleLiveRows contract", () => {
  it("preserves immutable history, sequence and mixed-role order", () => {
    const original: Message[] = [
      Object.freeze({ seq: 1, role: "user", text: "question", ts: null }),
      Object.freeze({ seq: 2, role: "assistant", text: "start", live: true, ts: null }),
    ];
    Object.freeze(original);
    const result = applyStreamParts(original, [
      { kind: "delta", text: " one" },
      { kind: "thinking", text: "reason" },
      { kind: "thinking", text: " more" },
      { kind: "delta", text: "answer" },
    ], "model");
    // omp interleaves the channels within ONE assistant message, so the
    // trailing delta folds back into the earlier live assistant row,
    // skipping the live thinking row — text stays one continuous document.
    expect(result.map((m) => [m.seq, m.role, m.text])).toEqual([
      [1, "user", "question"],
      [2, "assistant", "start oneanswer"],
      [3, "thinking", "reason more"],
    ]);
    expect(original[1].text).toBe("start");
    expect(result[0]).toBe(original[0]);
  });

  it("returns the original array for empty or textless parts", () => {
    const original: Message[] = [Object.freeze({ seq: 1, role: "user", text: "question", ts: null })];
    expect(applyStreamParts(original, [], null)).toBe(original);
    expect(applyStreamParts(original, [{ kind: "delta", text: "" }], null)).toBe(original);
  });

  it("settleLiveRows clears every live flag", () => {
    const result = applyStreamParts([], [{ kind: "delta", text: "hello" }], null);
    expect(settleLiveRows(result).every((m) => !m.live)).toBe(true);
  });
});
