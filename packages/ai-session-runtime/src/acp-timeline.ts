import type { ToolCallContent, ToolCallLocation, ToolCallStatus, ToolKind, ToolCallUpdate } from "@agentclientprotocol/sdk";
import type { AiSessionTimelineActivity } from "@task-handoff/protocol/ai-sessions";

type Activity = AiSessionTimelineActivity;

export type AcpToolSnapshot = {
  id: string;
  turnId: string;
  title: string;
  name?: string;
  kind?: ToolKind;
  status?: ToolCallStatus;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
};

type AcpFileChange = {
  path: string;
  kind?: string;
  movePath?: string;
  diff: string;
};

const MAX_TITLE = 240;
const MAX_SUMMARY = 4_000;
const MAX_INPUT = 100_000;
const MAX_OUTPUT = 1_000_000;
const MAX_PATHS = 500;
const MAX_PATH = 4_096;
const DIFF_CONTEXT = 3;

const DIRECTORY_KEYS = ["targetDirectory", "target_directory", "directory", "directoryPath", "directory_path", "dir"];
const FILE_KEYS = ["path", "filePath", "file_path", "file", "targetFile", "target_file", "filename"];
const SEARCH_PATH_KEYS = ["path", "directory", "dir", "cwd", "root"];
const SOURCE_KEYS = ["source", "from", "oldPath", "old_path", "path", "filePath", "file_path"];
const DESTINATION_KEYS = ["destination", "destinationPath", "destination_path", "to", "newPath", "new_path", "movePath", "move_path"];
const OLD_TEXT_KEYS = ["oldText", "old_text", "oldString", "old_string", "before"];
const NEW_TEXT_KEYS = ["newText", "new_text", "newString", "new_string", "after"];

export function mergeAcpToolSnapshot(
  previous: AcpToolSnapshot | undefined,
  update: ToolCallUpdate,
  fallback: { id: string; turnId: string },
): AcpToolSnapshot {
  const title = cleanText(update.title, MAX_TITLE);
  const name = cleanText(update.name, MAX_TITLE);
  return {
    id: previous?.id ?? fallback.id,
    turnId: previous?.turnId ?? fallback.turnId,
    title: title ?? previous?.title ?? "Tool call",
    ...(name ?? previous?.name ? { name: name ?? previous?.name } : {}),
    ...(update.kind ?? previous?.kind ? { kind: update.kind ?? previous?.kind } : {}),
    ...(update.status ?? previous?.status ? { status: update.status ?? previous?.status } : {}),
    ...(Array.isArray(update.content) ? { content: update.content } : previous?.content ? { content: previous.content } : {}),
    ...(Array.isArray(update.locations) ? { locations: update.locations } : previous?.locations ? { locations: previous.locations } : {}),
    ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : previous?.rawInput !== undefined ? { rawInput: previous.rawInput } : {}),
    ...(update.rawOutput !== undefined ? { rawOutput: update.rawOutput } : previous?.rawOutput !== undefined ? { rawOutput: previous.rawOutput } : {}),
  };
}

export function projectAcpToolActivity(snapshot: AcpToolSnapshot): Activity {
  const kind = snapshot.kind ?? "other";
  const paths = activityPaths(snapshot);
  const text = toolOutputText(snapshot, kind === "other" || kind === "switch_mode");
  if (isListTool(snapshot, kind)) return fileListActivity(snapshot, paths, text);

  switch (kind) {
    case "read": {
      const path = filePath(snapshot) ?? paths[0];
      return compactActivity({
        base: snapshot,
        activityKind: "fileRead",
        title: "Read",
        summary: path ? runtimePathBasename(path) : undefined,
        output: text,
        paths: path ? [path] : paths,
      });
    }
    case "edit":
    case "delete":
    case "move":
      return fileChangeActivity(snapshot, paths, text);
    case "search": {
      const query = rawString(snapshot.rawInput, ["query", "pattern", "regex", "search"]);
      const path = rawString(snapshot.rawInput, SEARCH_PATH_KEYS) ?? paths[0];
      return compactActivity({
        base: snapshot,
        activityKind: "fileSearch",
        title: "Search",
        summary: query ? (path ? `${query} in ${path}` : query) : path ?? cleanText(snapshot.title, MAX_SUMMARY),
        output: text,
        paths,
      });
    }
    case "execute": {
      const command = commandText(snapshot);
      return compactActivity({
        base: snapshot,
        activityKind: "commandExecution",
        title: "Command",
        input: command,
        output: text,
        exitCode: outputExitCode(snapshot.rawOutput),
      });
    }
    case "fetch": {
      const url = rawString(snapshot.rawInput, ["url", "href"]) ?? cleanText(snapshot.title, MAX_SUMMARY);
      return compactActivity({
        base: snapshot,
        activityKind: "webFetch",
        title: "Fetch URL",
        summary: url,
        output: text,
      });
    }
    case "think":
      return compactActivity({ base: snapshot, activityKind: "reasoning", title: "Reasoning", output: text });
    default:
      return compactActivity({
        base: snapshot,
        activityKind: "dynamicToolCall",
        title: cleanText(snapshot.title, MAX_TITLE) ?? cleanText(snapshot.name, MAX_TITLE) ?? "Tool",
        input: rawInputText(snapshot.rawInput),
        output: text,
        paths,
      });
  }
}

