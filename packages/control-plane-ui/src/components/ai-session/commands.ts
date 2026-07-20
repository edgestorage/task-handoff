import type { AiSessionCommandInput, AiSessionCommandName } from "@task-handoff/protocol/ai-sessions";

export type AiSessionCommandCandidate = {
  name: AiSessionCommandName;
  description: string;
  argumentHint?: string;
  requiresIdle?: boolean;
};

export const AI_SESSION_COMMANDS: AiSessionCommandCandidate[] = [
  { name: "review", description: "Review uncommitted changes", requiresIdle: true },
  { name: "rename", description: "Rename the current thread", argumentHint: "thread name" },
  { name: "goal", description: "Set or view the long-running goal", argumentHint: "objective" },
  { name: "compact", description: "Summarize conversation context", requiresIdle: true },
];

export function commandTokenAt(value: string, cursor: number, trigger: string) {
  if (!trigger || !value.startsWith(trigger) || cursor < trigger.length || cursor > value.length) return undefined;
  const beforeCursor = value.slice(trigger.length, cursor);
  if (/\s/.test(beforeCursor)) return undefined;
  let end = cursor;
  while (end < value.length && !/\s/.test(value[end] || "")) end += 1;
  return { start: 0, end, query: beforeCursor };
}

export function matchingCommands(query: string) {
  const normalized = query.trim().toLocaleLowerCase();
  return AI_SESSION_COMMANDS.filter((command) => !normalized || command.name.startsWith(normalized));
}

export function replaceCommandToken(value: string, cursor: number, trigger: string, command: AiSessionCommandCandidate) {
  const active = commandTokenAt(value, cursor, trigger);
  if (!active) return undefined;
  const inserted = `${trigger}${command.name}${command.argumentHint ? " " : ""}`;
  return { value: `${inserted}${value.slice(active.end)}`, cursor: inserted.length };
}

export function parseAiSessionCommand(value: string, trigger: string, provider: string | undefined): AiSessionCommandInput | undefined {
  if (provider !== "codex") return undefined;
  if (!trigger || !value.startsWith(trigger)) return undefined;
  const body = value.slice(trigger.length);
  const separator = body.search(/\s/);
  const name = (separator < 0 ? body : body.slice(0, separator)) as AiSessionCommandName;
  if (!AI_SESSION_COMMANDS.some((command) => command.name === name)) return undefined;
  const argument = separator < 0 ? "" : body.slice(separator).trim();
  return { command: name, ...(argument ? { argument } : {}) };
}
