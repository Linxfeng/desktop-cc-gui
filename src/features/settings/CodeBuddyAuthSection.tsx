import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import LogIn from "lucide-react/dist/esm/icons/log-in";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import UserCheck from "lucide-react/dist/esm/icons/user-check";
import {
  SettingsCard,
  SettingsSectionLabel,
} from "@/components/application/settings/settings-rows";
import { Button } from "@/components/base/buttons/button";
import { Badge } from "./CliChannelRow";
import { ipc, type CodeBuddyAccountStatus } from "@/lib/ipc";
import { launchCodeBuddyLogin } from "./codebuddyLogin";

interface AccountView {
  loggedIn: boolean;
  title: string;
  description: string;
}

// Navigation unmounts Settings. Keep the one-shot invalidation outside React
// so the first probe after returning to this section bypasses the 30s cache.
let forceNextProbe = false;

function consumeForcedProbe(): boolean {
  const force = forceNextProbe;
  forceNextProbe = false;
  return force;
}

export function CodeBuddyAuthSection() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [status, setStatus] = useState<CodeBuddyAccountStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const fetchStatus = useCallback(async (force = false) => {
    setRefreshing(true);
    try {
      setStatus(await ipc.codebuddyAccountStatus(force));
      setStatusFailed(false);
    } catch {
      setStatus(null);
      setStatusFailed(true);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void fetchStatus(consumeForcedProbe());
    const onFocus = () => {
      void fetchStatus(consumeForcedProbe());
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [fetchStatus]);

  const account = useMemo<AccountView | null>(() => {
    if (statusFailed) {
      return {
        loggedIn: false,
        title: t("settings.codebuddyAccountError"),
        description: t("settings.codebuddyAccountErrorDesc"),
      };
    }
    if (!status) return null; // probe pending: never claim "not logged in"
    if (!status.loggedIn) {
      // A negative probe is "unknown", not proof of being logged out: the
      // credential-store service names are guesses.
      return {
        loggedIn: false,
        title: t("settings.codebuddyAccountUnknown"),
        description: t("settings.codebuddyAccountUnknownDesc"),
      };
    }
    return {
      loggedIn: true,
      title: t("settings.codebuddyAccountLoggedIn"),
      description: t("settings.codebuddyAccountReady"),
    };
  }, [status, statusFailed, t]);

  // The CLI owns the interactive login flow: close the settings overlay so
  // the user sees the terminal the login runs in.
  const handleLaunchLogin = useCallback(async () => {
    if (launching) return;
    setLaunching(true);
    setNotice(null);
    try {
      const result = await launchCodeBuddyLogin();
      if (result.ok) {
        forceNextProbe = true;
        navigate("/");
      } else {
        setNotice(
          t(
            result.reason === "no-workspace"
              ? "settings.codebuddyLoginNoWorkspace"
              : "settings.codebuddyLoginFailed",
          ),
        );
      }
    } catch {
      setNotice(t("settings.codebuddyLoginFailed"));
    } finally {
      setLaunching(false);
    }
  }, [launching, navigate, t]);

  return (
    <div className="flex w-full flex-col gap-2">
      {notice && (
        <p role="status" className="text-body-regular text-text-secondary">
          {notice}
        </p>
      )}
      <div className="flex items-center justify-between gap-3">
        <SettingsSectionLabel anchor="codebuddyAuth">
          {t("settings.codebuddyAccountTitle")}
          <span className="ml-2 text-body-2-regular font-normal text-text-tertiary">
            {t("settings.codebuddyAccountHint")}
          </span>
        </SettingsSectionLabel>
        <Button
          variant="secondary"
          size="small"
          leadingIcon={RefreshCw}
          disabled={refreshing}
          onClick={() => void fetchStatus(true)}
        >
          {t("settings.codebuddyAccountRefresh")}
        </Button>
      </div>

      <SettingsCard>
        <div className="flex items-center gap-3 px-4 py-3.5">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background-secondary-default text-foreground-icon-primary">
            {account?.loggedIn ? (
              <UserCheck className="size-5 text-text-brand" />
            ) : (
              <LogIn className="size-5 text-text-tertiary" />
            )}
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-2">
              <span className="truncate text-body-medium text-text-primary">
                {account?.title ?? t("settings.codebuddyAccountChecking")}
              </span>
              {account?.loggedIn && (
                <Badge tone="default">{t("settings.codebuddyAccountLoggedIn")}</Badge>
              )}
            </div>
            <p className="truncate text-body-2-regular text-text-secondary">
              {account?.description ?? t("settings.codebuddyAccountCheckingDesc")}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant={account?.loggedIn ? "secondary" : "primary"}
              size="small"
              disabled={launching}
              onClick={() => void handleLaunchLogin()}
            >
              {account?.loggedIn
                ? t("settings.codebuddyAccountRelogin")
                : t("settings.codebuddyAccountLogin")}
            </Button>
          </div>
        </div>
      </SettingsCard>
    </div>
  );
}
