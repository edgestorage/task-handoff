export function formatTimeoutTargetReply(target: unknown, source = "cli") {
  const continuation =
    source === "mcp"
      ? "如果已完成当前目标，请返回ready，并在 MCP 端继续调用 get_task 工具发送ready以等待新任务或者目标"
      : "如果已完成当前目标，请返回ready，并继续执行命令行以等待新任务或者目标";
  return [
    `当前目标：「${target}」`,
    "",
    continuation,
  ].join("\n");
}
