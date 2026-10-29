import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("./transport", () => ({ invoke: mocks.invoke, isWeb: false }));

import {
  answerGrantRequest,
  currentGrantRequest,
  subscribeGrantDialog,
  withGrantRetry,
} from "./grant";

describe("withGrantRetry", () => {
  let unsubscribe: (() => void) | null = null;
  afterEach(() => {
    unsubscribe?.();
    unsubscribe = null;
    mocks.invoke.mockReset();
  });

  it("resolves the grant for the rejected path verbatim, trailing space included", async () => {
    mocks.invoke.mockImplementation(async (command: string) =>
      command === "grant_scope" ? "/outside" : undefined,
    );
    unsubscribe = subscribeGrantDialog(() => {
      if (currentGrantRequest()) answerGrantRequest(true);
    });
    const op = vi
      .fn()
      .mockRejectedValueOnce("path is outside the registered workspaces: /outside/report ")
      .mockResolvedValueOnce("ok");

    await expect(withGrantRetry(op)).resolves.toBe("ok");
    expect(mocks.invoke).toHaveBeenCalledWith("grant_scope", { path: "/outside/report " });
    expect(mocks.invoke).toHaveBeenCalledWith("grant_root", { path: "/outside" });
  });

  it("rethrows a rejection that names no path", async () => {
    const op = vi.fn().mockRejectedValue("path is outside the registered workspaces:  ");

    await expect(withGrantRetry(op)).rejects.toBe("path is outside the registered workspaces:  ");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
