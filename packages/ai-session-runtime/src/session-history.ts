import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type HistoricalSessionAgent = "codex" | "claude";

type HistoricalSession = {
  agent: HistoricalSessionAgent;
  sessionId: string;
  cwd: string;
  updatedAt: string;
  transcriptPath: string;
  title?: string;
};

type HistoricalSessionOptions = {
  cwd?: string;
  agent?: HistoricalSessionAgent;
  codexHome?: string;
  claudeHome?: string;
  limit?: number;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function compact(value: unknown, max = 120) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function parseJsonLine(line: string) {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function readHeadLines(filePath: string, maxLines = 80) {
  try {
    return fs.readFileSync(filePath, "utf8").split(/\r?\n/).slice(0, maxLines);
  } catch {
    return [];
  }
}

function fileUpdatedAt(filePath: string) {
  try {
    return fs.statSync(filePath).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function walkJsonlFiles(root: string, maxFiles = 2000) {
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0 && files.length < maxFiles) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(entryPath);
      }
    }
  }
  return files;
}

function firstCodexUserPrompt(lines: string[]) {
  for (const line of lines) {
    const event = asRecord(parseJsonLine(line));
    if (event.type !== "response_item") {
      continue;
    }
    const payload = asRecord(event.payload);
    if (payload.type !== "message" || payload.role !== "user") {
      continue;
    }
    const content = payload.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      const item = asRecord(part);
      const text = compact(item.text);
      if (text) {
        return text;
      }
    }
  }
  return "";
}

function codexSessionIdFromPath(filePath: string) {
  return path.basename(filePath).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/)?.[1];
}

function codexSessionFromFile(filePath: string, cwd: string): HistoricalSession | undefined {
  const lines = readHeadLines(filePath);
  for (const line of lines) {
    const event = asRecord(parseJsonLine(line));
    if (event.type !== "session_meta") {
      continue;
    }
    const payload = asRecord(event.payload);
    if (!payload.cwd) {
      return undefined;
    }
    const sessionCwd = path.resolve(String(payload.cwd || ""));
    if (sessionCwd !== cwd) {
      return undefined;
    }
    const sessionId = compact(payload.id || codexSessionIdFromPath(filePath), 200);
    if (!sessionId) {
      return undefined;
    }
    return {
      agent: "codex",
      sessionId,
      cwd: sessionCwd,
      updatedAt: fileUpdatedAt(filePath),
      transcriptPath: filePath,
      title: firstCodexUserPrompt(lines),
    };
  }
  return undefined;
}

function claudeProjectDirName(cwd: string) {
  return path.resolve(cwd).split(path.sep).join("-");
}

function firstClaudeUserPrompt(lines: string[]) {
  for (const line of lines) {
    const event = asRecord(parseJsonLine(line));
    if (event.type !== "user") {
      continue;
    }
    const message = asRecord(event.message);
    const content = message.content;
    if (typeof content === "string") {
      const text = compact(content);
      if (text) {
        return text;
      }
    }
  }
  return "";
}

function claudeSessionFromFile(filePath: string, cwd: string): HistoricalSession | undefined {
  const sessionId = path.basename(filePath, ".jsonl");
  if (!sessionId) {
    return undefined;
  }
  const lines = readHeadLines(filePath);
  return {
    agent: "claude",
    sessionId,
    cwd,
    updatedAt: fileUpdatedAt(filePath),
    transcriptPath: filePath,
    title: firstClaudeUserPrompt(lines),
  };
}

function listCodexSessionsForCwd(cwd: string, codexHome = path.join(os.homedir(), ".codex")) {
  return walkJsonlFiles(path.join(codexHome, "sessions"))
    .map((filePath) => codexSessionFromFile(filePath, cwd))
    .filter((session): session is HistoricalSession => Boolean(session));
}

function listClaudeSessionsForCwd(cwd: string, claudeHome = path.join(os.homedir(), ".claude")) {
  const projectDir = path.join(claudeHome, "projects", claudeProjectDirName(cwd));
  return walkJsonlFiles(projectDir)
    .map((filePath) => claudeSessionFromFile(filePath, cwd))
    .filter((session): session is HistoricalSession => Boolean(session));
}

function listHistoricalSessions({
  cwd = process.cwd(),
  agent,
  codexHome,
  claudeHome,
  limit = 20,
}: HistoricalSessionOptions = {}) {
  const resolvedCwd = path.resolve(cwd);
  const sessions = [
    ...(agent === undefined || agent === "codex" ? listCodexSessionsForCwd(resolvedCwd, codexHome) : []),
    ...(agent === undefined || agent === "claude" ? listClaudeSessionsForCwd(resolvedCwd, claudeHome) : []),
  ];
  return sessions
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, limit);
}

export {
  listHistoricalSessions,
  listCodexSessionsForCwd,
  listClaudeSessionsForCwd,
};
export type { HistoricalSession, HistoricalSessionAgent, HistoricalSessionOptions };
