import { useTranslation } from "react-i18next";
import { Button } from "@/components/base/buttons/button";
import { EmptyState } from "@/components/base/empty-state";

/** Changes panel body when the status could not be read at all (e.g.
 *  libgit2's ownership check refused the repository). The reason lives here,
 *  not in the dismissible header line, so closing that line never leaves the
 *  body on an endless "loading". Retry re-reads the status. */
export function StatusErrorState({
  message,
  busy,
  onRetry,
}: {
  message: string;
  busy: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <EmptyState className="flex-col gap-3 p-4">
      <p role="alert" className="text-center text-body-medium break-words text-text-error-primary">
        {message}
      </p>
      <Button size="small" variant="secondary" disabled={busy} aria-busy={busy} onClick={onRetry}>
        {t("git.retryStatus")}
      </Button>
    </EmptyState>
  );
}
