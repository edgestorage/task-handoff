import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePackageVersion } from "@task-handoff/core/core/package-version";

export const THCTL_CLI_NAME = "thctl";
export const THCTL_VERSION = resolvePackageVersion("@task-handoff/thctl");

/**
 * 正在执行的 thctl 安装版本：从可执行文件归属的 package.json 解析，
 * 不采用 TASK_HANDOFF_VERSION 覆盖——受管实例会把该变量设为实例镜像版本，
 * 不能代表 CLI 自身（更新检查与 skill 兼容判定必须用真实安装版本）。
 */
export function installedCliVersion() {
  const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
  if (entryPath) {
    let directory: string;
    try {
      directory = path.dirname(fs.realpathSync(entryPath));
    } catch {
      directory = path.dirname(entryPath);
    }
    for (let depth = 0; depth < 8; depth += 1) {
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
        if (manifest.name === "@task-handoff/thctl" && typeof manifest.version === "string" && manifest.version.trim()) {
          return manifest.version.trim();
        }
      } catch {
        // 继续向上查找
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return THCTL_VERSION;
}

/** 会话与本地信任端点记录的 CLI 元数据；name 使用主机名便于审计区分机器。 */
export function cliClientInfo() {
  const platform = process.platform === "darwin" || process.platform === "linux" || process.platform === "win32" ? process.platform : "linux";
  return { name: os.hostname() || THCTL_CLI_NAME, platform, version: THCTL_VERSION };
}
