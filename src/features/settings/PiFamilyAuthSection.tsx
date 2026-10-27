/**
 * pi/omp「供应商认证」区块 — host scope. State machine lives in
 * `usePiFamilyAuth` (shared with the WSL panel); this file binds it to the
 * host IPC backend (`pi_family_*`) and the built-in terminal OAuth launch.
 *
 * - 订阅授权 group (PiFamilyOauthSection): OAuth status + CLI-owned login/logout
 *   flows in the built-in terminal.
 * - API Key group (PiFamilyApiKeySection): search / featured-vs-all /
 *   three-state rows / inline key editor / delete with confirmation. Keys
 *   never round-trip to the frontend — list carries only a masked display
 *   string.
 * - 自定义供应商 group (PiFamilyCustomSection): raw-text editor over
 *   models.json (pi) / models.yml (omp) with loose backend validation.
 *
 * State is component-local: refresh on mount, after writes, and on window
 * focus (the OAuth flow completes in the terminal, outside this component).
 * After every write a `CLI_CONFIG_CHANGED_EVENT` with the engine detail makes
 * the chat model pickers re-probe — the CLIs filter available models by
 * stored credentials.
 */
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { ConfirmDialog } from "@/components/dialogs";
import { ipc } from "@/lib/ipc";
import { PI_FAMILY_APIKEY_PROVIDERS } from "./piFamilyAuthCatalog";
import {
  launchPiFamilyLogin,
  launchPiFamilyLogout,
  waitForPiFamilyLogout,
} from "./piFamilyLogin";
import type { PiFamilyOauthProvider } from "./piFamilyAuthCatalog";
import { notifyCliConfigChanged } from "./providers";
import { PiFamilyApiKeySection } from "./PiFamilyApiKeySection";
import {
  PiFamilyCustomSection,
} from "./PiFamilyCustomSection";
import { PiFamilyOauthSection } from "./PiFamilyOauthSection";
import { usePiFamilyAuthState, type PiFamilyAuthBackend } from "./usePiFamilyAuth";

/** Host data source: the `pi_family_*` commands over the host home dir.
 *  稳定引用：`refresh` 的依赖里有 backend，每次渲染新建对象会变成无限刷新。 */
function useHostBackend(engine: "pi" | "omp"): PiFamilyAuthBackend {
  return useMemo(
    () => ({
      list: () => ipc.piFamilyAuthList(engine),
      setKey: (providerId: string, key: string) =>
        ipc.piFamilyAuthSetApiKey(engine, providerId, key),
      deleteCredential: (providerId: string) =>
        ipc.piFamilyAuthDeleteCredential(engine, providerId),
      modelsRead: () => ipc.piFamilyModelsConfigRead(engine),
      modelsWrite: (text: string) => ipc.piFamilyModelsConfigWrite(engine, text),
    }),
    [engine],
  );
}

export function PiFamilyAuthSection({
  engine,
  openCustomEditorSignal,
}: {
  engine: "pi" | "omp";
  /** Bump to open the 自定义供应商 editor from the 官方配置 row's 编辑
   *  entry (pi/omp official files are never cc-gui-managed, so no gate). */
  openCustomEditorSignal?: number;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const backend = useHostBackend(engine);
  const [notice, setNotice] = useState<string | null>(null);
  const [logoutTarget, setLogoutTarget] = useState<PiFamilyOauthProvider | null>(null);
  // The CLI owns the interactive OAuth flow: close the settings overlay so
  // the user sees the terminal the login runs in.
  const onLaunchLogin = useCallback(
    (provider: PiFamilyOauthProvider) => {
      void launchPiFamilyLogin(engine, provider.loginArg).then((launched) => {
        if (launched) {
          navigate("/");
        } else {
          setNotice(t("settings.piAuthLoginNoWorkspace"));
        }
      });
    },
    [engine, navigate, t],
  );
  const auth = usePiFamilyAuthState(engine, backend, onLaunchLogin, openCustomEditorSignal);

  const handleConfirmLogout = useCallback(async () => {
    if (!logoutTarget) return;
    const target = logoutTarget;
    const providerId = target.statusIds.find((id) => auth.oauthActive.has(id));
    setLogoutTarget(null);
    // The credential state may have changed while the confirmation was open.
    if (!providerId) return;
    try {
      const launched = await launchPiFamilyLogout(engine, providerId);
      if (!launched) {
        setNotice(t("settings.piAuthLogoutNoWorkspace"));
        return;
      }
      navigate("/");
      void waitForPiFamilyLogout(engine, target.statusIds).then((changed) => {
        if (changed) notifyCliConfigChanged(engine);
      });
    } catch (error) {
      setNotice(String(error));
    }
  }, [auth.oauthActive, engine, logoutTarget, navigate, t]);

  return (
    <div className="flex w-full flex-col gap-6" data-testid="pi-family-auth-section">
      {notice && (
        <p role="status" className="text-body-regular text-text-secondary">
          {notice}
        </p>
      )}

      {/* ── 订阅授权 (read-only + terminal hand-off) ── */}
      <PiFamilyOauthSection
        engine={engine}
        providers={auth.oauthProviders}
        oauthActive={auth.oauthActive}
        onLaunchLogin={auth.handleLaunchLogin}
        onLaunchLogout={setLogoutTarget}
      />

      {/* ── API Key ── */}
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

      {/* ── 自定义供应商 (models.json / models.yml) ── */}
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
      {logoutTarget && (
        <ConfirmDialog
          danger
          message={t(engine === "pi" ? "settings.piAuthGoToLogoutConfirm" : "settings.piAuthLogoutConfirm", { name: logoutTarget.name })}
          onConfirm={() => void handleConfirmLogout()}
          onCancel={() => setLogoutTarget(null)}
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
