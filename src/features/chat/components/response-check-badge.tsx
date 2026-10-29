import { useMemo } from "react";
import CircleAlert from "lucide-react/dist/esm/icons/circle-alert";
import CircleHelp from "lucide-react/dist/esm/icons/circle-help";
import CircleCheck from "lucide-react/dist/esm/icons/circle-check";
import { Focusable } from "react-aria-components";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipPanel } from "@/components/base/tooltip/tooltip";
import { cx } from "@/utils/cx";
import {
  checkResponseSelection,
  type ResponseCheckState,
  type SelectionVerdict,
} from "../response-check";

/**
 * The response check badge — sits at the end of the tail indicator's meta
 * row ("模型 … · 推理档位 …") while a turn streams: a circled check when the
 * response's own account matches the launch selection, a circled caution
 * when it does not. Hovering opens the same rows as a card, mirroring how
 * a gateway reports "requested vs upstream".
 *
 * Renders nothing until there is something to check: evidence from the
 * response, or a request whose engine can report the response side. An
 * absent response side stays unknown ("未上报"), never a pass.
 */
export function ResponseCheckBadge({
  check,
}: {
  check?: ResponseCheckState | null;
}) {
  const { t } = useTranslation();
  const view = useMemo(() => checkResponseSelection(check), [check]);
  if (!view.visible) return null;
  const ok = view.verdict !== "mismatch";
  const Icon =
    view.verdict === "unknown" || view.verdict === "snapshot"
      ? CircleHelp
      : ok
        ? CircleCheck
        : CircleAlert;
  const requested = check?.requested;
  const requestedModel =
    requested?.comparisonModel === null && requested.model
      ? `${requested.model} · ${t("chat.checkUnresolved")}`
      : requested?.comparisonModel &&
          requested.comparisonModel !== requested.model
        ? `${requested.model} → ${requested.comparisonModel}`
        : (requested?.model ?? null);
  const mismatch = t("chat.checkMismatch");
  const snapshot = t("chat.checkSnapshot");
  return (
    <Tooltip delay={200}>
      <Focusable>
        <button
          type="button"
          aria-label={
            view.verdict === "unknown"
              ? t("chat.checkUnknownAria")
              : view.verdict === "snapshot"
                ? t("chat.checkSnapshotAria")
                : ok
                  ? t("chat.checkOkAria")
                  : t("chat.checkMismatchAria")
          }
          className={cx(
            "inline-flex shrink-0 cursor-help items-center justify-center transition-colors",
            ok
              ? "text-foreground-icon-quaternary hover:text-text-secondary"
              : "text-text-warning-primary",
          )}
        >
          <Icon className="size-3.5" aria-hidden />
        </button>
      </Focusable>
      <TooltipPanel
        title={t("chat.checkTitle")}
        className="max-w-[min(380px,calc(100vw-32px))]"
      >
        <CheckRow
          label={t("chat.checkRequestedModel")}
          value={requestedModel}
        />
        <CheckRow
          label={t("chat.checkServedModel")}
          value={check?.served.model ?? null}
          verdict={view.model}
          mismatch={mismatch}
          snapshot={snapshot}
        />
        <CheckRow
          label={t("chat.checkRequestedEffort")}
          value={check?.requested.effort ?? null}
        />
        <CheckRow
          label={t("chat.checkServedEffort")}
          value={check?.served.effort ?? null}
          verdict={view.effort}
          mismatch={mismatch}
        />
      </TooltipPanel>
    </Tooltip>
  );
}

/** One request/response row of the card. */
function CheckRow({
  label,
  value,
  verdict = "unknown",
  mismatch = "",
  snapshot = "",
}: {
  label: string;
  value: string | null;
  verdict?: SelectionVerdict;
  mismatch?: string;
  snapshot?: string;
}) {
  const { t } = useTranslation();
  const unreported = value === null;
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4">
      <dt className="whitespace-nowrap text-text-tertiary">{label}</dt>
      <dd
        className={cx(
          "m-0 flex min-w-0 flex-wrap items-baseline justify-end gap-x-1 text-right tabular-nums",
          unreported
            ? "text-text-tertiary"
            : verdict === "mismatch"
              ? "text-text-warning-primary"
              : "text-text-primary",
        )}
      >
        <span className="min-w-0 break-all">
          {value ?? t("chat.checkUnreported")}
        </span>
        {verdict === "mismatch" && (
          <span className="whitespace-nowrap text-caption-1-regular">
            {mismatch}
          </span>
        )}
        {verdict === "snapshot" && (
          <span className="whitespace-nowrap text-caption-1-regular text-text-tertiary">
            {snapshot}
          </span>
        )}
      </dd>
    </div>
  );
}
