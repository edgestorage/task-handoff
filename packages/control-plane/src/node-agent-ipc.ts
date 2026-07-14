import fs from "node:fs";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { WebSocket as WsClient } from "ws";

export const NODE_AGENT_IPC_ENDPOINT_PREFIX = "ipc://";

export function nodeAgentIpcPath(dataDir: string, platform = process.platform) {
  const root = path.resolve(dataDir);
  const hash = crypto.createHash("sha256").update(root).digest("hex").slice(0, 16);
  if (platform === "win32") {
    return `\\\\.\\pipe\\task-handoff-node-agent-${hash}`;
  }
  return path.join("/tmp", `task-handoff-node-agent-${process.getuid?.() ?? "user"}`, `${hash}.sock`);
}

export function nodeAgentIpcEndpoint(socketPath: string) {
  return `${NODE_AGENT_IPC_ENDPOINT_PREFIX}${encodeURIComponent(socketPath)}`;
}

export function parseNodeAgentIpcEndpoint(endpoint: string) {
  if (!endpoint.startsWith(NODE_AGENT_IPC_ENDPOINT_PREFIX)) {
    return undefined;
  }
  return decodeURIComponent(endpoint.slice(NODE_AGENT_IPC_ENDPOINT_PREFIX.length));
}

export function prepareNodeAgentIpcPath(socketPath: string, platform = process.platform) {
  if (platform === "win32") {
    return;
  }
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(path.dirname(socketPath), 0o700);
  } catch {
    // Best effort: chmod may fail on filesystems that do not support POSIX modes.
  }
  try {
    fs.unlinkSync(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export function localIpcSocketIsOwnedByCurrentUser(socketPath: string, platform = process.platform) {
  if (platform === "win32") {
    return socketPath.startsWith("\\\\.\\pipe\\");
  }
  const stat = fs.statSync(socketPath);
  const uid = process.getuid?.();
  return uid === undefined || stat.uid === uid;
}

export function assertLocalIpcSocketOwnedByCurrentUser(socketPath: string, platform = process.platform) {
  if (!localIpcSocketIsOwnedByCurrentUser(socketPath, platform)) {
    const error = new Error("Local node agent IPC socket is not owned by the current user.");
    Object.assign(error, { statusCode: 403, code: "NODE_AGENT_IPC_OWNER_INVALID" });
    throw error;
  }
}

export async function fetchNodeAgentIpc(socketPath: string, route: string, init: RequestInit = {}) {
  const method = init.method || "GET";
  const body = typeof init.body === "string" || init.body instanceof Buffer ? init.body : init.body === undefined || init.body === null ? undefined : String(init.body);
  const headers = new Headers(init.headers || {});
  if (body !== undefined && !headers.has("content-length")) {
    headers.set("content-length", String(Buffer.byteLength(body)));
  }
  return new Promise<Response>((resolve, reject) => {
    const request = http.request({
      socketPath,
      method,
      path: `/api/node-agent${route}`,
      headers: Object.fromEntries(headers.entries()),
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on("end", () => {
        resolve(new Response(Buffer.concat(chunks), {
          status: response.statusCode || 500,
          headers: response.headers as HeadersInit,
        }));
      });
    });
    request.on("error", reject);
    if (body !== undefined) {
      request.write(body);
    }
    request.end();
  });
}

export function createNodeAgentIpcWebSocket(socketPath: string, route: string, protocols?: string | string[], headers: Record<string, string> = {}) {
  const pathWithQuery = `/api/node-agent${route}`;
  const options = {
    createConnection: () => net.connect(socketPath),
    headers: {
      host: "task-handoff-node-agent.local",
      ...headers,
    },
  };
  return protocols && (Array.isArray(protocols) ? protocols.length > 0 : protocols.trim().length > 0)
    ? new WsClient(`ws://task-handoff-node-agent.local${pathWithQuery}`, protocols, options)
    : new WsClient(`ws://task-handoff-node-agent.local${pathWithQuery}`, options);
}
