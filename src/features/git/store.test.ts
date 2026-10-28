import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcMock = vi.hoisted(() => ({
  gitInit: vi.fn(),
  gitStatus: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({ ipc: ipcMock }));
vi.mock("@/features/files/store", () => ({
  useFilesStore: { getState: () => ({ refreshTree: vi.fn().mockResolvedValue(undefined) }) },
}));

import { useGitStore } from "./store";

const freshStatus = { branch: "main", staged: [], unstaged: [], untracked: [] };

describe("git store init", () => {
  beforeEach(() => {
    useGitStore.setState({
      statusByWorkspace: {},
      notRepoByWorkspace: { "/plain": true },
      errorByWorkspace: {},
      fetchedAtByWorkspace: { "/plain": Date.now() },
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("leaves the non-repo state with fresh status by the time it resolves", async () => {
    let resolveStatus!: (status: typeof freshStatus) => void;
    ipcMock.gitInit.mockResolvedValue(undefined);
    ipcMock.gitStatus.mockReturnValue(new Promise((done) => { resolveStatus = done; }));

    let settled = false;
    const pending = useGitStore.getState().init("/plain").then(() => { settled = true; });
    await vi.waitFor(() => expect(ipcMock.gitStatus).toHaveBeenCalled());
    // Still busy while status is in flight: the panel would otherwise
    // re-enable the init button over a not-yet-refreshed NOT_A_REPO body.
    expect(settled).toBe(false);
    resolveStatus(freshStatus);
    await pending;

    expect(ipcMock.gitInit).toHaveBeenCalledWith("/plain");
    // The TTL from the NOT_A_REPO probe must not short-circuit the refresh,
    // and the follow-up join must reuse runMutation's request.
    expect(ipcMock.gitStatus).toHaveBeenCalledTimes(1);
    const state = useGitStore.getState();
    expect(state.notRepoByWorkspace["/plain"]).toBe(false);
    expect(state.statusByWorkspace["/plain"]).toEqual(freshStatus);
  });

  it("asks again when a refresh from before init answers NOT_A_REPO", async () => {
    let rejectStale!: (error: unknown) => void;
    ipcMock.gitInit.mockResolvedValue(undefined);
    ipcMock.gitStatus
      .mockReturnValueOnce(new Promise((_, reject) => { rejectStale = reject; }))
      .mockResolvedValue(freshStatus);

    // e.g. a window-focus refresh already in flight when the user clicks.
    const stale = useGitStore.getState().refresh("/plain", true);
    const pending = useGitStore.getState().init("/plain");
    // Let init reach its refresh while the stale request is still in flight,
    // so the in-flight dedup hands that request back.
    await new Promise((done) => setTimeout(done, 0));
    rejectStale("NOT_A_REPO");
    await stale;
    await pending;

    expect(ipcMock.gitStatus).toHaveBeenCalledTimes(2);
    expect(useGitStore.getState().notRepoByWorkspace["/plain"]).toBe(false);
    expect(useGitStore.getState().statusByWorkspace["/plain"]).toEqual(freshStatus);
  });

  it("rethrows a failed init and keeps the non-repo state", async () => {
    ipcMock.gitInit.mockRejectedValue("not a directory: /plain");
    ipcMock.gitStatus.mockRejectedValue("NOT_A_REPO");

    await expect(useGitStore.getState().init("/plain")).rejects.toBe("not a directory: /plain");

    await vi.waitFor(() => expect(ipcMock.gitStatus).toHaveBeenCalled());
    expect(useGitStore.getState().notRepoByWorkspace["/plain"]).toBe(true);
  });
});
