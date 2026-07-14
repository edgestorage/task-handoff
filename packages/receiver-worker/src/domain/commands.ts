type ReceiverCommand = {
  value: string;
  description: string;
  complete: string;
  executable?: boolean;
};

const COMMANDS: ReceiverCommand[] = [
  { value: "/help", description: "显示命令帮助", complete: "/help", executable: true },
  { value: "/status", description: "显示 receiver 状态", complete: "/status", executable: true },
  { value: "/conversation use <id>", description: "切换终端会话", complete: "/conversation use " },
  { value: "/conversation new", description: "创建被动会话", complete: "/conversation new", executable: true },
  { value: "/conversation new codex", description: "创建主动 Codex 会话", complete: "/conversation new codex", executable: true },
  { value: "/conversation new claude", description: "创建主动 Claude 会话", complete: "/conversation new claude", executable: true },
  { value: "/conversation mode <id> <passive|codex|claude>", description: "设置会话模式", complete: "/conversation mode " },
  { value: "/conversation cwd [id] <path>", description: "设置会话工作目录，默认当前会话", complete: "/conversation cwd " },
  { value: "/conversation list", description: "列出会话", complete: "/conversation list", executable: true },
  { value: "/conversation default <id>", description: "设置默认发送会话", complete: "/conversation default " },
  { value: "/conversation close <id>", description: "关闭会话但不删除", complete: "/conversation close " },
  { value: "/conversation delete [id]", description: "删除会话和相关绑定，默认当前会话", complete: "/conversation delete", executable: true },
  { value: "/conversation open <id>", description: "重新打开已关闭会话", complete: "/conversation open " },
  { value: "/conversation status", description: "显示会话状态", complete: "/conversation status", executable: true },
  { value: "/c use <id>", description: "切换终端会话", complete: "/c use " },
  { value: "/c new", description: "创建被动会话", complete: "/c new", executable: true },
  { value: "/c new codex", description: "创建主动 Codex 会话", complete: "/c new codex", executable: true },
  { value: "/c new claude", description: "创建主动 Claude 会话", complete: "/c new claude", executable: true },
  { value: "/c mode <id> <passive|codex|claude>", description: "设置会话模式", complete: "/c mode " },
  { value: "/c cwd [id] <path>", description: "设置会话工作目录，默认当前会话", complete: "/c cwd " },
  { value: "/c list", description: "列出会话", complete: "/c list", executable: true },
  { value: "/c delete [id]", description: "删除会话和相关绑定，默认当前会话", complete: "/c delete", executable: true },
  { value: "/timeout <duration>", description: "设置默认等待时间", complete: "/timeout " },
  { value: "/timeout reset", description: "重置等待时间为 1 小时", complete: "/timeout reset", executable: true },
  { value: "/list", description: "列出所有待处理任务", complete: "/list", executable: true },
  { value: "/history", description: "查看当前会话最新历史结果", complete: "/history", executable: true },
  { value: "/history <conversation-id> [index]", description: "查看指定会话历史结果", complete: "/history " },
  { value: "/h", description: "查看当前会话最新历史结果", complete: "/h", executable: true },
  { value: "/chat status", description: "显示聊天软件实例数量", complete: "/chat status", executable: true },
  { value: "/focus #id", description: "设置默认回复目标", complete: "/focus #" },
  { value: "/focus clear", description: "清除默认回复目标", complete: "/focus clear", executable: true },
  { value: "/drop #id", description: "丢弃待处理任务并返回 continue", complete: "/drop #" },
  { value: "/approve #id", description: "批准权限请求", complete: "/approve #" },
  { value: "/deny #id", description: "拒绝权限请求", complete: "/deny #" },
  { value: "/skip #id", description: "跳过 task-handoff 审批交回 Codex", complete: "/skip #" },
  { value: "/auto-approve <on|off|status> [conversation-id]", description: "为当前或指定会话自动批准权限请求", complete: "/auto-approve " },
  { value: "/aa <on|off|status> [conversation-id]", description: "自动批准权限请求快捷命令", complete: "/aa " },
  { value: "/cancel", description: "取消当前主动 Codex/Claude 执行", complete: "/cancel", executable: true },
  { value: "/cancel <conversation-id>", description: "取消指定主动会话执行", complete: "/cancel " },
  { value: "/session", description: "列出当前目录历史 Codex/Claude session", complete: "/session", executable: true },
  { value: "/session codex", description: "列出当前目录历史 Codex session", complete: "/session codex", executable: true },
  { value: "/session claude", description: "列出当前目录历史 Claude session", complete: "/session claude", executable: true },
  { value: "/session new", description: "为当前主动 Codex/Claude 会话开启新 session", complete: "/session new", executable: true },
  { value: "/session new <conversation-id>", description: "为指定主动会话开启新 session", complete: "/session new " },
  { value: "/target <markdown>", description: "设置超时自动回复", complete: "/target " },
  { value: "/target clear", description: "清除超时自动回复", complete: "/target clear", executable: true },
  { value: "/reply <markdown>", description: "回复当前或最早任务", complete: "/reply " },
  { value: "/reply #id <markdown>", description: "回复指定任务", complete: "/reply #" },
  { value: "/telegram status", description: "显示 Telegram 状态", complete: "/telegram status", executable: true },
  { value: "/telegram bind <token> [chat]", description: "绑定 Telegram bot", complete: "/telegram bind " },
  { value: "/telegram chat <chat-id>", description: "设置 Telegram chat id", complete: "/telegram chat " },
  { value: "/telegram conversation <id>", description: "绑定 Telegram 到会话", complete: "/telegram conversation " },
  { value: "/telegram on", description: "启用 Telegram 轮询", complete: "/telegram on", executable: true },
  { value: "/telegram off", description: "停用 Telegram 轮询", complete: "/telegram off", executable: true },
  { value: "/telegram unbind", description: "解除 Telegram 绑定", complete: "/telegram unbind", executable: true },
  { value: "/wechat status", description: "显示 Wechat 状态", complete: "/wechat status", executable: true },
  { value: "/wechat login", description: "用二维码登录 Wechat", complete: "/wechat login", executable: true },
  { value: "/wechat bind <token>", description: "绑定 Wechat token", complete: "/wechat bind " },
  { value: "/wechat chat <chat-id>", description: "设置 Wechat chat id", complete: "/wechat chat " },
  { value: "/wechat conversation <id>", description: "绑定 Wechat 到会话", complete: "/wechat conversation " },
  { value: "/wechat context <token>", description: "设置 Wechat context token", complete: "/wechat context " },
  { value: "/wechat on", description: "启用 Wechat 轮询", complete: "/wechat on", executable: true },
  { value: "/wechat off", description: "停用 Wechat 轮询", complete: "/wechat off", executable: true },
  { value: "/wechat unbind", description: "解除 Wechat 绑定", complete: "/wechat unbind", executable: true },
  { value: "/dingding status", description: "显示 DingDing 状态", complete: "/dingding status", executable: true },
  { value: "/dingding bind <client-id> <client-secret> [corp-id] [robot-code] [chat-id]", description: "绑定 DingDing Stream", complete: "/dingding bind " },
  { value: "/dingding chat <conversation-id>", description: "设置 DingDing chat id", complete: "/dingding chat " },
  { value: "/dingding conversation <id>", description: "绑定 DingDing 到会话", complete: "/dingding conversation " },
  { value: "/dingding on", description: "启用 DingDing stream", complete: "/dingding on", executable: true },
  { value: "/dingding off", description: "停用 DingDing stream", complete: "/dingding off", executable: true },
  { value: "/dingding unbind", description: "解除 DingDing 绑定", complete: "/dingding unbind", executable: true },
  { value: "/ding status", description: "显示 DingDing 状态", complete: "/ding status", executable: true },
  { value: "/restart", description: "重启 receiver", complete: "/restart", executable: true },
  { value: "/quit", description: "停止 receiver", complete: "/quit", executable: true },
];

