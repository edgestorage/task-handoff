function createDesktopWindowManager(options) {
  let mainWindow;
  let presentation = "background";

  function usableWindow() {
    return mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  }

  function attach(window) {
    mainWindow = window;
    presentation = "visible";
    window.once("closed", () => {
      if (mainWindow === window) mainWindow = undefined;
      presentation = "background";
    });
    return window;
  }

  function open() {
    let window = usableWindow();
    if (!window) {
      const endpoint = options.endpoint();
      if (!endpoint) return undefined;
      window = attach(options.create(endpoint));
    }
    if (window.isMinimized?.()) window.restore();
    window.show();
    window.focus();
    presentation = "visible";
    return window;
  }

  function background() {
    const window = usableWindow();
    if (window) window.hide();
    presentation = "background";
    options.onBackground?.();
  }

  return {
    attach,
    background,
    current: usableWindow,
    open,
    presentation: () => presentation,
  };
}

module.exports = { createDesktopWindowManager };
