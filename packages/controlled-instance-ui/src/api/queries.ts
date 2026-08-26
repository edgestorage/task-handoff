import { useQuery } from "@tanstack/vue-query";
import { computed, unref, type MaybeRef } from "vue";
import { ApiError, deleteApiData, getApiData, patchApiData, postApiData } from "./client";
import { useAuthStore } from "../stores/auth";
import type {
  AppCatalogItem,
  AppAutomationStatus,
  AppLaunchOptions,
  AppSession,
  AppSessionsSnapshot,
  AppSessionLogs,
  AiSessionStatus,
  AiSessionTranscriptTail,
  AiSessionsSnapshot,
  AuthStatusResponse,
  CustomAppCatalog,
  DiagnosticsResponse,
  StatusResponse,
  TriggerCreateInput,
  TriggerIndex,
} from "./types";

function protectedQueryEnabled(extraEnabled: MaybeRef<boolean> = true) {
  const auth = useAuthStore();
  const authStatus = useAuthStatusQuery();
  return computed(() => {
    if (!unref(extraEnabled) || !authStatus.data.value) {
      return false;
    }
    return !authStatus.data.value.enabled || Boolean(auth.token);
  });
}

function retryUnlessUnauthorized(failureCount: number, error: Error) {
  return !(error instanceof ApiError && error.status === 401) && failureCount < 3;
}

export function useStatusQuery() {
  return useQuery({
    queryKey: ["status"],
    queryFn: () => getApiData<StatusResponse>("status"),
    enabled: protectedQueryEnabled(),
    refetchInterval: 10_000,
    retry: retryUnlessUnauthorized,
  });
}

export function useAuthStatusQuery() {
  return useQuery({
    queryKey: ["auth-status"],
    queryFn: () => getApiData<AuthStatusResponse>("auth/status"),
  });
}

export function useDiagnosticsQuery() {
  return useQuery({
    queryKey: ["diagnostics"],
    queryFn: () => getApiData<DiagnosticsResponse>("diagnostics"),
    enabled: protectedQueryEnabled(),
    refetchInterval: 15_000,
    retry: retryUnlessUnauthorized,
  });
}

export function useAppCatalogQuery() {
  return useQuery({
    queryKey: ["app-catalog"],
    queryFn: () => getApiData<AppCatalogItem[]>("apps/catalog"),
    enabled: protectedQueryEnabled(),
    retry: retryUnlessUnauthorized,
  });
}

export function useCustomAppCatalogQuery() {
  return useQuery({
    queryKey: ["app-catalog-custom"],
    queryFn: () => getApiData<CustomAppCatalog>("apps/catalog/custom"),
    enabled: protectedQueryEnabled(),
    retry: false,
  });
}

export function saveCustomAppCatalog(items: AppCatalogItem[]) {
  return patchApiData<CustomAppCatalog>("apps/catalog/custom", { items });
}

export function useAppSessionsQuery() {
  return useQuery({
    queryKey: ["app-sessions"],
    queryFn: async () => (await getApiData<{ snapshot: AppSessionsSnapshot }>("apps/sessions")).snapshot.sessions,
    enabled: protectedQueryEnabled(),
    retry: retryUnlessUnauthorized,
  });
}

export function useAiSessionsQuery() {
  return useQuery({
    queryKey: ["ai-sessions"],
    queryFn: async () => (await getApiData<{ snapshot: AiSessionsSnapshot }>("ai-sessions")).snapshot,
    enabled: protectedQueryEnabled(),
    retry: retryUnlessUnauthorized,
  });
}

export function useAiSessionQuery(id: MaybeRef<string>) {
  return useQuery({
    queryKey: computed(() => ["ai-session", unref(id)]),
    queryFn: () => getApiData<AiSessionStatus>(`ai-sessions/${unref(id)}`),
    enabled: protectedQueryEnabled(computed(() => Boolean(unref(id)))),
    retry: retryUnlessUnauthorized,
  });
}

export function useAiSessionTranscriptQuery(id: MaybeRef<string>, enabled: MaybeRef<boolean> = true) {
  return useQuery({
    queryKey: computed(() => ["ai-session-transcript", unref(id)]),
    queryFn: () => getApiData<AiSessionTranscriptTail>(`ai-sessions/${unref(id)}/transcript`),
    enabled: protectedQueryEnabled(computed(() => Boolean(unref(id)) && Boolean(unref(enabled)))),
    refetchInterval: 5_000,
    retry: false,
  });
}

