import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Check from "lucide-react/dist/esm/icons/check";
import Copy from "lucide-react/dist/esm/icons/copy";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import {
  ActionFeedbackIcon,
  useActionFeedback,
} from "@/components/base/action-feedback";
import { Button } from "@/components/base/buttons/button";
import {
  SettingsCard,
  SettingsRow,
} from "@/components/application/settings/settings-rows";
import { CLI_DISPLAY_NAMES } from "@/components/foundations/icons/engine-brands";
import { invalidateWslEngineAvailability } from "@/features/chat/components/use-wsl-engine-availability";
import { useChatStore } from "@/features/chat/store";
import { relativeTime } from "@/features/chat/time";
import { useCopied } from "@/hooks/use-copied";
import { errorText } from "@/lib/errors";
import { ipc } from "@/lib/ipc";
import { CliEngineCard } from "./CliEngineCard";
import { notifyCliConfigChanged, type EngineId } from "./providers";
import { useWslCliStatus } from "./use-wsl-cli-status";
import { WslEnginePathRow } from "./WslEnginePathRow";
import { WslOfficialEditDialog } from "./WslOfficialEditDialog";

/**
 * CLI 页的 WSL 作用域:应用级设置 + 只读状态 + 路径覆盖。
 *
 * 不挂载主机 `useCliConfig` / 官方配置编辑器 / cc-switch:那些会读写 Windows
 * 侧的 CLI 文件。这里展示的都是应用级能力(启停、渠道)或发行版内的事实
 * (探测路径、官方配置文件位置),编辑发行版内的配置文件仍留给后续的远程
 * 文件服务。
 *
 * 状态读取失败与路径保存失败是两种事实:前者进页面级 `role="alert"`,
 * 后者留在覆盖行;保存成功但刷新失败单独提示「已保存,但读取状态失败」,
 * 不把已成功的保存写成路径无效。
 */
