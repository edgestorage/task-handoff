import type { RemoteDesktopWindow } from "../../../api/remoteDesktop";

export type SelectedWindowInfo = Pick<
  RemoteDesktopWindow,
  "windowRef" | "title" | "applicationName" | "width" | "height"
>;

export function selectedWindowInfo(item: RemoteDesktopWindow): SelectedWindowInfo {
  return {
    windowRef: item.windowRef,
    title: item.title,
    applicationName: item.applicationName,
    width: item.width,
    height: item.height,
  };
}

export function parseSelectedWindowInfo(value: unknown): SelectedWindowInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Partial<SelectedWindowInfo>;
  if (typeof item.windowRef !== "string" || !item.windowRef.trim()) return undefined;
  if (typeof item.title !== "string" || typeof item.applicationName !== "string") return undefined;
  if (!Number.isSafeInteger(item.width) || !Number.isSafeInteger(item.height)) return undefined;
  if (item.width! < 0 || item.height! < 0) return undefined;
  return {
    windowRef: item.windowRef.trim(),
    title: item.title,
    applicationName: item.applicationName,
    width: item.width!,
    height: item.height!,
  };
}

function matchScore(candidate: RemoteDesktopWindow, selected: SelectedWindowInfo) {
  if (candidate.applicationName !== selected.applicationName) return 0;
  let score = 2;
  if (candidate.title === selected.title) score += 4;
  if (candidate.width === selected.width && candidate.height === selected.height) score += 1;
  return score;
}

/** Window references are stable for the component process. Keep the visible
 * identity fallback for component restarts and older persisted references. */
export function resolveRefreshedWindow(
  windows: readonly RemoteDesktopWindow[],
  windowRef: string | undefined,
  selected: SelectedWindowInfo | undefined,
) {
  const capturable = windows.filter((item) => item.capturable);
  if (windowRef) {
    const exact = capturable.find((item) => item.windowRef === windowRef);
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
