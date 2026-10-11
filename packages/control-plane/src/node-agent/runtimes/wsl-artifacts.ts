import type { RuntimeArtifactIdentity } from "@task-handoff/protocol/control-plane";
import type { ResolvedRuntimeArtifact } from "../runtime-artifacts.ts";

/**
 * WSL 受管 runtime artifact（openspec change add-wsl-runtime，Phase 7，7.1/7.2）。
 *
 * WSL 复用 Docker 同一条受管 artifact 链路：Node Agent 从随附 bundle
 * （`TASK_HANDOFF_BUNDLED_RUNTIME_DIR`/`runtime-artifacts`）离线取得 `linux-universal`
 * runtime artifact，经 stdin 桥接进 distro，再在 distro 内用同一份 `runtime-installer.mjs`
 * 解包、校验 manifest/SHA-256/launcher ABI 并原子切换 `current`（无网络依赖）。
 */

export const WSL_LAUNCHER_ABI = 1;
/** distro 内 runtime 安装根，与 Docker 完全一致（installer 决定 staging/releases/current 语义）。 */
export const WSL_RUNTIME_ROOT = "/opt/task-handoff/instance-runtime";
export const WSL_RUNTIME_INSTALLER = "/opt/task-handoff/bootstrap/runtime-installer.mjs";
export const WSL_RUNTIME_ARTIFACT_STAGING = "/run/task-handoff/runtime-artifact.tar.gz";

/** WSL distro 恒为 linux；架构随宿主（WSL2 与宿主同架构），artifact 本身是 universal。 */
export function wslArtifactTarget(hostArch: string) {
  return { platform: "linux", arch: hostArch, launcherAbi: WSL_LAUNCHER_ABI };
}

export type WslArtifactExecutor = {
  copyIntoDistro(name: string, sourcePath: string, destinationPath: string, options?: Record<string, unknown>): Promise<unknown>;
  execOrThrow(name: string, argv: readonly string[], options?: Record<string, unknown>): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  exec(name: string, argv: readonly string[], options?: Record<string, unknown>): Promise<{ stdout: string; stderr: string; exitCode: number }>;
};

export function artifactIdentityMatches(actual: Partial<RuntimeArtifactIdentity>, expected: RuntimeArtifactIdentity) {
  return actual.packageName === expected.packageName
    && actual.version === expected.version
    && actual.platform === expected.platform
    && actual.arch === expected.arch
    && actual.formatVersion === expected.formatVersion
    && actual.launcherAbi === expected.launcherAbi
    && actual.entrypoint === expected.entrypoint
    && actual.sha256 === expected.sha256;
}

/**
 * 7.2：把 artifact 离线注入 distro 并安装到 runtime 根。staging、版本目录与原子 `current`
 * 切换由复用的 `runtime-installer.mjs` 负责（7.3），上一已验证 release 保留在 `releases/`。
 */
export async function installWslRuntime(
  executor: WslArtifactExecutor,
  distroName: string,
  artifact: ResolvedRuntimeArtifact,
) {
  await executor.copyIntoDistro(distroName, artifact.archivePath, WSL_RUNTIME_ARTIFACT_STAGING);
  await executor.execOrThrow(distroName, [
    "sh",
    "-c",
    `install -d -m 0755 ${WSL_RUNTIME_ROOT} ${WSL_RUNTIME_ROOT}/releases ${WSL_RUNTIME_ROOT}/staging ${WSL_RUNTIME_ROOT}/incoming`
      + ` && node ${WSL_RUNTIME_INSTALLER} install`
      + ` --artifact ${WSL_RUNTIME_ARTIFACT_STAGING}`
      + ` --version ${shellQuote(artifact.identity.version)}`
      + ` --sha256 ${shellQuote(artifact.identity.sha256)}`
      + ` --platform ${shellQuote(artifact.identity.platform)}`
      + ` --arch ${shellQuote(artifact.identity.arch)}`
      + ` --launcher-abi ${String(artifact.identity.launcherAbi)}`,
  ]);
}

/** 7.4 的 inspect 分支：在 distro 内读取 `current` release manifest 并与期望身份比对。 */
export async function inspectWslRuntime(
  executor: WslArtifactExecutor,
  distroName: string,
  expected: RuntimeArtifactIdentity,
) {
  const result = await executor.exec(distroName, ["node", WSL_RUNTIME_INSTALLER, "verify-active"]);
  if (result.exitCode !== 0) return false;
  let parsed: Partial<RuntimeArtifactIdentity>;
  try {
    parsed = JSON.parse(result.stdout) as Partial<RuntimeArtifactIdentity>;
  } catch {
    return false;
  }
  return artifactIdentityMatches(parsed, expected);
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
