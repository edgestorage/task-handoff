import type { NodeStateProjectionEvent } from "@task-handoff/protocol/control-plane";

/**
 * Identity of a node state projection for change detection.
 *
 * The proxy state stream forwards every frame the target Control Plane
 * publishes, and each frame advances the proxy revision and its observation
 * timestamps. Those fields describe the stream, not the node, so publishing on
 * them made one idle node emit a full projection event roughly a hundred times
 * a minute — and every client that received one refetched its directory.
 */
export function proxyStateProjectionSignature(projection: NodeStateProjectionEvent) {
  if (!projection.proxyState) return JSON.stringify(projection);
  const { revision: _revision, observedAt: _observedAt, updatedAt: _updatedAt, ...semantic } = projection.proxyState;
  return JSON.stringify({ ...projection, proxyState: semantic });
}
