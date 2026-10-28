import { useTranslation } from "react-i18next";
import { Button } from "@/components/base/buttons/button";
import { EmptyState } from "@/components/base/empty-state";

/** Changes panel body for a workspace outside any Git repository: says so
 *  and offers `git init` where the missing repository is noticed. Success
 *  replaces this body with the change list; failure lands in the header. */
export function NotRepoState({ busy, onInit }: { busy: boolean; onInit: () => void }) {
  const { t } = useTranslation();
  return (
    <EmptyState className="flex-col gap-3 p-4">
      <p className="text-center text-body-medium">{t("git.notARepo")}</p>
      <Button size="small" variant="secondary" disabled={busy} aria-busy={busy} onClick={onInit}>
        {t("git.initRepo")}
      </Button>
    </EmptyState>
  );
}