function fileListActivity(snapshot: AcpToolSnapshot, paths: string[], output: string | undefined): Activity {
  const path = listPath(snapshot) ?? paths[0];
  const listPaths = path ? [path] : paths;
  return compactActivity({
    base: snapshot,
    activityKind: "fileList",
    title: "List",
    summary: listPaths.join(", ") || cleanText(snapshot.title, MAX_SUMMARY),
    output,
    paths: listPaths,
  });
}

function fileChangeActivity(snapshot: AcpToolSnapshot, paths: string[], text: string | undefined): Activity {
  const changes = fileChanges(snapshot);
  const changePaths = uniqueStrings([...changes.map((change) => change.path), ...paths]);
  return compactActivity({
    base: snapshot,
    activityKind: "fileChange",
    title: "File change",
    summary: changePaths.map(runtimePathBasename).join(", ") || cleanText(snapshot.title, MAX_SUMMARY),
    output: changes.length ? safeJson(changes) : text,
    paths: changePaths,
  });
}

function compactActivity(input: {
  base: AcpToolSnapshot;
  activityKind: string;
  title: string;
  summary?: string;
  input?: string;
  output?: string;
  paths?: string[];
  exitCode?: number;
}): Activity {
  const item: Activity = {
    type: "activity",
    id: input.base.id,
    turnId: input.base.turnId,
    activityKind: input.activityKind,
    title: cleanText(input.title, MAX_TITLE) ?? "Tool call",
    status: activityStatus(input.base.status),
  };
  const summary = cleanText(input.summary, MAX_SUMMARY);
  const command = nonEmptyText(input.input, MAX_INPUT);
  const output = nonEmptyText(input.output, MAX_OUTPUT);
  const paths = normalizePaths(input.paths);
  if (summary) item.summary = summary;
  if (command) item.input = command;
  if (output) item.output = output;
  if (paths.length) item.paths = paths;
  if (input.exitCode !== undefined) item.exitCode = input.exitCode;
  return item;
}

function activityStatus(status: ToolCallStatus | undefined): Activity["status"] {
  if (status === "in_progress") return "running";
  if (status === "pending" || status === undefined) return "waiting";
  return status;
}

function isListTool(snapshot: AcpToolSnapshot, kind: ToolKind) {
  if (kind !== "read" && kind !== "other") return false;
  const name = normalizeToolName(snapshot.name);
  if (name === "ls" || name === "dir" || name === "directory" || name === "readdir" || name === "list" || name.includes("list")) return true;
  if (DIRECTORY_KEYS.some((key) => rawString(snapshot.rawInput, [key]))) return true;
  return listTitlePath(snapshot.title) !== undefined;
}

function listPath(snapshot: AcpToolSnapshot) {
  return rawString(snapshot.rawInput, DIRECTORY_KEYS)
    ?? rawString(snapshot.rawInput, FILE_KEYS)
    ?? locationPaths(snapshot.locations)[0]
    ?? listTitlePath(snapshot.title);
}

function listTitlePath(title: string) {
  const match = title.trim().match(/^(?:list|ls|dir|directory)(?:\s*:\s*|\s+)(.+)$/i);
  return match ? cleanPath(match[1]) : undefined;
}

function filePath(snapshot: AcpToolSnapshot) {
  return rawString(snapshot.rawInput, FILE_KEYS) ?? locationPaths(snapshot.locations)[0];
}

