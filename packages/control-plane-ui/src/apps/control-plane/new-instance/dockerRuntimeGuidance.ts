import type { Node, NodeRuntime } from "../../../api/types";

export type DockerRuntimeCheckState = "idle" | "checking" | "online" | "offline" | "error";

export type DockerInstallGuidance = {
  label: string;
  message: string;
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
      label: "Install Docker Desktop",
      message: "Install Docker Desktop on the selected Windows node, start it, then retry the check.",
      url: "https://docs.docker.com/desktop/setup/install/windows-install/",
    };
  }
  if (platform === "darwin") {
    return {
      label: "Install OrbStack",
      message: "Install and start OrbStack on the selected macOS node, then retry the check.",
      url: "https://orbstack.dev/download",
    };
  }
  if (platform === "linux") {
    return {
      label: "Open Docker Engine installation guide",
      message: "Install Docker Engine using Docker's official instructions for the selected Linux distribution, start the daemon, then retry the check.",
      url: "https://docs.docker.com/engine/install/",
    };
  }
  return {
    label: "Open Docker installation guide",
    message: "Install and start Docker on the selected node, then retry the check.",
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
