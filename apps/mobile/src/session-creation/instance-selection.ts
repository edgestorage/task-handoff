export type SessionCreationKind = 'ai' | 'app';

export class MobileSessionCreationInstanceStore {
  private readonly selections = new Map<string, Partial<Record<SessionCreationKind, string>>>();

  read(controlPlaneId: string | undefined, kind: SessionCreationKind) {
    return controlPlaneId ? this.selections.get(controlPlaneId)?.[kind] : undefined;
  }

  write(controlPlaneId: string | undefined, kind: SessionCreationKind, instanceId: string) {
    if (!controlPlaneId) return;
    this.selections.set(controlPlaneId, { ...this.selections.get(controlPlaneId), [kind]: instanceId });
  }

  clearProfile(controlPlaneId: string) {
    this.selections.delete(controlPlaneId);
  }
}

export const mobileSessionCreationInstanceStore = new MobileSessionCreationInstanceStore();

export function preferredSessionCreationInstanceId(
  instances: readonly { id: string }[],
  requestedInstanceId: string | undefined,
  rememberedInstanceId: string | undefined,
) {
  if (requestedInstanceId && instances.some((instance) => instance.id === requestedInstanceId)) return requestedInstanceId;
  if (rememberedInstanceId && instances.some((instance) => instance.id === rememberedInstanceId)) return rememberedInstanceId;
  return undefined;
}