export function sendAiSessionMessage(id: string, message: string, mode?: "auto" | "queue" | "steer" | "immediate") {
  return postApiData<{ session: AiSessionStatus; provider: string; action: "send" | "queue" | "steer"; turnId?: string; providerTurnId?: string; queueId?: string }>(`ai-sessions/${id}/messages`, { message, mode });
}

export function steerAiSessionQueuedMessage(id: string, queueId: string) {
  return postApiData<{ session: AiSessionStatus; provider: string; action: "steer"; turnId?: string; providerTurnId?: string; queueId?: string }>(`ai-sessions/${id}/queue/${queueId}/steer`);
}

export function retryAiSessionQueuedMessage(id: string, queueId: string) {
  return postApiData<{ sessionId: string; queueRevision: number; action: "retry"; queueId: string }>(`ai-sessions/${id}/queue/${queueId}/retry`);
}

export function removeAiSessionQueuedMessage(id: string, queueId: string) {
  return deleteApiData<{ sessionId: string; queueRevision: number; action: "remove"; queueId: string }>(`ai-sessions/${id}/queue/${queueId}`);
}

export function resolveAiSessionApproval(id: string, decision: "allow" | "deny" | "skip") {
  return postApiData<{ session: AiSessionStatus; provider: string; action: "approval"; decision: "allow" | "deny" | "skip"; providerTurnId?: string }>(
    `ai-sessions/${id}/approval`,
    { decision },
  );
}

export function useTriggersQuery() {
  return useQuery({
    queryKey: ["triggers"],
    queryFn: () => getApiData<TriggerIndex>("triggers"),
    enabled: protectedQueryEnabled(),
    retry: retryUnlessUnauthorized,
  });
}

export function createTrigger(input: TriggerCreateInput) {
  return postApiData("triggers", input);
}

export function enableTrigger(configHash: string) {
  return postApiData(`triggers/${configHash}/enable`);
}

export function disableTrigger(configHash: string) {
  return postApiData(`triggers/${configHash}/disable`);
}

export function runTrigger(configHash: string, promptOverride?: string) {
  return postApiData(`triggers/${configHash}/run`, promptOverride ? { promptOverride } : {});
}

export function deleteTrigger(configHash: string) {
  return deleteApiData(`triggers/${configHash}`);
}

export function interruptAiSession(id: string) {
  return postApiData<{ session: AiSessionStatus; provider: string; action: "interrupt"; providerTurnId?: string }>(`ai-sessions/${id}/interrupt`);
}

export function useAppSessionLogsQuery(sessionId: string) {
  return useQuery({
    queryKey: ["app-session-logs", sessionId],
    queryFn: () => getApiData<AppSessionLogs>(`apps/sessions/${sessionId}/logs`),
    enabled: protectedQueryEnabled(Boolean(sessionId)),
    refetchInterval: 5_000,
    retry: retryUnlessUnauthorized,
  });
}

export function useAppAutomationStatusQuery(sessionId: string, enabled = true) {
  return useQuery({
    queryKey: ["app-session-automation", sessionId],
    queryFn: () => getApiData<AppAutomationStatus>(`apps/sessions/${sessionId}/automation`),
    enabled: protectedQueryEnabled(Boolean(sessionId) && enabled),
    refetchInterval: 5_000,
    retry: false,
  });
}

export function startAppSession(appId: string, options: AppLaunchOptions = {}) {
  return postApiData<AppSession>("apps/sessions", { appId, ...options });
}

export function stopAppSession(sessionId: string) {
  return postApiData<AppSession>(`apps/sessions/${sessionId}/stop`);
}

export function restartAppSession(sessionId: string) {
  return postApiData<AppSession>(`apps/sessions/${sessionId}/restart`);
}

export function renameAppSession(sessionId: string, title: string) {
  return patchApiData<AppSession>(`apps/sessions/${sessionId}`, { title });
}

export function resizeAppSessionDisplay(sessionId: string, display: NonNullable<AppLaunchOptions["display"]>) {
  return postApiData<AppSession>(`apps/sessions/${sessionId}/display`, display);
}

export function deleteAppSession(sessionId: string) {
  return deleteApiData<AppSession>(`apps/sessions/${sessionId}`);
}
