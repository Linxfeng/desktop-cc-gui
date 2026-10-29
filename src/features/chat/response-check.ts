/**
 * Response check — did the reply's own account of itself match what this
 * client asked for?
 *
 * Two partial sides, fed by engine events:
 *
 *  - `requested`: the launch selection (`launch`), i.e. the model/effort the
 *    run actually started with, after channel remap.
 *  - `served`: what the response reported (`served`) — claude's assistant
 *    snapshot model, the serving model the pi runtime recovered, or a codex
 *    reroute target.
 *
 * A side that never reported stays `null` and can never produce a verdict:
 * an unreported field is unknown, not a pass. Comparisons tolerate the
 * naming variants a gateway legitimately introduces: a provider prefix and
 * the picker's `[1m]` tag are ignored entirely, and a `-latest`/date/daily
 * build suffix (`deepseek-v4.1-flash` vs `deepseek-v4.1-flash-1017`,
 * `claude-sonnet-4-5` vs `claude-sonnet-4-5-20250929`) is a "snapshot" of
 * the same family — providers routinely resolve an alias to a dated id, so
 * that is rendered neutral, not as a substitution. Only a different family
 * is a mismatch. Reasoning levels remain separator/case-insensitive
 * (`xhigh` vs `extra-high`).
 */

export interface SelectionSide {
  model: string | null;
  /** Adapter-resolved request id. Null means the selector could not be resolved. */
  comparisonModel?: string | null;
  effort: string | null;
}

/** Requested vs served selection for the run the tail indicator shows. */
export interface ResponseCheckState {
  requested: SelectionSide;
  served: SelectionSide;
  /** The run's stream can report a served side (launch `reportsServed`).
   *  Absent for engines that never report one and for older records. */
  reportsServed?: boolean;
}

export type SelectionVerdict = "match" | "snapshot" | "mismatch" | "unknown";

export interface ResponseCheckView {
  model: SelectionVerdict;
  effort: SelectionVerdict;
  /** "mismatch" when a reported side disagrees; "snapshot" when only the
   *  build/date revision differs; "unknown" when a request alias is
   *  unresolved or nothing is comparable; otherwise "match". */
  verdict: "match" | "snapshot" | "mismatch" | "unknown";
  /** Visible when evidence can be compared, an alias needs clarification, or
   *  a run that can report its served side has not reported it yet. */
  visible: boolean;
}

const EMPTY_SIDE: SelectionSide = { model: null, effort: null };

/** "provider/model" and the picker's "[1m]" tag are the same model. */
function bareModel(id: string): string {
  const trimmed = id.trim().toLowerCase();
  const bare = trimmed.includes("/")
    ? trimmed.slice(trimmed.lastIndexOf("/") + 1)
    : trimmed;
  return bare.replace(/\[1m\]$/, "");
}

/** `-latest` and dated snapshots name the same family. */
function family(id: string): string {
  return bareModel(id)
    .replace(/-latest$/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-\d{4}-\d{2}-\d{2}$/, "")
    // Cohere-style monthly snapshots: `command-r-plus-08-2024`. Only a real
    // month and a recent year, so `qwen-14-2048` keeps its size and length.
    .replace(/-(?:0[1-9]|1[0-2])-20[23]\d$/, "")
    // Aggregators also stamp daily builds as `-MMDD` (`ds4.1-1017`); it is a
    // date revision of the same family, not a substituted model. Only strip
    // it when the digits are a plausible month/day — otherwise a trailing
    // context length (`qwen2.5-7b-instruct-4096`) would be eaten as a date.
    .replace(/-(\d{2})(\d{2})$/, (stamp, mm: string, dd: string) => {
      const month = Number(mm);
      const day = Number(dd);
      return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? "" : stamp;
    });
}

export function compareModel(
  requested: string | null,
  served: string | null,
): SelectionVerdict {
  if (!requested || !served) return "unknown";
  if (bareModel(requested) === bareModel(served)) return "match";
  return family(requested) === family(served) ? "snapshot" : "mismatch";
}

/** Separator/case-insensitive; `extra-high` is the same level as `xhigh`. */
function effortKey(level: string): string {
  const key = level
    .trim()
    .toLowerCase()
    .replace(/[-_\s]/g, "");
  return key === "extrahigh" ? "xhigh" : key;
}

export function compareEffort(
  requested: string | null,
  served: string | null,
): SelectionVerdict {
  if (!requested || !served) return "unknown";
  return effortKey(requested) === effortKey(served) ? "match" : "mismatch";
}

export function checkResponseSelection(
  check: ResponseCheckState | null | undefined,
): ResponseCheckView {
  const requested = check?.requested ?? EMPTY_SIDE;
  const served = check?.served ?? EMPTY_SIDE;
  const requestedModel =
    requested.comparisonModel === undefined
      ? requested.model
      : requested.comparisonModel;
  const model = compareModel(requestedModel, served.model);
  const effort = compareEffort(requested.effort, served.effort);
  const unresolvedAlias =
    requested.comparisonModel === null && !!requested.model && !!served.model;
  const verdict =
    model === "mismatch" || effort === "mismatch"
      ? "mismatch"
      : unresolvedAlias
        ? "unknown"
        : model === "snapshot"
          ? "snapshot"
          // The model is what the check is about: when the request named one
          // but the response never reported its own, a matching effort alone
          // is not a confirmation.
          : (requestedModel ?? requested.model) !== null && model === "unknown"
            ? "unknown"
            : model !== "unknown" || effort !== "unknown"
              ? "match"
              : "unknown";
  // A reported request with no response evidence still has something to say
  // when the response side could have answered: the card shows the request
  // and marks the missing side unreported, instead of the check vanishing as
  // if nothing were wrong. An engine that never reports a served side stays
  // hidden — an "unreported" badge on every one of its turns is noise.
  const requestedReported =
    requested.model !== null || requested.effort !== null;
  const servedReported = served.model !== null || served.effort !== null;
  const pendingEvidence =
    requestedReported && (servedReported || check?.reportsServed === true);
  return {
    model,
    effort,
    verdict,
    visible: verdict !== "unknown" || unresolvedAlias || pendingEvidence,
  };
}
