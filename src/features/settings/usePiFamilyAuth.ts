/**
 * pi/omp 供应商认证的状态 hook —— 主机与 WSL 作用域共用。
 *
 * 从 `PiFamilyAuthSection.tsx` 抽出：组件原本把「数据源」和「状态机」写在
 * 一起，主机直连 `ipc.piFamily*`。WSL 作用域的数据源是发行版内的
 * `wsl_pi_*` 命令（掩码/校验规则在后端共享，见 engine/pi_family_auth.rs），
 * 状态机完全一致，所以数据源收敛为 `PiFamilyAuthBackend` 适配器参数。
 *
 * 登录启动（OAuth 需要内置终端）同样作为回调注入：主机传现有实现，WSL
 * 作用域没有终端能力，不渲染登录按钮（适配器传 no-op）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  PiFamilyAuthListResult,
  PiFamilyAuthProviderSnapshot,
  PiFamilyCustomProviderSummary,
  PiFamilyModelsConfigReadResult,
} from "@/lib/ipc";
import {
  PI_FAMILY_APIKEY_PROVIDERS,
  PI_FAMILY_OAUTH_PROVIDERS,
  type PiFamilyAuthUiProvider,
  type PiFamilyOauthProvider,
} from "./piFamilyAuthCatalog";
import type { CustomProviderField } from "./PiFamilyCustomSection";
import {
  extractProviderBlock,
  removeProviderBlock,
  replaceProviderBlock,
  setProviderField,
} from "./piFamilyModelsBlocks";
import { notifyCliConfigChanged } from "./providers";

/** Data source for the auth state machine: host ipc vs distro wsl_pi_*. */
export interface PiFamilyAuthBackend {
  list(): Promise<PiFamilyAuthListResult>;
  setKey(providerId: string, key: string): Promise<void>;
  deleteCredential(providerId: string): Promise<void>;
  modelsRead(): Promise<PiFamilyModelsConfigReadResult>;
  /** Write models.json / models.yml text (verbatim; backend validates). */
  modelsWrite(text: string): Promise<void>;
}

/** Bump `CLI_CONFIG_CHANGED_EVENT` with the engine so the chat model picker
 *  re-probes that engine's catalog (pi filters models by stored credentials). */
function notifyChanged(engine: "pi" | "omp"): void {
  notifyCliConfigChanged(engine);
}

/** All credential-store / custom-provider state and handlers. Kept JSX-free so
 *  the component below only composes the three groups and their dialogs. */
