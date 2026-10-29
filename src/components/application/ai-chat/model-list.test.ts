import { describe, expect, it } from "vitest";
import {
  filterModels,
  groupModelsByProvider,
  isEnterpriseGroup,
  orderModelGroups,
} from "./model-list";
import type { ModelOption } from "./cli-menu";

const model = (
  id: string,
  label: string,
  provider?: string,
): ModelOption => ({ id, label, provider });

/** Two relays serving the same model id: the report was that these read as
 *  identical rows once the list was filtered (no section headers, no source). */
const RELAYS: ModelOption[] = [
  model("agentrouter/deepseek-v4-flash", "deepseek-v4-flash", "agentrouter"),
  model("laowang/deepseek-v4-flash", "deepseek-v4-flash", "老王"),
  model("agentrouter/deepseek-v4-pro", "deepseek-v4-pro", "agentrouter"),
];

describe("groupModelsByProvider", () => {
  it("keeps section keys when the list truly mixes providers", () => {
    const groups = groupModelsByProvider(RELAYS);
    expect(groups.map((g) => g.key)).toEqual(["agentrouter", "老王"]);
  });

  it("keeps the header when a filter narrowed the list to one provider", () => {
    // Filtering to a single relay used to drop the header, leaving rows that
    // no longer said where the model came from — the reported regression.
    const groups = groupModelsByProvider([RELAYS[0], RELAYS[2]]);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("agentrouter");
    expect(groups[0].rows).toHaveLength(2);
  });

  it("treats a provider-less catalog as keyless too", () => {
    const groups = groupModelsByProvider([model("gpt-5", "gpt-5")]);
    expect(groups).toEqual([{ key: "", rows: [model("gpt-5", "gpt-5")] }]);
  });
});

describe("filterModels", () => {
  it("passes the catalog through untouched for an empty query", () => {
    expect(filterModels(RELAYS, "")).toBe(RELAYS);
  });

  it("narrows to one relay when the query names its provider", () => {
    const hit = filterModels(RELAYS, "老王");
    expect(hit.map((m) => m.id)).toEqual(["laowang/deepseek-v4-flash"]);
  });

  it("matches provider alongside label and id", () => {
    // The panel lowercases the query before calling in (see EngineModelPanel).
    expect(filterModels(RELAYS, "agentrouter").map((m) => m.id)).toEqual([
      "agentrouter/deepseek-v4-flash",
      "agentrouter/deepseek-v4-pro",
    ]);
    expect(filterModels(RELAYS, "v4-pro").map((m) => m.id)).toEqual([
      "agentrouter/deepseek-v4-pro",
    ]);
  });
});

/** CodeBuddy catalog as the backend ships it: the configured default leads
 *  (here an enterprise model), enterprise rows share one provider key. */
const CODEBUDDY: ModelOption[] = [
  model("custom:glm-5.3", "GLM 5.3", "enterprise"),
  model("hy4-preview", "Hunyuan 4 Preview", "hunyuan"),
  model("glm-5.3", "GLM 5.3", "chatglm"),
  model("custom:kimi-k3.1-pro", "Kimi K3.1 Pro", "enterprise"),
];
const keys = (engineId: string, selected: string, rows = CODEBUDDY) =>
  orderModelGroups(groupModelsByProvider(rows), engineId, selected).map((g) => g.key);

describe("orderModelGroups", () => {
  it("sinks CodeBuddy's enterprise section below the vendor sections", () => {
    // Catalog order leads with the enterprise default; the panel still files
    // that section last while the pick lives elsewhere.
    expect(keys("codebuddy", "glm-5.3")).toEqual(["chatglm", "hunyuan", "enterprise"]);
    expect(keys("codebuddy", "")).toEqual(["hunyuan", "chatglm", "enterprise"]);
  });

  it("lets the section holding the pick lead, enterprise included", () => {
    // A 240px list with the picked enterprise row sunk to the bottom opened
    // with the selection scrolled out of view.
    expect(keys("codebuddy", "custom:kimi-k3.1-pro")).toEqual([
      "enterprise",
      "hunyuan",
      "chatglm",
    ]);
  });

  it("leaves another engine's relay named enterprise in catalog order", () => {
    const relays = [
      model("enterprise/gpt-5.4", "gpt-5.4", "enterprise"),
      model("openai/gpt-5.4", "gpt-5.4", "openai"),
    ];
    expect(keys("omp", "", relays)).toEqual(["enterprise", "openai"]);
    expect(isEnterpriseGroup("omp", "enterprise")).toBe(false);
    expect(isEnterpriseGroup("codebuddy", "enterprise")).toBe(true);
    expect(isEnterpriseGroup("codebuddy", "custom")).toBe(false);
  });
});

describe("filterModels section titles", () => {
  it("matches the header the panel shows, not just the provider key", () => {
    const title = (provider: string) => (provider === "enterprise" ? "企业模型" : provider);
    expect(filterModels(CODEBUDDY, "企业", title).map((m) => m.id)).toEqual([
      "custom:glm-5.3",
      "custom:kimi-k3.1-pro",
    ]);
    // Without a title resolver only the raw key matches, as before.
    expect(filterModels(CODEBUDDY, "企业")).toEqual([]);
    expect(filterModels(CODEBUDDY, "enterprise", title)).toHaveLength(2);
  });
});
