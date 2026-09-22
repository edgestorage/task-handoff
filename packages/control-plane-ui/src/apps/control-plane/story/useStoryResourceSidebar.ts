import { computed, reactive, ref, watch, type ComputedRef } from "vue";
import type { InstanceWithAiSessions } from "../../../api/types";
import {
  activeStoryResourceKey,
  aiSessionResourceContextKey,
  instanceAppResourceRefs,
  repositoryResourcesForContext,
  storyResourceKey,
  upsertAiSessionRepositoryResource,
  type StoryRepositoryResourceRef,
  type StoryEmbeddedBrowserResourceRef,
  type StoryResourceRef,
} from "./storyResources.ts";
import { reorderStoryResourceKeys, type StoryResourceDropPlacement } from "./storyResourceOrder.ts";

export const STORY_RESOURCE_SIDEBAR_MIN_WIDTH = 320;
export const STORY_RESOURCE_SIDEBAR_DEFAULT_WIDTH = 420;
const VISIBILITY_STORAGE_KEY = "task-handoff.control-plane.story-resources.visible-by-ai-session";
const WIDTH_STORAGE_KEY = "task-handoff.control-plane.story-resources.width";

export function normalizeStoryResourceSidebarWidth(value: unknown) {
  const width = typeof value === "number" ? value : Number(value);
  return Number.isFinite(width)
    ? Math.max(STORY_RESOURCE_SIDEBAR_MIN_WIDTH, width)
    : STORY_RESOURCE_SIDEBAR_DEFAULT_WIDTH;
}

