import { createBrowserChannelSocket } from "../instances/browser-channel-socket.ts";
import { controlledInstanceRemoteDesktopCapabilities } from "@task-handoff/protocol/control-plane";
import {
  parseRemoteDesktopRelayPath,
  remoteDesktopRelaySubprotocol,
} from "@task-handoff/protocol/remote-desktop";
import { type BrowserChannel, type BrowserChannelHandlers } from "@task-handoff/protocol/relay-browser-channel";
import { assertCan, instanceScopeAllows, type ControlPlaneActor } from "../auth/authorization.ts";
import type { DesktopAccess } from "./access.ts";

type RemoteDesktopAccess = Pick<DesktopAccess, "consume" | "consumeFallback" | "connect" | "connectFallback">;
type RemoteDesktopInstanceLookup = {
  requireControlledInstance(instanceId: string): Promise<{ id: string; nodeId: string; capabilities: unknown }>;
};

function failure(code: string, statusCode = 409) {
  return Object.assign(new Error("Remote desktop operation failed."), { code, statusCode });
}

export type RemoteDesktopRelayDependencies = {
  service: RemoteDesktopInstanceLookup;
  access(): RemoteDesktopAccess | undefined;
};

/** Bridge one encrypted Relay byte-channel to the same authority used by the
 * direct desktop WebSocket routes. No parallel ticket or session model. */
export async function openRemoteDesktopRelayChannel(
  dependencies: RemoteDesktopRelayDependencies,
  actor: ControlPlaneActor,
  input: { path: string; protocols: string[] },
  handlers: BrowserChannelHandlers,
): Promise<BrowserChannel> {
  const target = parseRemoteDesktopRelayPath(input.path);
  if (!target) throw failure("REMOTE_DESKTOP_CHANNEL_PATH_INVALID", 400);
  const expectedProtocol = remoteDesktopRelaySubprotocol(target);
  if (input.protocols.length !== 1 || input.protocols[0] !== expectedProtocol) {
    throw failure("REMOTE_DESKTOP_CHANNEL_PROTOCOL_INVALID", 400);
  }
  if (actor.type !== "cloud-account") throw failure("REMOTE_DESKTOP_UNAUTHORIZED", 403);

  const instance = await dependencies.service.requireControlledInstance(target.instanceId);
  if (!instanceScopeAllows(actor.nodeScope, actor.instanceScope, instance.id, instance.nodeId)) {
    throw failure("CONTROL_PLANE_RESOURCE_NOT_VISIBLE", 404);
  }
  assertCan(actor, "interactive-access", { type: "instance", id: instance.id, instanceId: instance.id, nodeId: instance.nodeId });
  if (!controlledInstanceRemoteDesktopCapabilities(instance.capabilities).available) throw failure("REMOTE_DESKTOP_UNSUPPORTED");

  const access = dependencies.access();
  if (!access) throw failure("REMOTE_DESKTOP_TRANSPORT_UNAVAILABLE", 503);
  const principal = { actor, deviceSessionId: actor.deviceSessionId };
  if (target.kind === "signal") {
    const entry = access.consume(principal, instance.id, target.sessionId, target.ticket);
    const bridge = createRemoteDesktopChannel(handlers);
    try { await access.connect(entry, bridge.socket); }
    catch (error) { bridge.channel.close(); throw error; }
    return bridge.channel;
  }
  const fallback = access.consumeFallback(principal, instance.id, target.sessionId, target.role, target.ticket);
  const bridge = createRemoteDesktopChannel(handlers);
  try { await access.connectFallback(fallback.entry, target.role, fallback.generation, bridge.socket); }
  catch (error) { bridge.channel.close(); throw error; }
  return bridge.channel;
}

/** One Relay channel is one NodeAgentWebSocket in both directions. Upstream
 * frames become BrowserChannel messages; client frames are emitted to the
 * desktop access layer with their original text/binary identity. */
export const createRemoteDesktopChannel = (handlers: BrowserChannelHandlers) =>
  createBrowserChannelSocket(handlers, { drainOnClose: true });
