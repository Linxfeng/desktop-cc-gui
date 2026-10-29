import { describe, expect, it } from "vitest";
import {
  checkResponseSelection,
  compareEffort,
  compareModel,
} from "./response-check";

describe("compareModel", () => {
  it("reads a provider-qualified id as the same model", () => {
    expect(compareModel("百倍baibei/claude-opus-5-5", "claude-opus-5-5")).toBe(
      "match",
    );
    expect(compareModel("claude-opus-5-5[1m]", "claude-opus-5-5")).toBe(
      "match",
    );
  });

  it("reads a date or build suffix as a snapshot of the same family", () => {
    expect(compareModel("claude-opus-4-5", "claude-opus-4-5-20251101")).toBe(
      "snapshot",
    );
    expect(compareModel("claude-opus-4-5-latest", "claude-opus-4-5")).toBe(
      "snapshot",
    );
    // The provider prefix is ignored; a dated resolution of the same id is
    // a snapshot, not a substitution.
    expect(
      compareModel("ds/deepseek-v4.1-flash", "deepseek/deepseek-v4.1-flash-1017"),
    ).toBe("snapshot");
    expect(compareModel("ds4.1", "ds4.1-1017")).toBe("snapshot");
    // Cohere stamps monthly snapshots as `-MM-YYYY`.
    expect(compareModel("command-r-plus", "command-r-plus-08-2024")).toBe(
      "snapshot",
    );
    expect(compareModel("command-r7b", "command-r7b-12-2024")).toBe("snapshot");
  });

  it("does not read a size/length pair as a monthly snapshot", () => {
    // `-14-2048` is no month and no year: these are different models.
    expect(compareModel("qwen-14-2048", "qwen-72-2048")).toBe("mismatch");
    expect(compareModel("qwen-12", "qwen-12-2048")).toBe("mismatch");
  });

  it("does not eat a context-length suffix as a date", () => {
    // `-\d{4}` that is not a plausible MMDD date is part of the id: 8192 is
    // a real substitution, not a snapshot of 4096.
    expect(
      compareModel("qwen2.5-7b-instruct-4096", "qwen2.5-7b-instruct-8192"),
    ).toBe("mismatch");
  });

  it("flags a different model", () => {
    expect(compareModel("gpt-6-astra", "gpt-5.6-luna")).toBe("mismatch");
    // A longer id that merely starts the same is not the same model.
    expect(compareModel("gpt-5", "gpt-5.6-luna")).toBe("mismatch");
  });

  it("stays unknown while either side has not reported", () => {
    expect(compareModel("gpt-6-astra", null)).toBe("unknown");
    expect(compareModel(null, "gpt-5.6-luna")).toBe("unknown");
    expect(compareModel(null, null)).toBe("unknown");
  });
});

describe("compareEffort", () => {
  it("ignores case and separators", () => {
    expect(compareEffort("xhigh", "XHigh")).toBe("match");
    expect(compareEffort("extra-high", "xhigh")).toBe("match");
    expect(compareEffort("high", "high")).toBe("match");
  });

  it("flags a downgraded or raised level", () => {
    expect(compareEffort("max", "low")).toBe("mismatch");
    expect(compareEffort("xhigh", "high")).toBe("mismatch");
    expect(compareEffort("high", null)).toBe("unknown");
  });
});