function commandText(snapshot: AcpToolSnapshot) {
  const raw = asRecord(snapshot.rawInput);
  const command = rawString(snapshot.rawInput, ["command", "cmd"]);
  if (!command) return cleanText(snapshot.title, MAX_INPUT) ?? "Command";
  const args = raw ? recordValue(raw, ["args", "arguments"]) : undefined;
  const suffix = Array.isArray(args)
    ? args.flatMap((value) => typeof value === "string" || typeof value === "number" ? [String(value)] : []).join(" ")
    : "";
  return nonEmptyText(suffix ? `${command} ${suffix}` : command, MAX_INPUT);
}

function toolOutputText(snapshot: AcpToolSnapshot, allowJsonFallback: boolean) {
  return contentText(snapshot.content) ?? unknownText(snapshot.rawOutput, allowJsonFallback);
}

function contentText(content: ToolCallContent[] | undefined) {
  const text = content?.flatMap((entry) => entry.type === "content" && entry.content.type === "text" ? [entry.content.text] : []).join("\n");
  return nonEmptyText(text, MAX_OUTPUT);
}

function fileChanges(snapshot: AcpToolSnapshot): AcpFileChange[] {
  const changes: AcpFileChange[] = [];
  for (const entry of snapshot.content ?? []) {
    if (entry.type !== "diff") continue;
    const path = cleanPath(entry.path);
    if (!path) continue;
    const kind = entry.oldText == null ? "add" : entry.newText === "" ? "delete" : "update";
    changes.push({ path, kind, diff: unifiedDiff(entry.oldText ?? null, entry.newText) });
  }
  if (changes.length) return uniqueChanges(changes);

  const paths = activityPaths(snapshot);
  const raw = snapshot.rawInput;
  if (snapshot.kind === "delete") {
    const path = rawString(raw, FILE_KEYS) ?? paths[0];
    return path ? [{ path, kind: "delete", diff: "" }] : [];
  }
  if (snapshot.kind === "move") {
    const path = rawString(raw, SOURCE_KEYS) ?? paths[0];
    if (!path) return [];
    const movePath = rawString(raw, DESTINATION_KEYS) ?? paths.find((candidate) => candidate !== path);
    return [{ path, kind: "move", diff: "", ...(movePath ? { movePath } : {}) }];
  }
  if (snapshot.kind === "edit") {
    const path = rawString(raw, FILE_KEYS) ?? paths[0];
    const oldText = rawString(raw, OLD_TEXT_KEYS);
    const newText = rawString(raw, NEW_TEXT_KEYS);
    if (path && oldText !== undefined && newText !== undefined) {
      return [{ path, kind: "update", diff: unifiedDiff(oldText, newText) }];
    }
  }
  return [];
}

