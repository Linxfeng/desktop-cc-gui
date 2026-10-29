/**
 * How the message meta line names a model. A relay setup records the
 * provider-qualified slug the picker launched with
 * ("agentrouter qunyou/deepseek-v4-flash") next to the plain id the engine
 * reports for the same model; the timeline shows the model's own name so no
 * relay vendor leaks into the UI.
 */

export function modelDisplayName(model: string): string {
  const name = (model ?? "").trim();
  const slash = name.lastIndexOf("/");
  return slash >= 0 ? name.slice(slash + 1).trim() : name;
}
