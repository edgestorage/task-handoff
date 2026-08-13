function usableVisibleWindow(window) {
  return window
    && !window.isDestroyed?.()
    && (window.isVisible?.() || window.isMinimized?.());
}

function activateExistingDesktopWindow(options = {}) {
  const windows = (options.windows || []).filter(usableVisibleWindow);
  if (windows.length === 0) return options.onEmpty?.();
  const focusedWindow = options.focusedWindow;
  const target = windows.includes(focusedWindow) ? focusedWindow : windows.at(-1);
  if (target.isMinimized?.()) target.restore();
  target.focus();
  return target;
}

module.exports = { activateExistingDesktopWindow, usableVisibleWindow };
