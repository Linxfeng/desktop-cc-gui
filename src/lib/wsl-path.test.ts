import { describe, expect, it } from "vitest";
import { isWslUncWorkspace, parseWslUncPath } from "./wsl-path";

/**
 * 前端只负责两件事:识别本机 WSL 工作区、取发行版名(侧栏徽标 / 引擎可用性
 * 查询)。这里覆盖系统选择器与 canonicalize 实际会给出的拼写;路径语义与
 * 安全校验在 Rust 侧(wsl_path.rs 的单测),不在前端重复实现。
 */

describe("parseWslUncPath", () => {
  it("接受两种主机名、两种分隔符与大小写差异", () => {
    const expected = { distro: "Ubuntu-24.04", linuxPath: "/home/me/repo" };
    expect(parseWslUncPath("\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\repo")).toEqual(expected);
    expect(parseWslUncPath("\\\\wsl$\\Ubuntu-24.04\\home\\me\\repo")).toEqual(expected);
    expect(parseWslUncPath("//wsl.localhost/Ubuntu-24.04/home/me/repo")).toEqual(expected);
    expect(parseWslUncPath("\\\\WSL.LOCALHOST\\Ubuntu-24.04\\home\\me\\repo")).toEqual(expected);
  });

  it("剥掉 canonicalize 的 \\\\?\\UNC\\ 前缀", () => {
    expect(parseWslUncPath("\\\\?\\UNC\\wsl.localhost\\Ubuntu-24.04\\home\\me\\repo")).toEqual({
      distro: "Ubuntu-24.04",
      linuxPath: "/home/me/repo",
    });
  });

  it("根目录归一为 /，保留中文与空格", () => {
    expect(parseWslUncPath("\\\\wsl.localhost\\Ubuntu\\")).toEqual({
      distro: "Ubuntu",
      linuxPath: "/",
    });
    expect(parseWslUncPath("\\\\wsl.localhost\\Ubuntu\\home\\me\\项目 一")).toEqual({
      distro: "Ubuntu",
      linuxPath: "/home/me/项目 一",
    });
  });

  it("非 WSL 路径与坏形状返回 null", () => {
    expect(parseWslUncPath("/home/me/repo")).toBeNull();
    expect(parseWslUncPath("C:\\Users\\me\\repo")).toBeNull();
    expect(parseWslUncPath("\\\\server\\share\\repo")).toBeNull();
    expect(parseWslUncPath("\\\\wsl.localhost\\")).toBeNull();
    expect(parseWslUncPath("")).toBeNull();
    expect(parseWslUncPath(null)).toBeNull();
    expect(parseWslUncPath(undefined)).toBeNull();
  });
});

describe("isWslUncWorkspace", () => {
  it("与解析结果一致", () => {
    expect(isWslUncWorkspace("\\\\wsl$\\Ubuntu\\home\\me")).toBe(true);
    expect(isWslUncWorkspace("D:\\repo")).toBe(false);
    expect(isWslUncWorkspace(undefined)).toBe(false);
  });
});
