/**
 * Fleet directory refreshes compare the semantic instance directory, not the
 * liveness observations that ride along with it. Heartbeats advance revision
 * and timestamp fields continuously, while lifecycle, Session, and trigger
 * events own their own projections. Keeping this projection in one place lets
 * the Node Agent derive a conditional-GET validator with the same semantics
 * the Control Plane already uses to decide whether content changed.
 */
export const INSTANCE_PROJECTION_HEADER = "x-task-handoff-instance-projection";
export const INSTANCE_DIRECTORY_PROJECTION = "directory";

export function projectInstancesForFleetComparison<T>(items: readonly T[]): unknown[] {
  return items.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const {
      stateRevision: _stateRevision,
      updatedAt: _updatedAt,
      lastHeartbeatAt: _lastHeartbeatAt,
      status: _status,
      health: _health,
      connectionStatus: _connectionStatus,
      agentStatus: _agentStatus,
      targetStatus: _targetStatus,
      uiAccessStatus: _uiAccessStatus,
      imageProvisioning: _imageProvisioning,
      workspace: _workspace,
      runtime: _runtime,
      runtimeVersion: _runtimeVersion,
      ready: _ready,
      aiSessions: _aiSessions,
      apps: _apps,
      triggers: _triggers,
      appInventory,
      access,
      target,
      ...semantic
    } = item as Record<string, unknown>;
    const comparableAppInventory = appInventory && typeof appInventory === "object" && !Array.isArray(appInventory)
      ? (({ observedAt: _observedAt, ...inventory }) => inventory)(appInventory as Record<string, unknown>)
      : appInventory;
    const comparableAccess = access && typeof access === "object" && !Array.isArray(access)
      ? (({ status: _status, ...topology }) => topology)(access as Record<string, unknown>)
      : access;
    const comparableTarget = target && typeof target === "object" && !Array.isArray(target)
      ? (({ status: _targetProbe, ...topology }) => topology)(target as Record<string, unknown>)
      : target;
    return {
      ...semantic,
      ...(comparableAccess ? { access: comparableAccess } : {}),
      ...(comparableTarget ? { target: comparableTarget } : {}),
      ...(comparableAppInventory ? { appInventory: comparableAppInventory } : {}),
    };
  });
}

/**
 * Projection for conditional GET validators. Unlike the fleet comparison above,
 * this keeps every observable state change (including AI Sessions and runtime
 * fields) and only omits timestamps that advance on heartbeat observations.
 */
export function projectInstancesForConditionalGet<T>(items: readonly T[]): unknown[] {
  return items.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const {
      stateRevision: _stateRevision,
      updatedAt: _updatedAt,
      lastHeartbeatAt: _lastHeartbeatAt,
      appInventory,
      aiSessions,
      ...semantic
    } = item as Record<string, unknown>;
    const comparableAppInventory = appInventory && typeof appInventory === "object" && !Array.isArray(appInventory)
      ? (({ observedAt: _observedAt, ...inventory }) => inventory)(appInventory as Record<string, unknown>)
      : appInventory;
    const comparableAiSessions = aiSessions && typeof aiSessions === "object" && !Array.isArray(aiSessions)
      ? (({ updatedAt: _aiSessionsUpdatedAt, ...snapshot }) => snapshot)(aiSessions as Record<string, unknown>)
      : aiSessions;
    return {
      ...semantic,
      ...(comparableAppInventory !== undefined ? { appInventory: comparableAppInventory } : {}),
      ...(comparableAiSessions !== undefined ? { aiSessions: comparableAiSessions } : {}),
    };
  });
}

/**
 * Directory refreshes do not carry AI Session details. Session state has its
 * own revisioned event stream, so repeating every Session summary in each
 * instance snapshot only makes the fleet payload larger and couples its ETag
 * to unrelated Session activity. Counts remain in the projection so a cold or
 * event-disconnected Control Plane still has useful liveness data.
 */
export function projectInstancesForDirectory<T>(items: readonly T[]): T[] {
  return items.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    const aiSessions = record.aiSessions;
    if (!aiSessions || typeof aiSessions !== "object" || Array.isArray(aiSessions)) return item;
    return {
      ...record,
      aiSessions: {
        ...(aiSessions as Record<string, unknown>),
        sessions: [],
      },
    } as T;
  });
}
