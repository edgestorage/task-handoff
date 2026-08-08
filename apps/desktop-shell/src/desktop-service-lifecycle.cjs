const DESKTOP_SHUTDOWN_POLICIES = Object.freeze({
  quit: Object.freeze({ controlPlane: true, nodeAgent: false }),
  update: Object.freeze({ controlPlane: true, nodeAgent: true }),
  "boot-failure": Object.freeze({ controlPlane: true, nodeAgent: "unless-ready" }),
});

function desktopShutdownPolicy(reason, context = {}) {
  const configured = DESKTOP_SHUTDOWN_POLICIES[reason];
  if (!configured) throw new Error(`Unsupported Desktop shutdown reason: ${reason}`);
  return {
    controlPlane: configured.controlPlane,
    nodeAgent: configured.nodeAgent === true || (configured.nodeAgent === "unless-ready" && !context.nodeAgentReady),
  };
}

function createDesktopServiceLifecycle(options) {
  let phase = "idle";
  let activeStop;
  let lastReason;
  const requested = { controlPlane: false, nodeAgent: false };
  const stopped = { controlPlane: false, nodeAgent: false };

  function mergePolicy(reason, context) {
    const policy = desktopShutdownPolicy(reason, context);
    requested.controlPlane ||= policy.controlPlane;
    requested.nodeAgent ||= policy.nodeAgent;
    if (!lastReason || reason === "update") lastReason = reason;
  }

  return {
    snapshot() {
      return { phase, reason: lastReason, requested: { ...requested }, stopped: { ...stopped } };
    },
    markRunning() {
      if (phase !== "stopping") phase = "running";
    },
    stop(reason, context = {}) {
      mergePolicy(reason, context);
      if (activeStop) return activeStop;
      phase = "stopping";
      activeStop = (async () => {
        let firstError;
        if (requested.controlPlane && !stopped.controlPlane) {
          try {
            await options.stopControlPlane();
            stopped.controlPlane = true;
          } catch (error) {
            firstError = error;
          }
        }
        // A stronger request can arrive while Control Plane shutdown is pending.
        if (requested.nodeAgent && !stopped.nodeAgent) {
          try {
            await options.stopNodeAgent();
            stopped.nodeAgent = true;
          } catch (error) {
            firstError ||= error;
          }
        }
        if (firstError) throw firstError;
      })().finally(() => {
        phase = requested.controlPlane === stopped.controlPlane && requested.nodeAgent === stopped.nodeAgent
          ? "stopped"
          : "stop-failed";
        activeStop = undefined;
      });
      return activeStop;
    },
  };
}

module.exports = {
  DESKTOP_SHUTDOWN_POLICIES,
  createDesktopServiceLifecycle,
  desktopShutdownPolicy,
};
