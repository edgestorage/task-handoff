import { useQueryClient } from "@tanstack/vue-query";
import { computed, onBeforeUnmount, ref, toValue, watch, type MaybeRefOrGetter } from "vue";
import type { AiSessionMentionCandidate, AiSessionMentionCatalog, AiSessionMentionDiagnostic } from "../../api/types";
import { getAiSessionMentionCatalog, searchAiSessionMentionFiles } from "../../api/queries";
import { sortMentionCandidates } from "./mentions";

export type AiSessionMentionContext = {
  instanceId: string;
  sessionId: string;
  provider: string;
  cwd: string;
};

export function useAiSessionMentions(context: MaybeRefOrGetter<AiSessionMentionContext | undefined>) {
  const queryClient = useQueryClient();
  const open = ref(false);
  const query = ref("");
  const catalog = ref<AiSessionMentionCatalog>();
  const fileCandidates = ref<AiSessionMentionCandidate[]>([]);
  const diagnostics = ref<AiSessionMentionDiagnostic[]>([]);
  const loadingCatalog = ref(false);
  const loadingFiles = ref(false);
  const error = ref("");
  let revision = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let fileController: AbortController | undefined;

  const candidates = computed(() => sortMentionCandidates([
    ...(catalog.value?.candidates || []),
    ...fileCandidates.value,
  ], query.value));

  async function show(nextQuery: string) {
    const current = toValue(context);
    if (!current || current.provider !== "codex" || !current.cwd) {
      close();
      return;
    }
    open.value = true;
    query.value = nextQuery;
    error.value = "";
    const requestRevision = ++revision;
    const signature = contextSignature(current);
    loadingCatalog.value = true;
    try {
      const nextCatalog = await queryClient.fetchQuery({
        queryKey: ["ai-session-mentions", current.instanceId, current.sessionId, current.provider, current.cwd],
        queryFn: ({ signal }) => getAiSessionMentionCatalog(current.instanceId, current.sessionId, signal),
        staleTime: 30_000,
      });
      if (!isCurrent(requestRevision, signature)) return;
      catalog.value = nextCatalog;
      diagnostics.value = nextCatalog.diagnostics;
    } catch (caught) {
      if (!isCurrent(requestRevision, signature)) return;
      error.value = caught instanceof Error ? caught.message : "Mention catalog unavailable.";
      catalog.value = undefined;
      diagnostics.value = [];
    } finally {
      if (isCurrent(requestRevision, signature)) loadingCatalog.value = false;
    }
    scheduleFileSearch(requestRevision, signature, nextQuery);
  }

  function scheduleFileSearch(requestRevision: number, signature: string, nextQuery: string) {
    if (debounceTimer) clearTimeout(debounceTimer);
    fileController?.abort();
    fileCandidates.value = [];
    loadingFiles.value = true;
    debounceTimer = setTimeout(async () => {
      const current = toValue(context);
      if (!current || !isCurrent(requestRevision, signature)) return;
      const controller = new AbortController();
      fileController = controller;
      try {
        const result = await searchAiSessionMentionFiles(current.instanceId, current.sessionId, nextQuery, controller.signal);
        if (isCurrent(requestRevision, signature) && result.query === nextQuery) fileCandidates.value = result.candidates;
      } catch (caught) {
        if (!controller.signal.aborted && isCurrent(requestRevision, signature)) {
          diagnostics.value = [...diagnostics.value.filter((item) => item.category !== "files"), {
            category: "files",
            code: "FILE_SEARCH_FAILED",
            message: caught instanceof Error ? caught.message : "File search unavailable.",
          }];
        }
      } finally {
        if (isCurrent(requestRevision, signature)) loadingFiles.value = false;
      }
    }, 180);
  }

  function close() {
    open.value = false;
    revision += 1;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = undefined;
    fileController?.abort();
    fileController = undefined;
    loadingCatalog.value = false;
    loadingFiles.value = false;
  }

  function isCurrent(requestRevision: number, signature: string) {
    const current = toValue(context);
    return open.value && revision === requestRevision && Boolean(current) && contextSignature(current!) === signature;
  }

  watch(() => contextSignature(toValue(context)), close);
  onBeforeUnmount(close);

  return {
    candidates,
    close,
    diagnostics,
    error,
    loading: computed(() => loadingCatalog.value || loadingFiles.value),
    open,
    query,
    show,
  };
}

function contextSignature(context: AiSessionMentionContext | undefined) {
  return context ? `${context.instanceId}\u0000${context.sessionId}\u0000${context.provider}\u0000${context.cwd}` : "";
}
