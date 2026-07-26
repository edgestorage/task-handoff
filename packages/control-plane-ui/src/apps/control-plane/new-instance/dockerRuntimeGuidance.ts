import type { Node, NodeRuntime } from "../../../api/types";

export type DockerRuntimeCheckState = "idle" | "checking" | "online" | "offline" | "error";

export type DockerInstallGuidance = {
  kind: "windows" | "mac" | "linux" | "generic";
  url: string;
};

export function nodePlatform(node?: Node) {
  const agent = node?.capabilities.agent;
  if (!agent || typeof agent !== "object") return "unknown";
  const platform = (agent as Record<string, unknown>).platform;
  return typeof platform === "string" ? platform : "unknown";
}

export function dockerInstallGuidance(platform: string): DockerInstallGuidance {
  if (platform === "win32") {
    return {
      kind: "windows",
      url: "https://docs.docker.com/desktop/setup/install/windows-install/",
    };
  }
  if (platform === "darwin") {
    return {
      kind: "mac",
      url: "https://orbstack.dev/download",
    };
  }
  if (platform === "linux") {
    return {
      kind: "linux",
      url: "https://docs.docker.com/engine/install/",
    };
  }
  return {
    kind: "generic",
    url: "https://docs.docker.com/engine/install/",
  };
}

export function dockerDaemonDetails(runtime: NodeRuntime) {
  const daemon = runtime.capabilities.daemon;
  if (!daemon || typeof daemon !== "object") return {};
  const record = daemon as Record<string, unknown>;
  return {
    ...(typeof record.hostPlatform === "string" ? { hostPlatform: record.hostPlatform } : {}),
    ...(typeof record.serverVersion === "string" ? { serverVersion: record.serverVersion } : {}),
    ...(typeof record.error === "string" ? { error: record.error } : {}),
  };
}
