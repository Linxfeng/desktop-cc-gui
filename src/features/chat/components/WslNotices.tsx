import { useTranslation } from "react-i18next";
import X from "lucide-react/dist/esm/icons/x";
import { useChatStore } from "../store";
import type { WslNotice } from "@/lib/ipc";

/**
 * 本机 WSL 的运行期提示条(设计稿 §5.7 第 5 条、§5.9)。
 *
 * 两类事实在后台才暴露、又必须让用户知道:会话回收未确认(发行版内进程
 * 可能仍在跑)、发行版内缺 ripgrep(@ 列表已退回 UNC 遍历)。它们不是某次
 * 操作的失败,不该占用 `actionError` 的错误横幅语义,所以单独一条
 * `role="status"` 的提示条,可逐条关闭。
 *
 * 后端队列取走即清(见 `wsl_take_unproven_notices`),store 里这份只是展示
 * 副本:关闭不会重新排队,重启应用也不会重复提示同一条。
 */
export function WslNotices({ className }: { className?: string }) {
  const { t } = useTranslation();
  const notices = useChatStore((s) => s.wslNotices);
  const dismiss = useChatStore((s) => s.dismissWslNotice);
  if (notices.length === 0) return null;

  const text = (notice: WslNotice) =>
    notice.kind === "rgMissing"
      ? t("wsl.noticeRgMissing", { distro: notice.distro })
      : t("wsl.noticeExitUnproven", { distro: notice.distro });

  return (
    <div className={className}>
      {notices.map((notice) => (
        <div
          key={
            notice.kind === "rgMissing"
              ? `${notice.kind}/${notice.distro}`
              : `${notice.kind}/${notice.distro}/${notice.runId}`
          }
          className="mb-1.5 flex min-w-0 items-start gap-2 rounded-lg border border-border-secondary bg-background-tertiary-default px-3 py-2 text-caption-1-regular text-text-secondary last:mb-0"
        >
          {/* live region 只包文本:按钮被算进 status 快照时,读屏会把它当
              成提示内容的一部分(§10 P2-3)。 */}
          <span
            role="status"
            aria-live="polite"
            className="min-w-0 flex-1 whitespace-pre-wrap break-words"
          >
            {text(notice)}
          </span>
          <button
            type="button"
            aria-label={t("wsl.dismissNamed", { name: notice.distro })}
            title={t("wsl.dismiss")}
            onClick={() => dismiss(notice)}
            className="shrink-0 cursor-pointer rounded p-0.5 text-text-tertiary hover:bg-background-tertiary-hover hover:text-text-secondary"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}
