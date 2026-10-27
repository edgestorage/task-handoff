import {
  CloudDeviceTrustChangedEventSchema,
  type CloudDeviceTrustSnapshot,
} from "@task-handoff/protocol/device-trust";

export type DeviceTrustViewSnapshot = CloudDeviceTrustSnapshot & { revision: number };

export const EMPTY_DEVICE_TRUST_SNAPSHOT: DeviceTrustViewSnapshot = {
  revision: -1,
  requests: [],
  trustedDevices: [],
  roles: [],
};

export function applyDeviceTrustSnapshot(current: DeviceTrustViewSnapshot, incoming: CloudDeviceTrustSnapshot): DeviceTrustViewSnapshot {
  return incoming.revision >= current.revision ? incoming : current;
}

export function deviceTrustSnapshotBindingId(snapshot: DeviceTrustViewSnapshot) {
  return snapshot.requests[0]?.bindingId ?? snapshot.trustedDevices[0]?.bindingId;
}

export function shouldRecoverDeviceTrust(current: DeviceTrustViewSnapshot, payload: unknown) {
  const parsed = CloudDeviceTrustChangedEventSchema.safeParse(payload);
  if (!parsed.success || parsed.data.revision <= current.revision) return false;
  const bindingId = deviceTrustSnapshotBindingId(current);
  return !bindingId || bindingId === parsed.data.bindingId;
}
