import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { TaskHandoffStoragePaths } from "@task-handoff/core/storage/paths";

export type WebAuthState = {
  enabled: boolean;
  source?: "env" | "file" | "generated";
  tokenFile?: string;
  token?: string;
};

function readTokenFile(filePath: string) {
  try {
    const value = fs.readFileSync(filePath, "utf8").trim();
    return value || undefined;
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function writeTokenFile(filePath: string, token: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${token}\n`, { mode: 0o600 });
}

export function resolveWebAuth(paths: TaskHandoffStoragePaths): WebAuthState {
  if (process.env.TASK_HANDOFF_WEB_AUTH === "off") {
    return { enabled: false };
  }
  const envToken = process.env.TASK_HANDOFF_WEB_TOKEN?.trim();
  if (envToken) {
    return { enabled: true, source: "env", token: envToken };
  }
  const fileToken = readTokenFile(paths.webTokenPath);
  if (fileToken) {
    return { enabled: true, source: "file", token: fileToken, tokenFile: paths.webTokenPath };
  }
  if (process.env.TASK_HANDOFF_WEB_AUTH === "required") {
    const token = crypto.randomBytes(24).toString("base64url");
    writeTokenFile(paths.webTokenPath, token);
    return { enabled: true, source: "generated", token, tokenFile: paths.webTokenPath };
  }
  return { enabled: false, tokenFile: paths.webTokenPath };
}

export function requestToken(request: FastifyRequest) {
  const authorization = request.headers.authorization || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (match?.[1]) {
    return match[1];
  }
  try {
    const url = new URL(request.url, "http://localhost");
    return url.searchParams.get("token") || undefined;
  } catch {
    return undefined;
  }
}

export function registerAuth(app: FastifyInstance, auth: WebAuthState) {
  app.addHook("preHandler", async (request, reply) => {
    if (!auth.enabled || request.url === "/api/health" || request.url === "/api/auth/status" || !request.url.startsWith("/api/")) {
      return;
    }
    if (requestToken(request) === auth.token) {
      return;
    }
    return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Missing or invalid web token." } });
  });
}
