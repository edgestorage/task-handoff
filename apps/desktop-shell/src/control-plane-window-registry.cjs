function createControlPlaneWindowRegistry() {
  const metadataByWindow = new Map();
  const windowByInstanceId = new Map();

  function usable(window) {
    return window && !window.isDestroyed?.();
  }

  function focus(window) {
    if (!usable(window)) return false;
    if (window.isMinimized?.()) window.restore();
    window.show();
    window.focus();
    return true;
  }

  function release(window) {
    const metadata = metadataByWindow.get(window);
    if (!metadata) return;
    metadataByWindow.delete(window);
    if (metadata.kind === "instance-detail" && windowByInstanceId.get(metadata.instanceId) === window) {
      windowByInstanceId.delete(metadata.instanceId);
    }
  }

  function register(window, metadata) {
    if (!usable(window)) throw new Error("Cannot register a destroyed control plane window.");
    if (metadataByWindow.has(window)) throw new Error("Control plane window is already registered.");
    if (metadata.kind === "instance-detail") {
      const owner = windowByInstanceId.get(metadata.instanceId);
      if (usable(owner) && owner !== window) return { action: "focused", window: owner, focused: focus(owner) };
      if (owner) release(owner);
      windowByInstanceId.set(metadata.instanceId, window);
    }
    metadataByWindow.set(window, metadata);
    window.once?.("closed", () => release(window));
    return { action: "registered", window };
  }

  function switchInstance(window, instanceId) {
    const current = metadataByWindow.get(window);
    if (!current || current.kind !== "instance-detail") return { action: "error", code: "not-instance-window" };
    if (current.instanceId === instanceId) return { action: "switched", instanceId };
    const owner = windowByInstanceId.get(instanceId);
    if (usable(owner) && owner !== window) return { action: "focused", instanceId, focused: focus(owner) };
    if (owner) release(owner);
    if (windowByInstanceId.get(current.instanceId) === window) windowByInstanceId.delete(current.instanceId);
    current.instanceId = instanceId;
    windowByInstanceId.set(instanceId, window);
    return { action: "switched", instanceId };
  }

  return {
    closeAll() {
      for (const window of [...metadataByWindow.keys()]) {
        if (usable(window)) window.close();
      }
    },
    focusInstance(instanceId) {
      const window = windowByInstanceId.get(instanceId);
      return usable(window) ? { action: "focused", instanceId, focused: focus(window), window } : undefined;
    },
    metadata: (window) => metadataByWindow.get(window),
    register,
    release,
    switchInstance,
    windows: () => [...metadataByWindow.keys()].filter(usable),
  };
}

module.exports = { createControlPlaneWindowRegistry };
