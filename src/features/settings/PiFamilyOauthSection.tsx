/** 订阅授权 group — read-only OAuth status rows plus a 登录 button that hands
 *  the interactive flow to the built-in terminal (extracted from
 *  PiFamilyAuthSection).
 *
 *  `onLaunchLogin = null`（WSL 作用域没有内置终端）时不渲染按钮：改为一行
 *  降级说明（在发行版内终端执行 `/login <arg>`），不提供点了无效的假按钮。 */
import { useTranslation } from "react-i18next";
import LogIn from "lucide-react/dist/esm/icons/log-in";
import Terminal from "lucide-react/dist/esm/icons/terminal";
import {
  SettingsCard,
  SettingsSectionLabel,
} from "@/components/application/settings/settings-rows";
import { cx } from "@/utils/cx";
import type { PiFamilyOauthProvider } from "./piFamilyAuthCatalog";
import { BrandIcon, ROW, StatusDot } from "./PiFamilyAuthShared";

export function PiFamilyOauthSection({
  engine,
  providers,
  oauthActive,
  onLaunchLogin,
}: {
  engine: "pi" | "omp";
  providers: readonly PiFamilyOauthProvider[];
  oauthActive: ReadonlySet<string>;
  /** null = 终端不可用（WSL 作用域）：隐藏按钮，只给降级说明。 */
  onLaunchLogin: ((provider: PiFamilyOauthProvider) => void) | null;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex w-full flex-col gap-2">
      <SettingsSectionLabel anchor="piAuthOauth">
        {t("settings.piAuthOauthTitle")}
        <span className="ml-2 text-body-2-regular font-normal text-text-tertiary">
          {t("settings.piAuthOauthHint")}
        </span>
      </SettingsSectionLabel>
      <SettingsCard>
        {providers.map((provider) => {
          const subscribed = provider.statusIds.some((id) => oauthActive.has(id));
          return (
            <div className={ROW} key={provider.id}>
              <BrandIcon iconSrc={provider.iconSrc} />
              <div className="flex min-w-0 flex-1 flex-col">
                <p className="truncate text-body-regular text-text-primary">{provider.name}</p>
                <p className="truncate text-body-2-regular text-text-secondary">
                  {t(`settings.piAuthOauthDesc${provider.descKey.charAt(0).toUpperCase()}${provider.descKey.slice(1)}`)}
                </p>
              </div>
              <span
                className={cx(
                  "flex shrink-0 items-center gap-1.5 text-body-2-regular",
                  subscribed ? "text-text-secondary" : "text-text-tertiary",
                )}
              >
                <StatusDot on={subscribed} />
                {subscribed ? t("settings.piAuthSubscribed") : t("settings.piAuthNotSubscribed")}
              </span>
              {onLaunchLogin ? (
                <button
                  type="button"
                  onClick={() => onLaunchLogin(provider)}
                  title={
                    engine === "pi"
                      ? `pi /login ${provider.loginArg}`
                      : `omp auth-broker login ${provider.loginArg}`
                  }
                  className="flex shrink-0 items-center gap-1 rounded-lg border border-border-button-default px-2.5 py-1 text-body-2-medium text-text-primary hover:bg-background-secondary-hover"
                >
                  <LogIn className="size-3.5" aria-hidden />
                  {t("settings.piAuthLogin")}
                </button>
              ) : (
                <span
                  className="flex min-w-0 shrink-0 items-center gap-1.5 text-body-2-regular text-text-tertiary"
                  title={t("wsl.cli.piAuthOauthHint", { command: `/login ${provider.loginArg}` })}
                >
                  <Terminal className="size-3.5" aria-hidden />
                  <code className="truncate">{`pi /login ${provider.loginArg}`}</code>
                </span>
              )}
            </div>
          );
        })}
      </SettingsCard>
    </div>
  );
}
