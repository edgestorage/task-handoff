import type { AiSessionTimelineActivity } from "@task-handoff/protocol/ai-sessions";

type ActivityLabelSource = Pick<AiSessionTimelineActivity, "activityKind" | "title">;
type ActivityTitleKey =
  | "command"
  | "fileChange"
  | "fileChanges"
  | "editFile"
  | "writeFile"
  | "read"
  | "readFile"
  | "search"
  | "searchFiles"
  | "findFiles"
  | "list"
  | "explored"
  | "reasoning"
  | "plan"
  | "hookPrompt"
  | "subAgentTask"
  | "spawnAgent"
  | "sendAgentInput"
  | "resumeAgent"
  | "waitForAgents"
  | "closeAgent"
  | "subAgentActivity"
  | "webSearch"
  | "viewImage"
  | "sleep"
  | "imageGeneration"
  | "enteredReviewMode"
  | "exitedReviewMode"
  | "contextCompaction"
  | "codexRetry"
  | "retry"
  | "fetchUrl"
  | "updateTasks"
  | "askUser"
  | "loadSkill"
  | "exitPlanMode"
  | "tool";
export type AiSessionActivityTitleTranslationKey = `sessions.timeline.activityTitle.${ActivityTitleKey}`;
type LabelTranslator = (key: AiSessionActivityTitleTranslationKey) => string;

const TITLE_KEYS: Record<string, ActivityTitleKey> = {
  Command: "command",
  "File change": "fileChange",
  "File changes": "fileChanges",
  "Edit file": "editFile",
  "Write file": "writeFile",
  Read: "read",
  "Read file": "readFile",
  Search: "search",
  "Search files": "searchFiles",
  "Find files": "findFiles",
  List: "list",
  Explored: "explored",
  Reasoning: "reasoning",
  Plan: "plan",
  "Hook prompt": "hookPrompt",
  "Sub-agent task": "subAgentTask",
  "Spawn agent": "spawnAgent",
  "Send agent input": "sendAgentInput",
  "Resume agent": "resumeAgent",
  "Wait for agents": "waitForAgents",
  "Close agent": "closeAgent",
  "Sub-agent activity": "subAgentActivity",
  "Web search": "webSearch",
  "View image": "viewImage",
  Sleep: "sleep",
  "Image generation": "imageGeneration",
  "Entered review mode": "enteredReviewMode",
  "Exited review mode": "exitedReviewMode",
  "Context compaction": "contextCompaction",
  "Codex retry": "codexRetry",
  Retry: "retry",
  "Fetch URL": "fetchUrl",
  "Update tasks": "updateTasks",
  "Ask user": "askUser",
  "Load skill": "loadSkill",
  "Exit plan mode": "exitPlanMode",
  Tool: "tool",
};

function titleKey(title: string | undefined) {
  return title ? TITLE_KEYS[title.trim()] : undefined;
}

function translationKey(key: ActivityTitleKey | undefined): AiSessionActivityTitleTranslationKey | undefined {
  return key ? `sessions.timeline.activityTitle.${key}` : undefined;
}

export function aiSessionActivityTitleKey(activity: ActivityLabelSource) {
  return translationKey(titleKey(activity.title));
}

export function aiSessionToolNameKey(name: string | undefined) {
  return translationKey(titleKey(name));
}

export function localizedAiSessionActivityTitle(activity: ActivityLabelSource, t: LabelTranslator) {
  const key = aiSessionActivityTitleKey(activity);
  return key ? t(key) : activity.title;
}

export function localizedAiSessionToolName(name: string, t: LabelTranslator) {
  const key = aiSessionToolNameKey(name);
  return key ? t(key) : name;
}
