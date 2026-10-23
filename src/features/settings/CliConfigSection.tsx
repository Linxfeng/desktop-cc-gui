import { useTranslation } from "react-i18next";
import { Button } from "@/components/base/buttons/button";
import {
  useCliScope,
  type CliScopeView,
} from "./use-cli-scope";
import { CliScopeSwitch } from "./CliScopeSwitch";
import type { EngineId } from "./providers";
import { HostCliConfig } from "./HostCliConfig";
import { WslCliPanel } from "./WslCliPanel";

/**
 * One CLI's page under the CLI 管理 nav group.
 *
 * Defaults to the host scope and renders exactly what it did before. On
 * desktop Windows with at least one distro and a backend-supported engine, a
 * scope switch appears above the content and can swap the whole page body for
 * the read-only WSL panel — no host config is read in that scope.
 */
export function CliConfigSection({ engine }: { engine: EngineId }) {
  const scope = useCliScope(engine);
  return (
    <div className="flex w-full flex-col gap-6">
      {scope.visible && <CliScopeSwitch scope={scope} />}
      {scope.requested === "wsl" && scope.metaError && (
        <MetaError scope={scope} />
      )}
      {scope.pending ? (
        <LoadingLine />
      ) : scope.active === "wsl" && scope.distro ? (
        <WslCliPanel
          engine={engine}
          distro={scope.distro}
          canEditOfficial={scope.editableEngines.includes(engine)}
          onManageHost={() => scope.setScope("host")}
        />
      ) : (
        <HostCliConfig engine={engine} />
      )}
    </div>
  );
}

/** 元数据读取失败但用户上次选的是 WSL：说明原因并给重试，下方仍可用本机页。 */
function MetaError({ scope }: { scope: CliScopeView }) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 rounded-2xl border border-separator-border bg-background-primary-default px-3 py-2.5"
    >
      <p className="text-body-2-regular text-text-error-primary">
        {t("wsl.cli.metaFailed", { message: scope.metaError ?? "" })}
      </p>
      <Button variant="secondary" size="small" onClick={scope.reloadMeta}>
        {t("wsl.cli.retry")}
      </Button>
    </div>
  );
}

/** 上次选 WSL、元数据还没回来：先别挂载 HostCliConfig，避免读一次主机配置再卸载。 */
function LoadingLine() {
  const { t } = useTranslation();
  return (
    <p role="status" className="px-3 text-body-regular text-text-tertiary">
      {t("wsl.cli.metaLoading")}
    </p>
  );
}
