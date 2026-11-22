export type BrowserPageSurface = {
  key: string;
  title?: string;
  status?: string;
  initialUrl?: string;
  currentUrl?: string;
  creationRef?: string;
};

export type BrowserTabSlot = {
  key: string;
  pageKey: string;
};

export type BrowserPageMoveResult =
  | { ok: false }
  | { ok: true; replacedPageKey: string; sourceSlot: BrowserTabSlot };

/**
 * Re-points a tab slot at an existing page host instead of switching selection.
 *
 * The page host owns the live <webview>; the tab slot only decides where that
 * guest is displayed. Callers must release `replacedPageKey` (it no longer has
 * a hosting slot) and assign a fresh blank page to `sourceSlot`.
 */
export function moveBrowserPageToSlot(
  slots: readonly BrowserTabSlot[],
  targetSlotKey: string,
  sourcePageKey: string,
): BrowserPageMoveResult {
  const target = slots.find((slot) => slot.key === targetSlotKey);
  const source = slots.find((slot) => slot.pageKey === sourcePageKey);
  if (!target || !source || target === source) return { ok: false };
  const replacedPageKey = target.pageKey;
  if (!replacedPageKey || replacedPageKey === sourcePageKey) return { ok: false };
  target.pageKey = sourcePageKey;
  return { ok: true, replacedPageKey, sourceSlot: source };
}
