import fs from "node:fs";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
import type { NodeAgentStorePaths } from "../persistence/paths.ts";
import { StoredNodeAgentDateTimeSchema, StoredNodeAgentIdSchema, StoredNodeAgentPairingInviteSchema, StoredNodeAgentRemoteControlPlaneSchema } from "./schemas.ts";
import type { NodeAgentIdentity } from "./types.ts";

function now() {
  return new Date().toISOString();
}

type IdentityStoreLogger = (message: string, details: Record<string, unknown>) => void;

const IDENTITY_FIELDS = new Set(["nodeId", "createdAt", "updatedAt", "pairingInvites", "remoteControlPlanes"]);
const PAIRING_INVITE_FIELDS = new Set(["tokenHash", "expiresAt", "createdAt", "controlPlaneName", "controlPlaneUrl"]);
const REMOTE_CONTROL_PLANE_FIELDS = new Set(["id", "keyId", "name", "url", "secret", "pairedAt", "updatedAt", "active"]);

function defaultLogger(message: string, details: Record<string, unknown>) {
  console.warn(JSON.stringify({ message, ...details }));
}

function identityError(message: string, cause?: unknown) {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), {
    code: "NODE_AGENT_IDENTITY_INVALID",
  });
}

function unknownFields(record: Record<string, unknown>, allowed: Set<string>) {
  return Object.keys(record).filter((key) => !allowed.has(key));
}

function validDateOrNow(value: unknown, field: string, logger: IdentityStoreLogger) {
  const parsed = StoredNodeAgentDateTimeSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  logger("invalid node agent identity timestamp was replaced", { field });
  return now();
}

function normalizeNodeAgentIdentity(record: unknown, logger: IdentityStoreLogger): NodeAgentIdentity {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw identityError("Node agent identity must be a JSON object.");
  }
  const value = record as Record<string, unknown>;
  const parsedNodeId = StoredNodeAgentIdSchema.safeParse(value.nodeId);
  if (!parsedNodeId.success) throw identityError("Node agent identity has an invalid nodeId.", parsedNodeId.error);
  const nodeId = parsedNodeId.data;
  const ignoredIdentityFields = unknownFields(value, IDENTITY_FIELDS);
  if (ignoredIdentityFields.length) {
    logger("unknown node agent identity fields were ignored", { fields: ignoredIdentityFields });
  }
  return {
    nodeId,
    createdAt: validDateOrNow(value.createdAt, "createdAt", logger),
    updatedAt: validDateOrNow(value.updatedAt, "updatedAt", logger),
    pairingInvites: Array.isArray(value.pairingInvites) ? value.pairingInvites.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        logger("invalid node agent pairing invite was ignored", {});
        return [];
      }
      const ignoredFields = unknownFields(item as Record<string, unknown>, PAIRING_INVITE_FIELDS);
      if (ignoredFields.length) logger("unknown node agent pairing invite fields were ignored", { fields: ignoredFields });
      const parsed = StoredNodeAgentPairingInviteSchema.safeParse(item);
      if (!parsed.success) {
        logger("invalid node agent pairing invite was ignored", { issues: parsed.error.issues });
        return [];
      }
      return [parsed.data];
    }) : [],
    remoteControlPlanes: Array.isArray(value.remoteControlPlanes) ? value.remoteControlPlanes.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        logger("invalid node agent remote control-plane was ignored", {});
        return [];
      }
      const ignoredFields = unknownFields(item as Record<string, unknown>, REMOTE_CONTROL_PLANE_FIELDS);
      if (ignoredFields.length) logger("unknown node agent remote control-plane fields were ignored", { fields: ignoredFields });
      const parsed = StoredNodeAgentRemoteControlPlaneSchema.safeParse(item);
      if (!parsed.success) {
        logger("invalid node agent remote control-plane was ignored", { issues: parsed.error.issues });
        return [];
      }
      return [parsed.data];
    }) : [],
  };
}

export class NodeAgentIdentityStore {
  private readonly paths: NodeAgentStorePaths;
  private readonly logger: IdentityStoreLogger;

  constructor(paths: NodeAgentStorePaths, options: { logger?: IdentityStoreLogger } = {}) {
    this.paths = paths;
    this.logger = options.logger || defaultLogger;
  }

  read() {
    let contents: string;
    try {
      contents = fs.readFileSync(this.paths.identityPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw Object.assign(new Error(`Node agent identity could not be read: ${this.paths.identityPath}`, { cause: error }), {
        code: "NODE_AGENT_IDENTITY_READ_FAILED",
      });
    }
    let record: unknown;
    try {
      record = JSON.parse(contents);
    } catch (error) {
      throw identityError(`Node agent identity contains invalid JSON: ${this.paths.identityPath}`, error);
    }
    return normalizeNodeAgentIdentity(record, this.logger);
  }

  write(identity: NodeAgentIdentity) {
    fs.mkdirSync(path.dirname(this.paths.identityPath), { recursive: true });
    const normalized = normalizeNodeAgentIdentity({ ...identity, updatedAt: now() }, this.logger);
    writeFileAtomic.sync(this.paths.identityPath, `${JSON.stringify(normalized, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}
