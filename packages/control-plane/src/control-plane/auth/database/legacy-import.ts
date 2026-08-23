import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  ControlPlaneMobileDeviceSchema,
  ControlPlaneUserNodeScopeSchema,
} from "@task-handoff/protocol/control-plane-access";
import type { ControlPlaneStorePaths } from "../../persistence/paths.ts";
import { normalizeControlPlaneLoginName } from "../passwords.ts";
import type { ControlPlaneUserRepository } from "./repository.ts";

const LEGACY_IMPORT_ID = "import_v0.0.21_auth_json";
const StoredRecordSchema = z.object({
  id: z.string().trim().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
const LegacyUserSchema = StoredRecordSchema.extend({
  username: z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9_.@-]+$/),
  passwordHash: z.string().trim().min(1),
  role: z.enum(["viewer", "operator", "admin"]),
  lastLoginAt: z.string().datetime().optional(),
// Compatibility for v0.0.24: JSON user records may contain the derived
// normalizedUsername field. Legacy persistence is a tolerant read boundary;
// retain declared required fields and discard additions before migration.
}).strip();
const LegacySessionSchema = StoredRecordSchema.extend({
  userId: z.string().trim().min(1),
  tokenHash: z.string().trim().min(1),
  expiresAt: z.string().datetime(),
  lastSeenAt: z.string().datetime().optional(),
  clientType: z.enum(["web", "mobile"]).default("web"),
  device: ControlPlaneMobileDeviceSchema.optional(),
}).strip().refine((session) => session.clientType !== "mobile" || Boolean(session.device), {
  path: ["device"],
  message: "Mobile sessions require device metadata.",
});
// Compatibility for v0.0.24: access grants were persisted as one membership
// record per local user before the SQL access model made grants authoritative.
const LegacyMembershipSchema = StoredRecordSchema.extend({
  subject: z.object({
    type: z.literal("local-user"),
    userId: z.string().trim().min(1),
  }).strip(),
  role: z.enum(["viewer", "operator", "admin"]),
  nodeScope: ControlPlaneUserNodeScopeSchema,
  status: z.enum(["active", "disabled"]),
  authorizationRevision: z.number().int().positive(),
}).strip();

type LegacyUser = z.infer<typeof LegacyUserSchema>;
type LegacySession = z.infer<typeof LegacySessionSchema>;
type LegacyMembership = z.infer<typeof LegacyMembershipSchema>;

function jsonFiles(directory: string) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
}

