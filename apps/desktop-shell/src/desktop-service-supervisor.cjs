const { EventEmitter } = require("node:events");

const SERVICE_PHASES = new Set(["idle", "starting", "running", "degraded", "stopping", "stopped"]);
const COMPONENT_PHASES = new Set(["stopped", "starting", "running", "stopping", "failed"]);

function createDesktopServiceSupervisor() {
  const events = new EventEmitter();
  let state = Object.freeze({
    phase: "idle",
    controlPlane: "stopped",
    nodeAgent: "stopped",
    endpoint: undefined,
    error: undefined,
  });

  function update(patch) {
    const next = Object.freeze({ ...state, ...patch });
    if (!SERVICE_PHASES.has(next.phase)) throw new Error(`Unsupported desktop service phase: ${next.phase}`);
    if (!COMPONENT_PHASES.has(next.controlPlane)) throw new Error(`Unsupported Control Plane phase: ${next.controlPlane}`);
    if (!COMPONENT_PHASES.has(next.nodeAgent)) throw new Error(`Unsupported node-agent phase: ${next.nodeAgent}`);
    state = next;
    events.emit("change", state);
    return state;
  }

  return {
    snapshot: () => state,
    subscribe(listener) {
      events.on("change", listener);
      listener(state);
      return () => events.off("change", listener);
    },
    markStarting() {
      return update({ phase: "starting", controlPlane: "starting", nodeAgent: "starting", error: undefined });
    },
    markNodeAgentRunning() {
      return update({ nodeAgent: "running" });
    },
    markRunning(endpoint) {
      if (!endpoint) throw new Error("A running Desktop service requires its authoritative Control Plane endpoint.");
      return update({ phase: "running", controlPlane: "running", nodeAgent: "running", endpoint, error: undefined });
    },
    markComponentStopped(component, error) {
      const key = component === "control-plane" ? "controlPlane" : component === "node-agent" ? "nodeAgent" : undefined;
      if (!key) throw new Error(`Unsupported Desktop service component: ${component}`);
      if (["stopping", "stopped"].includes(state.phase)) return update({ [key]: "stopped" });
      return update({ phase: "degraded", [key]: "failed", error: error || `${component} stopped unexpectedly` });
    },
    markDegraded(error) {
      return update({ phase: "degraded", error: error instanceof Error ? error.message : String(error) });
    },
    markStopping() {
      return update({
        phase: "stopping",
        controlPlane: state.controlPlane === "stopped" ? "stopped" : "stopping",
        nodeAgent: state.nodeAgent === "stopped" ? "stopped" : "stopping",
      });
    },
    markStopped() {
      return update({ phase: "stopped", controlPlane: "stopped", nodeAgent: "stopped" });
    },
    endpoint() {
      return state.endpoint;
    },
  };
}

module.exports = { createDesktopServiceSupervisor };
