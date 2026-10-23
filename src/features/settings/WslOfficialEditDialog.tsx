import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import X from "lucide-react/dist/esm/icons/x";
import { Button } from "@/components/base/buttons/button";
import { TextArea } from "@/components/base/input/textarea";
import { ModalShell } from "@/components/dialogs";
import { CLI_DISPLAY_NAMES } from "@/components/foundations/icons/engine-brands";
import { errorText } from "@/lib/errors";
import { ipc, type WslCliConfigFile } from "@/lib/ipc";
import { jsonErrorOf } from "./official-config-json";
import type { EngineId } from "./providers";

/**
 * 编辑发行版内官方配置 dialog。与主机的 CliOfficialEditDialog 同形,但读写走
 * `wsl_cli_config_*` 白名单文件服务:base64 内容经 stdin 脚本进出,secret
 * 文件(如 codex auth.json)标记密钥、写入 0600,冲突(expectedHash 不一致)
 * 返回冲突并提示重新读取,不覆盖发行版里刚改的内容。
 */

export function WslOfficialEditDialog({
  engine,
  distro,
  onClose,
}: {
  engine: EngineId;
  distro: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [files, setFiles] = useState<WslCliConfigFile[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [conflict, setConflict] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => {
    setLoadError("");
    setConflict("");
    void ipc
      .wslCliConfigRead(distro, engine)
      .then((read) => {
        setFiles(read);
        // 缺失的 JSON 文件预填空对象,第一次保存就能过「必须是对象」的校验。
        setDrafts(
          Object.fromEntries(
            read.map((file) => [
              file.key,
              file.exists || file.content
                ? file.content
                : file.format === "json"
                  ? "{\n}\n"
                  : "",
            ]),
          ),
        );
      })
      .catch((error: unknown) => setLoadError(errorText(error)));
  };

  useEffect(() => {
    load();
    // 打开即读一次;之后由「重新读取」显式刷新。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [distro, engine]);

  const invalid = (files ?? []).some(
    (file) => jsonErrorOf(file.format, drafts[file.key] ?? "") != null,
  );
  const tooLarge = (files ?? []).some((file) => file.tooLarge);

  const save = async () => {
    setBusy(true);
    setSaveError("");
    setConflict("");
    try {
      await ipc.wslCliConfigWrite(
        distro,
        engine,
        (files ?? [])
          .filter((file) => !file.tooLarge)
          .map((file) => ({
            key: file.key,
            content: drafts[file.key] ?? "",
            expectedHash: file.hash,
          })),
      );
      onClose();
    } catch (error: unknown) {
      const raw = error instanceof Error ? error.message : String(error);
      if (raw.startsWith("WSL_CLI_CONFIG_CONFLICT:")) {
        setConflict(errorText(error));
      } else {
        setSaveError(errorText(error));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell
      onClose={onClose}
      label={t("wsl.cli.editTitle", { name: CLI_DISPLAY_NAMES[engine] })}
      className="max-h-[calc(100vh-48px)] w-[640px] max-w-[calc(100vw-32px)] overflow-y-auto p-6"
    >
      <div className="flex items-start justify-between gap-4">
        <p className="text-title-3-medium text-text-primary">
          {t("wsl.cli.editTitle", { name: CLI_DISPLAY_NAMES[engine] })}
        </p>
        <button
          type="button"
          aria-label={t("common.cancel")}
          onClick={onClose}
          className="flex size-7 shrink-0 items-center justify-center rounded-lg text-foreground-icon-secondary hover:bg-background-secondary-hover hover:text-foreground-icon-primary"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>

      <div className="mt-5 flex flex-col gap-5">
        {loadError && <p className="text-body-2-regular text-text-error-primary">{loadError}</p>}
        {!files && !loadError && (
          <p className="text-body-2-regular text-text-tertiary">{t("common.loading")}</p>
        )}
        {files?.map((file) => {
          const draft = drafts[file.key] ?? "";
          const jsonError = jsonErrorOf(file.format, draft);
          return (
            <div key={file.key} className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <code
                  className="min-w-0 flex-1 truncate font-mono text-body-2-regular text-text-secondary"
                  title={file.path}
                >
                  {file.path}
                </code>
                {file.secret && (
                  <span className="shrink-0 rounded-full bg-background-tertiary-warning px-2 py-0.5 text-body-2-medium text-text-warning-primary">
                    {t("wsl.cli.secretBadge")}
                  </span>
                )}
              </div>
              {file.tooLarge ? (
                <p className="text-body-2-regular text-text-warning-primary">
                  {t("wsl.cli.fileTooLarge", { name: file.key })}
                </p>
              ) : (
                <>
                  {!file.exists && (
                    <p className="text-body-2-regular text-text-tertiary">
                      {t("wsl.cli.fileMissing")}
                    </p>
                  )}
                  <TextArea
                    mono
                    rows={file.format === "json" && files.length > 1 ? 6 : 12}
                    spellCheck={false}
                    aria-label={file.path}
                    value={draft}
                    onChange={(content) =>
                      setDrafts((d) => ({ ...d, [file.key]: content }))
                    }
                    isInvalid={jsonError != null}
                    hint={
                      jsonError === "object"
                        ? t("settings.cliOfficialEditJsonObject")
                        : jsonError
                          ? t("settings.cliOfficialEditJsonInvalid")
                          : undefined
                    }
                    inputClassName="whitespace-pre"
                  />
                </>
              )}
            </div>
          );
        })}
        {conflict && (
          <div className="flex items-center justify-between gap-3">
            <p role="alert" className="text-body-2-regular text-text-error-primary">
              {conflict}
            </p>
            <Button variant="secondary" size="small" onClick={load}>
              {t("wsl.cli.reRead")}
            </Button>
          </div>
        )}
        {saveError && <p role="alert" className="text-body-2-regular text-text-error-primary">{saveError}</p>}
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" size="small" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button
          size="small"
          disabled={busy || !files || invalid || tooLarge || Boolean(loadError)}
          onClick={() => void save()}
        >
          {t("common.confirm")}
        </Button>
      </div>
    </ModalShell>
  );
}
