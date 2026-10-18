function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function normalizedBaseUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/, "");
  try {
    const url = new URL(trimmed);
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return trimmed;
  }
}

/**
 * The one-line installer for a machine that has no node agent yet. It reuses the
 * existing install script and hands the script the cloud-relay binding
 * parameters, so the install finishes by binding the node to the account and no
 * Control Plane address or join token is needed on the target machine.
 */
export function nodeRelayInstallCommand(input: { controlPlaneUrl: string; cloudOrigin: string; bindingToken: string; version?: string }) {
  if (!input.controlPlaneUrl || !input.cloudOrigin || !input.bindingToken) return "";
  const installerUrl = `${normalizedBaseUrl(input.controlPlaneUrl)}/install-node-agent.sh`;
  const lines = [
    `curl -fsSL ${shellQuote(installerUrl)} | sudo sh -s --`,
    `  --cloud-relay-origin ${shellQuote(input.cloudOrigin)}`,
    `  --cloud-relay-bind-token ${shellQuote(input.bindingToken)}`,
    "  --npm-package @task-handoff/node-agent",
    "  --controlled-instance-package @task-handoff/controlled-instance",
    ...(input.version ? [`  --version ${shellQuote(input.version)}`] : []),
  ];
  return lines.map((line, index) => index < lines.length - 1 ? `${line} \\` : line).join("\n");
}
