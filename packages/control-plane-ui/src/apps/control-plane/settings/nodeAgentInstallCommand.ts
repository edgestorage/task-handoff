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

export function normalizeControlPlaneBaseUrl(value: string) {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return trimmed.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
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
  version?: string;
}) {
  const controlPlaneUrl = normalizeControlPlaneBaseUrl(input.controlPlaneUrl);
  if (!isHttpUrl(controlPlaneUrl) || !input.joinToken) return "";
  const installerUrl = `${controlPlaneUrl}/install-node-agent.sh`;
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
