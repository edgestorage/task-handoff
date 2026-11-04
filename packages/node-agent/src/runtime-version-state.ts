import { packageVersionResolver } from "@task-handoff/core/core/package-version";
import {
  RuntimeVersionStateSchema,
  type ControlledInstance,
} from "@task-handoff/protocol/control-plane";

const resolveDesiredVersion = packageVersionResolver(
  "@task-handoff/node-agent",
  process.env,
  "@task-handoff/control-plane",
);

export function desiredControlledInstanceVersion() {
  return resolveDesiredVersion();
}

function timestamp() {
  return new Date().toISOString();
}

function versionMismatch(desiredVersion: string, actualVersion?: string) {
  return {
    code: "INSTANCE_RUNTIME_VERSION_MISMATCH" as const,
    message: `Expected controlled-instance ${desiredVersion}, received ${actualVersion || "an unknown version"}.`,
    expectedVersion: desiredVersion,
    ...(actualVersion ? { actualVersion } : {}),
    retryable: true,
  };
}

export function runtimeVersionStateForActual(actualVersion?: string) {
  const desiredVersion = desiredControlledInstanceVersion();
  if (actualVersion === desiredVersion) {
    return {
      desiredVersion,
      actualVersion,
      phase: "matched" as const,
      attempt: 0,
      matchedAt: timestamp(),
    };
  }
  return {
    desiredVersion,
    ...(actualVersion ? { actualVersion } : {}),
    phase: "pending" as const,
    attempt: 0,
    error: versionMismatch(desiredVersion, actualVersion),
  };
}

export function runtimeVersionStateForReport(
  instance: ControlledInstance,
  actualVersion?: string,
  managedArtifacts = true,
) {
  if (!managedArtifacts) {
    const desiredVersion = desiredControlledInstanceVersion();
    const current = instance.runtimeVersion;
    // Local Runtime reports are heartbeat observations. Once the same desired
    // and actual version is matched, preserve the convergence timestamp instead
    // of manufacturing a new semantic runtime state on every heartbeat.
    if (
      current?.phase === "matched"
      && current.desiredVersion === desiredVersion
      && current.actualVersion === actualVersion
    ) return current;
    return runtimeVersionStateForActual(actualVersion);
  }

  const desiredVersion = desiredControlledInstanceVersion();
  const current = instance.runtimeVersion;
  if (!current || current.desiredVersion !== desiredVersion) {
    return runtimeVersionStateForActual(actualVersion);
  }

  const pendingError = current.error?.code !== "INSTANCE_RUNTIME_VERSION_MISMATCH"
    ? current.error
    : actualVersion === desiredVersion
      ? undefined
      : versionMismatch(desiredVersion, actualVersion);

  return RuntimeVersionStateSchema.parse({
    ...current,
    desiredVersion,
    ...(actualVersion ? { actualVersion } : { actualVersion: undefined }),
    ...(current.phase === "pending"
      ? { error: pendingError || (actualVersion !== desiredVersion ? versionMismatch(desiredVersion, actualVersion) : undefined) }
      : {}),
  });
}
