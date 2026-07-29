import fs from "node:fs";
import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { atomicWriteFileSync } from "@task-handoff/core/storage/atomic-write";
import type { TaskHandoffStoragePaths } from "@task-handoff/core/storage/paths";

export type WebAuthState = {
  enabled: boolean;
  source?: "env" | "file" | "generated";
  tokenFile?: string;
  token?: string;
};

declare module "fastify" {
  interface FastifyContextConfig {
    taskHandoffAuth?: "public" | "web" | "node-agent";
  }
}

export const publicApiRoute = { config: { taskHandoffAuth: "public" as const } };

function sameToken(actual: string | undefined, expected: string) {
  if (!actual) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && crypto.timingSafeEqual(actualBytes, expectedBytes);
}

export function nodeAgentApiRoute(error: { code: string; message: string; requireControlled?: boolean }) {
  return {
    config: { taskHandoffAuth: "node-agent" as const },
    preHandler: async (request: FastifyRequest, reply: FastifyReply) => {
      const expectedToken = process.env.TASK_HANDOFF_REGISTRATION_TOKEN?.trim();
      if ((error.requireControlled && process.env.TASK_HANDOFF_CONTROL_MODE !== "controlled") || !expectedToken || !sameToken(requestToken(request), expectedToken)) {
        return reply.code(403).send({ error: { code: error.code, message: error.message } });
      }
    },
  };
}

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
  atomicWriteFileSync(filePath, `${token}\n`);
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
    const policy = request.routeOptions.config.taskHandoffAuth;
    if (!auth.enabled || policy === "public" || policy === "node-agent" || !request.url.startsWith("/api/")) {
      return;
    }
    if (requestToken(request) === auth.token) {
      return;
    }
    return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Missing or invalid web token." } });
  });
}
