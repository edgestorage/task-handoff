function createDesktopQuitCoordinator(options) {
  let phase = "idle";
  let active;

  return {
    phase: () => phase,
    isReadyToExit: () => phase === "ready",
    request(reason) {
      if (active) return active;
      phase = "stopping";
      options.onStopping?.(reason);
      active = Promise.resolve()
        .then(() => options.stop(reason))
        .catch((error) => options.onError?.(error, reason))
        .finally(() => {
          phase = "ready";
          options.onStopped?.(reason);
        });
      return active;
    },
  };
}

module.exports = { createDesktopQuitCoordinator };
