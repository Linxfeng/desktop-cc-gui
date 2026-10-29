import type { ModelOption } from "./cli-menu";

/** Model rows bucketed by provider, first-appearance order. */
export interface ModelGroup {
  /** Provider id, "" for rows with no provider. */
  key: string;
  rows: ModelOption[];
}

/**
 * Bucket rows by provider, first-appearance order. A section header names the
 * source, which matters most exactly when a filter has narrowed the list to
 * one provider — dropping the header there left rows that no longer said
 * where they came from. Only a catalog with no provider information at all
 * collapses to a single keyless group.
 */
export function groupModelsByProvider(models: ModelOption[]): ModelGroup[] {
  const groups: ModelGroup[] = [];
  const byKey = new Map<string, ModelGroup>();
  for (const model of models) {
    const key = model.provider ?? "";
    let group = byKey.get(key);
    if (!group) {
      group = { key, rows: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.rows.push(model);
  }
  const labeled = groups.filter((g) => g.key !== "");
  return labeled.length > 0 ? groups : [{ key: "", rows: models }];
}

/**
 * CodeBuddy files its `custom:` (enterprise) models under this provider key
 * (`src-tauri/src/engine/models/codebuddy.rs`). Other engines' provider keys
 * are relay or channel names the user typed, so the same word there is just a
 * name: it keeps its own header and its catalog position.
 */
export function isEnterpriseGroup(engineId: string, key: string): boolean {
  return engineId === "codebuddy" && key === "enterprise";
}

/**
 * Section order for a layered list. The section holding the current pick
 * leads so the selection is never scrolled out of view; otherwise CodeBuddy's
 * enterprise section sinks below the vendor sections. Everything else keeps
 * catalog order (the sort is stable).
 */
export function orderModelGroups(
  groups: ModelGroup[],
  engineId: string,
  selectedModelId: string,
): ModelGroup[] {
  const rank = (group: ModelGroup) => {
    if (group.rows.some((m) => m.id === selectedModelId)) return 0;
    return isEnterpriseGroup(engineId, group.key) ? 2 : 1;
  };
  return [...groups].sort((a, b) => rank(a) - rank(b));
}

/**
 * Case-insensitive label/id/description/provider match; an empty query passes
 * the catalog through untouched (identity, so memoized groups stay stable).
 * Provider is part of the match because several relays serve the same model
 * id — typing the channel is how you narrow to one of them. `sectionTitle`
 * is what the header reads for a provider (CodeBuddy's `enterprise` is titled
 * through i18n), so typing the text on screen finds the section too.
 */
export function filterModels(
  models: ModelOption[],
  normalizedQuery: string,
  sectionTitle?: (provider: string) => string,
): ModelOption[] {
  if (!normalizedQuery) return models;
  return models.filter((m) => {
    const provider = m.provider ?? "";
    return (
      m.label.toLowerCase().includes(normalizedQuery) ||
      m.id.toLowerCase().includes(normalizedQuery) ||
      (m.description ?? "").toLowerCase().includes(normalizedQuery) ||
      provider.toLowerCase().includes(normalizedQuery) ||
      (provider !== "" &&
        (sectionTitle?.(provider) ?? "").toLowerCase().includes(normalizedQuery))
    );
  });
}