function uniqueChanges(changes: AcpFileChange[]) {
  const seen = new Set<string>();
  return changes.filter((change) => {
    const key = `${change.path}\0${change.movePath ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function unifiedDiff(oldText: string | null, newText: string) {
  const oldLines = splitLines(oldText ?? "");
  const newLines = splitLines(newText);
  if (oldText !== null && oldLines.length === newLines.length && oldLines.every((line, index) => line === newLines[index])) return "";
  if (oldText === null && !newLines.length) return "";

  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix += 1;

  const oldStart = Math.max(0, prefix - DIFF_CONTEXT);
  const newStart = oldStart;
  const oldEnd = Math.min(oldLines.length, oldLines.length - suffix + DIFF_CONTEXT);
  const newEnd = Math.min(newLines.length, newLines.length - suffix + DIFF_CONTEXT);
  const oldCount = oldEnd - oldStart;
  const newCount = newEnd - newStart;
  const header = oldLines.length === 0
    ? `@@ -0,0 +1,${newLines.length} @@`
    : newLines.length === 0
      ? `@@ -1,${oldLines.length} +0,0 @@`
      : `@@ -${oldStart + 1},${oldCount} +${newStart + 1},${newCount} @@`;
  const body: string[] = [];
  for (let index = oldStart; index < prefix; index += 1) body.push(` ${oldLines[index]}`);
  for (let index = prefix; index < oldEnd - suffix; index += 1) body.push(`-${oldLines[index]}`);
  for (let index = prefix; index < newEnd - suffix; index += 1) body.push(`+${newLines[index]}`);
  for (let index = oldEnd - suffix; index < oldEnd; index += 1) body.push(` ${oldLines[index]}`);
  return [header, ...body].join("\n");
}

function splitLines(value: string) {
  const lines = value.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function activityPaths(snapshot: AcpToolSnapshot) {
  return normalizePaths([
    ...locationPaths(snapshot.locations),
    ...FILE_KEYS.map((key) => rawString(snapshot.rawInput, [key])).filter((path): path is string => Boolean(path)),
  ]);
}

function locationPaths(locations: ToolCallLocation[] | undefined) {
  return normalizePaths(locations?.map((location) => location.path) ?? []);
}

function normalizePaths(paths: string[] | undefined) {
  return uniqueStrings((paths ?? []).map(cleanPath).filter((path): path is string => Boolean(path)))
    .slice(0, MAX_PATHS)
    .map((path) => takeCodePoints(path, MAX_PATH));
}

function cleanPath(path: string | undefined) {
  if (typeof path !== "string") return undefined;
  const trimmed = path.trim().replace(/^`+|`+$/g, "").trim();
  return trimmed || undefined;
}

function rawString(value: unknown, keys: string[]) {
  if (typeof value === "string") return cleanText(value, MAX_SUMMARY);
  const record = asRecord(value);
  if (!record) return undefined;
  const field = recordValue(record, keys);
  if (typeof field === "string") return cleanText(field, MAX_SUMMARY);
  if (typeof field === "number" || typeof field === "boolean") return String(field);
  return undefined;
}

function rawInputText(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value === "string") return nonEmptyText(value, MAX_INPUT);
  return nonEmptyText(safeJson(value), MAX_INPUT);
}

function unknownText(value: unknown, allowJsonFallback: boolean, depth = 0): string | undefined {
  if (value == null || depth > 4) return undefined;
  if (typeof value === "string") return nonEmptyText(value, MAX_OUTPUT);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const text = value.map((entry) => unknownText(entry, false, depth + 1)).filter(Boolean).join("\n");
    return nonEmptyText(text, MAX_OUTPUT) ?? (allowJsonFallback ? nonEmptyText(safeJson(value), MAX_OUTPUT) : undefined);
  }
  const record = asRecord(value);
  if (!record) return undefined;
  const stdout = rawString(record, ["stdout"]);
  const stderr = rawString(record, ["stderr"]);
  if (stdout || stderr) return nonEmptyText([stdout, stderr].filter(Boolean).join("\n"), MAX_OUTPUT);
  for (const key of ["output", "text", "content", "result", "message", "error", "value"]) {
    const nested = recordValue(record, [key]);
    const text = unknownText(nested, false, depth + 1);
    if (text) return text;
  }
  return allowJsonFallback ? nonEmptyText(safeJson(record), MAX_OUTPUT) : undefined;
}

function outputExitCode(value: unknown, depth = 0): number | undefined {
  if (value == null || depth > 4) return undefined;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = outputExitCode(entry, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  const direct = recordValue(record, ["exitCode", "exit_code", "code", "statusCode", "status_code"]);
  if (typeof direct === "number" && Number.isInteger(direct)) return direct;
  if (typeof direct === "string" && /^-?\d+$/.test(direct.trim())) return Number(direct);
  for (const nested of Object.values(record)) {
    const found = outputExitCode(nested, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function recordValue(record: Record<string, unknown>, keys: string[]) {
  const entries = Object.entries(record).map(([key, value]) => [normalizeKey(key), value] as const);
  for (const key of keys) {
    const match = entries.find(([candidate]) => candidate === normalizeKey(key));
    if (match) return match[1];
  }
  return undefined;
}

function normalizeKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeToolName(value: string | undefined) {
  return value ? normalizeKey(value) : "";
}

function runtimePathBasename(path: string) {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || path;
}

function cleanText(value: string | null | undefined, limit: number) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? takeCodePoints(trimmed, limit) : undefined;
}

function nonEmptyText(value: string | undefined, limit: number) {
  return value?.trim() ? takeCodePoints(value, limit) : undefined;
}

function takeCodePoints(value: string, limit: number) {
  if (value.length <= limit) return value;
  const characters: string[] = [];
  for (const character of value) {
    if (characters.length >= limit) break;
    characters.push(character);
  }
  return characters.join("");
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}

function safeJson(value: unknown) {
  if (value === undefined) return undefined;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? undefined : json;
  } catch {
    return String(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
