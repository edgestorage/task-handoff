import os from "node:os";
import path from "node:path";
import {
  processLockOwnerMatchesLiveProcess,
  readProcessSingletonLockOwner,
  type ProcessLockOwner,
} from "@task-handoff/core/core/process-singleton-lock";
import { CliProfileSchema, profileLabelFromOrigin, type CliProfile, type CliProfileStore } from "./config.ts";
import { fetchControlPlaneIdentity, type VerifiedControlPlaneIdentity } from "./control-plane.ts";

/** 与 server 端 `defaultControlPlaneSingletonLockPath` 保持同一约定。 */
export const CLI_CONTROL_PLANE_LOCK_ENV = "TASK_HANDOFF_CONTROL_PLANE_LOCK_PATH";
export const MANAGED_LOCAL_PROFILE_LABEL = "local";

export function localControlPlaneLockPath(env: Record<string, string | undefined> = process.env) {
  const override = env[CLI_CONTROL_PLANE_LOCK_ENV]?.trim();
  if (override) return path.resolve(override);
  return path.join(os.tmpdir(), `task-handoff-control-plane-${process.getuid?.() ?? "user"}.lock`);
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

/**
 * owner.json 的 host 可能是 loopback、通配地址或局域网地址；
 * 只有本机地址能建立本地信任，通配地址按 127.0.0.1 访问。
 */
export function localControlPlaneOrigin(owner: Pick<ProcessLockOwner, "host" | "port">) {
  const port = owner.port;
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65_535) return undefined;
  const host = owner.host?.trim().toLowerCase();
  if (!host || (!LOOPBACK_HOSTS.has(host) && !WILDCARD_HOSTS.has(host))) return undefined;
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const authority = LOOPBACK_HOSTS.has(host) ? (bare.includes(":") ? `[${bare}]` : bare) : "127.0.0.1";
  return `http://${authority}:${port}`;
}

export type LocalControlPlaneDiscovery = {
  origin: string;
  identity: VerifiedControlPlaneIdentity;
  lockPath: string;
  dataDir?: string;
};

/** 读取本机运行态锁并验签身份文档；锁不可信、地址非本机或目标不可达时返回 undefined。 */
export async function discoverLocalControlPlane(options: {
  env?: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
}): Promise<LocalControlPlaneDiscovery | undefined> {
  const lockPath = localControlPlaneLockPath(options.env);
  const owner = readProcessSingletonLockOwner(lockPath);
  if (!owner) return undefined;
  if (owner.component && owner.component !== "control-plane") return undefined;
  if (!processLockOwnerMatchesLiveProcess(owner)) return undefined;
  const origin = localControlPlaneOrigin(owner);
  if (!origin) return undefined;
  try {
    const identity = await fetchControlPlaneIdentity(origin, options.fetchImpl);
    return { origin, identity, lockPath, ...(owner.dataDir ? { dataDir: owner.dataDir } : {}) };
  } catch {
    return undefined;
  }
}

function managedLabel(store: CliProfileStore, origin: string) {
  if (!store.get(MANAGED_LOCAL_PROFILE_LABEL)) return MANAGED_LOCAL_PROFILE_LABEL;
  const base = profileLabelFromOrigin(origin);
  let label = base;
  let index = 2;
  while (store.get(label)) label = `${base}-${index++}`;
  return label;
}

/**
 * 为发现到的本机控制面板写入/收敛受管 profile：label 优先 `local`，首次 TOFU 固定身份；
 * 已存在的受管 profile 换 origin 时重新固定并记录身份变更；手动 profile 永不被改写。
 */
export function ensureLocalProfile(store: CliProfileStore, discovery: LocalControlPlaneDiscovery) {
  const { origin, identity } = discovery;
  const existingByOrigin = store.findByOrigin(origin);
  if (existingByOrigin) return existingByOrigin;
  const timestamp = new Date().toISOString();
  const managed = store.list().find((profile) => profile.source === "local-discovery");
  if (managed) {
    const changed = managed.controlPlaneId !== identity.payload.controlPlaneId
      || managed.fingerprint !== identity.payload.publicKey.fingerprint;
    return store.save({
      ...managed,
      origin,
      controlPlaneId: identity.payload.controlPlaneId,
      fingerprint: identity.payload.publicKey.fingerprint,
      protocolVersion: identity.payload.protocolVersion,
      capabilities: identity.payload.capabilities,
      updatedAt: timestamp,
      lastUsedAt: timestamp,
      ...(changed ? { trustedAt: timestamp, identityChangedAt: timestamp, replacedFingerprint: managed.fingerprint } : {}),
    });
  }
  const label = managedLabel(store, origin);
  const profile: CliProfile = CliProfileSchema.parse({
    label,
    origin,
    controlPlaneId: identity.payload.controlPlaneId,
    fingerprint: identity.payload.publicKey.fingerprint,
    protocolVersion: identity.payload.protocolVersion,
    capabilities: identity.payload.capabilities,
    source: "local-discovery",
    createdAt: timestamp,
    updatedAt: timestamp,
    trustedAt: timestamp,
    lastUsedAt: timestamp,
  });
  const saved = store.save(profile);
  if (!store.defaultProfile()) store.setDefault(saved.label);
  return saved;
}
