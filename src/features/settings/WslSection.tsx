import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import { Button } from "@/components/base/buttons/button";
import { ActionFeedbackIcon, useActionFeedback } from "@/components/base/action-feedback";
import { Input } from "@/components/base/input/input";
import {
  SettingsCard,
  SettingsRow,
  SettingsSectionLabel,
} from "@/components/application/settings/settings-rows";
import { CLI_DISPLAY_NAMES } from "@/components/foundations/icons/engine-brands";
import { errorText } from "@/lib/errors";
import { ipc } from "@/lib/ipc";
import { invalidateWslEngineAvailability } from "@/features/chat/components/use-wsl-engine-availability";

/**
 * 设置 → WSL(设计稿 §5.9)。
 *
 * 本机 WSL 工作区不需要插件:工作区就是 `\\wsl.localhost\<发行版>\…`。这一页
 * 只做三件事 —— 列出已安装发行版、展示每个发行版里探到的 CLI 与版本、给一个
 * 「重新检测」让用户装完 CLI 后不用重启应用。
 *
 * 探测本身有 2.4s 冷启动(V5),所以页面先用「未检测到」以外的加载态,拿到
 * 结果再逐行显示;探测失败按发行版降级为「未探测到」并把原因留在页面上,
 * 不让整页报错 —— 一个发行版起不来不影响其他发行版。
 *
 * 「重新检测」是刷新型动作,反馈走 §4.1 的转圈 → 对号(`useActionFeedback`)。
 */
