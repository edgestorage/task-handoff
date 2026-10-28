import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireBrowsableFolderPath } from "./folders.ts";

export const DEFAULT_WORKSPACE_INSTANCE_INITIALIZATION_KEY = "default-workspace-instance-v1";
export const DEFAULT_WORKSPACE_DIRECTORY_NAME = "th-workspace";
export const DEFAULT_WORKSPACE_HOSTNAME_MAX_LENGTH = 64;

const WORKSPACE_NAME_SUFFIX = " Workspace";

/** Keep instance names recognizable in lists while accepting long machine hostnames. */
export function defaultWorkspaceInstanceName(hostname: string | undefined) {
  const normalizedHostname = hostname?.trim().replace(/\s+/gu, " ") || "";
  const boundedHostname = Array.from(normalizedHostname).slice(0, DEFAULT_WORKSPACE_HOSTNAME_MAX_LENGTH).join("");
  return boundedHostname ? `${boundedHostname}${WORKSPACE_NAME_SUFFIX}` : "Workspace";
}

/** The default workspace is user-visible, beside ordinary home-directory folders. */
export function resolveDefaultWorkspacePath(override?: string, homeDir = os.homedir()) {
  return path.resolve(override?.trim() || path.join(homeDir, DEFAULT_WORKSPACE_DIRECTORY_NAME));
}

export function prepareDefaultWorkspace(workspacePath: string) {
  const resolvedPath = path.resolve(workspacePath);
  const existed = fs.existsSync(resolvedPath);
  if (!existed) {
    fs.mkdirSync(resolvedPath, { recursive: true, mode: 0o700 });
    fs.chmodSync(resolvedPath, 0o700);
  }
  const browsablePath = requireBrowsableFolderPath(resolvedPath);
  try {
    fs.accessSync(browsablePath, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
  } catch {
    throw Object.assign(new Error(`Default workspace ${browsablePath} is not writable.`), {
      statusCode: 403,
      code: "DEFAULT_WORKSPACE_UNWRITABLE",
    });
  }
  return browsablePath;
}
