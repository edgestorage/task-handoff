import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientApp, methods, ndJsonStream, PROTOCOL_VERSION,
  type RequestPermissionRequest, type RequestPermissionResponse, type SessionNotification,
} from "@agentclientprotocol/sdk";

export type AcpLaunch = {
  executable: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  /** Session-private directory removed after the Agent process exits. */
  cleanupDir?: string;
  /** Retains Agent-owned session state before cleanupDir is removed. */
  persistSessionHome?: (providerSessionId: string) => void | Promise<void>;
};
type AcpCallbacks = {
  update: (notification: SessionNotification) => void;
  permission: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
};

export async function connectAcp(launch: AcpLaunch, cwd: string, callbacks: AcpCallbacks) {
  const child = spawn(launch.executable, launch.args, { cwd, env: launch.env, stdio: ["pipe", "pipe", "ignore"] });
  const connection = new ClientApp()
    .onNotification(methods.client.session.update, ({ params }) => callbacks.update(params))
    .onRequest(methods.client.session.requestPermission, ({ params }) => callbacks.permission(params))
    .connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>));
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  child.once("error", () => connection.close());
  child.stdin.on("error", () => connection.close());
  const close = async () => {
    connection.close();
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const escalation = setTimeout(() => child.kill("SIGKILL"), 2_000);
    try { await exited; } finally { clearTimeout(escalation); }
  };
  const readyTimeout = AbortSignal.timeout(15_000);
  try {
    const response = await connection.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    }, { cancellationSignal: readyTimeout, stopWaitingOnCancel: true });
    if (response.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error("Agent does not support ACP v1.");
    }
    return { agent: connection.agent, capabilities: response.agentCapabilities, closed: connection.closed, close };
  } catch (error) {
    await close();
    throw error;
  }
}