export function WslSection() {
  const { t } = useTranslation();
  const [distros, setDistros] = useState<string[] | null>(null);
  const [enginesByDistro, setEnginesByDistro] = useState<
    Record<string, string[]>
  >({});
  /** 引擎 id → 发行版内 CLI 版本(§5.9「探测结果与版本」)。 */
  const [versionsByDistro, setVersionsByDistro] = useState<
    Record<string, Record<string, string>>
  >({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const refreshAction = useActionFeedback({ spin: true });

  /** 返回本次检测是否拿到了可展示的结果:失败时按钮不冒充成功(§4.1
   *  的「对号」只在真的成功时出现)。
   *  `force=false` 只读当前探测缓存(挂载);`true` 才失效缓存重探测。 */
  const probeAll = useCallback(async (force: boolean): Promise<boolean> => {
    const [listedResult, probed] = await Promise.all([
      ipc.wslDistros().then(
        (distros) => ({ ok: true as const, distros }),
        (error: unknown) => ({ ok: false as const, error: errorText(error) }),
      ),
      force ? ipc.wslReprobe() : ipc.wslProbeSnapshot(),
    ]);
    const listed = listedResult.ok ? listedResult.distros : [];
    setDistros(listed);
    setEnginesByDistro(
      Object.fromEntries(probed.map((row) => [row.distro, row.engines])),
    );
    setVersionsByDistro(
      Object.fromEntries(probed.map((row) => [row.distro, row.versions])),
    );
    if (force) invalidateWslEngineAvailability();
    // 列表读取失败(未安装 / 超时 / 命令失败)与「装好了但没有发行版」
    // 是两种事实:前者显示后端错误,后者显示空态(§10 P2-6)。
    if (!listedResult.ok) {
      setError(listedResult.error);
      return false;
    }
    const ok = listed.length > 0 || probed.length > 0;
    setError(ok ? null : t("wsl.distrosUnavailable"));
    return ok;
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    void probeAll(false)
      .catch((e: unknown) => {
        if (!cancelled) setError(errorText(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // 只在挂载时跑一次:刷新入口是显式的「重新检测」。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rescan = () => {
    // isFailure 读的是本次动作的返回值,不是渲染时闭包里的旧 error:
    // 否则失败过一次之后每次点都显示成功对号。
    let ok = false;
    void refreshAction
      .start(
        async () => {
          ok = await probeAll(true);
          setLoading(false);
        },
        () => !ok,
      )
      .catch((e: unknown) => setError(errorText(e)));
  };

  /** 保存单个覆盖后只重探该发行版,并把结果同步给聊天页的引擎菜单。 */
  const rescanDistro = useCallback(async (distro: string) => {
    const [row] = await ipc.wslReprobe(distro);
    if (row) {
      setEnginesByDistro((prev) => ({ ...prev, [row.distro]: row.engines }));
      setVersionsByDistro((prev) => ({ ...prev, [row.distro]: row.versions }));
    }
    invalidateWslEngineAvailability();
  }, []);

  const rows = useMemo(() => distros ?? [], [distros]);

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="flex w-full flex-col gap-2">
        <p className="px-3 text-body-2-regular text-text-secondary">
          {t("wsl.settingsDesc")}
        </p>
        <SettingsCard className="mt-1">
          <SettingsRow
            anchor="wslRescan"
            label={t("wsl.distros")}
            description={
              loading
                ? t("wsl.distrosLoading")
                : rows.length === 0
                  ? t("wsl.distrosEmpty")
                  : undefined
            }
          >
            <Button
              variant="secondary"
              size="small"
              aria-label={t("wsl.rescan")}
              title={t("wsl.rescan")}
              disabled={refreshAction.feedback === "running"}
              onClick={rescan}
            >
              <ActionFeedbackIcon
                icon={RefreshCw}
                feedback={refreshAction.feedback}
                spin
              />
              <span className="ml-1">{t("wsl.rescan")}</span>
            </Button>
          </SettingsRow>
          {error && (
            <div className="border-b border-separator-border px-3 py-2.5 pr-2.5 last:border-b-0">
              <p role="alert" className="text-body-2-regular text-text-error-primary">
                {error}
              </p>
            </div>
          )}
        </SettingsCard>
      </div>

      {rows.map((distro) => {
        const engines = enginesByDistro[distro] ?? [];
        const versions = versionsByDistro[distro] ?? {};
        // 覆盖位按引擎分开:一个发行版里 claude 装好了、codex 没装,是很常见的
        // 状态,共用一个输入框就没法只补 codex(见 §5.9「各引擎……自定义 CLI
        // 路径」)。阶段 1 在 WSL 里跑的就是 Claude 与 Codex,所以这两个即使探测
        // 不到也要给出输入框 —— 探测不到恰恰是最需要手工指定的时候。
        const overrideEngines = [
          ...new Set([...WSL_OVERRIDE_ENGINES, ...engines]),
        ];
        return (
          <div key={distro} className="flex w-full flex-col gap-2">
            <SettingsSectionLabel className="px-3">
              {distro}
            </SettingsSectionLabel>
            <SettingsCard>
              <SettingsRow
                anchor={`wslEngines:${distro}`}
                label={t("wsl.engines")}
                description={
                  engines.length === 0 ? t("wsl.enginesEmpty") : undefined
                }
              >
                <div className="flex flex-wrap justify-end gap-1.5">
                  {engines.map((engine) => (
                    <span
                      key={engine}
                      className="rounded-full bg-background-tertiary-default px-2 py-0.5 text-body-2-medium text-text-secondary"
                    >
                      {CLI_DISPLAY_NAMES[engine] ?? engine}
                      {versions[engine] && (
                        <span className="ml-1 text-text-tertiary tabular-nums">
                          {versions[engine]}
                        </span>
                      )}
                    </span>
                  ))}
                </div>
              </SettingsRow>
              {overrideEngines.map((engine) => (
                <OverrideRow
                  key={engine}
                  distro={distro}
                  engine={engine}
                  onSaved={(savedDistro) =>
                    void rescanDistro(savedDistro).catch((e: unknown) =>
                      setError(errorText(e)),
                    )
                  }
                  onError={setError}
                />
              ))}
            </SettingsCard>
          </div>
        );
      })}
    </div>
  );
}

/**
 * 阶段 1 在 WSL 工作区里支持的引擎(设计稿 §1.2)。它们即使没被探测到也要
 * 有覆盖位:用户点进这一页多半就是因为某个 CLI 没被自动找到。
 */
const WSL_OVERRIDE_ENGINES = ["claude", "codex", "pi"] as const;

/** 单个发行版里某个引擎的 CLI 路径覆盖(§5.9)。
 *
 *  独立组件而不是写在 `.map()` 里:它有自己的草稿状态与保存动作,做成
 *  hook 会被条件调用 —— 发行版列表是动态的,行数每次刷新都可能变。
 */
function OverrideRow({
  distro,
  engine,
  onSaved,
  onError,
}: {
  distro: string;
  engine: string;
  onSaved: (distro: string) => void;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const saved = useRef<string | null>(null);

  // 挂载时读回该引擎已登记的覆盖:页面刷新不该把用户填过的路径显示成空。
  useEffect(() => {
    let cancelled = false;
    void ipc
      .getWslEnginePaths(distro)
      .then((rows) => {
        if (cancelled) return;
        const value = rows.find(([id]) => id === engine)?.[1] ?? "";
        saved.current = value;
        setDraft(value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [distro, engine]);

  const save = useCallback(() => {
    const value = draft.trim();
    // 未改动就不写盘:设置写入会广播 settings://changed。
    if (value === (saved.current ?? "")) return;
    // 键是 `<distro>:<engine>` 一条一个引擎:写错引擎会把别的 CLI 盖掉,
    // 所以这里用行自己绑定的 engine,不再去猜「首个引擎」。
    // 空串 = 删除该引擎的覆盖,退回自动探测。
    void ipc
      .setWslEnginePath(distro, engine, value)
      .then(() => {
        saved.current = value;
        onError("");
        onSaved(distro);
      })
      .catch((err: unknown) => onError(errorText(err)));
  }, [draft, distro, engine, onError, onSaved]);

  const label = t("wsl.cliPathFor", {
    cli: CLI_DISPLAY_NAMES[engine] ?? engine,
  });

  return (
    <SettingsRow
      anchor={`wslCliPath:${distro}:${engine}`}
      label={label}
      description={t("wsl.cliPathDesc")}
    >
      <div className="w-[260px] shrink-0">
        <Input
          size="small"
          aria-label={label}
          value={draft}
          onChange={setDraft}
          onBlur={save}
        />
      </div>
    </SettingsRow>
  );
}
