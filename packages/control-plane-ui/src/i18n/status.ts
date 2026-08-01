export type Translate = (key: string, params?: Record<string, unknown>) => string;

export const instanceStatusKeys: Record<string, string> = {
  created: "instances.status.created",
  provisioning: "instances.status.provisioning",
  starting: "instances.status.starting",
  registering: "instances.status.registering",
  registered: "instances.status.registered",
  running: "instances.status.running",
  stopping: "instances.status.stopping",
  stopped: "instances.status.stopped",
  failed: "instances.status.failed",
  unhealthy: "instances.status.unhealthy",
};

export const connectionStatusKeys: Record<string, string> = {
  unknown: "instances.connection.unknown",
  online: "instances.connection.online",
  offline: "instances.connection.offline",
  "endpoint-unreachable": "instances.connection.endpointUnreachable",
};

export const healthStatusKeys: Record<string, string> = {
  unknown: "instances.health.unknown",
  ok: "instances.health.ok",
  degraded: "instances.health.degraded",
  failed: "instances.health.failed",
};

export const aiSessionStatusKeys: Record<string, string> = {
  idle: "sessions.status.idle",
  running: "sessions.status.running",
  waiting: "sessions.status.waiting",
  failed: "sessions.status.failed",
  completed: "sessions.status.completed",
  stopped: "sessions.status.stopped",
};

export const imagePullStatusKeys: Record<string, string> = {
  connecting: "instances.imagePull.connecting",
  pulling: "instances.imagePull.pulling",
  extracting: "instances.imagePull.extracting",
  complete: "instances.imagePull.ready",
  failed: "instances.imagePull.failed",
};

export const nodeRuntimeStatusKeys: Record<string, string> = {
  unknown: "settings.nodeDetail.statusUnknown",
  online: "settings.nodeDetail.statusOnline",
  offline: "settings.nodeDetail.statusOffline",
  degraded: "settings.nodeDetail.statusDegraded",
};

export const nodeConnectionModeKeys: Record<string, string> = {
  "direct-http": "settings.nodeDetail.connectionDirectHttp",
  "reverse-wss": "settings.nodeDetail.connectionReverseWss",
  "control-plane-proxy": "settings.nodeDetail.connectionControlPlaneProxy",
};

export const runtimeTypeKeys: Record<string, string> = {
  docker: "settings.nodeDetail.runtimeDocker",
  kubernetes: "settings.nodeDetail.runtimeKubernetes",
  local: "settings.nodeDetail.runtimeLocal",
};

export const runtimeAccessStrategyKeys: Record<string, string> = {
  "node-proxy": "settings.nodeDetail.accessNodeProxy",
  "direct-port": "settings.nodeDetail.accessDirectPort",
  "kubernetes-ingress": "settings.nodeDetail.accessKubernetesIngress",
  "kubernetes-port-forward": "settings.nodeDetail.accessKubernetesPortForward",
};

export const updateJobStatusKeys: Record<string, string> = {
  queued: "settings.nodeDetail.jobQueued",
  "updating-node": "settings.nodeDetail.jobUpdatingNode",
  "restarting-node": "settings.nodeDetail.jobRestartingNode",
  "converging-instances": "settings.nodeDetail.jobConvergingInstances",
  succeeded: "settings.nodeDetail.jobSucceeded",
  degraded: "settings.nodeDetail.jobDegraded",
  failed: "settings.nodeDetail.jobFailed",
};

export const runtimeVersionStatusKeys: Record<string, string> = {
  pending: "settings.nodeDetail.runtimePending",
  draining: "settings.nodeDetail.runtimeDraining",
  installing: "settings.nodeDetail.runtimeInstalling",
  restarting: "settings.nodeDetail.runtimeRestarting",
  verifying: "settings.nodeDetail.runtimeVerifying",
  matched: "settings.nodeDetail.runtimeMatched",
  failed: "settings.nodeDetail.runtimeFailed",
};

export const externalListenerStatusKeys: Record<string, string> = {
  listening: "settings.nodeDetail.listenerListening",
  error: "settings.nodeDetail.listenerError",
};

export const externalListenerSourceKeys: Record<string, string> = {
  bootstrap: "settings.nodeDetail.listenerBootstrap",
  persisted: "settings.nodeDetail.listenerPersisted",
};

export const remoteConnectStatusKeys: Record<string, string> = {
  disabled: "settings.nodeDetail.remoteDisabled",
  saved: "settings.nodeDetail.remoteSaved",
  connecting: "settings.nodeDetail.remoteConnecting",
  connected: "settings.nodeDetail.remoteConnected",
  reconnecting: "settings.nodeDetail.remoteReconnecting",
  failed: "settings.nodeDetail.remoteFailed",
};

export function translateStatus(keys: Record<string, string>, value: string, t: Translate) {
  const key = keys[value];
  return key ? t(key) : t("common.status.unknownValue", { value });
}
