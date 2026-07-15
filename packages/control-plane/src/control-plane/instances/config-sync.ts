export type ConfigSyncPreset = {
  id: string;
  label: string;
  projectRoot: string;
  items: Array<{
    id: string;
    type: "file" | "dir";
    projectPath: string;
    containerPath: string;
  }>;
};

export function configSyncPresets(): ConfigSyncPreset[] {
  return [
    {
      id: "codex",
      label: "Codex",
      projectRoot: ".task-handoff/configs/codex",
      items: [
        { id: "config", type: "file", projectPath: "config.toml", containerPath: "${CODEX_HOME}/config.toml" },
        { id: "auth", type: "file", projectPath: "auth.json", containerPath: "${CODEX_HOME}/auth.json" },
        { id: "agents", type: "file", projectPath: "AGENTS.md", containerPath: "${CODEX_HOME}/AGENTS.md" },
        { id: "skills", type: "dir", projectPath: "skills", containerPath: "${CODEX_HOME}/skills" },
      ],
    },
    {
      id: "claude",
      label: "Claude",
      projectRoot: ".task-handoff/configs/claude",
      items: [
        { id: "claude-json", type: "file", projectPath: ".claude.json", containerPath: "${HOME}/.claude.json" },
        { id: "settings", type: "file", projectPath: "settings.json", containerPath: "${CLAUDE_HOME}/settings.json" },
        { id: "claude-md", type: "file", projectPath: "CLAUDE.md", containerPath: "${CLAUDE_HOME}/CLAUDE.md" },
        { id: "commands", type: "dir", projectPath: "commands", containerPath: "${CLAUDE_HOME}/commands" },
        { id: "agents", type: "dir", projectPath: "agents", containerPath: "${CLAUDE_HOME}/agents" },
        { id: "skills", type: "dir", projectPath: "skills", containerPath: "${CLAUDE_HOME}/skills" },
      ],
    },
    {
      id: "browser",
      label: "Browser",
      projectRoot: ".task-handoff/configs/browser",
      items: [
        { id: "chromium-profile", type: "dir", projectPath: "chromium", containerPath: "${HOME}/.config/chromium" },
      ],
    },
  ];
}
