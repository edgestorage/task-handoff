import { compactChatLabel, createSingleColumnKeyboard } from "@task-handoff/core/core/chat-interactions";
import type { ControlledInstance, PendingRoute, Project } from "@task-handoff/protocol/control-plane";
import { appSessionBindingKeys } from "@task-handoff/protocol/app-sessions";
import { isVisibleAppSessionStatus } from "./app-session-visibility.ts";

type AppSessionRecord = Record<string, unknown>;
type BoardAiSession = NonNullable<ControlledInstance["aiSessions"]>["sessions"][number];
export type BoardInstanceWithAiSessions = {
  id: string;
  name: string;
  projectId?: string;
  sourceSnapshot: Record<string, unknown>;
  project?: { name?: string };
  apps?: { sessions?: unknown[] };
  aiSessions?: ControlledInstance["aiSessions"];
};

export type AiSessionChoice = {
  index: number;
  projectName: string;
  instance: BoardInstanceWithAiSessions;
  session: BoardAiSession;
  active: boolean;
};

export function visibleAiSessionsForBoardInstance(instance: BoardInstanceWithAiSessions) {
  return (instance.aiSessions?.sessions || []).filter((session) => aiSessionAppTabForBoardInstance(instance, session));
}

export function aiSessionPriority(session: BoardAiSession) {
  if (session.status === "waiting") return 4;
  if (session.status === "failed") return 3;
  if (session.status === "running") return 2;
  if (session.status === "idle") return 1;
  return 0;
}

export function aiSessionStableSortKey(session: BoardAiSession) {
  return [
    session.cwd || "",
    session.agent || "",
    session.providerSessionId || session.id,
  ].join("\u0000");
}

export function renderAiSessionChoiceLine(choice: AiSessionChoice) {
  const title = choice.session.userPrompt || choice.session.summary || choice.session.lastMessage || "";
  const marker = choice.active ? "* " : "";
  const phase = choice.session.phase && choice.session.phase !== "unknown" ? `/${choice.session.phase}` : "";
  return `${marker}${choice.index + 1}. ${choice.projectName} / ${choice.instance.name} - ${choice.session.agent} - ${choice.session.status}${phase} - ${choice.session.id}${title ? ` - ${title}` : ""}`;
}

export function aiSessionButtonText(choice: AiSessionChoice) {
  const title = choice.session.title || choice.session.userPrompt || choice.session.summary || choice.session.lastMessage || "";
  const suffix = title ? ` - ${compactChatLabel(title, 18)}` : "";
  return `${choice.instance.name} - ${choice.session.agent} ${choice.session.status}${suffix}`;
}

export function pendingRoutesKeyboard(
  routes: Array<PendingRoute & { project?: Project; instance?: { id: string; name: string } }>,
  callbackData: (route: PendingRoute, decision: "allow" | "deny" | "skip") => string = (route, decision) => `task_handoff:approval:${route.id}:${decision}`,
) {
  return createSingleColumnKeyboard(routes.flatMap((route) => {
    if (route.kind !== "approval") {
      return [];
    }
    return [
      { text: compactChatLabel(`Allow ${route.instance?.name || route.instanceId} / ${route.aiSessionId}`, 56), callbackData: callbackData(route, "allow") },
      { text: compactChatLabel(`Skip ${route.instance?.name || route.instanceId} / ${route.aiSessionId}`, 56), callbackData: callbackData(route, "skip") },
      { text: compactChatLabel(`Deny ${route.instance?.name || route.instanceId} / ${route.aiSessionId}`, 56), callbackData: callbackData(route, "deny") },
    ];
  }));
}

export function renderPendingRouteLine(route: PendingRoute & { project?: Project; instance?: { id: string; name: string } }) {
  const target = `${route.project?.name || route.projectId} / ${route.instance?.name || route.instanceId}`;
  const command = route.kind === "approval" ? `/approve ${route.id} | /deny ${route.id} | /skip ${route.id}` : `/reply ${route.id} <message>`;
  return `[${target}] ${route.kind} ${route.id}: ${route.result}\n${command}`;
}

function aiSessionAppTabForBoardInstance(instance: BoardInstanceWithAiSessions, session: BoardAiSession) {
  const tabs = (instance.apps?.sessions || []).filter(isVisibleAppSessionRecord);
  if (session.appSessionId && tabs.some((tab) => tab.id === session.appSessionId)) {
    return true;
  }
  const bindingKeys = new Set(session.appBindingKeys || []);
  return Boolean(bindingKeys.size && tabs.some((tab) => appSessionBindingKeys(tab).some((key) => bindingKeys.has(key))));
}

function isVisibleAppSessionRecord(session: unknown): session is AppSessionRecord {
  const record = session && typeof session === "object" && !Array.isArray(session) ? session as AppSessionRecord : {};
  const status = typeof record.status === "string" ? record.status : undefined;
  return isVisibleAppSessionStatus(status);
}
