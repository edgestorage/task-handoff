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

export type BrowserPageSlotResult = {
  slot: BrowserTabSlot;
  created: boolean;
};

/**
 * Returns the tab slot that already owns a page host, or appends a new slot.
 *
 * The page host owns the live <webview>; the tab slot only decides where that
 * guest is displayed. Reusing the existing slot keeps the guest mounted and
 * avoids replacing the currently active tab with a different page.
 */
export function ensureBrowserPageSlot(
  slots: BrowserTabSlot[],
  pageKey: string,
  slotKey: string,
): BrowserPageSlotResult | undefined {
  if (!pageKey || !slotKey || slots.some((slot) => slot.key === slotKey)) return undefined;
  const existing = slots.find((slot) => slot.pageKey === pageKey);
  if (existing) return { slot: existing, created: false };
  const slot = { key: slotKey, pageKey };
  slots.push(slot);
  return { slot, created: true };
}
