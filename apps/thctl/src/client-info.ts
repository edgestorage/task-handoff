import os from "node:os";
import { executablePackageVersionResolver } from "@task-handoff/core/core/package-version";

export const THCTL_CLI_NAME = "thctl";

/**
 * 正在执行的 thctl 安装版本：从可执行文件归属的 package.json 解析。
 * 不使用 TASK_HANDOFF_VERSION——受管实例会把该变量设为实例镜像版本，
 * 不能代表 CLI 自身；`--version`、更新检查、skill 兼容判定、客户信息与
 * schema 导出都必须报告真实安装版本。
 */
export function installedCliVersion() {
  return executablePackageVersionResolver("@task-handoff/thctl")();
}

export const THCTL_VERSION = installedCliVersion();

/** 会话与本地信任端点记录的 CLI 元数据；name 使用主机名便于审计区分机器。 */
export function cliClientInfo() {
  const platform = process.platform === "darwin" || process.platform === "linux" || process.platform === "win32" ? process.platform : "linux";
  return { name: os.hostname() || THCTL_CLI_NAME, platform, version: THCTL_VERSION };
}