describe("checkResponseSelection", () => {
  it("compares an adapter-resolved alias without losing the selector", () => {
    const requested = {
      model: "opus",
      comparisonModel: "claude-opus-5-5",
      effort: "high",
    };
    expect(
      checkResponseSelection({
        requested,
        served: { model: "claude-opus-5-5", effort: null },
      }).verdict,
    ).toBe("match");
    expect(
      checkResponseSelection({
        requested,
        served: { model: "claude-opus-4-5", effort: null },
      }).verdict,
    ).toBe("mismatch");
    expect(
      checkResponseSelection({
        requested: { ...requested, comparisonModel: "custom-model" },
        served: { model: "custom-model", effort: null },
      }).verdict,
    ).toBe("match");
  });

  it("shows an unresolved alias as unknown, never a mismatch or pass", () => {
    const requested = { model: "opus", comparisonModel: null, effort: "high" };
    expect(
      checkResponseSelection({
        requested,
        served: { model: "claude-opus-5-5", effort: null },
      }),
    ).toEqual({
      model: "unknown",
      effort: "unknown",
      verdict: "unknown",
      visible: true,
    });
    expect(
      checkResponseSelection({
        requested,
        served: { model: "claude-opus-5-5", effort: "high" },
      }).verdict,
    ).toBe("unknown");
    expect(
      checkResponseSelection({
        requested,
        served: { model: null, effort: null },
        reportsServed: true,
      }).visible,
    ).toBe(true);
    expect(
      checkResponseSelection({
        requested,
        served: { model: "claude-opus-5-5", effort: "low" },
      }).verdict,
    ).toBe("mismatch");
  });

  it("reports a match when every reported side agrees", () => {
    const view = checkResponseSelection({
      requested: { model: "claude-opus-5-5", effort: "xhigh" },
      served: { model: "claude-opus-5-5", effort: "xhigh" },
    });
    expect(view).toEqual({
      model: "match",
      effort: "match",
      verdict: "match",
      visible: true,
    });
  });

  it("flags any reported disagreement", () => {
    const view = checkResponseSelection({
      requested: { model: "gpt-6-astra", effort: "max" },
      served: { model: "gpt-5.6-luna", effort: "max" },
    });
    expect(view.verdict).toBe("mismatch");
    expect(view.model).toBe("mismatch");
    expect(view.effort).toBe("match");
    expect(view.visible).toBe(true);
  });

  it("reads a dated id of the same family as a neutral snapshot", () => {
    const view = checkResponseSelection({
      requested: { model: "claude-sonnet-4-5", effort: "high" },
      served: { model: "claude-sonnet-4-5-20250929", effort: "high" },
    });
    expect(view).toEqual({
      model: "snapshot",
      effort: "match",
      verdict: "snapshot",
      visible: true,
    });
    // A snapshot never outranks a real disagreement on the other axis.
    expect(
      checkResponseSelection({
        requested: { model: "claude-sonnet-4-5", effort: "high" },
        served: { model: "claude-sonnet-4-5-20250929", effort: "low" },
      }).verdict,
    ).toBe("mismatch");
  });

  it("still shows the card when a reporting engine's response never reported", () => {
    const view = checkResponseSelection({
      requested: { model: "claude-opus-5-5", effort: "xhigh" },
      served: { model: null, effort: null },
      reportsServed: true,
    });
    expect(view.visible).toBe(true);
    expect(view.verdict).toBe("unknown");
    expect(checkResponseSelection(null).visible).toBe(false);
    expect(
      checkResponseSelection({
        requested: { model: null, effort: null },
        served: { model: null, effort: null },
        reportsServed: true,
      }).visible,
    ).toBe(false);
  });

  it("stays hidden for an engine that never reports a served side", () => {
    // kimi/grok/opencode/… only report the launch: a permanent "unreported"
    // badge on every turn would be noise, not a finding.
    const requestOnly = {
      requested: { model: "kimi-k2", effort: "high" },
      served: { model: null, effort: null },
    };
    expect(checkResponseSelection(requestOnly).visible).toBe(false);
    expect(
      checkResponseSelection({ ...requestOnly, reportsServed: false }).visible,
    ).toBe(false);
    // Any response evidence still opens the card, flag or not.
    expect(
      checkResponseSelection({
        ...requestOnly,
        served: { model: null, effort: "high" },
      }),
    ).toEqual({
      model: "unknown",
      effort: "match",
      verdict: "unknown",
      visible: true,
    });
  });

  it("never reads an unreported side as a match", () => {
    // The model matched, but the level was never echoed: the level row is
    // unknown, and the verdict rests on what was actually reported.
    const view = checkResponseSelection({
      requested: { model: "claude-opus-5-5", effort: "xhigh" },
      served: { model: "claude-opus-5-5", effort: null },
    });
    expect(view.effort).toBe("unknown");
    expect(view.verdict).toBe("match");
  });

  it("stays unknown when the response never reported its model", () => {
    // omp/pi emit Served{model: None, effort: Some(..)} when only the
    // thinking level came back: a matching level alone is not a confirmed
    // model.
    const view = checkResponseSelection({
      requested: { model: "deepseek-v4.1-flash", effort: "high" },
      served: { model: null, effort: "high" },
    });
    expect(view).toEqual({
      model: "unknown",
      effort: "match",
      verdict: "unknown",
      visible: true,
    });
    // Same for an unresolved alias whose served model never arrived.
    expect(
      checkResponseSelection({
        requested: { model: "opus", comparisonModel: null, effort: "high" },
        served: { model: null, effort: "high" },
      }).verdict,
    ).toBe("unknown");
  });
});
