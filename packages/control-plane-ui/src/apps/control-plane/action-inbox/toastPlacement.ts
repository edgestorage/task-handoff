type ToastBounds = Pick<DOMRect, "top" | "bottom" | "left" | "right" | "height">;

export function actionInboxPlacement(viewportWidth: number, viewportHeight: number, toasts: readonly ToastBounds[]) {
  const cardWidth = Math.min(380, viewportWidth - 36);
  const overlapping = toasts.filter((bounds) => bounds.height > 0 && bounds.right > viewportWidth - 18 - cardWidth && bounds.left < viewportWidth - 18 && bounds.bottom > 68);
  let top = Math.max(76, ...overlapping.map((bounds) => bounds.bottom + 12));
  let right = 18;
  if (top > viewportHeight - 160 && overlapping.length) {
    const availableLeft = Math.min(...overlapping.map((bounds) => bounds.left)) - 12;
    if (availableLeft >= cardWidth + 18) {
      right = viewportWidth - availableLeft;
      top = 76;
    } else {
      top = Math.min(top, Math.max(76, viewportHeight - 140));
    }
  }
  return { top, right, availableHeight: Math.max(0, viewportHeight - top - 16) };
}
