import type { AiSessionTimelineActivity } from "@task-handoff/protocol/ai-sessions";

export type AiSessionFileChange = {
  path: string;
  movePath?: string;
  kind?: string;
  diff: string;
};

export type AiSessionDiffLine = {
  kind: "context" | "addition" | "deletion";
  content: string;
  oldLine?: number;
  newLine?: number;
};

const maxFiles = 200;
const maxRenderedLines = 5_000;

export function aiSessionFileChanges(activity: AiSessionTimelineActivity): AiSessionFileChange[] {
  if (activity.activityKind !== "fileChange") return [];
  const outputChanges = structuredChanges(activity.output);
  if (outputChanges.length) return outputChanges;
  const inputChanges = structuredChanges(activity.input);
  if (inputChanges.length) return inputChanges;
  const diff = activity.input?.trim();
  const path = activity.paths?.[0];
  return diff && path && looksLikeDiff(diff) ? [{ path, diff }] : [];
}

export function parseAiSessionDiff(diff: string): AiSessionDiffLine[] {
  const result: AiSessionDiffLine[] = [];
  let oldLine: number | undefined;
  let newLine: number | undefined;
  const rawLines = diff.split("\n");
  if (rawLines.at(-1) === "") rawLines.pop();
  for (const rawLine of rawLines) {
    if (result.length >= maxRenderedLines) break;
    const hunk = rawLine.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      continue;
    }
    if (isPatchMetadata(rawLine)) continue;
    if (rawLine.startsWith("+")) {
      result.push({ kind: "addition", content: rawLine.slice(1), ...(newLine === undefined ? {} : { newLine }) });
      if (newLine !== undefined) newLine += 1;
      continue;
    }
    if (rawLine.startsWith("-")) {
      result.push({ kind: "deletion", content: rawLine.slice(1), ...(oldLine === undefined ? {} : { oldLine }) });
      if (oldLine !== undefined) oldLine += 1;
      continue;
    }
    if (oldLine === undefined || newLine === undefined) continue;
    result.push({ kind: "context", content: rawLine.startsWith(" ") ? rawLine.slice(1) : rawLine, oldLine, newLine });
    oldLine += 1;
    newLine += 1;
  }
  return result;
}

function structuredChanges(value: string | undefined) {
  if (!value) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(0, maxFiles).flatMap((raw): AiSessionFileChange[] => {
    if (!isRecord(raw)) return [];
    const path = stringField(raw, "path") || stringField(raw, "filePath") || stringField(raw, "relativePath");
    const diff = stringValue(raw.diff) ?? stringValue(raw.patch) ?? "";
    if (!path) return [];
    const rawKind = raw.kind;
    const kind = typeof rawKind === "string" ? rawKind : isRecord(rawKind) ? stringField(rawKind, "type") : stringField(raw, "type");
    const movePath = stringField(raw, "movePath") || stringField(raw, "move_path")
      || (isRecord(rawKind) ? stringField(rawKind, "move_path") || stringField(rawKind, "movePath") : undefined);
    return [{ path, diff, ...(kind ? { kind } : {}), ...(movePath ? { movePath } : {}) }];
  });
}

function looksLikeDiff(value: string) {
  return /(^|\n)(?:@@ |\+[^+]|-[^-])/.test(value);
}

function isPatchMetadata(line: string) {
  return line.startsWith("diff --git ") || line.startsWith("index ") || line.startsWith("--- ")
    || line.startsWith("+++ ") || line.startsWith("\\ No newline") || line.startsWith("@@@");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringField(value: Record<string, unknown>, key: string) {
  const field = value[key];
  return typeof field === "string" && field.trim() ? field : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}
