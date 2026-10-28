import {
  DEFAULT_NODE_AGENT_INSTALLER_SOURCE,
  nodeAgentInstallerUrl,
  normalizeControlPlaneBaseUrl,
  type NodeAgentInstallerSource,
} from "@task-handoff/protocol/control-plane";

export { normalizeControlPlaneBaseUrl };

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function nodeAgentConnectCommand(input: {
  controlPlaneUrl: string;
  joinToken: string;
}) {
  const controlPlaneUrl = normalizeControlPlaneBaseUrl(input.controlPlaneUrl);
  if (!isHttpUrl(controlPlaneUrl) || !input.joinToken) return "";
  return [
    "sudo task-handoff-node-agent connect",
    `  --control-plane ${shellQuote(controlPlaneUrl)}`,
    `  --join-token ${shellQuote(input.joinToken)}`,
  ].map((line, index, lines) => index < lines.length - 1 ? `${line} \\` : line).join("\n");
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.host);
  } catch {
    return false;
  }
}

export function nodeAgentInstallCommand(input: {
  controlPlaneUrl: string;
  joinToken: string;
  installerSource?: NodeAgentInstallerSource;
  version?: string;
}) {
  const controlPlaneUrl = normalizeControlPlaneBaseUrl(input.controlPlaneUrl);
  if (!isHttpUrl(controlPlaneUrl) || !input.joinToken) return "";
  const installerUrl = nodeAgentInstallerUrl(input.installerSource ?? DEFAULT_NODE_AGENT_INSTALLER_SOURCE, controlPlaneUrl);
  const command = [
    `curl -fsSL ${shellQuote(installerUrl)} | sudo sh -s --`,
    `  --control-plane ${shellQuote(controlPlaneUrl)}`,
    `  --join-token ${shellQuote(input.joinToken)}`,
    "  --npm-package @task-handoff/node-agent",
    "  --controlled-instance-package @task-handoff/controlled-instance",
    ...(input.version ? [`  --version ${shellQuote(input.version)}`] : []),
  ];
  return command.map((line, index) => index < command.length - 1 ? `${line} \\` : line).join("\n");
}

export function withNodeAgentInstallerSource(command: string, input: {
  controlPlaneUrl: string;
  installerSource: NodeAgentInstallerSource;
}) {
  const lineEnd = command.indexOf("\n");
  const firstLine = lineEnd === -1 ? command : command.slice(0, lineEnd);
  const marker = " | sudo sh -s --";
  const markerIndex = firstLine.indexOf(marker);
  if (!firstLine.startsWith("curl -fsSL ") || markerIndex === -1) return command;
  const suffix = command.slice(markerIndex);
  return `curl -fsSL ${shellQuote(nodeAgentInstallerUrl(input.installerSource, input.controlPlaneUrl))}${suffix}`;
}
