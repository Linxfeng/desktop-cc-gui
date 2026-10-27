/** 订阅授权 group — OAuth status rows plus CLI-owned login/logout actions in
 *  the built-in terminal (extracted from PiFamilyAuthSection).
 *
 *  终端动作传 `null`（WSL 作用域没有内置终端）时不渲染对应按钮：登录改为一行
 *  降级说明，登出不提供依赖 host 终端的假入口。 */
import { useTranslation } from "react-i18next";
import LogIn from "lucide-react/dist/esm/icons/log-in";
import LogOut from "lucide-react/dist/esm/icons/log-out";
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
  onLaunchLogout,
}: {
  engine: "pi" | "omp";
  providers: readonly PiFamilyOauthProvider[];
  oauthActive: ReadonlySet<string>;
  /** null = 终端不可用（WSL 作用域）：隐藏按钮，只给降级说明。 */
  onLaunchLogin: ((provider: PiFamilyOauthProvider) => void) | null;
  /** null = 终端不可用（WSL 作用域）：不提供 host 终端登出入口。 */
  onLaunchLogout: ((provider: PiFamilyOauthProvider) => void) | null;
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
          const loginCommand = engine === "pi"
            ? `pi /login ${provider.loginArg}`
            : `omp auth-broker login ${provider.loginArg}`;
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
                  title={loginCommand}
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
                  <code className="truncate">{loginCommand}</code>
                </span>
              )}
              {subscribed && onLaunchLogout && (
                <button
                  type="button"
                  onClick={() => onLaunchLogout(provider)}
                  className="flex shrink-0 items-center gap-1 rounded-lg border border-border-button-default px-2.5 py-1 text-body-2-medium text-text-primary hover:bg-background-secondary-hover"
                >
                  <LogOut className="size-3.5" aria-hidden />
                  {t(engine === "pi" ? "settings.piAuthGoToLogout" : "settings.piAuthLogout")}
                </button>
              )}
            </div>
          );
        })}
      </SettingsCard>
    </div>
  );
}
