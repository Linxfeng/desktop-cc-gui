import { useTranslation } from "react-i18next";
import {
  SettingsCard,
  SettingsRow,
} from "@/components/application/settings/settings-rows";
import { Select, SelectItem } from "@/components/base/select/select";
import { PillTab, PillTabList } from "@/components/base/tabs/pill-tab";
import type { CliScopeView } from "./use-cli-scope";

/**
 * CLI 页顶部的「本机 / WSL 发行版」作用域。
 *
 * 只在可见时由 `CliConfigSection` 渲染；控件本身不做可见性判断。选择是全局
 * 记忆的（不按引擎分裂），所以在一个 CLI 页切到 WSL 后，其他受支持的引擎页
 * 也保持 WSL。
 *
 * 用 blue 变体而不是 gray：暗色主题下 gray 的选中底色（neutral-850）与卡片
 * （neutral-900）几乎同色，看不出选中；作用域是主模式切换，值得强调。
 */
export function CliScopeSwitch({ scope }: { scope: CliScopeView }) {
  const { t } = useTranslation();
  return (
    <SettingsCard>
      <SettingsRow label={t("wsl.cli.scope")}>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <PillTabList aria-label={t("wsl.cli.scope")}>
            <PillTab
              variant="blue"
              isSelected={scope.requested === "host"}
              onSelect={() => scope.setScope("host")}
            >
              {t("wsl.cli.scopeHost")}
            </PillTab>
            <PillTab
              variant="blue"
              isSelected={scope.requested === "wsl"}
              onSelect={() => scope.setScope("wsl")}
            >
              {t("wsl.cli.scopeWsl")}
            </PillTab>
          </PillTabList>
          {scope.requested === "wsl" && (
            <Select
              aria-label={t("wsl.cli.distro")}
              size="sm"
              selectedKey={scope.distro}
              onSelectionChange={(key) => {
                if (key != null) scope.setDistro(String(key));
              }}
              triggerClassName="min-w-40"
            >
              {scope.distros.map((distro) => (
                <SelectItem key={distro} id={distro}>
                  {distro}
                </SelectItem>
              ))}
            </Select>
          )}
        </div>
      </SettingsRow>
    </SettingsCard>
  );
}
