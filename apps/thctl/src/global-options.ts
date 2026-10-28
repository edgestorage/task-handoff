export const CLI_GLOBAL_OPTIONS = [
  { flags: "--profile <label>", description: "Profile to use (overrides TASK_HANDOFF_CLI_PROFILE)" },
  { flags: "--json", description: "Emit JSON (the default output format)" },
  { flags: "--table", description: "Emit human-readable data as tables" },
  { flags: "--yes", description: "Skip interactive confirmation for write commands" },
  { flags: "--dry-run", description: "Print the request a write command would send without sending it" },
  { flags: "--token-stdin", description: "Read a secret (token, join token, credential) from stdin instead of a flag" },
  { flags: "--no-update-check", description: "Skip the background CLI and skill update check" },
] as const;
