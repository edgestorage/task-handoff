import type { ControlPlaneQueryDomain } from "../../api/queryInvalidation.ts";

export type InvalidationEvent = {
  type?: string;
  topic?: string;
};

const TERMINAL_APP_MANAGEMENT_JOB_STATES = new Set(["succeeded", "failed", "cancelled", "interrupted"]);

/**
 * Compatibility for v0.0.57 Node Agents: app operations do not publish the
 * inventory/capability event introduced after that release. Recover the board
 * on terminal jobs for those producers. Current producers additionally publish
 * the revisioned projection; this best-effort HTTP recovery can race its report
 * and must never be the source of the installed-app state.
 */
export function appManagementEventChangesInstanceInventory(event: { job?: { state?: unknown } } | undefined) {
  const state = event?.job?.state;
  return typeof state === "string" && TERMINAL_APP_MANAGEMENT_JOB_STATES.has(state);
}

export function controlPlaneEventDomains(events: InvalidationEvent[]): ControlPlaneQueryDomain[] {
  const topics = new Set(events.map((event) => event.topic).filter(Boolean));
  const domains: ControlPlaneQueryDomain[] = [];
  if (events.some(event => event.type === "desktop-turn.updated")) domains.push("desktopTurn");
  if (topics.has("desktop-connection-options")) domains.push("desktopConnectionOptions");
  if (topics.has("node.state")) domains.push("nodeState");
  if (topics.has("node.runtime")) domains.push("nodeRuntimeState");
  if (topics.has("nodes")) domains.push("nodeTopology");
  if (topics.has("instances")) domains.push("instances");
  if (topics.has("projects")) domains.push("projects");
  if (topics.has("models")) domains.push("models");
  if (topics.has("images")) domains.push("images");
  if (topics.has("market")) domains.push("market");
  if (topics.has("stories")) domains.push("stories");
  if (topics.has("agents")) domains.push("agents");
  if (topics.has("control-plane-proxy")) domains.push("controlPlaneProxy");
  return domains;
}