function readDirectory<T extends { id: string }>(directory: string, schema: z.ZodType<T>): T[] {
  return jsonFiles(directory).map((name) => {
    const filePath = path.join(directory, name);
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      throw legacyImportError(`Cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw legacyImportError(`Invalid v0.0.21 record ${filePath}: ${z.prettifyError(parsed.error)}`);
    if (name !== `${parsed.data.id}.json`) throw legacyImportError(`Legacy record filename does not match id: ${filePath}.`);
    return parsed.data;
  });
}

function legacyImportError(message: string) {
  return Object.assign(new Error(message), {
    code: "CONTROL_PLANE_LEGACY_AUTH_IMPORT_FAILED",
    recovery: "Fix or restore the v0.0.21 auth JSON files, then restart. The source files were not modified.",
  });
}

function identityId(userId: string) {
  return `identity_legacy_${crypto.createHash("sha256").update(userId).digest("hex").slice(0, 20)}`;
}

function checksum(users: LegacyUser[], sessions: LegacySession[], memberships: LegacyMembership[]) {
  return crypto.createHash("sha256").update(JSON.stringify({ users, sessions, memberships })).digest("hex");
}

export function legacyAuthDataPresent(paths: ControlPlaneStorePaths) {
  return jsonFiles(paths.authUsersDir).length > 0
    || jsonFiles(paths.authSessionsDir).length > 0
    || jsonFiles(paths.authMembershipsDir).length > 0;
}

export async function importV0021AuthJson(repository: ControlPlaneUserRepository, paths: ControlPlaneStorePaths) {
  const users = readDirectory(paths.authUsersDir, LegacyUserSchema);
  const sessions = readDirectory(paths.authSessionsDir, LegacySessionSchema);
  const memberships = readDirectory(paths.authMembershipsDir, LegacyMembershipSchema);
  const sourceChecksum = checksum(users, sessions, memberships);
  const previous = await repository.migration(LEGACY_IMPORT_ID);
  if (previous) {
    if (previous.checksum !== sourceChecksum) throw legacyImportError("Legacy auth JSON changed after it was imported.");
    return {
      imported: false,
      users: Number(previous.details.users || 0),
      sessions: Number(previous.details.sessions || 0),
      memberships: Number(previous.details.memberships || 0),
    };
  }
  const userIds = new Set(users.map((user) => user.id));
  if (userIds.size !== users.length) throw legacyImportError("Legacy auth data contains duplicate user ids.");
  const loginNames = users.map((user) => normalizeControlPlaneLoginName(user.username));
  if (new Set(loginNames).size !== loginNames.length) {
    throw legacyImportError("Legacy auth data contains usernames that collide after normalization.");
  }
  const membershipsByUserId = new Map<string, LegacyMembership>();
  for (const membership of memberships) {
    const userId = membership.subject.userId;
    if (!userIds.has(userId)) throw legacyImportError(`Legacy membership ${membership.id} references missing user ${userId}.`);
    if (membershipsByUserId.has(userId)) throw legacyImportError(`Legacy auth data contains multiple memberships for user ${userId}.`);
    membershipsByUserId.set(userId, membership);
  }
  const tokenHashes = sessions.map((session) => session.tokenHash);
  if (new Set(tokenHashes).size !== tokenHashes.length) throw legacyImportError("Legacy auth data contains duplicate session token hashes.");
  for (const session of sessions) {
    if (!userIds.has(session.userId)) throw legacyImportError(`Legacy session ${session.id} references missing user ${session.userId}.`);
  }
  const existingCounts = await Promise.all([
    repository.users.list(), repository.identities.list(), repository.grants.list(), repository.sessions.list(),
  ]);
  if (existingCounts.some((records) => records.length > 0)) {
    throw legacyImportError("The SQL user store is not empty; refusing to merge legacy auth JSON automatically.");
  }

  try {
    await repository.transaction(async (transaction) => {
    for (const user of users) {
      const membership = membershipsByUserId.get(user.id);
      await transaction.users.put({
        id: user.id,
        displayName: user.username,
        status: membership?.status === "disabled" ? "disabled" : "active",
        lastLoginAt: user.lastLoginAt,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      });
      await transaction.identities.put({
        id: identityId(user.id),
        userId: user.id,
        kind: "local-password",
        normalizedLoginName: normalizeControlPlaneLoginName(user.username),
        passwordHash: user.passwordHash,
        requiresPasswordChange: false,
        lastUsedAt: user.lastLoginAt,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      });
      await transaction.grants.put({
        id: user.id,
        userId: user.id,
        roleIds: [`role_${membership?.role || user.role}`],
        nodeScope: membership?.nodeScope || { kind: "all" },
        authorizationRevision: membership?.authorizationRevision || 1,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      });
    }
    const currentTimestamp = new Date().toISOString();
    for (const session of sessions.filter((session) => session.expiresAt > currentTimestamp)) {
      const authorizationRevision = membershipsByUserId.get(session.userId)?.authorizationRevision || 1;
      await transaction.sessions.put({
        ...session,
        identityId: identityId(session.userId),
        authorizationRevision,
      });
    }
    const initializedAt = users.map((user) => user.createdAt).sort()[0] || currentTimestamp;
    await transaction.putMetadata({ schemaVersion: 1, initializedAt });
    await transaction.putMigration({
      id: LEGACY_IMPORT_ID,
      checksum: sourceChecksum,
      appliedAt: currentTimestamp,
      details: {
        sourceVersion: memberships.length ? "v0.0.24" : "v0.0.21",
        users: users.length,
        sessions: sessions.length,
        memberships: memberships.length,
      },
    });
    });
  } catch (error) {
    if ((error as { code?: string }).code === "CONTROL_PLANE_LEGACY_AUTH_IMPORT_FAILED") throw error;
    throw legacyImportError(`v0.0.21 import transaction failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { imported: true, users: users.length, sessions: sessions.length, memberships: memberships.length };
}
