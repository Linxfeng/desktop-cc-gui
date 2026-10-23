import { describe, expect, it } from "vitest";
import { filterEngineOptions, orderEngineOptions } from "./engine-options";
import type { EngineInfo } from "@/lib/ipc";

function engine(id: string, over: Partial<EngineInfo> = {}): EngineInfo {
  return { id, enabled: true, available: true, ...over } as EngineInfo;
}

const t = (key: string) => key;

describe("filterEngineOptions", () => {
  it("drops disabled engines entirely", () => {
    const out = filterEngineOptions(
      [engine("omp"), engine("claude", { enabled: false })],
      null,
      t,
    );
    expect(out.map((o) => o.id)).toEqual(["omp"]);
  });

  it("drops engines the local binary probe marks uninstalled", () => {
    const out = filterEngineOptions(
      [engine("omp", { available: false }), engine("claude")],
      null,
      t,
    );
    expect(out.map((o) => o.id)).toEqual(["claude"]);
  });

  it("WSL 工作区:只列发行版内探到的引擎,可用态按探针而非本机", () => {
    const out = filterEngineOptions(
      // 本机都没装(available=false),但发行版里探到 omp
      [engine("omp", { available: false }), engine("claude", { available: false })],
      ["omp"],
      t,
    );
    expect(out.map((o) => o.id)).toEqual(["omp"]);
    expect(out[0]?.available).toBe(true);
    expect(out[0]?.disabled).toBe(false);
  });

  it("delegated 但结果未到/失败:不回落到本机探针,不隐藏引擎", () => {
    // Windows 侧一个都没装,发行版探测还没返回(或失败)→ allowed=null。
    // 此时必须仍列出全部已启用引擎,否则「Windows 不装 CLI」场景在
    // 探测的 2.4s 内/失败后菜单为空(§10 P1-1)。
    const out = filterEngineOptions(
      [engine("claude", { available: false }), engine("codex", { available: false })],
      null,
      t,
      true,
    );
    expect(out.map((o) => o.id)).toEqual(["claude", "codex"]);
    expect(out.every((o) => o.available)).toBe(true);
  });
});

describe("orderEngineOptions", () => {
  const options = (ids: string[]) =>
    filterEngineOptions(ids.map((id) => engine(id)), null, t);

  it("follows the settings rail drag order, keyed cli:<id>", () => {
    const out = orderEngineOptions(options(["claude", "omp", "kimi"]), [
      "cli:kimi",
      "cli:claude",
    ]);
    expect(out.map((o) => o.id)).toEqual(["kimi", "claude", "omp"]);
  });

  it("keeps registry order when no preference is stored", () => {
    const out = orderEngineOptions(options(["omp", "claude"]), []);
    expect(out.map((o) => o.id)).toEqual(["omp", "claude"]);
  });
});
