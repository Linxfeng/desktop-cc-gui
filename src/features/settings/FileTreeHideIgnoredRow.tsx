import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Switch } from "@/components/base/switch/switch";
import { SettingsRow } from "@/components/application/settings/settings-rows";
import { errorText } from "@/lib/errors";
import {
  hydrateFileTreePreferences,
  useFileTreePreferencesStore,
} from "@/features/files/tree-preferences";

/** 设置 → 通用 → 行为: hide Git-ignored entries from the file tree. Off by
 *  default — they stay listed, drawn faded. The tree re-filters at once. */
export function FileTreeHideIgnoredRow() {
  const { t } = useTranslation();
  const hideIgnored = useFileTreePreferencesStore((s) => s.hideIgnored);
  const [error, setError] = useState<string | null>(null);

  // Authoritative read on mount: startup hydration may have failed and left
  // the switch at its default.
  useEffect(() => {
    void hydrateFileTreePreferences();
  }, []);

  const onChange = (hide: boolean) => {
    void useFileTreePreferencesStore
      .getState()
      .setHideIgnored(hide)
      .then(() => setError(null))
      .catch((e) => setError(errorText(e)));
  };

  return (
    <SettingsRow
      anchor="fileTreeHideIgnored"
      label={t("settings.fileTreeHideIgnored")}
      description={t("settings.fileTreeHideIgnoredDesc")}
    >
      <div className="flex shrink-0 items-center gap-2">
        {error && (
          <span
            role="alert"
            className="max-w-48 truncate text-caption-1-regular text-text-error-primary"
            title={error}
          >
            {t("common.error")}: {error}
          </span>
        )}
        <Switch
          size="sm"
          aria-label={t("settings.fileTreeHideIgnored")}
          isSelected={hideIgnored}
          onChange={onChange}
        />
      </div>
    </SettingsRow>
  );
}
