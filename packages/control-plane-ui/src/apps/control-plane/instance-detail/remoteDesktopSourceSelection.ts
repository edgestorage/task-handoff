import type { DesktopSource } from "@task-handoff/protocol/remote-desktop";

export type SelectedSourceIdentity = Pick<
  DesktopSource,
  "kind" | "title" | "subtitle" | "width" | "height"
>;

export function selectedSourceIdentity(item: DesktopSource): SelectedSourceIdentity {
  return {
    kind: item.kind,
    title: item.title,
    subtitle: item.subtitle,
    width: item.width,
    height: item.height,
  };
}

export function parseSelectedSourceIdentity(value: unknown): SelectedSourceIdentity | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Partial<SelectedSourceIdentity>;
  if (typeof item.kind !== "string" || !item.kind.trim() || item.kind.length > 64) return undefined;
  if (typeof item.title !== "string" || item.title.length > 512) return undefined;
  if (item.subtitle !== null && typeof item.subtitle !== "string") return undefined;
  if (typeof item.subtitle === "string" && item.subtitle.length > 256) return undefined;
  if (!Number.isSafeInteger(item.width) || !Number.isSafeInteger(item.height)) return undefined;
  if (item.width! < 0 || item.height! < 0) return undefined;
  return {
    kind: item.kind.trim(),
    title: item.title,
    subtitle: item.subtitle,
    width: item.width!,
    height: item.height!,
  };
}

function matchScore(candidate: DesktopSource, selected: SelectedSourceIdentity) {
  if (candidate.kind !== selected.kind) return 0;
  let score = 2;
  if (selected.subtitle !== null && candidate.subtitle === selected.subtitle) score += 6;
  if (candidate.title === selected.title) score += 4;
  if (candidate.width === selected.width && candidate.height === selected.height) score += 1;
  return score;
}

/** Source references are process-scoped. Resolve a refreshed reference by its
 * durable visible identity only when exactly one capturable source matches. */
export function resolveRefreshedSource(
  sources: readonly DesktopSource[],
  sourceRef: string | undefined,
  selected: SelectedSourceIdentity | undefined,
) {
  const capturable = sources.filter((item) => item.capturable);
  if (sourceRef) {
    const exact = capturable.find((item) => item.sourceRef === sourceRef);
    if (exact) return exact;
  }
  if (!selected) return undefined;
  const scored = capturable
    .map((item) => ({ item, score: matchScore(item, selected) }))
    .filter((entry) => entry.score > 0);
  if (!scored.length) return undefined;
  const best = Math.max(...scored.map((entry) => entry.score));
  const matches = scored.filter((entry) => entry.score === best);
  return matches.length === 1 ? matches[0].item : undefined;
}
