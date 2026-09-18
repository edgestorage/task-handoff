export function codexStoryMcpArgs(env: NodeJS.ProcessEnv) {
  const storyEndpoint = env.TASK_HANDOFF_AGENT_TOOLS_ENDPOINT?.trim();
  const storyToken = env.TASK_HANDOFF_AGENT_TOOLS_TOKEN?.trim();
  return storyEndpoint && storyToken ? [
    "-c", `mcp_servers.task_handoff_story.url=${JSON.stringify(`${storyEndpoint}/mcp`)}`,
    "-c", "mcp_servers.task_handoff_story.bearer_token_env_var=\"TASK_HANDOFF_AGENT_TOOLS_TOKEN\"",
  ] : [];
}
