import {
  DEFAULT_NODE_AGENT_INSTALLER_SOURCE,
  nodeAgentInstallerUrl,
  type NodeAgentInstallerSource,
} from "@task-handoff/protocol/control-plane";

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * The one-line installer for a machine that has no node agent yet. It reuses the
 * selected install script and hands it the cloud-relay binding token, so the
 * install finishes by binding the node to the account without a join token.
 * Official builds resolve the Coordinator origin from their baked cloud
 * discovery record; `cloudOrigin` is only needed for ad-hoc clouds.
 */
export function nodeRelayInstallCommand(input: {
  controlPlaneUrl: string;
  cloudOrigin?: string;
  bindingToken: string;
  installerSource?: NodeAgentInstallerSource;
  version?: string;
}) {
  if (!input.controlPlaneUrl || !input.bindingToken) return "";
  const installerUrl = nodeAgentInstallerUrl(input.installerSource ?? DEFAULT_NODE_AGENT_INSTALLER_SOURCE, input.controlPlaneUrl);
  const lines = [
    `curl -fsSL ${shellQuote(installerUrl)} | sudo sh -s --`,
    ...(input.cloudOrigin ? [`  --cloud-relay-origin ${shellQuote(input.cloudOrigin)}`] : []),
    `  --cloud-relay-bind-token ${shellQuote(input.bindingToken)}`,
    "  --npm-package @task-handoff/node-agent",
    "  --controlled-instance-package @task-handoff/controlled-instance",
    ...(input.version ? [`  --version ${shellQuote(input.version)}`] : []),
  ];
  return lines.map((line, index) => index < lines.length - 1 ? `${line} \\` : line).join("\n");
}
