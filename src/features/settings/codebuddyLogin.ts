/**
 * Login launch for CodeBuddy: the CLI owns the interactive OAuth/login flow,
 * so the app drives its built-in terminal: open the dock on a fresh tab,
 * wait for the PTY, then run codebuddy and trigger /login.
 */
import { ipc } from "@/lib/ipc";
import { useChatStore } from "@/features/chat/store";
import { useTerminalStore } from "@/features/terminal/store";
import {
  openDedicatedTerminalTab,
  runCliLogin,
  shellQuote,
  waitForSession,
} from "./terminalLogin";

export type CodeBuddyLoginResult =
  | { ok: true }
  /** No active chat tab to host the terminal. */
  | { ok: false; reason: "no-workspace" }
  /** The terminal tab opened but its PTY never became usable. */
  | { ok: false; reason: "terminal-unavailable" };

/**
 * Open the terminal dock on exactly one fresh tab and start CodeBuddy login.
 * The result covers both PTY writes and the bounded CLI readiness wait; any
 * failure closes only the tab created by this launch.
 */
export async function launchCodeBuddyLogin(): Promise<CodeBuddyLoginResult> {
  const workspacePath = useChatStore.getState().active?.workspacePath;
  if (!workspacePath) return { ok: false, reason: "no-workspace" };

  const id = openDedicatedTerminalTab(workspacePath);
  if (!id) return { ok: false, reason: "terminal-unavailable" };
  const unavailable = (): CodeBuddyLoginResult => {
    useTerminalStore.getState().closeTab(workspacePath, id);
    return { ok: false, reason: "terminal-unavailable" };
  };

  let bin: string;
  try {
    const [settings, host] = await Promise.all([
      ipc.getAppSettings().catch(() => null),
      ipc.terminalHostInfo(),
    ]);
    const customBin = settings?.codebuddyBin?.trim();
    bin = shellQuote(customBin || "codebuddy", host);
  } catch {
    return unavailable();
  }

  if (!(await waitForSession(id))) return unavailable();
  if (!(await runCliLogin(id, bin, "/login"))) return unavailable();
  return { ok: true };
}