function storedRecord(key: string) {
  try {
    const value: unknown = JSON.parse(window.localStorage?.getItem(key) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function storedWidth() {
  try {
    const value = window.localStorage?.getItem(WIDTH_STORAGE_KEY);
    return value === null || value === undefined ? STORY_RESOURCE_SIDEBAR_DEFAULT_WIDTH : normalizeStoryResourceSidebarWidth(value);
  } catch {
    return STORY_RESOURCE_SIDEBAR_DEFAULT_WIDTH;
  }
}

export function useStoryResourceSidebar(input: {
  aiSessionId: ComputedRef<string>;
  instanceId: ComputedRef<string>;
  instances: ComputedRef<InstanceWithAiSessions[]>;
}) {
  const storedVisibleByAiSession = storedRecord(VISIBILITY_STORAGE_KEY);
  const visibleByAiSession = reactive<Record<string, boolean>>(Object.fromEntries(
    Object.entries(storedVisibleByAiSession).filter((entry): entry is [string, boolean] => Boolean(entry[0]) && typeof entry[1] === "boolean"),
  ));
  const width = ref(storedWidth());
  const repositoryByAiSession = reactive<Record<string, StoryRepositoryResourceRef[]>>({});
  const browserByAiSession = reactive<Record<string, StoryEmbeddedBrowserResourceRef[]>>({});
  const activeByAiSession = reactive<Record<string, string>>({});
  const orderByAiSession = reactive<Record<string, string[]>>({});
  const contextKey = computed(() => aiSessionResourceContextKey(input.instanceId.value, input.aiSessionId.value));
  const visible = computed({
    get: () => Boolean(contextKey.value && visibleByAiSession[contextKey.value]),
    set(value: boolean) {
      if (contextKey.value) visibleByAiSession[contextKey.value] = value;
    },
  });

  const unorderedResources = computed<StoryResourceRef[]>(() => {
    const aiSessionId = input.aiSessionId.value;
    const instanceId = input.instanceId.value;
    if (!aiSessionId || !instanceId) return [];
    return [
      ...instanceAppResourceRefs(instanceId, input.instances.value),
      ...repositoryResourcesForContext(contextKey.value, repositoryByAiSession),
      ...(browserByAiSession[contextKey.value] || []),
    ];
  });
  const resources = computed<StoryResourceRef[]>(() => {
    const resourceContextKey = contextKey.value;
    const current = unorderedResources.value;
    const byKey = new Map(current.map((resource) => [storyResourceKey(resource), resource]));
    const ordered = (orderByAiSession[resourceContextKey] || []).flatMap((key) => {
      const resource = byKey.get(key);
      if (!resource) return [];
      byKey.delete(key);
      return [resource];
    });
    return [...ordered, ...byKey.values()];
  });

  const activeKey = computed({
    get() {
      const resourceContextKey = contextKey.value;
      return resourceContextKey ? activeStoryResourceKey(activeByAiSession[resourceContextKey], resources.value) : "";
    },
    set(key: string) {
      const resourceContextKey = contextKey.value;
      if (resourceContextKey && resources.value.some((resource) => storyResourceKey(resource) === key)) activeByAiSession[resourceContextKey] = key;
    },
  });
  const activeResource = computed(() => resources.value.find((resource) => storyResourceKey(resource) === activeKey.value));

  watch(resources, (next) => {
    const resourceContextKey = contextKey.value;
    if (!resourceContextKey) return;
    const nextActiveKey = activeStoryResourceKey(activeByAiSession[resourceContextKey], next);
    if (activeByAiSession[resourceContextKey] !== nextActiveKey) activeByAiSession[resourceContextKey] = nextActiveKey;
    const nextOrder = next.map(storyResourceKey);
    const currentOrder = orderByAiSession[resourceContextKey] || [];
    if (nextOrder.length !== currentOrder.length || nextOrder.some((key, index) => key !== currentOrder[index])) {
      orderByAiSession[resourceContextKey] = nextOrder;
    }
  }, { immediate: true });
  watch(visibleByAiSession, (value) => {
    try { window.localStorage?.setItem(VISIBILITY_STORAGE_KEY, JSON.stringify(value)); } catch { /* Local storage is optional. */ }
  }, { deep: true });
  watch(width, (value) => {
    try { window.localStorage?.setItem(WIDTH_STORAGE_KEY, String(normalizeStoryResourceSidebarWidth(value))); } catch { /* Local storage is optional. */ }
  });

  function belongsToCurrentAiSession(resource: StoryResourceRef) {
    return resource.instanceId === input.instanceId.value
      && (resource.kind === "app-session" || resource.aiSessionId === input.aiSessionId.value);
  }

  function select(resource: StoryResourceRef) {
    const resourceContextKey = contextKey.value;
    if (!resourceContextKey || !belongsToCurrentAiSession(resource)) return;
    activeByAiSession[resourceContextKey] = storyResourceKey(resource);
    visible.value = true;
  }

  function openRepository(resource: StoryRepositoryResourceRef) {
    if (!belongsToCurrentAiSession(resource)) return;
    repositoryByAiSession[contextKey.value] = upsertAiSessionRepositoryResource(repositoryByAiSession[contextKey.value] || [], resource);
    select(resource);
  }

  function removeRepository(resource: StoryRepositoryResourceRef) {
    const resourceContextKey = aiSessionResourceContextKey(resource.instanceId, resource.aiSessionId);
    if (resourceContextKey !== contextKey.value) return;
    const key = storyResourceKey(resource);
    repositoryByAiSession[resourceContextKey] = (repositoryByAiSession[resourceContextKey] || []).filter((candidate) => storyResourceKey(candidate) !== key);
    activeByAiSession[resourceContextKey] = activeStoryResourceKey(
      activeByAiSession[resourceContextKey],
      resources.value.filter((candidate) => storyResourceKey(candidate) !== key),
    );
  }

  function openBrowser(instanceId: string, initialUrl?: string) {
    const aiSessionId = input.aiSessionId.value;
    if (!aiSessionId || instanceId !== input.instanceId.value) return;
    const resource = {
      kind: "embedded-browser" as const,
      aiSessionId,
      instanceId,
      browserTabId: `story-browser:${crypto.randomUUID()}`,
      status: initialUrl ? "loading" : "running",
      ...(initialUrl ? { initialUrl } : {}),
    };
    browserByAiSession[contextKey.value] = [...(browserByAiSession[contextKey.value] || []), resource];
    select(resource);
  }

  function updateBrowser(resource: StoryEmbeddedBrowserResourceRef, patch: { title?: string; url?: string; status?: string }) {
    const resourceContextKey = aiSessionResourceContextKey(resource.instanceId, resource.aiSessionId);
    const current = browserByAiSession[resourceContextKey] || [];
    const index = current.findIndex((candidate) => candidate.browserTabId === resource.browserTabId && candidate.instanceId === resource.instanceId);
    if (index < 0) return;
    const next = [...current];
    next[index] = {
      ...next[index]!,
      ...(patch.title?.trim() ? { title: patch.title.trim().slice(0, 120) } : {}),
      ...(patch.url?.trim() ? { currentUrl: patch.url.trim().slice(0, 2000) } : {}),
      ...(patch.status?.trim() ? { status: patch.status.trim().slice(0, 40) } : {}),
    };
    browserByAiSession[resourceContextKey] = next;
  }

  function removeBrowser(resource: StoryEmbeddedBrowserResourceRef) {
    const resourceContextKey = aiSessionResourceContextKey(resource.instanceId, resource.aiSessionId);
    const key = storyResourceKey(resource);
    browserByAiSession[resourceContextKey] = (browserByAiSession[resourceContextKey] || []).filter((candidate) => storyResourceKey(candidate) !== key);
    if (resourceContextKey === contextKey.value) {
      activeByAiSession[resourceContextKey] = activeStoryResourceKey(
        activeByAiSession[resourceContextKey],
        resources.value.filter((candidate) => storyResourceKey(candidate) !== key),
      );
    }
  }

  const allBrowserResources = computed(() => Object.values(browserByAiSession).flat());

  function focusApp(instanceId: string, sessionId: string) {
    if (instanceId !== input.instanceId.value) return;
    const resource = resources.value.find((candidate) => candidate.kind === "app-session" && candidate.instanceId === instanceId && candidate.sessionId === sessionId);
    if (resource) select(resource);
  }

  function reorder(sourceKey: string, targetKey: string, placement: StoryResourceDropPlacement) {
    const resourceContextKey = contextKey.value;
    const keys = resources.value.map(storyResourceKey);
    if (!resourceContextKey) return;
    const nextKeys = reorderStoryResourceKeys(keys, sourceKey, targetKey, placement);
    if (nextKeys !== keys) orderByAiSession[resourceContextKey] = nextKeys;
  }

  return {
    visible,
    width,
    resources,
    activeKey,
    activeResource,
    select,
    openRepository,
    removeRepository,
    openBrowser,
    updateBrowser,
    removeBrowser,
    allBrowserResources,
    focusApp,
    reorder,
  };
}
