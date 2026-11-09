import { controlledInstanceRemoteDesktopCapabilities } from "@task-handoff/protocol/control-plane";
import type { RemoteDesktopCapabilities } from "@task-handoff/protocol/remote-desktop";
import type { InstanceBoardItem } from "../../api/types";

/** The UI consumes the control-plane capability projection through one query
 * boundary. Components never interpret raw feature fields independently. */
export function remoteDesktopCapabilities(instance: Pick<InstanceBoardItem, "capabilities">): RemoteDesktopCapabilities {
  const document = instance.capabilities as Record<string, unknown>;
  return controlledInstanceRemoteDesktopCapabilities(document);
}
export function remoteDesktopAvailable(instance: Pick<InstanceBoardItem, "capabilities">) {
  return remoteDesktopCapabilities(instance).available;
}