const SUGGESTION_WINDOW_SIZE = 6;

function formatCommandHelp() {
  const valueWidth = Math.max(...COMMANDS.map((command) => command.value.length));
  return ["命令：", ...COMMANDS.map((command) => `${command.value.padEnd(valueWidth)}  ${command.description}`)].join("\n");
}

function commandMatches(input: string, command: ReceiverCommand) {
  const query = input.trim().toLowerCase();
  if (!query.startsWith("/")) {
    return false;
  }
  const value = command.value.toLowerCase();
  const complete = command.complete.toLowerCase();
  const commandPrefix = value.split(/\s*<|\s*\[/)[0].trim();
  return (
    value.startsWith(query) ||
    complete.startsWith(query) ||
    (commandPrefix && query.startsWith(`${commandPrefix} `))
  );
}

function getArgumentEntryCommand(input: string) {
  return COMMANDS.find((command) => !command.executable && input.startsWith(command.complete));
}

function getCommandSuggestions(input: string) {
  if (!input.startsWith("/")) {
    return [];
  }
  if (getArgumentEntryCommand(input)) {
    return [];
  }
  return COMMANDS.filter((command) => commandMatches(input, command));
}

function getSuggestionWindow(suggestions: ReceiverCommand[], selectedIndex: number) {
  const start = Math.min(
    Math.max(0, selectedIndex - Math.floor(SUGGESTION_WINDOW_SIZE / 2)),
    Math.max(0, suggestions.length - SUGGESTION_WINDOW_SIZE),
  );
  return {
    start,
    items: suggestions.slice(start, start + SUGGESTION_WINDOW_SIZE),
  };
}

function hasCommandArguments(rawInput: string, command: ReceiverCommand) {
  if (command.executable) {
    return true;
  }
  return rawInput.startsWith(command.complete) && rawInput.slice(command.complete.length).trim().length > 0;
}

function shouldCompleteCommand(rawInput: string, command?: ReceiverCommand) {
  if (!command) {
    return false;
  }
  if (rawInput === command.complete) {
    return false;
  }
  return command.complete.startsWith(rawInput.trimEnd());
}

export {
  COMMANDS,
  formatCommandHelp,
  getArgumentEntryCommand,
  getCommandSuggestions,
  getSuggestionWindow,
  hasCommandArguments,
  shouldCompleteCommand,
};

export type { ReceiverCommand };