export function usePiFamilyAuthState(
  engine: "pi" | "omp",
  backend: PiFamilyAuthBackend,
  onLaunchLogin: (provider: PiFamilyOauthProvider) => void,
  openCustomEditorSignal?: number,
) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<PiFamilyAuthListResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftKey, setDraftKey] = useState("");
  const [draftVisible, setDraftVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PiFamilyAuthUiProvider | null>(null);
  // ── custom providers (models.json / models.yml) ──
  const [modelsConfig, setModelsConfig] = useState<PiFamilyModelsConfigReadResult | null>(null);
  const [modelsEditorOpen, setModelsEditorOpen] = useState(false);
  const [modelsDraft, setModelsDraft] = useState("");
  const [modelsSaving, setModelsSaving] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [customQuery, setCustomQuery] = useState("");
  const [customEditingId, setCustomEditingId] = useState<string | null>(null);
  const [customDraft, setCustomDraft] = useState("");
  const [customSaving, setCustomSaving] = useState(false);
  const [customError, setCustomError] = useState<string | null>(null);
  const [customDeleteTarget, setCustomDeleteTarget] = useState<PiFamilyCustomProviderSummary | null>(null);
  const [customEditingField, setCustomEditingField] = useState<{
    id: string;
    field: CustomProviderField;
  } | null>(null);
  const [customFieldDraft, setCustomFieldDraft] = useState("");
  const [customFieldError, setCustomFieldError] = useState<string | null>(null);

  const oauthProviders = PI_FAMILY_OAUTH_PROVIDERS[engine];
  const storePath = snapshot?.store.path ?? "";

  const refresh = useCallback(async () => {
    try {
      const [authResult, modelsResult] = await Promise.all([
        backend.list(),
        backend.modelsRead(),
      ]);
      setSnapshot(authResult);
      setModelsConfig(modelsResult);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, [backend]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // OAuth completes in the terminal, so the credential store changes behind
  // this component's back: refresh on window focus (event-driven, no polling).
  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const byId = useMemo(() => {
    const map = new Map<string, PiFamilyAuthProviderSnapshot>();
    for (const item of snapshot?.providers ?? []) {
      map.set(item.id, item);
    }
    return map;
  }, [snapshot]);

  const oauthActive = useMemo(() => new Set(snapshot?.oauthProviders ?? []), [snapshot]);

  const visibleProviders = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return PI_FAMILY_APIKEY_PROVIDERS.filter((provider) => {
      if (!showAll && !provider.featured && !normalized) {
        return false;
      }
      if (!normalized) {
        return true;
      }
      const envVar = byId.get(provider.id)?.envVar ?? "";
      return (
        provider.name.toLowerCase().includes(normalized) ||
        provider.id.includes(normalized) ||
        envVar.toLowerCase().includes(normalized)
      );
    });
  }, [query, showAll, byId]);

  const visibleCustomProviders = useMemo(() => {
    const normalized = customQuery.trim().toLowerCase();
    const providers = modelsConfig?.providers ?? [];
    if (!normalized) {
      return providers;
    }
    return providers.filter((provider) =>
      [provider.id, provider.name ?? "", provider.baseUrl ?? "", provider.api ?? ""]
        .some((value) => value.toLowerCase().includes(normalized)),
    );
  }, [customQuery, modelsConfig]);

  const closeEditor = useCallback(() => {
    setEditingId(null);
    setDraftKey("");
    setDraftVisible(false);
    setActionError(null);
  }, []);

  const openEditor = useCallback(
    (id: string) => {
      if (editingId === id) {
        closeEditor();
        return;
      }
      setEditingId(id);
      setDraftKey("");
      setDraftVisible(false);
      setActionError(null);
    },
    [editingId, closeEditor],
  );

  const handleSave = useCallback(
    async (provider: PiFamilyAuthUiProvider) => {
      const key = draftKey.trim();
      if (!key) {
        // Empty = cancel, leave the credential untouched.
        closeEditor();
        return;
      }
      setSaving(true);
      setActionError(null);
      try {
        await backend.setKey(provider.id, key);
        // Credentials gate the CLI's live model catalog — make the chat
        // pickers re-probe.
        notifyChanged(engine);
        closeEditor();
        await refresh();
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
      } finally {
        setSaving(false);
      }
    },
    [backend, engine, draftKey, closeEditor, refresh],
  );

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) {
      return;
    }
    try {
      await backend.deleteCredential(deleteTarget.id);
      notifyChanged(engine);
      setDeleteTarget(null);
      await refresh();
    } catch (error) {
      setDeleteTarget(null);
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, [backend, engine, deleteTarget, refresh]);

  const closeCustomProviderEditor = useCallback(() => {
    setCustomEditingId(null);
    setCustomDraft("");
    setCustomError(null);
  }, []);

  const closeCustomFieldEditor = useCallback(() => {
    setCustomEditingField(null);
    setCustomFieldDraft("");
    setCustomFieldError(null);
  }, []);

  const showModelsEditor = useCallback(
    (error: string | null = null) => {
      closeCustomProviderEditor();
      closeCustomFieldEditor();
      const existing = modelsConfig?.text ?? "";
      setModelsDraft(existing.trim() ? existing : (modelsConfig?.template ?? ""));
      setModelsError(error);
      setModelsEditorOpen(true);
    },
    [closeCustomFieldEditor, closeCustomProviderEditor, modelsConfig],
  );

  const openModelsEditor = useCallback(() => {
    if (modelsEditorOpen) {
      setModelsEditorOpen(false);
      setModelsDraft("");
      setModelsError(null);
      return;
    }
    showModelsEditor();
  }, [modelsEditorOpen, showModelsEditor]);

  const openCustomProviderEditor = useCallback(
    (id: string) => {
      if (customEditingId === id) {
        closeCustomProviderEditor();
        return;
      }
      const format = modelsConfig?.file.format ?? "yaml";
      const block = extractProviderBlock(modelsConfig?.text ?? "", format, id);
      if (!block) {
        showModelsEditor(t("settings.piAuthCustomEditNotFound", { id }));
        return;
      }
      setModelsEditorOpen(false);
      setModelsDraft("");
      setModelsError(null);
      setCustomEditingId(id);
      setCustomDraft(block.text);
      setCustomError(null);
    },
    [closeCustomProviderEditor, customEditingId, modelsConfig, showModelsEditor, t],
  );

  const handleCustomProviderSave = useCallback(async () => {
    if (!customEditingId || !modelsConfig?.text) {
      return;
    }
    setCustomSaving(true);
    setCustomError(null);
    try {
      const format = modelsConfig.file.format;
      const block = extractProviderBlock(modelsConfig.text, format, customEditingId);
      if (!block) {
        setCustomError(t("settings.piAuthCustomEditNotFound", { id: customEditingId }));
        return;
      }
      const nextText = replaceProviderBlock(modelsConfig.text, block, customDraft);
      if (!extractProviderBlock(nextText, format, customEditingId)) {
        setCustomError(t("settings.piAuthCustomEditProviderMissing", { id: customEditingId }));
        return;
      }
      await backend.modelsWrite(nextText);
      notifyChanged(engine);
      closeCustomProviderEditor();
      await refresh();
    } catch (error) {
      setCustomError(error instanceof Error ? error.message : String(error));
    } finally {
      setCustomSaving(false);
    }
  }, [backend, closeCustomProviderEditor, customDraft, customEditingId, engine, modelsConfig, refresh, t]);

  const openCustomFieldEditor = useCallback(
    (id: string, field: CustomProviderField) => {
      if (customEditingField?.id === id && customEditingField.field === field) {
        closeCustomFieldEditor();
        return;
      }
      const provider = modelsConfig?.providers.find((item) => item.id === id);
      if (!provider) {
        return;
      }
      closeCustomProviderEditor();
      setCustomEditingField({ id, field });
      setCustomFieldDraft(
        field === "baseUrl" ? (provider.baseUrl ?? "") : provider.id,
      );
      setCustomFieldError(null);
    },
    [closeCustomFieldEditor, closeCustomProviderEditor, customEditingField, modelsConfig],
  );

  const handleCustomFieldSave = useCallback(async () => {
    if (!customEditingField || !modelsConfig?.text) {
      return;
    }
    const { id, field } = customEditingField;
    const value = customFieldDraft.trim();
    if (field === "baseUrl" && value === "") {
      setCustomFieldError(t("settings.piAuthCustomFieldEmptyUrl"));
      return;
    }
    if (field === "id" && value === "") {
      setCustomFieldError(t("settings.piAuthCustomFieldEmptyId"));
      return;
    }
    if (
      field === "id" &&
      modelsConfig.providers.some((item) => item.id !== id && item.id === value)
    ) {
      setCustomFieldError(t("settings.piAuthCustomFieldDuplicateId", { id: value }));
      return;
    }
    setCustomSaving(true);
    setCustomFieldError(null);
    try {
      const nextText = setProviderField(
        modelsConfig.text,
        modelsConfig.file.format,
        id,
        field,
        value,
      );
      if (!nextText) {
        setCustomFieldError(t("settings.piAuthCustomEditNotFound", { id }));
        return;
      }
      if (nextText === modelsConfig.text) {
        closeCustomFieldEditor();
        return;
      }
      await backend.modelsWrite(nextText);
      notifyChanged(engine);
      closeCustomFieldEditor();
      await refresh();
    } catch (error) {
      setCustomFieldError(error instanceof Error ? error.message : String(error));
    } finally {
      setCustomSaving(false);
    }
  }, [
    backend,
    closeCustomFieldEditor,
    customEditingField,
    customFieldDraft,
    engine,
    modelsConfig,
    refresh,
    t,
  ]);

  const handleCustomProviderDelete = useCallback(async () => {
    const target = customDeleteTarget;
    if (!target || !modelsConfig?.text) {
      return;
    }
    setCustomSaving(true);
    setCustomError(null);
    try {
      const format = modelsConfig.file.format;
      const block = extractProviderBlock(modelsConfig.text, format, target.id);
      if (!block) {
        setCustomError(t("settings.piAuthCustomEditNotFound", { id: target.id }));
        return;
      }
      const nextText = removeProviderBlock(modelsConfig.text, block, format);
      await backend.modelsWrite(nextText);
      notifyChanged(engine);
      setCustomDeleteTarget(null);
      if (customEditingId === target.id) {
        closeCustomProviderEditor();
      }
      if (customEditingField?.id === target.id) {
        closeCustomFieldEditor();
      }
      await refresh();
    } catch (error) {
      setCustomDeleteTarget(null);
      setCustomError(error instanceof Error ? error.message : String(error));
    } finally {
      setCustomSaving(false);
    }
  }, [backend, closeCustomFieldEditor, closeCustomProviderEditor, customDeleteTarget, customEditingField, customEditingId, engine, modelsConfig, refresh, t]);

  // The 官方配置 row's 编辑 entry bumps this signal to open the models
  // editor. Adjusting state during render (React's recommended pattern,
  // comparing against the previous signal) fires exactly once per bump —
  // modelsConfig refreshes can't re-fire it while the signal stays set.
  const openSignal = openCustomEditorSignal ?? 0;
  const [prevOpenSignal, setPrevOpenSignal] = useState(openSignal);
  if (openSignal !== prevOpenSignal) {
    setPrevOpenSignal(openSignal);
    const existing = modelsConfig?.text ?? "";
    setModelsDraft(existing.trim() ? existing : (modelsConfig?.template ?? ""));
    setModelsError(null);
    setModelsEditorOpen(true);
  }

  const handleModelsSave = useCallback(async () => {
    setModelsSaving(true);
    setModelsError(null);
    try {
      await backend.modelsWrite(modelsDraft);
      // Custom providers join the CLI's model catalog too.
      notifyChanged(engine);
      setModelsEditorOpen(false);
      setModelsDraft("");
      await refresh();
    } catch (error) {
      setModelsError(error instanceof Error ? error.message : String(error));
    } finally {
      setModelsSaving(false);
    }
  }, [backend, engine, modelsDraft, refresh]);

  // The CLI owns the interactive OAuth flow; the launch strategy (built-in
  // terminal on host, degrade note in WSL) is injected by the caller.
  const handleLaunchLogin = useCallback(
    (provider: PiFamilyOauthProvider) => {
      onLaunchLogin(provider);
    },
    [onLaunchLogin],
  );

  const toggleShowAll = useCallback(() => setShowAll((value) => !value), []);
  const toggleDraftVisible = useCallback(() => setDraftVisible((visible) => !visible), []);

  return {
    oauthProviders,
    oauthActive,
    handleLaunchLogin,
    loadError,
    storePath,
    query,
    setQuery,
    showAll,
    toggleShowAll,
    visibleProviders,
    byId,
    editingId,
    openEditor,
    deleteTarget,
    setDeleteTarget,
    handleDelete,
    draftKey,
    setDraftKey,
    draftVisible,
    toggleDraftVisible,
    saving,
    actionError,
    handleSave,
    closeEditor,
    modelsConfig,
    modelsEditorOpen,
    modelsDraft,
    setModelsDraft,
    modelsSaving,
    modelsError,
    openModelsEditor,
    handleModelsSave,
    customQuery,
    setCustomQuery,
    visibleCustomProviders,
    customEditingId,
    customDraft,
    setCustomDraft,
    customSaving,
    customError,
    openCustomProviderEditor,
    handleCustomProviderSave,
    closeCustomProviderEditor,
    customDeleteTarget,
    setCustomDeleteTarget,
    handleCustomProviderDelete,
    customEditingField,
    customFieldDraft,
    setCustomFieldDraft,
    customFieldError,
    openCustomFieldEditor,
    handleCustomFieldSave,
    closeCustomFieldEditor,
  };
}
