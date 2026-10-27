/**
 * OAuth login launch for pi/omp: the CLI owns the interactive flow, so the
 * app drives its built-in terminal (same approach as the reference
 * desktop-cc-gui's `mossx:terminal-command-request`, minus the event bus):
 * open the dock on a fresh tab, wait for the PTY, then type the command.
 *
 * - pi:  slash commands can't go through argv (they'd be sent to the model
 *        as prompt text) — two-stage PTY input: start the `pi` TUI, then
 *        write `/login <arg>` once it is up.
 * - omp: `omp auth-broker login <arg>` is a plain interactive command —
 *        single write, no TUI boot wait.
 */
import { ipc } from "@/lib/ipc";
import { useChatStore } from "@/features/chat/store";
import { useTerminalStore } from "@/features/terminal/store";
import {
  ENTER,
  openDedicatedTerminalTab,
  runCliLogin,
  shellQuote,
  waitForSession,
} from "./terminalLogin";

/**
 * Open the terminal dock on a fresh tab and start the OAuth login flow.
 * Returns false when there is no active workspace to host the terminal.
 */
export async function launchPiFamilyLogin(
  engine: "pi" | "omp",
  loginArg: string,
): Promise<boolean> {
  const workspacePath = useChatStore.getState().active?.workspacePath;
  if (!workspacePath) return false;

  const id = openDedicatedTerminalTab(workspacePath);
  if (!id) return false;
  const failed = () => {
    useTerminalStore.getState().closeTab(workspacePath, id);
    return false;
  };

  let bin: string;
  try {
    const [settings, host] = await Promise.all([
      ipc.getAppSettings().catch(() => null),
      ipc.terminalHostInfo(),
    ]);
    const customBin = (engine === "pi" ? settings?.piBin : settings?.ompBin)?.trim();
    bin = shellQuote(customBin || engine, host);
  } catch {
    return failed();
  }

  if (!(await waitForSession(id))) return failed();

  if (engine === "omp") {
    try {
      await ipc.terminalWrite(id, `${bin} auth-broker login ${loginArg}${ENTER}`);
      return true;
    } catch {
      return failed();
    }
  }
  if (!(await runCliLogin(id, bin, `/login ${loginArg}`))) return failed();
  return true;
}

/** Open a dedicated terminal for the CLI-owned OAuth logout flow. */
export async function launchPiFamilyLogout(
  engine: "pi" | "omp",
  providerId: string,
): Promise<boolean> {
  const workspacePath = useChatStore.getState().active?.workspacePath;
  if (!workspacePath) return false;

  const id = openDedicatedTerminalTab(workspacePath);
  if (!id) return false;
  const failed = () => {
    useTerminalStore.getState().closeTab(workspacePath, id);
    return false;
  };

  let bin: string;
  try {
    const [settings, host] = await Promise.all([
      ipc.getAppSettings().catch(() => null),
      ipc.terminalHostInfo(),
    ]);
    const customBin = (engine === "pi" ? settings?.piBin : settings?.ompBin)?.trim();
    bin = shellQuote(customBin || engine, host);
    if (!(await waitForSession(id))) return failed();

    if (engine === "omp") {
      await ipc.terminalWrite(id, `${bin} auth-broker logout ${providerId}${ENTER}`);
      return true;
    }
    await ipc.terminalWrite(id, `${bin}${ENTER}`);
  } catch (error) {
    failed();
    throw error;
  }
  window.setTimeout(() => {
    const tabStillExists = useTerminalStore
      .getState()
      .tabsByWorkspace[workspacePath]?.some((tab) => tab.id === id);
    if (!tabStillExists) {
      return;
    }
    void ipc.terminalWrite(id, `/logout${ENTER}`).catch(() => {});
  }, 1500);
  return true;
}

/** A terminal write cannot report the shell command's exit status. Verify the
 * credential store instead; a timeout never counts as a successful logout. */
export async function waitForPiFamilyLogout(
  engine: "pi" | "omp",
  statusIds: readonly string[],
): Promise<boolean> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    try {
      const result = await ipc.piFamilyAuthList(engine);
      if (statusIds.every((id) => !result.oauthProviders.includes(id))) return true;
    } catch {
      // The next read may succeed; a failed read cannot prove logout.
    }
  }
  return false;
}
