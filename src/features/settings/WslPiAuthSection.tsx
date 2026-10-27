/**
 * WSL 作用域内的 pi 供应商认证区块。与主机 `PiFamilyAuthSection` 共用状态
 * hook（`usePiFamilyAuth`）与两个展示组件（`PiFamilyApiKeySection` /
 * `PiFamilyCustomSection`）；差别只有数据源与 OAuth：
 *
 * - 数据源是发行版内的 `wsl_pi_*` 命令（掩码/校验在后端与主机共享）；
 * - WSL 作用域没有内置终端能力，OAuth 登录不渲染按钮，只给「在发行版内
 *   终端执行 /login <arg>」的降级说明 —— 不做点了无效的假按钮。
 */
import { useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "@/components/dialogs";
import { ipc, type PiFamilyModelsConfigReadResult } from "@/lib/ipc";
import { PI_FAMILY_APIKEY_PROVIDERS } from "./piFamilyAuthCatalog";
import { PiFamilyApiKeySection } from "./PiFamilyApiKeySection";
import { PiFamilyCustomSection } from "./PiFamilyCustomSection";
import { PiFamilyOauthSection } from "./PiFamilyOauthSection";
import { usePiFamilyAuthState, type PiFamilyAuthBackend } from "./usePiFamilyAuth";

/** Distro data source: the `wsl_pi_*` commands pinned to this distro.
 *  读时记下 models.json 的 sha256，写回带上 —— 发行版侧窗口期的修改会被
 *  后端按冲突拒绝，不覆盖。 */
function useWslBackend(distro: string): PiFamilyAuthBackend {
  const modelsHash = useRef<string | null>(null);
  return useMemo(
    () => ({
      list: () => ipc.wslPiAuthList(distro),
      setKey: (providerId, key) => ipc.wslPiAuthSetKey(distro, providerId, key),
      deleteCredential: (providerId) => ipc.wslPiAuthDelete(distro, providerId),
      modelsRead: async (): Promise<PiFamilyModelsConfigReadResult> => {
        const read = await ipc.wslPiModelsRead(distro);
        // WSL 读结果带 hash（写回冲突检测用）；展示组件吃主机形状。
        modelsHash.current = read.hash;
        return {
          file: { path: read.path, format: "json", exists: read.exists },
          text: read.text,
          template: read.template,
          providers: read.providers,
          parseError: read.parseError,
        };
      },
      modelsWrite: (text) =>
        ipc.wslPiModelsWrite(distro, text, modelsHash.current),
    }),
    [distro],
  );
}

export function WslPiAuthSection({ distro }: { distro: string }) {
  const { t } = useTranslation();
  const backend = useWslBackend(distro);
  // WSL 无内置终端：登录按钮改为降级说明，也不提供 host 终端登出入口。
  const onLaunchLogin = useCallback(() => {}, []);
  const auth = usePiFamilyAuthState("pi", backend, onLaunchLogin);

  return (
    <div className="flex w-full flex-col gap-6" data-testid="wsl-pi-auth-section">
      <PiFamilyOauthSection
        engine="pi"
        providers={auth.oauthProviders}
        oauthActive={auth.oauthActive}
        onLaunchLogin={null}
        onLaunchLogout={null}
      />

      <PiFamilyApiKeySection
        loadError={auth.loadError}
        storePath={auth.storePath}
        query={auth.query}
        onQueryChange={auth.setQuery}
        showAll={auth.showAll}
        onToggleShowAll={auth.toggleShowAll}
        totalCount={PI_FAMILY_APIKEY_PROVIDERS.length}
        providers={auth.visibleProviders}
        byId={auth.byId}
        editingId={auth.editingId}
        onOpenEditor={auth.openEditor}
        onDelete={auth.setDeleteTarget}
        draftKey={auth.draftKey}
        onDraftKeyChange={auth.setDraftKey}
        draftVisible={auth.draftVisible}
        onToggleDraftVisible={auth.toggleDraftVisible}
        saving={auth.saving}
        actionError={auth.actionError}
        onSave={(provider) => void auth.handleSave(provider)}
        onCloseEditor={auth.closeEditor}
      />

      <PiFamilyCustomSection
        modelsConfig={auth.modelsConfig}
        editorOpen={auth.modelsEditorOpen}
        draft={auth.modelsDraft}
        saving={auth.modelsSaving}
        error={auth.modelsError}
        onToggleEditor={auth.openModelsEditor}
        onDraftChange={auth.setModelsDraft}
        onSave={() => void auth.handleModelsSave()}
        query={auth.customQuery}
        onQueryChange={auth.setCustomQuery}
        providers={auth.visibleCustomProviders}
        editingProviderId={auth.customEditingId}
        providerDraft={auth.customDraft}
        providerSaving={auth.customSaving}
        providerError={auth.customError}
        onOpenProviderEditor={auth.openCustomProviderEditor}
        onProviderDraftChange={auth.setCustomDraft}
        onProviderSave={() => void auth.handleCustomProviderSave()}
        onCloseProviderEditor={auth.closeCustomProviderEditor}
        onDeleteProvider={auth.setCustomDeleteTarget}
        editingField={auth.customEditingField}
        fieldDraft={auth.customFieldDraft}
        fieldError={auth.customFieldError}
        onOpenFieldEditor={auth.openCustomFieldEditor}
        onFieldDraftChange={auth.setCustomFieldDraft}
        onFieldSave={() => void auth.handleCustomFieldSave()}
        onCloseFieldEditor={auth.closeCustomFieldEditor}
      />

      {auth.deleteTarget && (
        <ConfirmDialog
          danger
          message={t("settings.piAuthDeleteConfirm", { name: auth.deleteTarget.name })}
          onConfirm={() => void auth.handleDelete()}
          onCancel={() => auth.setDeleteTarget(null)}
        />
      )}
      {auth.customDeleteTarget && (
        <ConfirmDialog
          danger
          message={t("settings.piAuthCustomDeleteConfirm", {
            name: auth.customDeleteTarget.name ?? auth.customDeleteTarget.id,
          })}
          onConfirm={() => void auth.handleCustomProviderDelete()}
          onCancel={() => auth.setCustomDeleteTarget(null)}
        />
      )}
    </div>
  );
}
