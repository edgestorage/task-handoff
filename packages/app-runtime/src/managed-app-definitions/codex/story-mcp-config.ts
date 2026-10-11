/**
 * Values are written as TOML literal strings (single quotes) on purpose. On
 * Windows the managed CLI is an npm `.cmd` shim that runs through `cmd.exe`,
 * which rewrites argument values carrying double quotes: a `-c` override ends
 * up wrapped in stray quotes and Codex discards it as an unrecognized setting.
 * The literal form carries the same value with no double quote to mangle, so
 * `quoteCommandInterpreterArgument` passes it through untouched.
 */
export function codexStoryMcpArgs(env: NodeJS.ProcessEnv) {
  const storyEndpoint = env.TASK_HANDOFF_AGENT_TOOLS_ENDPOINT?.trim();
  const storyToken = env.TASK_HANDOFF_AGENT_TOOLS_TOKEN?.trim();
  return storyEndpoint && storyToken ? [
    "-c", `mcp_servers.task_handoff_story.url='${storyEndpoint}/mcp'`,
    "-c", "mcp_servers.task_handoff_story.bearer_token_env_var='TASK_HANDOFF_AGENT_TOOLS_TOKEN'",
  ] : [];
}