export function WslCliPanel({
  engine,
  distro,
  canEditOfficial,
  onManageHost,
}: {
  engine: EngineId;
  distro: string;
  /** 后端声明该引擎的发行版内官方配置可编辑。 */
  canEditOfficial: boolean;
  /** 渠道是应用级的,切回本机作用域管理。 */
  onManageHost: () => void;
}) {
  const { t } = useTranslation();
  const { statuses, loading, error, reload } = useWslCliStatus(distro);
  const [pathError, setPathError] = useState("");
  const [engineError, setEngineError] = useState("");
  const [engineBusy, setEngineBusy] = useState(false);
  const [editingOfficial, setEditingOfficial] = useState(false);
  const feedback = useActionFeedback({ spin: true });

  const engines = useChatStore((state) => state.engines);
  const enabled = engines.find((info) => info.id === engine)?.enabled ?? true;

  const status = statuses?.find((row) => row.engine === engine) ?? null;

  useEffect(() => {
    if (statuses && !status) {
      // 前后端能力表漂移:不静默空白,留一条可诊断的痕迹。
      console.warn(`[wsl] cli status: no row for ${engine} in ${distro}`);
    }
  }, [statuses, status, engine, distro]);

  // 切换发行版后,上一个发行版的路径校验错误不该留在新发行版上。
  useEffect(() => {
    setPathError("");
  }, [distro]);

  const toggleEnabled = useCallback(
    async (on: boolean) => {
      setEngineBusy(true);
      setEngineError("");
      try {
        await ipc.setEngineEnabled(engine, on);
        notifyCliConfigChanged();
      } catch (cause) {
        setEngineError(errorText(cause));
      } finally {
        setEngineBusy(false);
      }
    },
    [engine],
  );

  const rescan = useCallback(() => {
    void feedback
      .start(async () => {
        // `wsl_reprobe` 先 invalidate 正/负缓存:关停后立刻重试不会拿到
        // 10 秒内的旧错误。
        await ipc.wslReprobe(distro);
        invalidateWslEngineAvailability();
        // 等状态读取也有结果:探测成功但状态读取失败时不冒充对号。
        await reload("rescan");
      })
      .catch(() => {
        // 错误由 useWslCliStatus.error 渲染;这里只吞掉 rethrow。
      });
  }, [distro, feedback, reload]);

  const onSaved = useCallback(() => {
    // 保存成功后只重读状态(不强制重探),并让聊天页的引擎菜单同步。
    invalidateWslEngineAvailability();
    void reload("save").catch(() => undefined);
  }, [reload]);

  const cli = CLI_DISPLAY_NAMES[engine] ?? engine;
  const source = status?.source ?? "missing";
  const bin = status?.bin ?? null;
  const version = status?.version ?? null;
  const configPath = status?.configPath ?? null;
  const probedAgoSecs = status?.probedAgoSecs ?? null;
  const statusAlert = error
    ? error.reason === "save"
      ? t("wsl.cli.statusStale", { message: error.message })
      : t("wsl.cli.statusFailed", { message: error.message })
    : null;

  return (
    <div className="flex w-full flex-col gap-6">
      {statusAlert && (
        <p role="alert" className="px-3 text-body-2-regular text-text-error-primary">
          {statusAlert}
        </p>
      )}

      <CliEngineCard
        engine={engine}
        enabled={enabled}
        busy={engineBusy}
        onToggleEnabled={(on) => void toggleEnabled(on)}
      />
      {engineError && (
        <p role="alert" className="px-3 text-body-2-regular text-text-error-primary">
          {engineError}
        </p>
      )}

      {configPath && (
        <SettingsCard>
          <SettingsRow
            label={t("settings.cliOfficial")}
            description={t("wsl.cli.officialDesc")}
          >
            <div className="flex min-w-0 items-center gap-2">
              <span
                className="max-w-[320px] truncate font-mono text-body-2-regular text-text-secondary"
                title={configPath}
              >
                {configPath}
              </span>
              <CopyPathButton path={configPath} />
              {canEditOfficial && (
                <Button
                  variant="secondary"
                  size="small"
                  onClick={() => setEditingOfficial(true)}
                >
                  {t("settings.cliEdit")}
                </Button>
              )}
            </div>
          </SettingsRow>
        </SettingsCard>
      )}

      <SettingsCard>
        {loading && !statuses ? (
          <SettingsRow label={t("wsl.cli.status")}>
            <span role="status" className="text-body-2-regular text-text-tertiary">
              {t("wsl.cli.loading")}
            </span>
          </SettingsRow>
        ) : error && !statuses ? null : (
          <>
            <SettingsRow label={t("wsl.cli.status")}>
              <div className="flex min-w-0 items-center gap-2">
                <SourceBadge source={source} />
                <span className="tabular-nums text-body-2-regular text-text-secondary">
                  {version ?? "—"}
                </span>
                <Button
                  variant="secondary"
                  size="small"
                  aria-label={t("wsl.rescan")}
                  title={t("wsl.rescan")}
                  disabled={feedback.feedback === "running"}
                  onClick={rescan}
                >
                  <ActionFeedbackIcon
                    icon={RefreshCw}
                    feedback={feedback.feedback}
                    spin
                  />
                  <span className="ml-1">{t("wsl.rescan")}</span>
                </Button>
              </div>
            </SettingsRow>
            <SettingsRow label={t("wsl.cli.path")}>
              {bin ? (
                <span
                  className="max-w-[340px] truncate font-mono text-body-2-regular text-text-secondary"
                  title={bin}
                >
                  {bin}
                </span>
              ) : (
                <span className="text-body-2-regular text-text-tertiary">
                  {t("wsl.cli.pathMissing")}
                </span>
              )}
            </SettingsRow>
            <SettingsRow label={t("wsl.cli.probed")}>
              <span className="tabular-nums text-body-2-regular text-text-secondary">
                {probedAgoSecs == null
                  ? t("wsl.cli.probedUnknown")
                  : relativeTime(Date.now() - probedAgoSecs * 1000)}
              </span>
            </SettingsRow>
          </>
        )}
        <WslEnginePathRow
          key={`${distro}:${engine}`}
          distro={distro}
          engine={engine}
          anchor={`cliWslPath:${engine}`}
          onSaved={onSaved}
          onError={setPathError}
        />
        {pathError && (
          <div className="border-b border-separator-border px-3 py-2.5 pr-2.5 last:border-b-0">
            <p role="alert" className="text-body-2-regular text-text-error-primary">
              {pathError}
            </p>
          </div>
        )}
      </SettingsCard>

      {!loading && !error && source === "missing" && (
        <div className="flex w-full flex-col gap-1 px-3">
          <p className="text-body-regular text-text-primary">
            {t("wsl.cli.emptyTitle", { cli })}
          </p>
          <p className="text-body-2-regular text-text-secondary">
            {t("wsl.cli.emptyDesc")}
          </p>
        </div>
      )}

      <SettingsCard>
        <SettingsRow
          label={t("settings.cliChannels")}
          description={t("wsl.cli.channelsGlobal")}
        >
          <Button variant="secondary" size="small" onClick={onManageHost}>
            {t("wsl.cli.manageChannels")}
          </Button>
        </SettingsRow>
      </SettingsCard>

      {editingOfficial && (
        <WslOfficialEditDialog
          engine={engine}
          distro={distro}
          onClose={() => setEditingOfficial(false)}
        />
      )}
    </div>
  );
}

function CopyPathButton({ path }: { path: string }) {
  const { t } = useTranslation();
  const { copied, copy } = useCopied();
  const label = t("wsl.cli.copyPath");
  return (
    <Button
      iconOnly
      size="small"
      variant="ghost"
      aria-label={label}
      title={label}
      leadingIcon={copied ? Check : Copy}
      onClick={() => copy(path)}
    />
  );
}

function SourceBadge({ source }: { source: "probe" | "override" | "missing" }) {
  const { t } = useTranslation();
  const text =
    source === "probe"
      ? t("wsl.cli.sourceProbe")
      : source === "override"
        ? t("wsl.cli.sourceOverride")
        : t("wsl.cli.sourceMissing");
  return (
    <span
      className={
        source === "override"
          ? "shrink-0 rounded-full bg-background-tertiary-warning px-2 py-0.5 text-body-2-medium text-text-warning-primary"
          : source === "missing"
            ? "shrink-0 rounded-full bg-background-tertiary-default px-2 py-0.5 text-body-2-medium text-text-tertiary"
            : "shrink-0 rounded-full bg-background-tertiary-default px-2 py-0.5 text-body-2-medium text-text-secondary"
      }
    >
      {text}
    </span>
  );
}
