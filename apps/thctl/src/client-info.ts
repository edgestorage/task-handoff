import os from "node:os";
import { resolvePackageVersion } from "@task-handoff/core/core/package-version";

export const THCTL_CLI_NAME = "thctl";
export const THCTL_VERSION = resolvePackageVersion("@task-handoff/thctl");

/** 会话与本地信任端点记录的 CLI 元数据；name 使用主机名便于审计区分机器。 */
export function cliClientInfo() {
  const platform = process.platform === "darwin" || process.platform === "linux" || process.platform === "win32" ? process.platform : "linux";
  return { name: os.hostname() || THCTL_CLI_NAME, platform, version: THCTL_VERSION };
}
