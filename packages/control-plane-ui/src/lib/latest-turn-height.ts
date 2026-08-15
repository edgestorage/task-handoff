export function createLatestTurnHeightBuffer(maxRetainedSlack = 100) {
  let reservedHeight = 0;

  function update(contentHeight: number, enabled = true) {
    const actualHeight = Math.max(0, Math.ceil(contentHeight));
    if (!enabled) {
      reservedHeight = 0;
      return 0;
    }
    if (actualHeight >= reservedHeight || reservedHeight - actualHeight > maxRetainedSlack) {
      reservedHeight = actualHeight;
    }
    return reservedHeight;
  }

  function reset() {
    reservedHeight = 0;
  }

  return { reset, update };
}
