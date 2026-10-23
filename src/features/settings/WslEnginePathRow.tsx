import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/base/input/input";
import { SettingsRow } from "@/components/application/settings/settings-rows";
import { CLI_DISPLAY_NAMES } from "@/components/foundations/icons/engine-brands";
import { errorText } from "@/lib/errors";
import { ipc } from "@/lib/ipc";

/**
 * 单个发行版里某个引擎的 CLI 路径覆盖（设置 → WSL 与 CLI 管理共用）。
 *
 * 独立组件而不是写在 `.map()` 里:它有自己的草稿状态与保存动作,做成 hook
 * 会被条件调用 —— 发行版/引擎行是动态的。
 *
 * 保存语义:失焦且值有变化才写盘(设置写入会广播 settings://changed);
 * 空串 = 删除覆盖,退回自动探测。
 */
export function WslEnginePathRow({
  distro,
  engine,
  anchor,
  onSaved,
  onError,
}: {
  distro: string;
  engine: string;
  /** 页面内唯一:WSL 设置页用 `wslCliPath:<distro>:<engine>`,CLI 面板用 `cliWslPath:<engine>`。 */
  anchor: string;
  onSaved?: (distro: string) => void;
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
    void ipc
      .setWslEnginePath(distro, engine, value)
      .then(() => {
        saved.current = value;
        onError("");
        onSaved?.(distro);
      })
      .catch((err: unknown) => onError(errorText(err)));
  }, [draft, distro, engine, onError, onSaved]);

  const label = t("wsl.cliPathFor", {
    cli: CLI_DISPLAY_NAMES[engine] ?? engine,
  });

  return (
    <SettingsRow
      anchor={anchor}
      label={label}
      description={t("wsl.cliPathDesc")}
    >
      <div className="w-[260px] shrink-0">
        <Input
          size="small"
          aria-label={label}
          placeholder={t("wsl.cliPathPlaceholder")}
          // 默认输入框在暗色主题下与卡片同色，看不出这里可以填；显式描边。
          fieldClassName="border border-border-button-default"
          value={draft}
          onChange={setDraft}
          onBlur={save}
        />
      </div>
    </SettingsRow>
  );
}
