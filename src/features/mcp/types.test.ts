import { describe, expect, it } from "vitest";
import type { McpConfigSource, McpEngineId } from "./types";

describe("CodeBuddy MCP inventory contract", () => {
  it("accepts the engine and every source registered by the backend", () => {
    const engine = "codebuddy" satisfies McpEngineId;
    const sources = [
      "codebuddy_user",
      "codebuddy_local",
      "codebuddy_project",
    ] satisfies McpConfigSource[];

    expect({ engine, sources }).toEqual({
      engine: "codebuddy",
      sources: ["codebuddy_user", "codebuddy_local", "codebuddy_project"],
    });
  });
});
