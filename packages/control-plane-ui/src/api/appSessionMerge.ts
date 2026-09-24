import type { ControlPlaneAppSessions } from "./types";

export function mergeAppSessionQueryData(
  previous: ControlPlaneAppSessions | undefined,
  incoming: ControlPlaneAppSessions,
): ControlPlaneAppSessions {
  if (!previous) return incoming;
  const previousByInstance = new Map(previous.instances.map((entry) => [entry.instanceId, entry]));
  let preservedNewerEntry = false;
  const instances = incoming.instances.map((entry) => {
    const current = previousByInstance.get(entry.instanceId);
    if (!current || current.streamId !== entry.streamId || (current.revision ?? 0) <= (entry.revision ?? 0)) return entry;
    preservedNewerEntry = true;
    return current;
  });
  return preservedNewerEntry ? { ...incoming, instances } : incoming;
}
